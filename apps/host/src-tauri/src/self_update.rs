//! In-app updates for the Android build.
//!
//! The launcher checks GitHub Releases for a newer version itself (plain
//! `fetch`). When the user taps "Update", this plugin hands the work to
//! `SelfUpdatePlugin.kt`, which downloads the APK, checks it against the
//! `.sha256` file published next to it, makes sure it is a newer build of this
//! same app and opens the Android installer. Android then refuses the update
//! unless it is signed with the same key, so a tampered APK cannot replace
//! the app.
//!
//! The permission (`self-update:default`) is only granted to the bundled
//! launcher in `capabilities/default.json`. Dev-server pages cannot call it.
//!
//! Downloads always come from this repository's releases: JavaScript only
//! picks the tag and asset name, and both are validated here.

use tauri::{
    ipc::Channel,
    plugin::{Builder, TauriPlugin},
    AppHandle, Runtime,
};

#[cfg(target_os = "android")]
use tauri::{plugin::PluginHandle, Manager};

/// Plugin name: the launcher calls `plugin:self-update|<command>`.
pub const PLUGIN_NAME: &str = "self-update";

/// GitHub repository that publishes the release APKs.
const RELEASES_REPO: &str = "urukaa/ukacell";

#[cfg(not(target_os = "android"))]
const UNSUPPORTED: &str = "In-app updates are only available on Android.";

#[cfg(target_os = "android")]
struct SelfUpdate<R: Runtime>(PluginHandle<R>);

#[cfg(target_os = "android")]
fn native<R: Runtime>(app: &AppHandle<R>) -> &PluginHandle<R> {
    &app.state::<SelfUpdate<R>>().inner().0
}

/// `v1.2.3` or `v1.2.3-beta.1`.
fn is_valid_tag(tag: &str) -> bool {
    let Some(rest) = tag.strip_prefix('v') else {
        return false;
    };
    let (core, pre) = match rest.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (rest, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        && pre.is_none_or(|pre| {
            !pre.is_empty()
                && pre
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-')
        })
}

/// A plain file name ending in `.apk`, e.g. `ukacell-0.2.0-universal.apk`.
fn is_valid_apk_name(name: &str) -> bool {
    name.len() > 4
        && name.ends_with(".apk")
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

/// Download URL of a release asset in [`RELEASES_REPO`].
fn release_asset_url(tag: &str, asset: &str) -> Result<String, String> {
    if !is_valid_tag(tag) {
        return Err(format!("'{tag}' is not a release tag."));
    }
    if !is_valid_apk_name(asset) {
        return Err(format!("'{asset}' is not an APK file name."));
    }
    Ok(format!(
        "https://github.com/{RELEASES_REPO}/releases/download/{tag}/{asset}"
    ))
}

#[cfg(target_os = "android")]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallPayload {
    url: String,
    checksum_url: String,
    on_progress: Channel<serde_json::Value>,
}

/// `{ granted: bool }`: may Ukacell open the package installer?
#[tauri::command]
async fn can_install<R: Runtime>(app: AppHandle<R>) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        native(&app)
            .run_mobile_plugin_async("canInstall", ())
            .await
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err(UNSUPPORTED.into())
    }
}

/// Opens "Install unknown apps" for Ukacell. Resolves with `{ granted: bool }`
/// once the user comes back.
#[tauri::command]
async fn open_install_settings<R: Runtime>(
    app: AppHandle<R>,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        native(&app)
            .run_mobile_plugin_async("openInstallSettings", ())
            .await
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err(UNSUPPORTED.into())
    }
}

/// Downloads `asset` from release `tag`, verifies it and opens the installer.
/// `on_progress` receives `{ downloaded, total }` (bytes; `total` is -1 when
/// unknown).
#[tauri::command]
async fn install<R: Runtime>(
    app: AppHandle<R>,
    tag: String,
    asset: String,
    on_progress: Channel<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let url = release_asset_url(&tag, &asset)?;
    #[cfg(target_os = "android")]
    {
        let payload = InstallPayload {
            checksum_url: format!("{url}.sha256"),
            url,
            on_progress,
        };
        native(&app)
            .run_mobile_plugin_async("install", payload)
            .await
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, url, on_progress);
        Err(UNSUPPORTED.into())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new(PLUGIN_NAME)
        .invoke_handler(tauri::generate_handler![
            can_install,
            open_install_settings,
            install
        ])
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let handle = _api.register_android_plugin("dev.ukacell.host", "SelfUpdatePlugin")?;
                _app.manage(SelfUpdate(handle));
            }
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_urls_for_this_repo_only() {
        assert_eq!(
            release_asset_url("v0.2.0", "ukacell-0.2.0-universal.apk").unwrap(),
            "https://github.com/urukaa/ukacell/releases/download/v0.2.0/ukacell-0.2.0-universal.apk"
        );
        assert!(release_asset_url("v1.0.0-beta.1", "ukacell-1.0.0-beta.1-universal.apk").is_ok());
    }

    #[test]
    fn rejects_unexpected_input() {
        for tag in ["0.2.0", "v0.2", "v0.2.0/../../x", "v0.2.0-", "v0.2.0?x", "", "v1.2.3-be ta"] {
            assert!(release_asset_url(tag, "ukacell.apk").is_err(), "tag {tag:?}");
        }
        for asset in ["../ukacell.apk", "ukacell.apk?x=1", "ukacell.zip", ".apk", "a/b.apk", "https://evil/x.apk"] {
            assert!(release_asset_url("v0.2.0", asset).is_err(), "asset {asset:?}");
        }
    }
}
