#!/usr/bin/env node
// ukacell: print a QR code for your LAN dev server so the Ukacell host app
// on your phone can open it.
//
//   npx ukacell                 # http://<lan-ip>:5173
//   npx ukacell 3000            # custom port
//   npx ukacell --port 3000
//   npx ukacell --run           # also runs `npm run dev -- --host`
//   npx ukacell --run -- --mode staging   # extra args for the dev script

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { join } from "node:path";
import process from "node:process";

import pc from "picocolors";
import qrcode from "qrcode-terminal";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const DEFAULT_PORT = 5173;
const DEV_SERVER_WAIT_MS = 90_000;
const PORT_POLL_MS = 400;

// Interfaces that are almost never the phone-facing Wi-Fi/LAN adapter.
const VIRTUAL_INTERFACE =
  /(vethernet|virtualbox|vmware|vbox|docker|podman|br-|veth|virbr|wsl|hyper-v|loopback|utun|tailscale|zerotier|wireguard|^wg\d|^tun|^tap|vpn|hamachi|awdl|llw|bridge)/i;
const PHYSICAL_INTERFACE = /^(wi-?fi|wlan|wlp|wl|en|eth|ethernet)/i;

class UsageError extends Error {}

/* Arguments ---------------------------------------------------------------- */

const HELP = `
${pc.bold("ukacell")} ${pc.dim(`v${pkg.version}`)}: open your Tauri v2 frontend in the Ukacell app

${pc.bold("Usage")}
  npx ukacell [port] [options] [-- <dev script args>]

${pc.bold("Options")}
  -p, --port <port>   Port of your dev server (default ${DEFAULT_PORT})
  -r, --run           Start the dev server with ${pc.cyan("npm run dev -- --host")}
      --host <ip>     Use this address instead of the detected LAN IPv4
  -v, --version       Print the version
  -h, --help          Show this help

${pc.bold("Examples")}
  npx ukacell                    QR code for http://<lan-ip>:5173
  npx ukacell 3000               QR code for port 3000
  npx ukacell --run              run the dev server, then show the QR code
  npx ukacell 3000 --run -- --port 3000
                                  run the dev server on port 3000 (args after
                                  -- go to the dev script; Vite syntax shown)
`;

function parsePort(value, flag) {
  if (value === undefined || value === "") {
    throw new UsageError(`${flag} needs a value, for example ${flag} 5173`);
  }
  if (!/^\d+$/.test(value)) {
    throw new UsageError(`"${value}" is not a valid port number`);
  }
  const port = Number(value);
  if (port < 1 || port > 65535) {
    throw new UsageError(`Port ${port} is out of range (1-65535)`);
  }
  return port;
}

function requireValue(value, flag) {
  if (value === undefined || value === "" || value.startsWith("-")) {
    throw new UsageError(`${flag} needs a value`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    port: DEFAULT_PORT,
    run: false,
    host: null,
    help: false,
    version: false,
    devArgs: [],
  };
  let positionalPortSeen = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      options.devArgs = argv.slice(i + 1);
      break;
    } else if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "-v" || arg === "--version") {
      options.version = true;
    } else if (arg === "-r" || arg === "--run") {
      options.run = true;
    } else if (arg === "-p" || arg === "--port") {
      options.port = parsePort(argv[i + 1], arg);
      i += 1;
    } else if (arg.startsWith("--port=")) {
      options.port = parsePort(arg.slice("--port=".length), "--port");
    } else if (arg === "--host") {
      options.host = requireValue(argv[i + 1], arg);
      i += 1;
    } else if (arg.startsWith("--host=")) {
      options.host = requireValue(arg.slice("--host=".length), "--host");
    } else if (/^\d+$/.test(arg) && !positionalPortSeen) {
      options.port = parsePort(arg, "port");
      positionalPortSeen = true;
    } else {
      throw new UsageError(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

/* Network ------------------------------------------------------------------ */

function isPrivateIPv4(address) {
  const [a, b] = address.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// Mirrors `remote.urls` in apps/host/src-tauri/capabilities/remote-dev.json:
// every private IPv4 range (192.168/16, 10/8, 172.16/12).
function isTrustedByHost(address) {
  return /^(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}$/.test(address);
}

function scoreInterface(name, address) {
  let score = 0;
  if (isPrivateIPv4(address)) score += 10;
  if (isTrustedByHost(address)) score += 5;
  if (address.startsWith("192.168.")) score += 1;
  if (PHYSICAL_INTERFACE.test(name)) score += 3;
  if (VIRTUAL_INTERFACE.test(name)) score -= 30;
  return score;
}

function lanAddresses() {
  const found = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      // Node 18.0-18.3 reported `family` as the number 4.
      const isIPv4 = entry.family === "IPv4" || entry.family === 4;
      if (!isIPv4 || entry.internal || entry.address.startsWith("169.254.")) continue;
      found.push({ name, address: entry.address, score: scoreInterface(name, entry.address) });
    }
  }
  return found.sort((a, b) => b.score - a.score);
}

function canConnect(port, host, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function isListening(port, lanHost) {
  for (const host of [lanHost, "127.0.0.1", "::1"]) {
    if (host && (await canConnect(port, host, 700))) return true;
  }
  return false;
}

async function waitForPort(port, lanHost, timeoutMs, shouldStop) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shouldStop()) return false;
    if (await isListening(port, lanHost)) return true;
    await new Promise((resolve) => setTimeout(resolve, PORT_POLL_MS));
  }
  return false;
}

