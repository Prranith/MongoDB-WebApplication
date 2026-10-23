/* CodeLeaf application authentication UI. */
const Auth = (() => {
  const state = { user: null, required: false, action: null, mode: 'signin' };
  const $ = id => document.getElementById(id);

  function overlay() { return $('auth-overlay'); }
  function setMessage(message, error = false) {
    const target = $('auth-message');
    if (target) { target.textContent = message || ''; target.classList.toggle('error', error); }
  }

  function setMode(mode) {
    if (mode === 'verify') {
      state.mode = 'verify';
      $('auth-title').textContent = 'Verify your email';
      $('auth-subtitle').textContent = 'One last step to secure your CodeLeaf account.';
      $('auth-email-heading').textContent = 'Enter the 6-digit code we sent to your email';
      $('auth-name-field').hidden = true;
      $('auth-otp-field').hidden = false;
      const password = $('auth-password');
      password.closest('.auth-field').hidden = true;
      password.required = false;
      $('auth-submit').textContent = 'Verify email';
      $('auth-submit').onclick = verifyEmail;
      $('auth-mode-toggle').textContent = 'Resend code';
      $('auth-mode-toggle').onclick = resendVerification;
      return;
    }
    state.mode = mode === 'signup' ? 'signup' : 'signin';
    const signup = state.mode === 'signup';
    const title = $('auth-title');
    const nameField = $('auth-name-field');
    const nameInput = $('auth-name');
    const otpField = $('auth-otp-field');
    const passwordField = $('auth-password')?.closest('.auth-field');
    const submit = $('auth-submit');
    const toggle = $('auth-mode-toggle');
    if (title) title.textContent = signup ? 'Create your CodeLeaf account' : 'Sign in to CodeLeaf';
    const subtitle = $('auth-subtitle');
    const emailHeading = $('auth-email-heading');
    if (subtitle) subtitle.textContent = signup ? 'One secure account for your workspace, exams, and meetings.' : 'Welcome back. Sign in to continue securely.';
    if (emailHeading) emailHeading.textContent = signup ? 'Create your secure CodeLeaf account' : 'Sign in with your CodeLeaf email';
    if (nameField) nameField.hidden = !signup;
    if (otpField) otpField.hidden = true;
    if (passwordField) passwordField.hidden = false;
    if ($('auth-password')) $('auth-password').required = true;
    if (nameInput) {
      nameInput.required = signup;
      nameInput.disabled = !signup;
      if (!signup) nameInput.value = '';
    }
    if (submit) {
      submit.textContent = signup ? 'Create account' : 'Sign in';
      submit.onclick = signup ? register : login;
    }
    if (toggle) {
      toggle.textContent = signup ? 'Use sign in' : 'Create account';
      toggle.onclick = () => setMode(signup ? 'signin' : 'signup');
    }
  }

  function open(action, mode = 'signin') {
    state.action = action || null;
    setMode(mode);
    const node = overlay();
    if (node) { node.hidden = false; document.body.classList.add('auth-open'); }
    window.WorkspaceAIAssistant?.syncLauncherVisibility?.();
    setMessage('');
    $('auth-email')?.focus();
  }

  function close() {
    const node = overlay();
    if (node) { node.hidden = true; document.body.classList.remove('auth-open'); }
    window.WorkspaceAIAssistant?.syncLauncherVisibility?.();
  }

  function renderAccount() {
    const wrap = $('auth-account-wrap');
    const button = $('auth-account-button');
    const avatar = $('auth-account-avatar');
    const name = $('auth-account-name');
    const email = $('auth-account-email');
    if (!button || !wrap) return;
    wrap.hidden = !state.user;
    if (state.user) {
      const displayName = state.user.name || state.user.email?.split('@')[0] || 'Account';
      // Keep the account control visually consistent for every user. The
      // profile details belong in the popover, not inside the avatar button.
      if (avatar) avatar.innerHTML = '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M12 12a4.2 4.2 0 1 0 0-8.4A4.2 4.2 0 0 0 12 12Zm0 2.1c-4.05 0-7.35 2.1-7.35 4.7 0 .66.54 1.2 1.2 1.2h12.3c.66 0 1.2-.54 1.2-1.2 0-2.6-3.3-4.7-7.35-4.7Z"/></svg>';
      if (name) name.textContent = displayName;
      if (email) email.textContent = state.user.email || '';
      button.title = state.user.email || '';
    }
  }

  function openProfile() {
    if (!state.user) return open();
    const modal = $('profile-modal');
    if (!modal) return;
    $('profile-name').value = state.user.name || '';
    $('profile-email').value = state.user.email || '';
    $('profile-college').value = state.user.college || '';
    $('profile-linkedin').value = state.user.linkedin || '';
    $('profile-bio').value = state.user.bio || '';
    $('profile-phone').value = state.user.phone || '';
    $('profile-avatar').src = state.user.avatar || 'assets/branding/codeleaf-emblem.png?v=20261019-auth';
    $('profile-avatar-data').value = state.user.avatar || '';
    $('profile-links').innerHTML = '';
    (state.user.links || []).forEach(link => addProfileLink(link.label, link.url));
    modal.hidden = false;
    modal.style.display = 'grid';
    document.body.classList.add('profile-open');
  }
  function addProfileLink(label = '', url = '') {
    const row = document.createElement('div'); row.className = 'profile-link-row';
    row.innerHTML = `<input class="profile-link-label" placeholder="LinkedIn / GitHub / LeetCode" value="${String(label).replace(/"/g, '&quot;')}"><input class="profile-link-url" placeholder="https://..." value="${String(url).replace(/"/g, '&quot;')}"><button type="button" aria-label="Remove link">×</button>`;
    row.querySelector('button').onclick = () => row.remove(); $('profile-links').appendChild(row);
  }
  function readProfileLinks() { return [...document.querySelectorAll('.profile-link-row')].map(row => ({ label: row.querySelector('.profile-link-label').value, url: row.querySelector('.profile-link-url').value })).filter(x => x.url); }
  function chooseAvatar(event) { const file = event.target.files?.[0]; if (!file || !file.type.startsWith('image/')) return; if (file.size > 1000000) return setMessage('Profile photo must be smaller than 1 MB.', true); const reader = new FileReader(); reader.onload = () => { $('profile-avatar').src = reader.result; $('profile-avatar-data').value = reader.result; }; reader.readAsDataURL(file); }
  async function searchProfiles() {
    const query = $('profile-search-query').value.trim(); const target = $('profile-search-results');
    if (query.length < 2) { target.textContent = 'Type at least 2 characters.'; return; }
    target.textContent = 'Searching…';
    const response = await fetch(`/api/auth/search?q=${encodeURIComponent(query)}`, { credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    target.innerHTML = (data.users || []).map(user => `<div class="profile-search-result"><strong>${user.name || 'CodeLeaf member'}</strong><span>${user.college || user.bio || 'CodeLeaf member'}</span></div>`).join('') || 'No matching profiles found.';
  }
  function closeProfile() { const modal = $('profile-modal'); if (modal) { modal.hidden = true; modal.style.display = 'none'; } document.body.classList.remove('profile-open'); }
  async function saveProfile() {
    const response = await fetch('/api/auth/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ name: $('profile-name').value, phone: $('profile-phone').value, college: $('profile-college').value, bio: $('profile-bio').value, avatar: $('profile-avatar-data').value, links: readProfileLinks() }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Unable to save profile.');
    state.user = data.user; renderAccount(); closeProfile();
    window.dispatchEvent(new CustomEvent('codeleaf:auth-changed', { detail: state.user }));
  }

  async function request(path, payload) {
    const response = await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Authentication request failed.');
    return data;
  }

  function completed(data) {
    state.user = data.user || null;
    renderAccount();
    window.dispatchEvent(new CustomEvent('codeleaf:auth-changed', { detail: state.user }));
    close();
    setMessage('');
    if (state.action) { const action = state.action; state.action = null; action(); }
  }

  async function login() {
    if (!validate('signin')) return;
    try {
      setMessage('Signing you in…');
      completed(await request('/api/auth/login', { email: $('auth-email')?.value, password: $('auth-password')?.value }));
    } catch (error) { setMessage(error.message, true); }
  }

  async function register() {
    if (!validate('signup')) return;
    try {
      setMessage('Creating your secure account…');
      const data = await request('/api/auth/register', { name: $('auth-name')?.value, email: $('auth-email')?.value, password: $('auth-password')?.value });
      if (data.verificationRequired) {
        setMode('verify');
        setMessage('We sent a verification code to your email.');
        $('auth-otp')?.focus();
        return;
      }
      completed(data);
    } catch (error) { setMessage(error.message, true); }
  }

  async function verifyEmail() {
    const email = $('auth-email')?.value.trim();
    const code = $('auth-otp')?.value.trim();
    if (!email || !/^\d{6}$/.test(code || '')) { setMessage('Enter the 6-digit verification code.', true); return; }
    try { completed(await request('/api/auth/verify-email', { email, code })); }
    catch (error) { setMessage(error.message, true); }
  }

  async function resendVerification() {
    try { await request('/api/auth/resend-verification', { email: $('auth-email')?.value }); setMessage('A new verification code was sent.'); }
    catch (error) { setMessage(error.message, true); }
  }

  function validate(mode) {
    const email = $('auth-email')?.value.trim();
    const password = $('auth-password')?.value || '';
    const name = $('auth-name')?.value.trim();
    if (!email || !password || (mode === 'signup' && !name)) {
      setMessage(mode === 'signup' ? 'Enter your name, email, and password.' : 'Enter your email and password.', true);
      return false;
    }
    if (mode === 'signup' && password.length < 10) {
      setMessage('Password must contain at least 10 characters.', true);
      return false;
    }
    return true;
  }

  async function signOut() {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } finally {
      state.user = null;
      const popover = $('auth-profile-popover');
      const button = $('auth-account-button');
      if (popover) popover.hidden = true;
      if (button) button.setAttribute('aria-expanded', 'false');
      renderAccount();
      window.dispatchEvent(new CustomEvent('codeleaf:auth-changed', { detail: null }));
      if (typeof showView === 'function') showView('intro');
    }
  }

  function accountAction() {
    if (state.user) return openProfile();
    fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' })
      .then(response => response.json())
      .then(data => { state.user = data.user || null; renderAccount(); state.user ? openProfile() : open(); })
      .catch(() => open());
  }

  async function init() {
    try {
      const response = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json();
      state.user = data.user || null;
      state.required = !!data.required;
      renderAccount();
      window.dispatchEvent(new CustomEvent('codeleaf:auth-changed', { detail: state.user }));
      const accountPopover = $('auth-profile-popover');
      const accountButton = $('auth-account-button');
      accountButton?.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); accountAction(); });
      document.addEventListener('click', event => {
        const wrap = $('auth-account-wrap');
        const popover = $('auth-profile-popover');
        const button = $('auth-account-button');
        if (wrap && popover && !wrap.contains(event.target)) {
          popover.hidden = true;
          button?.setAttribute('aria-expanded', 'false');
        }
      });
      if (new URLSearchParams(location.search).get('auth') === 'error') open();
    } catch (_) { /* The app remains usable until an authenticated API is needed. */ }
  }

  return {
    init, open, close, login, register, signOut, accountAction, openProfile, closeProfile, saveProfile, addProfileLink, chooseAvatar, searchProfiles, setMode,
    require(action) { if (state.user) return action(); open(action); },
    get user() { return state.user; },
  };
})();

window.Auth = Auth;

document.addEventListener('DOMContentLoaded', () => Auth.init());
