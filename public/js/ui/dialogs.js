// Unified in-app alert surface. This keeps informational errors and notices
// inside CodeLeaf instead of opening browser-native alert dialogs.
(function () {
  'use strict';

  const overlay = () => document.getElementById('app-alert-overlay');
  const title = () => document.getElementById('app-alert-title');
  const message = () => document.getElementById('app-alert-message');
  const ok = () => document.getElementById('app-alert-ok');

  function showAppAlert(text, heading) {
    const root = overlay();
    if (!root) return;
    if (title()) title().textContent = heading || 'CodeLeaf';
    if (message()) message().textContent = String(text || '');
    root.hidden = false;
    document.body.classList.add('app-alert-open');
    const close = () => {
      root.hidden = true;
      document.body.classList.remove('app-alert-open');
    };
    if (ok()) {
      ok().onclick = close;
      ok().focus();
    }
    root.onclick = (event) => {
      if (event.target === root) close();
    };
  }

  window.showAppAlert = showAppAlert;
  window.alert = showAppAlert;

  document.addEventListener('keydown', (event) => {
    const root = overlay();
    if (!root || root.hidden) return;
    if (event.key === 'Escape' || event.key === 'Enter') {
      event.preventDefault();
      if (ok()) ok().click();
    }
  });
})();
