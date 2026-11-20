#!/usr/bin/env node
// Prepares the generated Android project (src-tauri/gen/android) for Ukacell.
//
// Run it after `tauri android init` (and again whenever the project is
// regenerated). It is idempotent: running it twice changes nothing.
//
//   1. AndroidManifest.xml
//      - <uses-permission> for every native API the host exposes
//      - optional <uses-feature> entries, so phones without NFC, a flash or a
//        fingerprint reader can still install the APK
//      - android:usesCleartextTraffic="true", because dev servers are plain
//        http:// on the LAN (Tauri only enables it for debug builds)
//   2. app/build.gradle.kts
//      - release signing from gen/android/keystore.properties, when present
//      - the cleartext manifest placeholder forced on for release builds
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
  const begin = original.indexOf(GRADLE_BEGIN);
  let gradle;
  if (begin === -1) {
    gradle = original.replace(/\s*$/, "\n\n") + GRADLE_BLOCK;
  } else {
    const end = original.indexOf(GRADLE_END, begin);
    if (end === -1) {
      throw new Error(`${path} has the ukacell start marker but no end marker; fix it by hand`);
    }
    const afterEnd = original.indexOf("\n", end);
    gradle = original.slice(0, begin) + GRADLE_BLOCK + (afterEnd === -1 ? "" : original.slice(afterEnd + 1));
  }
  if (!new RegExp(`^${PROPERTIES_IMPORT.replace(/\./g, "\\.")}\\s*$`, "m").test(gradle)) {
    gradle = `${PROPERTIES_IMPORT}\n${gradle}`;
  }
  if (gradle !== original) {
    writeFileSync(path, gradle);
    return ["release signing + cleartext block"];
  }
  return [];
}

function main() {
  const { androidDir } = parseArgs(process.argv.slice(2));
  const manifestPath = join(androidDir, "app", "src", "main", "AndroidManifest.xml");
  const gradlePath = join(androidDir, "app", "build.gradle.kts");

  for (const path of [manifestPath, gradlePath]) {
    if (!existsSync(path)) {
      console.error(`Not found: ${path}`);
      console.error("Run `npm run android:init` (tauri android init) in apps/host first.");
      process.exit(1);
    }
  }

  const changes = [...patchManifest(manifestPath), ...patchGradle(gradlePath)];
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
