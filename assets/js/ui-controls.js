(function () {
  "use strict";

  var THEME_KEY = "sele4n-theme";
  var BG_ANIMATION_KEY = "sele4n-bg-animation-paused-v1";

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

  function setupBackgroundAnimationToggle() {
    var button = document.getElementById("bg-animation-toggle");
    if (!button) return;

    function readPausedState() {
      try { return localStorage.getItem(BG_ANIMATION_KEY) === "1"; }
      catch (e) { return false; }
    }

    function applyState(paused) {
      button.classList.toggle("is-paused", paused);
      button.setAttribute("aria-pressed", paused ? "true" : "false");
      var label = paused ? "Resume background animation" : "Pause background animation";
      button.setAttribute("aria-label", label);
      button.title = label;
      document.documentElement.setAttribute("data-bg-animation", paused ? "paused" : "running");
      window.dispatchEvent(new CustomEvent("sele4n:bg-animation-toggle", { detail: { paused: paused } }));
    }

    applyState(readPausedState());

    button.addEventListener("click", function () {
      var nextPaused = button.getAttribute("aria-pressed") !== "true";
      try { localStorage.setItem(BG_ANIMATION_KEY, nextPaused ? "1" : "0"); } catch (e) {}
      applyState(nextPaused);
    });

    window.addEventListener("storage", function (event) {
      if (!event || event.key !== BG_ANIMATION_KEY) return;
      applyState(readPausedState());
    });
  }

  setupTheme();
  setupBackgroundAnimationToggle();
})();
