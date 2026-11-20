// Ukacell launcher. Plain script, no bundler: plugin APIs come from
// `window.__TAURI__`, injected because `app.withGlobalTauri` is true.
// Theme handling lives in theme.js (loaded first, exposes window.UkacellTheme).
(function () {
  "use strict";

  const TAURI = window.__TAURI__ || null;
  const Theme = window.UkacellTheme;

  const HISTORY_KEY = "ukacell.history.v1";
  const HISTORY_LIMIT = 5;
  const HANDLED_DEEP_LINK_KEY = "ukacell.handledDeepLink";
  const SPLASH_SHOWN_KEY = "ukacell.splashShown";
  const REACHABILITY_TIMEOUT_MS = 4000;
  const STATUS_TIMEOUT_MS = 2500;
  const TOAST_DURATION_MS = 3800;
  const SOURCE_URL = "https://github.com/urukaa/ukacell";

  // Keep in sync with src-tauri/Cargo.toml and the README plugin table.
  const PLUGINS = [
    { name: "Barcode scanner", js: "barcodeScanner", version: "2.5.3", group: "Hardware", icon: "i-qr-cam", mobileOnly: true },
    { name: "Biometric", js: "biometric", version: "2.5.0", group: "Hardware", icon: "i-finger", mobileOnly: true },
    { name: "Geolocation", js: "geolocation", version: "2.5.0", group: "Hardware", icon: "i-pin", mobileOnly: true },
    { name: "Haptics", js: "haptics", version: "2.4.2", group: "Hardware", icon: "i-vibrate", mobileOnly: true },
    { name: "NFC", js: "nfc", version: "2.4.2", group: "Hardware", icon: "i-nfc", mobileOnly: true },
    { name: "Torch", js: null, invoke: "plugin:torch|toggle", version: "0.1.0", group: "Hardware", icon: "i-torch", mobileOnly: true, community: true },
    { name: "File system", js: "fs", version: "2.7.1", group: "Storage", icon: "i-folder" },
    { name: "Store", js: "store", version: "2.5.1", group: "Storage", icon: "i-box" },
    { name: "SQL", js: "sql", version: "2.6.0", group: "Storage", icon: "i-db", note: "SQLite" },
    { name: "Stronghold", js: "stronghold", version: "2.4.0", group: "Storage", icon: "i-lock", optional: true },
    { name: "Notification", js: "notification", version: "2.8.1", group: "System", icon: "i-bell" },
    { name: "Dialog", js: "dialog", version: "2.8.4", group: "System", icon: "i-message" },
    { name: "Clipboard", js: "clipboardManager", version: "2.5.0", group: "System", icon: "i-clipboard" },
    { name: "Opener", js: "opener", version: "2.7.3", group: "System", icon: "i-open" },
    { name: "Deep link", js: "deepLink", version: "2.6.3", group: "System", icon: "i-link" },
    { name: "OS", js: "os", version: "2.4.0", group: "System", icon: "i-cpu" },
    { name: "Log", js: "log", version: "2.10.2", group: "System", icon: "i-terminal" },
    { name: "HTTP", js: "http", version: "2.9.0", group: "Network", icon: "i-globe" },
    { name: "WebSocket", js: "websocket", version: "2.5.0", group: "Network", icon: "i-wave" },
    { name: "Upload", js: "upload", version: "2.5.0", group: "Network", icon: "i-upload" },
  ];
  const GROUPS = ["Hardware", "Storage", "System", "Network"];

  // Default dev-server ports: a best guess at what is running there.
  const FRAMEWORKS = {
    5173: ["Vite", "#6d5bd0"],
    5174: ["Vite", "#6d5bd0"],
    4173: ["Vite preview", "#6d5bd0"],
    1420: ["Tauri + Vite", "#c2692d"],
    3000: ["Next.js", "#52525b"],
    3001: ["Next.js", "#52525b"],
    4200: ["Angular", "#b5473a"],
    4321: ["Astro", "#8b4fc8"],
    8080: ["Vue / webpack", "#3f8f6a"],
    8081: ["Metro", "#52525b"],
    1234: ["Parcel", "#a3842a"],
    6006: ["Storybook", "#c2417a"],
    9000: ["Quasar", "#2b7fb8"],
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    views: Array.from(document.querySelectorAll(".view")),
    form: $("url-form"),
    input: $("url-input"),
    actionBtn: $("action-btn"),
    actionIcon: $("action-icon"),
    urlError: $("url-error"),
    historyList: $("history-list"),
    historyEmpty: $("history-empty"),
    recentCount: $("recent-count"),
    clearHistory: $("clear-history"),
    themeToggle: $("theme-toggle"),
    themeToggleIcon: $("theme-toggle-icon"),
    themeOptions: Array.from(document.querySelectorAll("[data-theme-option]")),
    apisSummary: $("apis-summary"),
    settingsClear: $("settings-clear-history"),
    aboutVersion: $("about-version"),
    aboutTauri: $("about-tauri"),
    openSource: $("open-source"),
    apiSearch: $("api-search"),
    apiFilters: $("api-filters"),
    apiGroups: $("api-groups"),
    scanOverlay: $("scan-overlay"),
    cancelScan: $("cancel-scan"),
    confirmSheet: $("confirm-sheet"),
    confirmTitle: $("confirm-title"),
    confirmMessage: $("confirm-message"),
    confirmOk: $("confirm-ok"),
    toast: $("toast"),
  };

  const isMobileDevice =
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const scanner = TAURI && TAURI.barcodeScanner && isMobileDevice ? TAURI.barcodeScanner : null;

  /* Helpers ----------------------------------------------------------------- */

  function messageOf(error) {
    if (!error) return "Unknown error";
    if (typeof error === "string") return error;
    return error.message || String(error);
  }

  function svgUse(symbolId, className) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", className || "i");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS(ns, "use");
    use.setAttribute("href", "#" + symbolId);
    svg.appendChild(use);
    return svg;
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  let toastTimer = null;
  function showToast(message, isError) {
    el.toast.textContent = message;
    el.toast.classList.toggle("error", Boolean(isError));
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.hidden = true;
    }, TOAST_DURATION_MS);
  }

  function relativeTime(timestamp) {
    const seconds = Math.round((Date.now() - timestamp) / 1000);
    if (seconds < 60) return "just now";
    const units = [
      ["y", 31536000],
      ["mo", 2592000],
      ["d", 86400],
      ["h", 3600],
      ["m", 60],
    ];
    for (const [unit, size] of units) {
      if (seconds >= size) return Math.floor(seconds / size) + unit + " ago";
    }
    return "just now";
  }

  /* URLs -------------------------------------------------------------------- */

  // `ukacell://open?url=http%3A%2F%2F192.168.1.20%3A5173` -> "http://192.168.1.20:5173"
  function serverFromDeepLink(value) {
    if (!/^ukacell:\/\//i.test(value)) return null;
    try {
      return new URL(value).searchParams.get("url");
    } catch (error) {
      return null;
    }
  }

  function normalizeServerUrl(raw) {
    let value = String(raw || "").trim();
    if (!value) throw new Error("Enter the address of your dev server.");
    const fromDeepLink = serverFromDeepLink(value);
    if (fromDeepLink) value = fromDeepLink.trim();
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = "http://" + value;
    let url;
    try {
      url = new URL(value);
    } catch (error) {
      throw new Error("That doesn't look like an address. Try something like 192.168.1.20:5173.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Only http:// and https:// addresses can be opened.");
    }
    if (!url.hostname) throw new Error("The address is missing a host name.");
    return url;
  }

  // Mirrors `remote.urls` in src-tauri/capabilities/remote-dev.json.
  function isTrustedDevOrigin(url) {
    if (url.protocol !== "http:") return false;
    const host = url.hostname;
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)
    );
  }

  function frameworkFor(url) {
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    const [label, color] = FRAMEWORKS[port] || ["Dev server", "#6b6560"];
    return { label, color };
  }

  async function isReachable(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await fetch(url.href, { mode: "no-cors", cache: "no-store", signal: controller.signal });
      return true;
    } catch (error) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /* History ------------------------------------------------------------------- */

  function loadHistory() {
    try {
      const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((entry) => entry && typeof entry.url === "string" && typeof entry.openedAt === "number")
        .slice(0, HISTORY_LIMIT);
    } catch (error) {
      return [];
    }
  }

  function saveHistory(entries) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, HISTORY_LIMIT)));
    } catch (error) {
      showToast("Could not save history: storage is unavailable.", true);
    }
  }

  function rememberServer(href) {
    const entries = loadHistory().filter((entry) => entry.url !== href);
    entries.unshift({ url: href, openedAt: Date.now() });
    saveHistory(entries);
  }

  function forgetServer(href) {
    saveHistory(loadHistory().filter((entry) => entry.url !== href));
    renderHistory();
  }

  const statusCache = new Map(); // href -> { online, checkedAt }

  function setBadge(badge, url) {
    if (!isTrustedDevOrigin(url)) {
      badge.className = "badge warn";
      badge.textContent = "No APIs";
      badge.title = "Outside the trusted dev ranges: native APIs are disabled";
      return;
    }
    const cached = statusCache.get(url.href);
    const fresh = cached && Date.now() - cached.checkedAt < 10000;
    if (fresh) {
      badge.className = cached.online ? "badge ok" : "badge";
      badge.textContent = cached.online ? "Online" : "Offline";
      return;
    }
    badge.className = "badge";
    badge.textContent = "…";
    isReachable(url, STATUS_TIMEOUT_MS).then((online) => {
      statusCache.set(url.href, { online, checkedAt: Date.now() });
      badge.className = online ? "badge ok" : "badge";
      badge.textContent = online ? "Online" : "Offline";
    });
  }

  function renderHistory() {
    const entries = loadHistory();
    el.historyList.replaceChildren();
    el.historyEmpty.hidden = entries.length > 0;
    el.clearHistory.hidden = entries.length === 0;
    el.recentCount.textContent = entries.length ? "(" + entries.length + ")" : "";

    for (const entry of entries) {
      let url;
      try {
        url = new URL(entry.url);
      } catch (error) {
        continue;
      }
      const framework = frameworkFor(url);

      const item = node("li");
      const row = node("button", "row");
      row.type = "button";
      row.setAttribute("aria-label", "Open " + url.host);

      const avatar = node("span", "avatar", framework.label.charAt(0));
      avatar.style.background = framework.color;

      const text = node("span", "row-text");
      text.append(node("b", "", url.host), node("small", "", framework.label + " · " + relativeTime(entry.openedAt)));

      const badge = node("span", "badge");
      setBadge(badge, url);

      row.append(avatar, text, badge);
      row.addEventListener("click", () => connect(url));
      // Long-press (context menu) removes the entry.
      row.addEventListener("contextmenu", async (event) => {
        event.preventDefault();
        if (await askConfirm("Remove from recent?", url.host, "Remove")) forgetServer(entry.url);
      });

      item.appendChild(row);
      el.historyList.appendChild(item);
    }
  }

  /* Confirm sheet -------------------------------------------------------------- */

  let resolveConfirm = null;
  let lastFocus = null;

  function askConfirm(title, message, okLabel) {
    lastFocus = document.activeElement;
    el.confirmTitle.textContent = title;
    el.confirmMessage.textContent = message;
    el.confirmOk.textContent = okLabel;
    el.confirmSheet.hidden = false;
    el.confirmOk.focus();
    return new Promise((resolve) => {
      resolveConfirm = resolve;
    });
  }

  function settleConfirm(value) {
    if (!resolveConfirm) return;
    const resolve = resolveConfirm;
    resolveConfirm = null;
    el.confirmSheet.hidden = true;
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
    resolve(value);
  }

  /* Connecting ------------------------------------------------------------------ */

  let connecting = false;

  function updateActionButton() {
    const typing = el.input.value.trim().length > 0;
    const scanMode = !typing && Boolean(scanner);
    el.actionIcon.setAttribute("href", scanMode ? "#i-scan" : "#i-arrow");
    el.actionBtn.setAttribute("aria-label", scanMode ? "Scan QR code" : "Connect");
    el.actionBtn.title = scanMode ? "Scan QR code" : "Connect";
  }

  function setBusy(busy) {
    el.actionBtn.disabled = busy;
  }

  async function connect(url) {
    if (connecting) return;
    connecting = true;
    setBusy(true);
    try {
      if (!isTrustedDevOrigin(url)) {
        const proceed = await askConfirm(
          "Native APIs will be off",
          url.host +
            " is not a local dev address (localhost or a private LAN IP over http).\n\n" +
            "The page will load, but every window.__TAURI__ call will be rejected.",
          "Open anyway"
        );
        if (!proceed) return;
      } else if (!(await isReachable(url, REACHABILITY_TIMEOUT_MS))) {
        const proceed = await askConfirm(
          "Can't reach " + url.host,
          "No response within " +
            REACHABILITY_TIMEOUT_MS / 1000 +
            " seconds. Check that:\n" +
            "• the dev server runs with --host (npx ukacell --run does this)\n" +
            "• the phone and the computer are on the same Wi-Fi\n" +
            "• the computer's firewall allows port " +
            (url.port || "80"),
          "Try anyway"
        );
        if (!proceed) return;
      }
      rememberServer(url.href);
      window.location.href = url.href;
    } finally {
      connecting = false;
      setBusy(false);
    }
  }

  function showUrlError(message) {
    el.urlError.textContent = message;
    el.urlError.hidden = !message;
    el.input.closest(".field").classList.toggle("invalid", Boolean(message));
  }

  /* Scanner --------------------------------------------------------------------- */

  let scanning = false;

  function setScanning(active) {
    scanning = active;
    document.documentElement.classList.toggle("scanning", active);
    document.body.classList.toggle("scanning", active);
    el.scanOverlay.hidden = !active;
  }

  async function ensureCameraPermission() {
    let state = await scanner.checkPermissions();
    if (state === "prompt" || state === "prompt-with-rationale") state = await scanner.requestPermissions();
    return state === "granted";
  }

  async function startScan() {
    if (!scanner) {
      showToast("QR scanning needs the Android or iOS build.", true);
      return;
    }
    if (scanning || connecting) return;
    try {
      if (!(await ensureCameraPermission())) {
        showToast("Camera access is off. Allow it for Ukacell in system settings.", true);
        return;
      }
      setScanning(true);
      const result = await scanner.scan({ windowed: true, formats: [scanner.Format.QRCode] });
      setScanning(false);
      const content = result && typeof result.content === "string" ? result.content : "";
      if (!content) return;
      let url;
      try {
        url = normalizeServerUrl(content);
      } catch (error) {
        showToast("That QR code doesn't contain a server address.", true);
        return;
      }
      await connect(url);
    } catch (error) {
      setScanning(false);
      if (!/cancel/i.test(messageOf(error))) showToast("Scan failed: " + messageOf(error), true);
    }
  }

  async function cancelScan() {
    try {
      await scanner.cancel();
    } catch (error) {
      // Nothing to cancel; the overlay closes below either way.
    }
    setScanning(false);
  }

  /* Deep links ------------------------------------------------------------------- */

  function handleDeepLinks(urls) {
    if (!Array.isArray(urls)) return;
    for (const raw of urls) {
      const link = String(raw);
      const target = serverFromDeepLink(link);
      if (!target) continue;
      // getCurrent() keeps returning the launch link for the whole session;
      // act on it once so "Home" doesn't bounce straight back.
      try {
        if (sessionStorage.getItem(HANDLED_DEEP_LINK_KEY) === link) return;
        sessionStorage.setItem(HANDLED_DEEP_LINK_KEY, link);
      } catch (error) {
        // Without sessionStorage the link is simply handled again.
      }
      try {
        connect(normalizeServerUrl(target));
      } catch (error) {
        showToast("Ignored deep link: " + messageOf(error), true);
      }
      return;
    }
  }

  async function initDeepLinks() {
    const deepLink = TAURI && TAURI.deepLink;
    if (!deepLink) return;
    try {
      handleDeepLinks(await deepLink.getCurrent());
    } catch (error) {
      // Not launched from a link.
    }
    try {
      await deepLink.onOpenUrl((urls) => {
        try {
          sessionStorage.removeItem(HANDLED_DEEP_LINK_KEY);
        } catch (error) {
          // ignore
        }
        handleDeepLinks(urls);
      });
    } catch (error) {
      // Deep links unavailable on this platform.
    }
  }

  /* Theme ------------------------------------------------------------------------- */

  function renderTheme() {
    const current = Theme.current();
    const pref = Theme.preference();
    el.themeToggleIcon.setAttribute("href", current === "dark" ? "#i-sun" : "#i-moon");
    el.themeToggle.setAttribute("aria-label", current === "dark" ? "Switch to light theme" : "Switch to dark theme");
    for (const option of el.themeOptions) {
      option.setAttribute("aria-checked", String(option.dataset.themeOption === pref));
    }
  }

  /* Native APIs ------------------------------------------------------------------- */

  let apiFilter = "All";

  function pluginStatus(plugin) {
    if (plugin.optional && TAURI && plugin.js && !(plugin.js in TAURI)) return { label: "Not in build", ok: false };
    if (plugin.mobileOnly && !isMobileDevice) return { label: "Mobile only", ok: false };
    return { label: "Ready", ok: true };
  }

  function renderApiSummary() {
    const ready = PLUGINS.filter((plugin) => pluginStatus(plugin).ok).length;
    el.apisSummary.textContent = ready + " of " + PLUGINS.length + " ready";
  }

  function renderApiFilters() {
    el.apiFilters.replaceChildren();
    for (const name of ["All"].concat(GROUPS)) {
      const button = node("button", "", name === "All" ? "All " + PLUGINS.length : name);
      button.type = "button";
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(apiFilter === name));
      button.addEventListener("click", () => {
        apiFilter = name;
        renderApiFilters();
        renderApis();
      });
      el.apiFilters.appendChild(button);
    }
  }

  function renderApis() {
    const query = el.apiSearch.value.trim().toLowerCase();
    el.apiGroups.replaceChildren();
    let shown = 0;
    for (const group of GROUPS) {
      if (apiFilter !== "All" && apiFilter !== group) continue;
      const plugins = PLUGINS.filter(
        (plugin) =>
          plugin.group === group &&
          (!query || (plugin.name + " " + (plugin.js || "") + " " + (plugin.note || "")).toLowerCase().includes(query))
      );
      if (plugins.length === 0) continue;
      shown += plugins.length;

      const section = node("section", "api-group");
      section.appendChild(node("h2", "group-title", group + " (" + plugins.length + ")"));
      for (const plugin of plugins) {
        const status = pluginStatus(plugin);
        const row = node("div", "api-row" + (status.ok ? "" : " missing"));
        const tile = node("span", "tile");
        tile.appendChild(svgUse(plugin.icon));
        const text = node("span", "row-text");
        const meta = [plugin.js || plugin.invoke, plugin.version];
        if (plugin.note) meta.push(plugin.note);
        if (plugin.community) meta.push("community");
        text.append(node("b", "", plugin.name), node("small", "", meta.join(" · ")));
        const badge = node("span", status.ok ? "badge ok" : "badge", status.label);
        row.append(tile, text, badge);
        section.appendChild(row);
      }
      el.apiGroups.appendChild(section);
    }
    if (shown === 0) el.apiGroups.appendChild(node("p", "no-results", "No API matches “" + query + "”."));
  }

  /* Views ----------------------------------------------------------------------------- */

  function currentView() {
    const hash = location.hash.replace(/^#/, "");
    return hash === "settings" || hash === "apis" ? hash : "home";
  }

  function route() {
    const view = currentView();
    for (const section of el.views) section.hidden = section.dataset.view !== view;
    if (view === "home") renderHistory();
    if (view === "apis") {
      renderApiFilters();
      renderApis();
    }
    window.scrollTo(0, 0);
  }

  /* Opening animation -------------------------------------------------------------- */

  // Plays once per app launch: a phone divides from the laptop like a cell,
  // then locks into the Ukacell mark. Going "Home" from a dev app skips it.
  function playSplash() {
    const splash = $("splash");
    let alreadyShown = false;
    try {
      alreadyShown = sessionStorage.getItem(SPLASH_SHOWN_KEY) === "1";
      sessionStorage.setItem(SPLASH_SHOWN_KEY, "1");
    } catch (error) {
      // No sessionStorage: show it every time, which is harmless.
    }
    const reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const divide = $("splash-divide");
    if (alreadyShown || reducedMotion || currentView() !== "home" || !divide || typeof divide.beginElement !== "function") {
      splash.remove();
      return;
    }
    splash.hidden = false;
    const at = (ms, fn) => setTimeout(fn, ms);
    at(250, () => divide.beginElement());
    at(1250, () => {
      $("splash-goo-out").beginElement();
      $("splash-lock").beginElement();
    });
    at(1900, () => splash.classList.add("out"));
    at(2300, () => splash.remove());
  }

  /* About -------------------------------------------------------------------------- */

  async function renderAbout() {
    if (!TAURI || !TAURI.app) return;
    try {
      el.aboutVersion.textContent = await TAURI.app.getVersion();
      el.aboutTauri.textContent = await TAURI.app.getTauriVersion();
    } catch (error) {
      // Keep the static fallback.
    }
  }

  async function openSource() {
    try {
      if (TAURI && TAURI.opener) await TAURI.opener.openUrl(SOURCE_URL);
      else window.open(SOURCE_URL, "_blank");
    } catch (error) {
      showToast("Could not open the browser: " + messageOf(error), true);
    }
  }

  async function clearAllHistory() {
    if (loadHistory().length === 0) {
      showToast("No recent servers to clear.");
      return;
    }
    if (await askConfirm("Clear recent servers?", "The last 5 addresses will be removed from this phone.", "Clear")) {
      saveHistory([]);
      renderHistory();
      showToast("Recent servers cleared.");
    }
  }

  /* Wiring ---------------------------------------------------------------------------- */

  function wireEvents() {
    el.form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = el.input.value.trim();
      if (!value) {
        if (scanner) startScan();
        else showUrlError("Enter the address of your dev server.");
        return;
      }
      let url;
      try {
        url = normalizeServerUrl(value);
      } catch (error) {
        showUrlError(messageOf(error));
        return;
      }
      showUrlError("");
      el.input.blur();
      connect(url);
    });
    el.input.addEventListener("input", () => {
      showUrlError("");
      updateActionButton();
    });

    el.clearHistory.addEventListener("click", clearAllHistory);
    el.settingsClear.addEventListener("click", clearAllHistory);
    el.openSource.addEventListener("click", openSource);
    el.cancelScan.addEventListener("click", cancelScan);

    el.themeToggle.addEventListener("click", () => Theme.set(Theme.current() === "dark" ? "light" : "dark"));
    for (const option of el.themeOptions) {
      option.addEventListener("click", () => Theme.set(option.dataset.themeOption));
    }
    document.addEventListener("ukacell:themechange", renderTheme);

    el.apiSearch.addEventListener("input", renderApis);

    // In-app back buttons return through history so the Android back button
    // and the on-screen one behave the same.
    document.querySelectorAll(".back").forEach((link) => {
      link.addEventListener("click", (event) => {
        if (history.length > 1) {
          event.preventDefault();
          history.back();
        }
      });
    });

    el.confirmSheet.querySelectorAll("[data-confirm]").forEach((button) => {
      button.addEventListener("click", () => settleConfirm(button.getAttribute("data-confirm") === "ok"));
    });

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (scanning) cancelScan();
      else if (!el.confirmSheet.hidden) settleConfirm(false);
    });

    window.addEventListener("hashchange", route);

    // Returning with the back button can restore this page from cache.
    window.addEventListener("pageshow", () => {
      setScanning(false);
      setBusy(false);
      connecting = false;
      statusCache.clear();
      if (currentView() === "home") renderHistory();
    });
  }

  function init() {
    playSplash();
    renderTheme();
    updateActionButton();
    renderApiSummary();
    wireEvents();
    route();
    renderAbout();
    initDeepLinks();
  }

  init();
})();
