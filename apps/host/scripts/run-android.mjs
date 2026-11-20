#!/usr/bin/env node
// Builds a debug APK of the Ukacell host, installs it on the connected Android
// device or emulator, launches it and streams its log.
//
// Why not `tauri android dev`? In dev mode on mobile, Tauri always proxies
// the app's assets from a dev server on the computer. The launcher is plain
// static files, so a debug *build* (assets embedded in the APK) is simpler and
// never depends on the phone reaching the computer over the network.
//
// Usage: node scripts/run-android.mjs [--target aarch64|armv7|i686|x86_64] [--device <serial>] [--no-logcat]
//   --target   ABI to build (default aarch64, the ABI of almost every phone;
//              use x86_64 for the Android Studio emulator)

import { spawnSync, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ID = "dev.ukacell.host";
const TARGETS = ["aarch64", "armv7", "i686", "x86_64"];

const hostDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apkRoot = join(hostDir, "src-tauri", "gen", "android", "app", "build", "outputs", "apk");
const isWindows = process.platform === "win32";

function parseArgs(argv) {
  const options = { target: "aarch64", device: null, logcat: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--target" && argv[i + 1]) {
      options.target = argv[i + 1];
      i += 1;
    } else if (arg === "--device" && argv[i + 1]) {
      options.device = argv[i + 1];
      i += 1;
    } else if (arg === "--no-logcat") {
      options.logcat = false;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/run-android.mjs [--target aarch64|armv7|i686|x86_64] [--device <serial>] [--no-logcat]");
      process.exit(0);
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }
  if (!TARGETS.includes(options.target)) {
    fail(`--target must be one of ${TARGETS.join(", ")}`);
  }
  return options;
}

function fail(message) {
  console.error(`\nrun-android: ${message}\n`);
  process.exit(1);
}

function step(message) {
  console.log(`\n> ${message}`);
}

// npm puts node_modules/.bin on PATH for scripts; on Windows the tauri and
// adb shims need a shell to resolve .cmd/.exe.
function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: hostDir,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    shell: isWindows,
  });
  if (result.error) {
    fail(`could not run ${command}: ${result.error.message}`);
  }
  return result;
}

function adbArgs(options, args) {
  return options.device ? ["-s", options.device, ...args] : args;
}

function connectedDevices() {
  const result = run("adb", ["devices"], { capture: true });
  if (result.status !== 0) {
    fail("`adb devices` failed. Is the Android SDK platform-tools folder on PATH?");
  }
  return result.stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state);
}

function newestApk(dir) {
  let newest = null;
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const info = statSync(path);
      if (info.isDirectory()) {
        walk(path);
      } else if (name.endsWith(".apk") && /[\\/]debug[\\/]/.test(path)) {
        if (!newest || info.mtimeMs > newest.mtimeMs) newest = { path, mtimeMs: info.mtimeMs };
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return newest && newest.path;
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  step("Checking for a connected device");
  const devices = connectedDevices();
  const ready = devices.filter(([, state]) => state === "device");
  if (devices.some(([, state]) => state === "unauthorized")) {
    fail("A device is connected but unauthorized. Unlock the phone and accept the 'Allow USB debugging?' prompt.");
  }
  if (ready.length === 0) {
    fail("No device found. Connect the phone with USB debugging on, or start an emulator (then use --target x86_64).");
  }
  if (ready.length > 1 && !options.device) {
    fail(`Several devices are connected (${ready.map(([s]) => s).join(", ")}). Pick one with --device <serial>.`);
  }
  console.log(`  using ${options.device ?? ready[0][0]}`);

  step("Patching the Android project");
  if (run("node", ["scripts/patch-android.mjs"]).status !== 0) fail("patch-android.mjs failed");

  step(`Building a debug APK for ${options.target} (assets embedded, no dev server)`);
  const buildStartedAt = Date.now();
  const build = run("tauri", ["android", "build", "--debug", "--apk", "--target", options.target]);
  if (build.status !== 0) fail("tauri android build failed (see the output above)");

  const apk = newestApk(apkRoot);
  if (!apk || statSync(apk).mtimeMs < buildStartedAt - 1000) {
    fail(`could not find the freshly built debug APK under ${apkRoot}`);
  }

  step(`Installing ${apk}`);
  if (run("adb", adbArgs(options, ["install", "-r", apk])).status !== 0) {
    fail("adb install failed. If it mentions INSTALL_FAILED_UPDATE_INCOMPATIBLE, uninstall Ukacell from the phone first.");
  }

  step("Launching Ukacell");
  run("adb", adbArgs(options, ["shell", "am", "force-stop", APP_ID]));
  if (run("adb", adbArgs(options, ["shell", "monkey", "-p", APP_ID, "-c", "android.intent.category.LAUNCHER", "1"]), { capture: true }).status !== 0) {
    fail("could not launch the app");
  }

  if (!options.logcat) return;

  let pid = "";
  for (let attempt = 0; attempt < 20 && !pid; attempt += 1) {
    await sleep(500);
    pid = (run("adb", adbArgs(options, ["shell", "pidof", "-s", APP_ID]), { capture: true }).stdout || "").trim();
  }
  if (!pid) {
    console.log("\nUkacell is installed, but its process was not found for logging.");
    return;
  }

  step(`Streaming logs for pid ${pid} (Ctrl+C to stop; the app keeps running)`);
  const logcat = spawn("adb", adbArgs(options, ["logcat", "--pid", pid, "-v", "time", "Tauri/Console:V", "RustStdoutStderr:V", "AndroidRuntime:E", "*:S"]), {
    stdio: "inherit",
    shell: isWindows,
  });
  logcat.on("exit", (code) => process.exit(code ?? 0));
}

main();
