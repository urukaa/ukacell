// Ukacell floating dev menu.
//
// Injected by src/lib.rs (`on_page_load`) into every page that is not the
// launcher. The HOME_URL placeholder below is replaced with a JSON string
// literal before injection. Everything lives in a closed-over scope and a shadow root
// so it never collides with the developer's own code or styles.
(function () {
  "use strict";

  if (window.__UKACELL_DEV_MENU__) {
    return;
  }
  window.__UKACELL_DEV_MENU__ = true;

  var HOME_URL = __UKACELL_HOME_URL__;
  var HOST_ID = "ukacell-dev-menu";
  var POSITION_KEY = "ukacell.devMenu.top";
  var EDGE_GAP = 8;

  var ICON_GRIP =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 9h8"/><path d="M8 15h8"/></svg>';
  var ICON_RELOAD =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.35-5.65"/><path d="M20 4v5h-5"/></svg>';
  var ICON_HOME =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11.5 12 5l8 6.5"/><path d="M6.5 10v9h11v-9"/><path d="M10.5 19v-4.5h3V19"/></svg>';

  // Ukacell launcher palette (warm neutrals); follows the phone's light/dark setting.
  var CSS =
    ":host{all:initial;--pill-bg:rgba(35,33,32,.9);--pill-line:#3b3733;--pill-ink:#eeebe6;--pill-ink-2:#85807a;--pill-press:rgba(238,235,230,.14)}" +
    "@media (prefers-color-scheme: light){:host{--pill-bg:rgba(255,255,255,.92);--pill-line:#dedad3;--pill-ink:#1c1b19;--pill-ink-2:#8f8a83;--pill-press:rgba(28,27,25,.08)}}" +
    ".pill{display:flex;flex-direction:column;align-items:center;gap:2px;padding:4px;" +
    "border-radius:16px;background:var(--pill-bg);border:1px solid var(--pill-line);" +
    "box-shadow:0 10px 28px rgba(0,0,0,.28);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);" +
    "opacity:.6;transition:opacity .2s ease;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}" +
    ".pill:hover,.pill:focus-within,.pill.active{opacity:1}" +
    ".grip{display:flex;align-items:center;justify-content:center;width:40px;height:18px;" +
    "color:var(--pill-ink-2);cursor:grab;touch-action:none}" +
    ".grip:active{cursor:grabbing}" +
    ".btn{all:unset;box-sizing:border-box;display:flex;align-items:center;justify-content:center;" +
    "width:40px;height:40px;border-radius:12px;color:var(--pill-ink);cursor:pointer;-webkit-tap-highlight-color:transparent}" +
    ".btn:active{background:var(--pill-press)}" +
    ".btn:focus-visible{outline:2px solid #38bdf8;outline-offset:1px}" +
    "svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}";

  function readSavedTop() {
    try {
      var saved = parseInt(window.sessionStorage.getItem(POSITION_KEY), 10);
      return isNaN(saved) ? null : saved;
    } catch (error) {
      return null;
    }
  }

  function saveTop(top) {
    try {
      window.sessionStorage.setItem(POSITION_KEY, String(Math.round(top)));
    } catch (error) {
      // Storage can be unavailable (private mode, sandboxed frames); the menu still works.
    }
  }

  function clampTop(top, height) {
    var max = Math.max(EDGE_GAP, window.innerHeight - height - EDGE_GAP);
    return Math.min(Math.max(top, EDGE_GAP), max);
  }

  function createMenu() {
    var host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText =
      "all:initial;position:fixed;z-index:2147483647;right:10px;top:" +
      Math.round(window.innerHeight * 0.6) +
      "px;";

    var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    root.innerHTML =
      "<style>" +
      CSS +
      "</style>" +
      '<div class="pill" role="toolbar" aria-label="Ukacell dev menu">' +
      '<span class="grip" title="Drag to move">' +
      ICON_GRIP +
      "</span>" +
      '<button type="button" class="btn" data-action="reload" title="Reload page" aria-label="Reload page">' +
      ICON_RELOAD +
      "</button>" +
      '<button type="button" class="btn" data-action="home" title="Disconnect and go home" aria-label="Disconnect and return to Ukacell">' +
      ICON_HOME +
      "</button>" +
      "</div>";

    var pill = root.querySelector(".pill");
    var grip = root.querySelector(".grip");
    var fadeTimer = null;

    function flashActive() {
      pill.classList.add("active");
      clearTimeout(fadeTimer);
      fadeTimer = setTimeout(function () {
        pill.classList.remove("active");
      }, 2500);
    }

    root.querySelector('[data-action="reload"]').addEventListener("click", function () {
      flashActive();
      window.location.reload();
    });

    root.querySelector('[data-action="home"]').addEventListener("click", function () {
      flashActive();
      // replace() so the hardware back button does not return to the dev server.
      window.location.replace(HOME_URL);
    });

    var dragStartY = 0;
    var dragStartTop = 0;
    var dragging = false;

    grip.addEventListener("pointerdown", function (event) {
      dragging = true;
      dragStartY = event.clientY;
      dragStartTop = host.getBoundingClientRect().top;
      flashActive();
      if (grip.setPointerCapture) {
        grip.setPointerCapture(event.pointerId);
      }
      event.preventDefault();
    });

    grip.addEventListener("pointermove", function (event) {
      if (!dragging) {
        return;
      }
      var top = clampTop(dragStartTop + (event.clientY - dragStartY), host.offsetHeight);
      host.style.top = top + "px";
    });

    function endDrag() {
      if (!dragging) {
        return;
      }
      dragging = false;
      saveTop(host.getBoundingClientRect().top);
    }

    grip.addEventListener("pointerup", endDrag);
    grip.addEventListener("pointercancel", endDrag);

    window.addEventListener("resize", function () {
      host.style.top = clampTop(host.getBoundingClientRect().top, host.offsetHeight) + "px";
    });

    return host;
  }

  var menu = null;

  function attach() {
    if (!document.body) {
      return false;
    }
    if (!menu) {
      menu = createMenu();
    }
    if (!menu.isConnected) {
      document.body.appendChild(menu);
      var saved = readSavedTop();
      var top = saved === null ? menu.getBoundingClientRect().top : saved;
      menu.style.top = clampTop(top, menu.offsetHeight) + "px";
    }
    return true;
  }

  function keepAttached() {
    // Single-page apps sometimes replace <body> or wipe its children; put the
    // menu back whenever that happens.
    var observer = new MutationObserver(function () {
      if (!menu || !menu.isConnected) {
        attach();
      }
      if (document.body) {
        // Re-observing a node only refreshes its options, so this also covers a swapped <body>.
        observer.observe(document.body, { childList: true });
      }
    });
    observer.observe(document.documentElement, { childList: true });
    if (document.body) {
      observer.observe(document.body, { childList: true });
    }
  }

  function start() {
    if (attach()) {
      keepAttached();
    } else {
      document.addEventListener(
        "DOMContentLoaded",
        function () {
          attach();
          keepAttached();
        },
        { once: true }
      );
    }
  }

  start();
})();
