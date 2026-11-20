// Ukacell theme: "system" (default), "dark" or "light".
// Loaded synchronously in <head> so the right theme is applied before first paint.
(function () {
  "use strict";

  var KEY = "ukacell.theme";
  var COLORS = { dark: "#171615", light: "#f6f5f2" };
  var media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function preference() {
    try {
      var value = localStorage.getItem(KEY);
      return value === "dark" || value === "light" ? value : "system";
    } catch (error) {
      return "system";
    }
  }

  function resolve(pref) {
    if (pref !== "system") return pref;
    return media && !media.matches ? "light" : "dark";
  }

  function apply() {
    var pref = preference();
    var theme = resolve(pref);
    var root = document.documentElement;
    root.setAttribute("data-theme", theme);
    root.setAttribute("data-theme-pref", pref);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", COLORS[theme]);
  }

  function notify() {
    document.dispatchEvent(new CustomEvent("ukacell:themechange"));
  }

  window.UkacellTheme = {
    preference: preference,
    current: function () {
      return resolve(preference());
    },
    set: function (pref) {
      try {
        if (pref === "system") localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, pref);
      } catch (error) {
        // Storage unavailable: the choice lasts for this page only.
      }
      apply();
      notify();
    },
  };

  if (media) {
    var onSystemChange = function () {
      if (preference() === "system") {
        apply();
        notify();
      }
    };
    if (media.addEventListener) media.addEventListener("change", onSystemChange);
    else if (media.addListener) media.addListener(onSystemChange);
  }

  apply();
})();
