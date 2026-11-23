#!/usr/bin/env node
// Prepares the generated Android project (src-tauri/gen/android) for Ukacell.
//
// Run it after `tauri android init` (and again whenever the project is
// regenerated). It is idempotent: running it twice changes nothing.
//
//   1. AndroidManifest.xml
//      - <uses-permission> for every native API the host exposes, plus
//        REQUEST_INSTALL_PACKAGES for in-app updates
//      - optional <uses-feature> entries, so phones without NFC, a flash or a
//        fingerprint reader can still install the APK
//      - android:usesCleartextTraffic="true", because dev servers are plain
//        http:// on the LAN (Tauri only enables it for debug builds)
//   2. app/build.gradle.kts
//      - release signing from gen/android/keystore.properties, when present
//      - the cleartext manifest placeholder forced on for release builds
//   3. build.gradle.kts (root)
//      - plugins that pin compileSdk below what :tauri-android needs (36) are
//        raised to the app's compileSdk (tauri-plugin-torch 0.1.0 pins 34)
//   4. app/proguard-rules.pro
//      - keep rules for ML Kit, without which the release (R8) build of the
//        barcode scanner crashes on the camera's first frame
//
// Usage: node scripts/patch-android.mjs [--android-dir <path>]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PERMISSIONS = [
  "android.permission.INTERNET",
  "android.permission.CAMERA",
  "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.ACCESS_COARSE_LOCATION",
  "android.permission.USE_BIOMETRIC",
  "android.permission.NFC",
  "android.permission.VIBRATE",
  "android.permission.FLASHLIGHT",
  "android.permission.POST_NOTIFICATIONS",
  // In-app updates (SelfUpdatePlugin.kt). Remove for a Google Play build.
  "android.permission.REQUEST_INSTALL_PACKAGES",
];

const OPTIONAL_FEATURES = [
  "android.hardware.camera",
  "android.hardware.camera.autofocus",
  "android.hardware.camera.flash",
  "android.hardware.location.gps",
  "android.hardware.nfc",
  "android.hardware.fingerprint",
];

const GRADLE_BEGIN = "// >>> ukacell: release signing & cleartext (managed by scripts/patch-android.mjs)";
const GRADLE_END = "// <<< ukacell";

const GRADLE_BLOCK = `${GRADLE_BEGIN}
val ukacellKeystoreFile = rootProject.file("keystore.properties")
if (ukacellKeystoreFile.exists()) {
    val ukacellKeystore = Properties().apply {
        ukacellKeystoreFile.inputStream().use { load(it) }
    }
    android {
        signingConfigs {
            create("ukacellRelease") {
                keyAlias = ukacellKeystore.getProperty("keyAlias")
                keyPassword = ukacellKeystore.getProperty("password")
                storeFile = file(ukacellKeystore.getProperty("storeFile"))
                storePassword = ukacellKeystore.getProperty("password")
            }
        }
        buildTypes {
            getByName("release") {
                signingConfig = signingConfigs.getByName("ukacellRelease")
            }
        }
    }
} else {
    logger.warn("ukacell: gen/android/keystore.properties not found, the release APK will be unsigned")
}
android {
    buildTypes {
        getByName("release") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
        }
    }
}
${GRADLE_END}
`;

function parseArgs(argv) {
  const hostDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let androidDir = join(hostDir, "src-tauri", "gen", "android");
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--android-dir" && argv[i + 1]) {
      androidDir = resolve(argv[i + 1]);
      i += 1;
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("Usage: node scripts/patch-android.mjs [--android-dir <path>]");
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(1);
    }
  }
  return { androidDir };
}

function detectIndent(manifest) {
  const match = manifest.match(/\n([ \t]+)<application/);
  return match ? match[1] : "    ";
}

function insertBeforeApplication(manifest, lines) {
  if (lines.length === 0) return manifest;
  const indent = detectIndent(manifest);
  const index = manifest.search(/^[ \t]*<application\b/m);
  if (index === -1) {
    throw new Error("AndroidManifest.xml has no <application> element");
  }
  const block = lines.map((line) => `${indent}${line}\n`).join("");
  return manifest.slice(0, index) + block + manifest.slice(index);
}

