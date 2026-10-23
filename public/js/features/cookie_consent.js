(() => {
  window.addEventListener('DOMContentLoaded', () => {
    if (localStorage.getItem('codeleaf-cookie-consent')) return;
    const banner = document.createElement('div');
    banner.className = 'cookie-consent';
    banner.innerHTML = '<div class="cookie-consent-copy">We use essential cookies to keep your CodeLeaf session secure and keep you signed in across visits.</div><div class="cookie-consent-actions"><button type="button" class="cookie-decline">Decline</button><button type="button" class="cookie-accept">Accept</button></div>';
    const close = value => { localStorage.setItem('codeleaf-cookie-consent', value); banner.remove(); };
    banner.querySelector('.cookie-accept').onclick = () => close('accepted');
    banner.querySelector('.cookie-decline').onclick = () => close('declined');
    document.body.appendChild(banner);
  });
})();
