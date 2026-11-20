# Ukacell host app

The phone app of Ukacell: a Tauri v2 shell with 20 native plugins bundled in.
Its launcher (`src/`) scans the QR code printed by
[`ukacell`](../../packages/cli) and loads your dev server in the main
webview.

```
apps/host/
├── app-icon.png               1024×1024 source for `tauri icon`
├── scripts/patch-android.mjs  Android manifest + Gradle adjustments
├── src/                       launcher UI (plain HTML/CSS/JS, no bundler)
└── src-tauri/
    ├── capabilities/
    │   ├── default.json       launcher: core + barcode scanner + deep links
    │   └── remote-dev.json    dev servers on localhost and private LAN IPs
    ├── icons/
    ├── src/
    │   ├── lib.rs             plugin setup, page-load hook, deep links
    │   ├── floating_menu.js   Reload / Home pill injected into dev pages
    │   └── main.rs
    ├── Cargo.toml
    ├── Info.ios.plist         merged into the generated iOS Info.plist
    └── tauri.conf.json
```

## Requirements

| Tool | Version |
| --- | --- |
| Node.js | 18.18 or newer |
| Rust | 1.90 or newer (`rustup update stable`) |
| Android | Android Studio or the command-line SDK, NDK 27, JDK 17 |
| iOS | macOS with Xcode 15+ and CocoaPods |

