//! Ukacell host: the mobile dev companion app for Tauri v2.
//!
//! The launcher UI in `../src` scans a QR code (or takes a typed URL) and
//! navigates the main webview to a developer's dev server. Pages served from
//! the LAN ranges listed in `capabilities/remote-dev.json` can call every
//! bundled plugin. Every page that is not the launcher also gets a small
//! floating menu (Reload / Home) injected from `on_page_load`.

use std::sync::OnceLock;

use tauri::{
    webview::{PageLoadEvent, PageLoadPayload},
    Manager, Runtime, Url, Webview,
};
use tauri_plugin_deep_link::DeepLinkExt;

// The mobile-only plugins stay plain dependencies on desktop (so their
// permissions validate everywhere) but are only registered on mobile.
// Referencing them here keeps Cargo's unused-dependency lint quiet.
#[cfg(desktop)]
use {
    tauri_plugin_barcode_scanner as _, tauri_plugin_biometric as _,
    tauri_plugin_geolocation as _, tauri_plugin_haptics as _, tauri_plugin_nfc as _,
    tauri_plugin_torch as _,
};

/// Label of the only webview window, declared in `tauri.conf.json`.
const MAIN_WEBVIEW: &str = "main";

/// Floating menu injected into dev-server pages. `__UKACELL_HOME_URL__` is
/// replaced with a JSON string literal holding the launcher URL.
const FLOATING_MENU_JS: &str = include_str!("floating_menu.js");
const HOME_URL_PLACEHOLDER: &str = "__UKACELL_HOME_URL__";

/// Custom URL scheme registered in `tauri.conf.json` (`plugins.deep-link`).
const DEEP_LINK_SCHEME: &str = "ukacell";

/// Where Tauri serves the bundled frontend on each platform.
#[cfg(any(target_os = "windows", target_os = "android"))]
const FALLBACK_HOME_URL: &str = "http://tauri.localhost/";
#[cfg(not(any(target_os = "windows", target_os = "android")))]
const FALLBACK_HOME_URL: &str = "tauri://localhost/";

/// Root URL of the launcher, recorded from the first page the main webview
/// loads. In release builds that is the app's own `tauri://localhost` or
/// `http://tauri.localhost` origin; under `tauri dev` it is the CLI's built-in
/// dev server, which must not be mistaken for a remote app.
static LAUNCHER_ROOT: OnceLock<Url> = OnceLock::new();

fn origin_root(url: &Url) -> Url {
    let mut root = url.clone();
    root.set_path("/");
    root.set_query(None);
    root.set_fragment(None);
    root
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

/// True for the launcher UI itself (`tauri://localhost`, `http(s)://tauri.localhost`
/// or the origin the main webview started on).
fn is_launcher_page(url: &Url) -> bool {
    let builtin_origin = match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    };
    builtin_origin
        || LAUNCHER_ROOT
            .get()
            .is_some_and(|root| same_origin(root, url))
}

fn launcher_home_url() -> String {
    LAUNCHER_ROOT
        .get()
        .map(|root| root.to_string())
        .unwrap_or_else(|| FALLBACK_HOME_URL.to_owned())
}

fn floating_menu_script() -> String {
    let home = serde_json::Value::String(launcher_home_url()).to_string();
    FLOATING_MENU_JS.replace(HOME_URL_PLACEHOLDER, &home)
}

/// `ukacell://open?url=http://192.168.1.20:5173` -> `http://192.168.1.20:5173/`
fn dev_server_from_deep_link(link: &Url) -> Option<Url> {
    if link.scheme() != DEEP_LINK_SCHEME {
        return None;
    }
    let target = link
        .query_pairs()
        .find(|(key, _)| key == "url")
        .map(|(_, value)| value.into_owned())?;
    let target = Url::parse(&target).ok()?;
    matches!(target.scheme(), "http" | "https").then_some(target)
}

fn handle_page_load<R: Runtime>(webview: &Webview<R>, payload: &PageLoadPayload<'_>) {
    if webview.label() != MAIN_WEBVIEW {
        return;
    }
    let url = payload.url();

    if LAUNCHER_ROOT.get().is_none() && matches!(url.scheme(), "tauri" | "http" | "https") {
        // The first document the main webview ever loads is the launcher.
        let _ = LAUNCHER_ROOT.set(origin_root(url));
    }

    if !matches!(payload.event(), PageLoadEvent::Finished) {
        return;
    }
    if !matches!(url.scheme(), "http" | "https") || is_launcher_page(url) {
        return;
    }

    if let Err(error) = webview.eval(floating_menu_script()) {
        log::warn!("could not inject the Ukacell floating menu into {url}: {error}");
    }
}

