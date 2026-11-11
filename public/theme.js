(function () {
  var root = document.documentElement;
  try {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) root.setAttribute('data-theme', 'light');
  } catch {}
  function wire() {
    var button = document.getElementById('themetoggle');
    function sync() {
      var light = root.getAttribute('data-theme') === 'light';
      button.textContent = light ? 'Dark mode' : 'Light mode';
      button.setAttribute('aria-pressed', light ? 'true' : 'false');
    }
    button.addEventListener('click', function () {
      if (root.getAttribute('data-theme') === 'light') root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', 'light');
      sync();
    });
    sync();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