Follow the official [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
for the Android SDK/NDK environment variables (`ANDROID_HOME`, `NDK_HOME`,
`JAVA_HOME`) and add the Rust targets:

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
rustup target add aarch64-apple-ios x86_64-apple-ios aarch64-apple-ios-sim   # macOS only
```

## Commands

Run from the repository root after `npm install`, or inside `apps/host`
without the `--workspace` flag.

| Task | Command |
| --- | --- |
| Desktop window (UI work, no hardware plugins) | `npm run dev --workspace apps/host` |
| Generate the Android project | `npm run android:init --workspace apps/host` |
| Build, install and launch on a phone (+ live log) | `npm run android:dev --workspace apps/host` |
| Same, for the Android Studio emulator | `npm run android:dev:emulator --workspace apps/host` |
| Live-reload the launcher UI (`tauri android dev`) | `npm run android:dev:live --workspace apps/host` |
| Build the universal APK | `npm run android:build --workspace apps/host` |
| Generate the iOS project | `npm run ios:init --workspace apps/host` |
| Run on an iPhone or simulator | `npm run ios:dev --workspace apps/host` |

### Stronghold and Windows

`tauri-plugin-stronghold` is an optional Cargo feature (`stronghold`). Its
libsodium dependency can only be cross-compiled for Android on Linux or macOS,
because the build script runs `./configure`. Without the feature, Android
builds on Windows fail with *"Failed to run './configure': %1 is not a valid
Win32 application"*.

- Local builds (`android:dev`, `android:build`) leave Stronghold out.
- CI builds the release APK with `--features stronghold`.
- On Linux/macOS you can include it locally:
  `npm run tauri -- android dev --features stronghold`.
- `build.rs` loads `capabilities/stronghold/*.json` only when the feature is
  on, so the capability files always match the compiled plugins.

## Android setup

`tauri android init` writes the native project to `src-tauri/gen/android`.
Ukacell needs three changes there, and `scripts/patch-android.mjs` makes all
of them (it runs automatically in `android:init`, `android:dev`,
`android:build` and in CI):

1. **Permissions.** Each `<uses-permission>` is added once, just before
   `<application>`.
2. **Optional hardware.** Each `<uses-feature>` is marked
   `android:required="false"`, so Google Play and sideloading still accept
   phones without NFC, a flash or a fingerprint sensor.
3. **Cleartext HTTP.** Dev servers are `http://` on the LAN. Tauri only
   enables cleartext traffic for debug builds, so the script sets it for
   release builds too.

After patching, the relevant part of
`src-tauri/gen/android/app/src/main/AndroidManifest.xml` looks like this:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
    <uses-permission android:name="android.permission.USE_BIOMETRIC" />
    <uses-permission android:name="android.permission.NFC" />
    <uses-permission android:name="android.permission.VIBRATE" />
    <uses-permission android:name="android.permission.FLASHLIGHT" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <uses-feature android:name="android.hardware.camera" android:required="false" />
    <uses-feature android:name="android.hardware.camera.autofocus" android:required="false" />
    <uses-feature android:name="android.hardware.camera.flash" android:required="false" />
    <uses-feature android:name="android.hardware.location.gps" android:required="false" />
    <uses-feature android:name="android.hardware.nfc" android:required="false" />
    <uses-feature android:name="android.hardware.fingerprint" android:required="false" />

    <application
        android:usesCleartextTraffic="true"
        ...>
```

To make the same change by hand, copy those lines into the manifest and set
`manifestPlaceholders["usesCleartextTraffic"] = "true"` for the `release`
build type in `app/build.gradle.kts`.

### Signing a release APK

Android refuses to install unsigned APKs. The patch script appends a block to
`app/build.gradle.kts` that signs release builds whenever
`src-tauri/gen/android/keystore.properties` exists:

```properties
password=your-keystore-password
keyAlias=ukacell
storeFile=/absolute/path/to/ukacell-release.jks
```

Create a keystore once and keep it safe. If you lose it, updates can no
longer be installed over earlier versions:

```bash
keytool -genkeypair -v -keystore ukacell-release.jks -alias ukacell \
  -keyalg RSA -keysize 2048 -validity 10000
```

`keystore.properties`, `*.jks` and `*.keystore` are git-ignored.

## iOS setup

`src-tauri/Info.ios.plist` is merged into the generated
`gen/apple/ukacell_iOS/Info.plist` by the Tauri CLI. It contains:

```xml
<key>NSCameraUsageDescription</key>
<string>Ukacell uses the camera to scan the QR code shown by `npx ukacell`, and lets the app you are developing use it.</string>
<key>NSLocationWhenInUseUsageDescription</key>
<string>The app you are developing in Ukacell requested your location.</string>
<key>NSFaceIDUsageDescription</key>
<string>The app you are developing in Ukacell requested Face ID authentication.</string>
<key>NFCReaderUsageDescription</key>
<string>The app you are developing in Ukacell requested to read or write NFC tags.</string>
<key>NSLocalNetworkUsageDescription</key>
<string>Ukacell connects to the dev server running on your computer over the local network.</string>
<key>NSAppTransportSecurity</key>
<dict>
  <key>NSAllowsLocalNetworking</key><true/>
  <key>NSAllowsArbitraryLoadsInWebContent</key><true/>
</dict>
```

NFC on iOS also needs the **Near Field Communication Tag Reading**
capability. Enable it in Xcode (`npm run tauri --workspace apps/host -- ios
dev --open`, then *Signing & Capabilities → + Capability*).

## How the pieces fit

- **Global API.** `app.withGlobalTauri` is `true`, so every page loaded in
  the main webview (the launcher and your dev server) gets
  `window.__TAURI__` and each plugin's namespace, for example
  `window.__TAURI__.geolocation`.
- **Capabilities.** `default.json` applies to the bundled launcher only.
  `remote-dev.json` has `"local": false` and a `remote.urls` list, so it
  applies only to pages from `http://localhost:*`, `http://127.0.0.1:*`,
  and the private IPv4 ranges `192.168.0.0/16`, `10.0.0.0/8` and
  `172.16.0.0/12`. Those ranges are URLPattern regexp groups
  (`http://(192\.168\.\d{1,3}\.\d{1,3}):*/*`): a wildcard inside an IP literal
  such as `192.168.*.*` never matches. `cargo test` in `src-tauri` checks
  them. Any other origin loads,
  but its IPC calls are rejected.
- **Mobile-only plugins.** Barcode scanner, biometric, geolocation, haptics,
  NFC and torch are registered behind `#[cfg(mobile)]`. They stay ordinary
  Cargo dependencies, so their permissions are known on every target and a
  desktop `tauri dev` still validates the capability files.
- **Floating menu.** `on_page_load` records the first URL the main webview
  loads as the launcher. On every later `Finished` load whose origin is
  different, it injects `floating_menu.js`: a draggable, semi-transparent
  pill with **Reload** (`location.reload()`) and **Home**
  (`location.replace(<launcher URL>)`).
- **Deep links.** `ukacell://open?url=<dev server URL>` opens a server. The
  launcher handles it (and saves it to history) when it is showing.
  Otherwise `lib.rs` navigates the webview directly.
