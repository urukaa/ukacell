fn main() {
    // Capability files in capabilities/stronghold/ reference the optional
    // Stronghold plugin, so they are only picked up when its feature is on.
    let capabilities = if std::env::var_os("CARGO_FEATURE_STRONGHOLD").is_some() {
        "./capabilities/**/*.json"
    } else {
        "./capabilities/*.json"
    };
    println!("cargo:rerun-if-changed=capabilities");

    tauri_build::try_build(tauri_build::Attributes::new().capabilities_path_pattern(capabilities))
        .expect("failed to run tauri-build");
}
