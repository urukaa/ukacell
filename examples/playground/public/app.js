// Ukacell playground: one button per plugin. Everything goes through the
// globals the host injects (withGlobalTauri), so no bundler or npm packages.
(function () {
  "use strict";

  const T = window.__TAURI__;
  const logList = document.getElementById("log");
  let torchOn = false;

  function show(label, value, isError) {
    const item = document.createElement("li");
    if (isError) item.className = "error";
    const title = document.createElement("span");
    title.className = "label";
    title.textContent = `${new Date().toLocaleTimeString()}  ${label}`;
    const body = document.createElement("span");
    body.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    item.append(title, body);
    logList.prepend(item);
  }

  function errorText(error) {
    if (!error) return "Unknown error";
    if (typeof error === "string") return error;
    return error.message || JSON.stringify(error);
  }

  function need(namespace) {
    if (!T) throw new Error("window.__TAURI__ is missing: open this page inside Ukacell");
    if (!T[namespace]) throw new Error(`window.__TAURI__.${namespace} is not available in this host build`);
    return T[namespace];
  }

  const TESTS = [
    {
      title: "Device info",
      about: "os + app",
      actions: {
        Read: async () => {
          const os = need("os");
          return {
            platform: await os.platform(),
            version: await os.version(),
            arch: await os.arch(),
            locale: await os.locale(),
            hostVersion: await need("app").getVersion(),
          };
        },
      },
    },
    {
      title: "Haptics",
      about: "vibration and feedback",
      actions: {
        Vibrate: async () => need("haptics").vibrate(300),
        Impact: async () => need("haptics").impactFeedback("heavy"),
        Success: async () => need("haptics").notificationFeedback("success"),
      },
    },
    {
      title: "Dialog",
      about: "native message and ask",
      actions: {
        Message: async () => need("dialog").message("Hello from the Ukacell playground!", { title: "Ukacell" }),
        Ask: async () => ({ answer: await need("dialog").ask("Is the native dialog working?", { title: "Question" }) }),
      },
    },
    {
      title: "Notification",
      about: "local notification",
      actions: {
        Send: async () => {
          const notification = need("notification");
          let granted = await notification.isPermissionGranted();
          if (!granted) granted = (await notification.requestPermission()) === "granted";
          if (!granted) throw new Error("Notification permission denied");
          notification.sendNotification({ title: "Ukacell playground", body: "Local notifications work 🎉" });
          return "sent";
        },
      },
    },
    {
      title: "Clipboard",
      about: "write then read text",
      actions: {
        "Copy & read": async () => {
          const clipboard = need("clipboardManager");
          const text = `Ukacell ${new Date().toISOString()}`;
          await clipboard.writeText(text);
          return { wrote: text, read: await clipboard.readText() };
        },
      },
    },
    {
      title: "Geolocation",
      about: "current GPS position",
      actions: {
        Locate: async () => {
          const geo = need("geolocation");
          let permissions = await geo.checkPermissions();
          if (permissions.location !== "granted") {
            permissions = await geo.requestPermissions(["location"]);
          }
          if (permissions.location !== "granted") throw new Error("Location permission denied");
          const position = await geo.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
          const { latitude, longitude, accuracy } = position.coords;
          return { latitude, longitude, accuracyMeters: Math.round(accuracy) };
        },
      },
    },
    {
      title: "Biometric",
      about: "fingerprint / face",
      actions: {
        Status: async () => need("biometric").checkStatus(),
        Authenticate: async () => {
          await need("biometric").authenticate("Confirm it's you", { allowDeviceCredential: true });
          return "authenticated";
        },
      },
    },
    {
      title: "Torch",
      about: "community plugin, via invoke",
      actions: {
        Toggle: async () => {
          const result = await need("core").invoke("plugin:torch|toggle", { payload: { value: !torchOn } });
          torchOn = Boolean(result && result.value);
          return { torchOn };
        },
      },
    },
    {
      title: "Barcode scanner",
      about: "full-screen camera scan",
      actions: {
        Scan: async () => {
          const scanner = need("barcodeScanner");
          let state = await scanner.checkPermissions();
          if (state !== "granted") state = await scanner.requestPermissions();
          if (state !== "granted") throw new Error("Camera permission denied");
          const result = await scanner.scan({ windowed: false, formats: [scanner.Format.QRCode] });
          return { content: result.content, format: result.format };
        },
      },
    },
    {
      title: "Store",
      about: "persistent JSON counter",
      actions: {
        "+1": async () => {
          const store = await need("store").load("playground.json");
          const count = ((await store.get("count")) || 0) + 1;
          await store.set("count", count);
          await store.save();
          return { count };
        },
      },
    },
    {
      title: "SQLite",
      about: "insert + count rows",
      actions: {
        Insert: async () => {
          const db = await need("sql").load("sqlite:playground.db");
          await db.execute("CREATE TABLE IF NOT EXISTS visits (id INTEGER PRIMARY KEY, at TEXT NOT NULL)");
          await db.execute("INSERT INTO visits (at) VALUES ($1)", [new Date().toISOString()]);
          const rows = await db.select("SELECT COUNT(*) AS total FROM visits");
          return { totalVisits: rows[0].total };
        },
      },
    },
    {
      title: "HTTP",
      about: "native fetch, no CORS",
      actions: {
        Fetch: async () => {
          const response = await need("http").fetch("https://api.github.com/zen");
          return { status: response.status, body: await response.text() };
        },
      },
    },
  ];

  function render() {
    const container = document.getElementById("tests");
    for (const test of TESTS) {
      const card = document.createElement("section");
      card.className = "card";
      const heading = document.createElement("h2");
      heading.textContent = test.title;
      const about = document.createElement("p");
      about.textContent = test.about;
      const actions = document.createElement("div");
      actions.className = "actions";

      for (const [label, run] of Object.entries(test.actions)) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.addEventListener("click", async () => {
          button.disabled = true;
          const name = `${test.title} → ${label}`;
          try {
            let result = await run();
            // Some plugins (haptics) wrap results as { status: "ok", data } or
            // { status: "error", error } instead of resolving/rejecting directly.
            if (result && typeof result === "object" && "status" in result) {
              if (result.status === "error") throw result.error;
              if (result.status === "ok") result = result.data;
            }
            show(name, result === undefined || result === null ? "ok" : result, false);
          } catch (error) {
            show(name, errorText(error), true);
          } finally {
            button.disabled = false;
          }
        });
        actions.appendChild(button);
      }

      card.append(heading, about, actions);
      container.appendChild(card);
    }
  }

  document.getElementById("clear-log").addEventListener("click", () => logList.replaceChildren());
  document.getElementById("no-tauri").hidden = Boolean(T);
  render();
  show("Ready", T ? `Running inside Ukacell at ${location.origin}` : "Plain browser: native calls will fail", !T);
})();
