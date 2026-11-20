# ukacell

Prints a QR code for your local dev server so the **Ukacell** app can open
your Tauri v2 frontend on a phone, with 20 native plugins ready to call.

```bash
npx ukacell            # QR code for http://<your-lan-ip>:5173
npx ukacell 3000       # another port
npx ukacell --run      # run `npm run dev -- --host` first, then show the QR code
```

## Options

| Option | Description |
| --- | --- |
| `[port]`, `-p, --port <port>` | Port of your dev server. Default `5173`. |
| `-r, --run` | Starts `npm run dev -- --host` in a child process, waits for the port to open, then prints the QR code. Ctrl+C stops both. |
| `--host <ip>` | Use this address instead of the detected LAN IPv4. |
| `-- <args>` | With `--run`, extra arguments for your dev script, for example `npx ukacell 3000 --run -- --port 3000`. |
| `-v, --version` | Print the version. |
| `-h, --help` | Show help. |

## How the address is picked

ukacell lists every non-internal IPv4 interface and ranks them: private
ranges first (`192.168.x.x`, `10.x.x.x`, `172.16-31.x.x`, the ones the Ukacell
host trusts), physical Wi-Fi/Ethernet adapters above
virtual ones (WSL, Hyper-V, Docker, VirtualBox, VPNs). The best match goes in
the QR code and up to three alternatives are printed below it. If the wrong
one wins, pass `--host`.

## Dev server checklist

- Listen on all interfaces, not just localhost: `vite --host`,
  `next dev -H 0.0.0.0`, and so on. `--run` adds `--host` for you.
- Phone and computer on the same Wi-Fi.
- Allow the port through your computer's firewall.

Requires Node.js 18.18 or newer. MIT licensed.
