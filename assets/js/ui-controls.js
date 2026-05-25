(function () {
  "use strict";

  var THEME_KEY = "knomosis-theme";
  var THEME_COLORS = { light: "#e6ece8", dark: "#262d29" };

  /* Apply a theme to the document. `persist` records an explicit user choice in
     localStorage; system-driven and initial-sync updates must NOT persist, or
     the site would stop following the OS preference after the first change. */
  function applyTheme(theme, persist) {
    var root = document.documentElement;
    root.setAttribute("data-theme", theme);

    var meta = document.getElementById("theme-color-meta");
    if (meta) meta.setAttribute("content", THEME_COLORS[theme] || THEME_COLORS.dark);

    if (persist) {
      try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
    }
  }

  function currentTheme() {
    var root = document.documentElement;
    var theme = root.getAttribute("data-theme");
    return theme === "light" || theme === "dark" ? theme : "dark";
  }

  function setupTheme() {
    /* theme-init.js has already set data-theme before paint; sync the
       theme-color meta to it (without persisting) so the browser chrome
       matches the active theme on first render. */
    applyTheme(currentTheme(), false);

    var themeToggle = document.getElementById("theme-toggle");
    if (themeToggle) {
      themeToggle.addEventListener("click", function () {
        applyTheme(currentTheme() === "dark" ? "light" : "dark", true);
      });
    }

    /* Follow the OS preference until the user explicitly toggles. Applying
       without persisting keeps this responsive to every subsequent change. */
    if (window.matchMedia) {
      var mq = window.matchMedia("(prefers-color-scheme: light)");
      var onChange = function (e) {
        var saved = null;
        try { saved = localStorage.getItem(THEME_KEY); } catch (err) {}
        if (!saved) applyTheme(e.matches ? "light" : "dark", false);
      };
      if (mq.addEventListener) mq.addEventListener("change", onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  }

  setupTheme();
})();