#[cfg(test)]
mod tests {
    use tauri::utils::acl::RemoteUrlPattern;

    /// The remote URL patterns exactly as Tauri parses them from a capability file.
    fn remote_patterns(capability_json: &str) -> Vec<RemoteUrlPattern> {
        let capability: serde_json::Value = serde_json::from_str(capability_json).unwrap();
        capability["remote"]["urls"]
            .as_array()
            .expect("remote.urls")
            .iter()
            .map(|url| url.as_str().unwrap().parse().expect("valid URL pattern"))
            .collect()
    }

    fn trusted(patterns: &[RemoteUrlPattern], url: &str) -> bool {
        let url = url.parse().unwrap();
        patterns.iter().any(|pattern| pattern.test(&url))
    }

    fn assert_dev_ranges(capability_json: &str) {
        let patterns = remote_patterns(capability_json);
        for url in [
            "http://localhost:5173/",
            "http://127.0.0.1:1420/index.html",
            "http://192.168.1.12:5173/",
            "http://192.168.137.1:3000/page?q=1#top",
            "http://192.168.0.5/",
            "http://10.0.0.5:8080/",
            "http://172.16.0.2:5173/",
            "http://172.31.255.254:5173/",
        ] {
            assert!(trusted(&patterns, url), "{url} should be trusted");
        }
        for url in [
            "https://192.168.1.12:5173/",
            "http://172.15.0.1:5173/",
            "http://172.32.0.1:5173/",
            "http://8.8.8.8:5173/",
            "http://192.168.1.12.evil.example:5173/",
            "http://example.com/",
        ] {
            assert!(!trusted(&patterns, url), "{url} must not be trusted");
        }
    }

    #[test]
    fn remote_dev_capability_trusts_private_lan_only() {
        assert_dev_ranges(include_str!("../capabilities/remote-dev.json"));
    }

    #[test]
    fn stronghold_capability_uses_the_same_ranges() {
        assert_dev_ranges(include_str!("../capabilities/stronghold/remote-dev-stronghold.json"));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `mut` is only needed on mobile, where the hardware plugins are added.
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    // Hardware plugins that only have a real implementation on Android/iOS.
    #[cfg(mobile)]
    {
        builder = builder
            .plugin(tauri_plugin_barcode_scanner::init())
            .plugin(tauri_plugin_biometric::init())
            .plugin(tauri_plugin_geolocation::init())
            .plugin(tauri_plugin_haptics::init())
            .plugin(tauri_plugin_nfc::init())
            .plugin(tauri_plugin_torch::init());
    }

    builder
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_websocket::init())
        .plugin(tauri_plugin_upload::init())
        .setup(|app| {
            // Stronghold is an optional feature (see Cargo.toml). It derives
            // vault keys with Argon2; the salt lives in the app's local data
            // directory, which may not exist on first launch.
            #[cfg(feature = "stronghold")]
            {
                let data_dir = app.path().app_local_data_dir()?;
                std::fs::create_dir_all(&data_dir)?;
                let salt_path = data_dir.join("stronghold-salt.txt");
                app.handle().plugin(
                    tauri_plugin_stronghold::Builder::with_argon2(&salt_path).build(),
                )?;
            }

            // `ukacell://open?url=...` while a dev app is showing: jump straight
            // to the new server. When the launcher is showing, its own
            // `onOpenUrl` listener handles the link and records it in history.
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let Some(window) = handle.get_webview_window(MAIN_WEBVIEW) else {
                    return;
                };
                let on_launcher = window
                    .url()
                    .map(|current| is_launcher_page(&current))
                    .unwrap_or(true);
                if on_launcher {
                    return;
                }
                if let Some(target) = event.urls().iter().find_map(dev_server_from_deep_link) {
                    if let Err(error) = window.navigate(target) {
                        log::warn!("could not open deep link: {error}");
                    }
                }
            });

            Ok(())
        })
        .on_page_load(|webview, payload| handle_page_load(webview, payload))
        .run(tauri::generate_context!())
        .expect("error while running the Ukacell host");
}