function patchManifest(path) {
  const original = readFileSync(path, "utf8");
  let manifest = original;
  const changes = [];

  const missingPermissions = PERMISSIONS.filter(
    (name) => !new RegExp(`<uses-permission[^>]*android:name="${name.replace(/\./g, "\\.")}"`).test(manifest)
  );
  manifest = insertBeforeApplication(
    manifest,
    missingPermissions.map((name) => `<uses-permission android:name="${name}" />`)
  );
  changes.push(...missingPermissions.map((name) => `permission ${name}`));

  const missingFeatures = OPTIONAL_FEATURES.filter(
    (name) => !new RegExp(`<uses-feature[^>]*android:name="${name.replace(/\./g, "\\.")}"`).test(manifest)
  );
  manifest = insertBeforeApplication(
    manifest,
    missingFeatures.map((name) => `<uses-feature android:name="${name}" android:required="false" />`)
  );
  changes.push(...missingFeatures.map((name) => `optional feature ${name}`));

  if (/android:usesCleartextTraffic="[^"]*"/.test(manifest)) {
    const patched = manifest.replace(/android:usesCleartextTraffic="[^"]*"/, 'android:usesCleartextTraffic="true"');
    if (patched !== manifest) {
      manifest = patched;
      changes.push('android:usesCleartextTraffic="true"');
    }
  } else {
    manifest = manifest.replace(/<application\b/, '<application\n        android:usesCleartextTraffic="true"');
    changes.push('android:usesCleartextTraffic="true" (added)');
  }

  if (manifest !== original) {
    writeFileSync(path, manifest);
  }
  return changes;
}

// Inside a Gradle Kotlin script `java` resolves to the Java extension, so a
// fully qualified `java.util.Properties` does not compile; import it instead.
const PROPERTIES_IMPORT = "import java.util.Properties";

function patchGradle(path) {
  const original = readFileSync(path, "utf8");
  let gradle = upsertBlock(path, original, GRADLE_BEGIN, GRADLE_END, GRADLE_BLOCK);
  if (!new RegExp(`^${PROPERTIES_IMPORT.replace(/\./g, "\\.")}\\s*$`, "m").test(gradle)) {
    gradle = `${PROPERTIES_IMPORT}\n${gradle}`;
  }
  if (gradle !== original) {
    writeFileSync(path, gradle);
    return ["release signing + cleartext block"];
  }
  return [];
}

// Appends `block` to `source`, or replaces the copy between `begin` and `end`
// markers when one is already there.
function upsertBlock(path, source, begin, end, block) {
  const start = source.indexOf(begin);
  if (start === -1) {
    return source.replace(/\s*$/, "\n\n") + block;
  }
  const stop = source.indexOf(end, start);
  if (stop === -1) {
    throw new Error(`${path} has the ukacell start marker but no end marker; fix it by hand`);
  }
  const afterEnd = source.indexOf("\n", stop);
  return source.slice(0, start) + block + (afterEnd === -1 ? "" : source.slice(afterEnd + 1));
}

const ROOT_GRADLE_BEGIN = "// >>> ukacell: minimum plugin compileSdk (managed by scripts/patch-android.mjs)";
const ROOT_GRADLE_END = "// <<< ukacell";
const MIN_PLUGIN_COMPILE_SDK = 36;

