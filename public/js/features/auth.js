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
    state.mode = mode === 'signup' ? 'signup' : 'signin';
    const signup = state.mode === 'signup';
    const title = $('auth-title');
    const nameField = $('auth-name-field');
    const nameInput = $('auth-name');
    const submit = $('auth-submit');
    const toggle = $('auth-mode-toggle');
    if (title) title.textContent = signup ? 'Create your CodeLeaf account' : 'Sign in to CodeLeaf';
    if (nameField) nameField.hidden = !signup;
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
    setMessage('');
    $('auth-email')?.focus();
  }

  function close() {
    const node = overlay();
    if (node) { node.hidden = true; document.body.classList.remove('auth-open'); }
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
      if (avatar) avatar.textContent = displayName.slice(0, 1).toUpperCase();
      if (name) name.textContent = displayName;
      if (email) email.textContent = state.user.email || '';
      button.title = state.user.email || '';
    }
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
      completed(await request('/api/auth/register', { name: $('auth-name')?.value, email: $('auth-email')?.value, password: $('auth-password')?.value }));
    } catch (error) { setMessage(error.message, true); }
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
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    state.user = null;
    renderAccount();
    if (typeof showView === 'function') showView('intro');
  }

  function accountAction() {
    if (!state.user) return open();
    const popover = $('auth-profile-popover');
    const button = $('auth-account-button');
    if (popover) popover.hidden = !popover.hidden;
    if (button) button.setAttribute('aria-expanded', String(popover ? !popover.hidden : false));
  }

  async function init() {
    try {
      const response = await fetch('/api/auth/me', { credentials: 'same-origin' });
      const data = await response.json();
      state.user = data.user || null;
      state.required = !!data.required;
      renderAccount();
      const accountWrap = $('auth-account-wrap');
      const accountPopover = $('auth-profile-popover');
      const accountButton = $('auth-account-button');
      accountWrap?.addEventListener('mouseenter', () => {
        if (state.user && accountPopover) {
          accountPopover.hidden = false;
          accountButton?.setAttribute('aria-expanded', 'true');
        }
      });
      accountWrap?.addEventListener('mouseleave', () => {
        if (accountPopover) accountPopover.hidden = true;
        accountButton?.setAttribute('aria-expanded', 'false');
      });
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
    init, open, close, login, register, signOut, accountAction, setMode,
    require(action) { if (state.user || !state.required) return action(); open(action); },
    get user() { return state.user; },
  };
})();

window.Auth = Auth;

document.addEventListener('DOMContentLoaded', () => Auth.init());
