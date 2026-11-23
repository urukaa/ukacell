fn main() {
    // Capability files in capabilities/stronghold/ reference the optional
    // Stronghold plugin, so they are only picked up when its feature is on.
    let capabilities = if std::env::var_os("CARGO_FEATURE_STRONGHOLD").is_some() {
        "./capabilities/**/*.json"
    } else {
        "./capabilities/*.json"
    };
    println!("cargo:rerun-if-changed=capabilities");

    // In-app updates (src/self_update.rs). `self-update:default` allows all
    // three commands; only the launcher capability grants it.
    let self_update = tauri_build::InlinedPlugin::new()
        .commands(&["can_install", "open_install_settings", "install"])
        .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands);

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .capabilities_path_pattern(capabilities)
            .plugin("self-update", self_update),
    )
    .expect("failed to run tauri-build");
}