// :tauri-android requires every library that depends on it to compile against
// android-${MIN_PLUGIN_COMPILE_SDK}+, but some community plugins pin an older
// compileSdk (tauri-plugin-torch 0.1.0 uses 34) and live in the Cargo registry,
// where they cannot be edited. finalizeDsl runs after the plugin's own
// build.gradle.kts, so this override wins. Plugins are raised to the app's
// compileSdk, which is already installed, so no extra SDK platform is needed.
function rootGradleBlock(targetSdk) {
  return `${ROOT_GRADLE_BEGIN}
// Some community plugins (e.g. tauri-plugin-torch) pin a compileSdk below the
// ${MIN_PLUGIN_COMPILE_SDK} that :tauri-android requires; raise them to the app's compileSdk.
subprojects {
    plugins.withId("com.android.library") {
        extensions.configure<com.android.build.api.variant.LibraryAndroidComponentsExtension> {
            finalizeDsl {
                val current = it.compileSdk ?: 0
                if (current < ${MIN_PLUGIN_COMPILE_SDK}) {
                    it.compileSdk = ${targetSdk}
                    logger.lifecycle("ukacell: \${project.path} compileSdk \$current -> ${targetSdk}")
                }
            }
        }
    }
}
${ROOT_GRADLE_END}
`;
}

function patchRootGradle(path, appGradlePath) {
  const match = readFileSync(appGradlePath, "utf8").match(/^\s*compileSdk\s*=\s*(\d+)/m);
  const appCompileSdk = match ? Number(match[1]) : 0;
  const targetSdk = Math.max(appCompileSdk, MIN_PLUGIN_COMPILE_SDK);
  const original = readFileSync(path, "utf8");
  const gradle = upsertBlock(path, original, ROOT_GRADLE_BEGIN, ROOT_GRADLE_END, rootGradleBlock(targetSdk));
  if (gradle !== original) {
    writeFileSync(path, gradle);
    return [`plugin compileSdk >= ${MIN_PLUGIN_COMPILE_SDK}`];
  }
  return [];
}

const PROGUARD_BEGIN = "# >>> ukacell: ML Kit keep rules (managed by scripts/patch-android.mjs)";
const PROGUARD_END = "# <<< ukacell";

// ML Kit (used by the barcode scanner plugin) wires itself together at runtime
// through Firebase components found by reflection. R8 in full mode, the AGP
// default, optimizes that wiring away: the release APK then crashes on the
// camera's first frame with a NullPointerException ("...Object.getClass() on
// a null object reference") inside InputImage.fromMediaImage. Debug builds are
// not shrunk, so they never show it.
const PROGUARD_BLOCK = `${PROGUARD_BEGIN}
# ML Kit looks its components up by reflection; without these the release
# build's barcode scanner crashes on the camera's first frame.
-keep class com.google.mlkit.** { *; }
-keep class com.google.android.gms.internal.mlkit_** { *; }
-keep class com.google.firebase.components.** { *; }
${PROGUARD_END}
`;

function patchProguard(path) {
  const original = readFileSync(path, "utf8");
  const rules = upsertBlock(path, original, PROGUARD_BEGIN, PROGUARD_END, PROGUARD_BLOCK);
  if (rules !== original) {
    writeFileSync(path, rules);
    return ["ML Kit keep rules"];
  }
  return [];
}

function main() {
  const { androidDir } = parseArgs(process.argv.slice(2));
  const manifestPath = join(androidDir, "app", "src", "main", "AndroidManifest.xml");
  const gradlePath = join(androidDir, "app", "build.gradle.kts");
  const rootGradlePath = join(androidDir, "build.gradle.kts");
  const proguardPath = join(androidDir, "app", "proguard-rules.pro");

  for (const path of [manifestPath, gradlePath, rootGradlePath, proguardPath]) {
    if (!existsSync(path)) {
      console.error(`Not found: ${path}`);
      console.error("Run `npm run android:init` (tauri android init) in apps/host first.");
      process.exit(1);
    }
  }

  const changes = [
    ...patchManifest(manifestPath),
    ...patchGradle(gradlePath),
    ...patchRootGradle(rootGradlePath, gradlePath),
    ...patchProguard(proguardPath),
  ];
  if (changes.length === 0) {
    console.log("patch-android: already up to date");
  } else {
    console.log("patch-android: updated the Android project");
    for (const change of changes) console.log(`  + ${change}`);
  }

  const keystore = join(androidDir, "keystore.properties");
  if (!existsSync(keystore)) {
    console.log(
      "patch-android: no keystore.properties yet; `tauri android build` will produce an unsigned release APK"
    );
  }
}

main();
