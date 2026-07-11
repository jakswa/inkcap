(function () {
  var input = document.querySelector('[data-browser-timezone]');
  if (!input || !window.Intl) return;
  try {
    var zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone) input.value = zone;
  } catch (_) {}
})();
