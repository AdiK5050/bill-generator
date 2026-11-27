// Apply the theme chosen in the app (Settings > Appearance) before the page paints.
// Same key as js/settings.js. A classic script, so it runs before first paint.
(function () {
  try {
    const theme = localStorage.getItem('theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  } catch {
    /* storage blocked: follow the device setting */
  }
})();
