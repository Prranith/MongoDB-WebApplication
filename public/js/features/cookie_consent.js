(() => {
  window.addEventListener('DOMContentLoaded', () => {
    if (localStorage.getItem('codeleaf-cookie-consent')) return;
    const banner = document.createElement('div');
    banner.className = 'cookie-consent';
    banner.innerHTML = '<span>CodeLeaf uses a secure session cookie to keep you signed in across visits.</span><button type="button">Allow</button>';
    banner.querySelector('button').onclick = () => { localStorage.setItem('codeleaf-cookie-consent', '1'); banner.remove(); };
    document.body.appendChild(banner);
  });
})();
