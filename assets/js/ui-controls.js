(function () {
  "use strict";

  var THEME_KEY = "knomosis-theme";

  function setTheme(theme) {
    var root = document.documentElement;
    var themeColorMeta = document.getElementById("theme-color-meta");

    root.setAttribute("data-theme", theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}

    if (themeColorMeta) {
      themeColorMeta.setAttribute("content", theme === "light" ? "#f8f9fc" : "#080c15");
    }
  }

  function setupTheme() {
    var root = document.documentElement;
    var themeToggle = document.getElementById("theme-toggle");
    if (!root.getAttribute("data-theme")) setTheme("dark");

    if (themeToggle) {
      themeToggle.addEventListener("click", function () {
        var current = root.getAttribute("data-theme") || "dark";
        setTheme(current === "dark" ? "light" : "dark");
      });
    }

    if (window.matchMedia) {
      var mq = window.matchMedia("(prefers-color-scheme: light)");
      var onChange = function (e) {
        var saved = null;
        try { saved = localStorage.getItem(THEME_KEY); } catch (err) {}
        if (!saved) setTheme(e.matches ? "light" : "dark");
      };
      if (mq.addEventListener) mq.addEventListener("change", onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  }

  setupTheme();
})();
