// Applies the theme before first paint. A classic script, so it runs while the head is parsed; src/ui/theme.ts keeps
// the same key up to date when the user changes the setting.
(function () {
  // Dark unless the person chose otherwise, as Command Center is.
  var pref = 'dark';
  try {
    pref = localStorage.getItem('nb.theme') || 'dark';
  } catch (e) {
    // Storage unavailable: dark.
  }
  var dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
})();