/* Output ------------------------------------------------------------------- */

function renderQr(text) {
  return new Promise((resolve) => {
    qrcode.generate(text, { small: true }, (code) => resolve(code));
  });
}

function indent(text, spaces = 2) {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line ? pad + line : line))
    .join("\n");
}

async function printBanner({ url, port, chosen, others, listening }) {
  const lines = [
    "",
    `  ${pc.bgCyan(pc.black(pc.bold(" ukacell ")))} ${pc.dim(`v${pkg.version}`)}`,
    "",
    `  ${pc.dim("Local:  ")} ${pc.cyan(`http://localhost:${port}`)}`,
    `  ${pc.dim("Network:")} ${pc.bold(pc.cyan(url))}${chosen ? pc.dim(`  (${chosen})`) : ""}`,
  ];
  for (const other of others) {
    lines.push(`  ${pc.dim("         ")} ${pc.dim(`http://${other.address}:${port}  (${other.name})`)}`);
  }
  lines.push("", `  Scan with the ${pc.bold("Ukacell")} app:`, "");
  console.log(lines.join("\n"));
  console.log(indent(await renderQr(url)));

  const notes = [`  ${pc.dim("Phone and computer must be on the same Wi-Fi network.")}`];
  if (!listening) {
    notes.push(
      `  ${pc.yellow("!")} Nothing is answering on port ${port} yet. Start your dev server with`,
      `    ${pc.cyan("npm run dev -- --host")} or let ukacell do it: ${pc.cyan("npx ukacell --run")}`
    );
  }
  const host = new URL(url).hostname;
  if (host !== "localhost" && host !== "127.0.0.1" && !isTrustedByHost(host)) {
    notes.push(
      `  ${pc.yellow("!")} ${host} is not a private LAN address, which the Ukacell host requires.`,
      "    The page will load, but native plugin calls will be rejected."
    );
  }
  console.log(notes.join("\n") + "\n");
}

/* Dev server --------------------------------------------------------------- */

function quoteForCmd(arg) {
  return /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function startDevServer(extraArgs) {
  const packageJson = join(process.cwd(), "package.json");
  if (!existsSync(packageJson)) {
    throw new UsageError(`--run needs a package.json in ${process.cwd()}`);
  }
  const scripts = JSON.parse(readFileSync(packageJson, "utf8")).scripts ?? {};
  if (!scripts.dev) {
    throw new UsageError(`--run needs a "dev" script in ${packageJson}`);
  }

  const args = ["run", "dev", "--", "--host", ...extraArgs];
  console.log(pc.dim(`\n  > npm ${args.join(" ")}\n`));

  // npm is a .cmd shim on Windows, which Node only runs through a shell.
  return process.platform === "win32"
    ? spawn(["npm", ...args].map(quoteForCmd).join(" "), { stdio: "inherit", shell: true })
    : spawn("npm", args, { stdio: "inherit" });
}

/* Main --------------------------------------------------------------------- */

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(HELP);
    return;
  }
  if (options.version) {
    console.log(pkg.version);
    return;
  }

  const candidates = lanAddresses();
  let chosen;
  if (options.host) {
    chosen = { name: "--host", address: options.host };
  } else if (candidates.length > 0) {
    chosen = candidates[0];
  } else {
    console.error(
      `\n  ${pc.red("✖")} No LAN IPv4 address found. Connect this computer to Wi-Fi or Ethernet,` +
        `\n    or pass one explicitly: ${pc.cyan("npx ukacell --host 192.168.1.20")}\n`
    );
    process.exitCode = 1;
    return;
  }

  const url = `http://${chosen.address}:${options.port}`;
  const others = options.host ? [] : candidates.slice(1, 4);

  if (!options.run) {
    const listening = await isListening(options.port, chosen.address);
    await printBanner({ url, port: options.port, chosen: chosen.name, others, listening });
    return;
  }

  const child = startDevServer(options.devArgs);
  let childExited = false;
  let interrupted = false;

  child.on("error", (error) => {
    console.error(`\n  ${pc.red("✖")} Could not start the dev server: ${error.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    childExited = true;
    process.exit(code ?? (signal ? 1 : 0));
  });

  // Ctrl+C (SIGINT) already reaches the dev server through the shared
  // terminal, so just wait for it to shut down cleanly. SIGTERM is only sent
  // to ukacell, so pass it on. A second signal forces ukacell out.
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (interrupted) process.exit(130);
      interrupted = true;
      if (signal === "SIGTERM" && !childExited) child.kill(signal);
    });
  }

  const ready = await waitForPort(
    options.port,
    chosen.address,
    DEV_SERVER_WAIT_MS,
    () => childExited || interrupted
  );
  if (childExited || interrupted) return;

  if (!ready) {
    console.log(
      `\n  ${pc.yellow("!")} The dev server did not open port ${options.port} within ` +
        `${DEV_SERVER_WAIT_MS / 1000}s. If it picked another port, run ukacell with --port.`
    );
  }
  await printBanner({ url, port: options.port, chosen: chosen.name, others, listening: ready });
}

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(`\n  ${pc.red("✖")} ${error.message}\n  Run ${pc.cyan("npx ukacell --help")} for usage.\n`);
  } else {
    console.error(error);
  }
  process.exit(1);
});
