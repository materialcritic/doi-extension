// Shared across popup/options/author/collaborators pages. Included as the
// first script in <head> (blocking, no defer) so it can hide <html> before
// paint and avoid a theme flash while chrome.storage resolves.
(function () {
  document.documentElement.style.visibility = "hidden";

  const LIGHT_THEMES = ["parchment", "slate", "sage", "minimal", "carrot"];

  function apply(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.style.visibility = "";
    document.querySelectorAll("[data-theme-icon]").forEach((el) => {
      el.textContent = theme === "dark" ? "☀" : "🌙";
    });
    document.querySelectorAll("[data-theme-select]").forEach((el) => {
      el.value = theme;
    });
  }

  chrome.storage.sync.get({ theme: "dark", lightTheme: "parchment" }, (items) => apply(items.theme));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.theme) apply(changes.theme.newValue);
  });

  // Quick toggle button: flips between dark and whichever light theme was
  // last picked from the Settings dropdown (defaults to parchment).
  window.toggleTheme = function () {
    chrome.storage.sync.get({ theme: "dark", lightTheme: "parchment" }, (items) => {
      chrome.storage.sync.set({ theme: items.theme === "dark" ? items.lightTheme : "dark" });
    });
  };

  // Settings dropdown: sets the active theme directly, and remembers it as
  // the light theme to toggle back to if it's a light variant.
  window.setTheme = function (theme) {
    const patch = { theme };
    if (LIGHT_THEMES.includes(theme)) patch.lightTheme = theme;
    chrome.storage.sync.set(patch);
  };
})();
