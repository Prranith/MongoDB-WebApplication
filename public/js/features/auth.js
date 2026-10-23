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
      if (avatar) {
        const fallback = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" fill="#06110b"/><circle cx="40" cy="40" r="34" fill="#087d43" stroke="#00ed64" stroke-width="2"/><circle cx="40" cy="29" r="10" fill="#eafff0"/><path fill="#eafff0" d="M20 58c0-10 9-17 20-17s20 7 20 17v2H20v-2Z"/></svg>');
        if (state.user.avatar) {
          const image = document.createElement('img'); image.alt = ''; image.src = state.user.avatar; image.onerror = () => { avatar.innerHTML = `<img src="${fallback}" alt="">`; }; avatar.replaceChildren(image);
        } else avatar.innerHTML = `<img src="${fallback}" alt="">`;
      }
      if (name) name.textContent = displayName;
      if (email) email.textContent = state.user.email || '';
      button.title = state.user.email || '';
    }
  }

  function openProfile() {
    if (!state.user) return open();
    const modal = $('profile-modal');
    if (!modal) return;
    // Mount discovery when the profile is opened as well as during startup;
    // this keeps the directory available after a delayed auth/session restore.
    mountProfileDirectory();
    $('profile-name').value = state.user.name || '';
    $('profile-display-name').textContent = state.user.name || 'CodeLeaf member';
    const verified = document.createElement('span'); verified.className = 'profile-verified'; verified.setAttribute('aria-label', 'Verified profile'); verified.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.3 16.8-4.1-4.1 1.8-1.8 2.3 2.3 7.7-7.7 1.8 1.8-9.5 9.5Z"/></svg>'; $('profile-display-name').appendChild(verified);
    $('profile-display-email').textContent = state.user.email || '';
    if ($('profile-display-bio')) $('profile-display-bio').textContent = state.user.bio || 'Build your CodeLeaf identity.';
    $('profile-email').value = state.user.email || '';
    $('profile-college').value = state.user.college || '';
    $('profile-bio').value = state.user.bio || '';
    $('profile-phone').value = state.user.phone || '';
    window.__profilePreferences = { emailNotifications: state.user.preferences?.emailNotifications !== false, assessmentReminders: state.user.preferences?.assessmentReminders !== false, profileVisibility: state.user.preferences?.profileVisibility || 'members' };
    const avatar = $('profile-avatar');
    const fallback = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" rx="40" fill="#087d43"/><path fill="#eafff0" d="M40 39a12 12 0 1 0 0-24 12 12 0 0 0 0 24Zm0 7c-12 0-22 7-22 16 0 2 2 3 4 3h36c2 0 4-1 4-3 0-9-10-16-22-16Z"/></svg>');
    avatar.src = state.user.avatar || fallback;
    if ($('profile-avatar-preview')) $('profile-avatar-preview').src = state.user.avatar || fallback;
    avatar.onerror = () => { avatar.onerror = null; avatar.src = fallback; };
    $('profile-avatar-data').value = state.user.avatar || '';
    const cover = document.querySelector('.profile-cover-pattern');
    if (cover && state.user.cover) { cover.style.backgroundImage = `linear-gradient(90deg,rgba(7,20,12,.18),rgba(3,16,11,.08)),url(${state.user.cover})`; cover.style.backgroundSize = 'cover'; cover.style.backgroundPosition = 'center'; }
    $('profile-links').innerHTML = '';
    (state.user.links || []).forEach(link => addProfileLink(link.label, link.url));
    const profileSections = document.querySelectorAll('.profile-main > .profile-section');
    profileSections[0]?.classList.add('profile-personal-section');
    profileSections[1]?.classList.add('profile-social-section');
    setEditMode(false);
    modal.hidden = false;
    modal.style.display = 'grid';
    document.body.classList.add('profile-open');
  }
  function setEditMode(enabled) {
    document.querySelectorAll('#profile-name,#profile-phone,#profile-college,#profile-bio,.profile-link-label,.profile-link-url').forEach(field => { field.disabled = !enabled; });
    const actions = document.querySelector('.profile-actions'); if (actions) actions.hidden = false;
    const edit = $('profile-edit-button'); if (edit) edit.hidden = enabled;
    document.querySelectorAll('.profile-photo-button,.profile-photo-remove,.profile-photo-edit,.profile-camera-button,.profile-cover-button,.profile-add-link').forEach(button => { button.disabled = !enabled; });
    if (enabled) document.querySelector('.profile-personal-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function renderTab(index) {
    const personal = document.querySelector('.profile-personal-section');
    const social = document.querySelector('.profile-social-section');
    let panel = $('profile-tab-panel');
    if (index < 2) {
      if (panel) panel.hidden = true;
      if (personal) personal.hidden = index !== 0;
      if (social) social.hidden = index !== 1;
      return;
    }
    if (personal) personal.hidden = true;
    if (social) social.hidden = true;
    if (!panel) { panel = document.createElement('section'); panel.id = 'profile-tab-panel'; panel.className = 'profile-section profile-tab-panel'; document.querySelector('.profile-main').insertBefore(panel, document.querySelector('.profile-actions')); }
    panel.hidden = false;
    if (index === 2) {
      const prefs = window.__profilePreferences || {};
      panel.innerHTML = `<div class="profile-section-heading"><div><span class="profile-eyebrow">PREFERENCES</span><h3>Workspace preferences</h3><p>Choose how CodeLeaf keeps you informed.</p></div></div><label class="profile-setting"><span><strong>Email notifications</strong><small>Receive account and workspace updates.</small></span><input id="profile-pref-email" type="checkbox" ${prefs.emailNotifications ? 'checked' : ''}></label><label class="profile-setting"><span><strong>Assessment reminders</strong><small>Get reminders for assigned exams and meetings.</small></span><input id="profile-pref-assessments" type="checkbox" ${prefs.assessmentReminders ? 'checked' : ''}></label><label class="profile-setting"><span><strong>Profile visibility</strong><small>Control who can find your public profile.</small></span><select id="profile-pref-visibility"><option value="members" ${prefs.profileVisibility !== 'public' ? 'selected' : ''}>CodeLeaf members</option><option value="public" ${prefs.profileVisibility === 'public' ? 'selected' : ''}>Anyone with a profile link</option></select></label><div class="profile-tab-actions"><button class="auth-primary" type="button" id="profile-save-preferences">Save preferences</button></div>`;
      $('profile-save-preferences').onclick = async () => { const payload = { preferences: { emailNotifications: $('profile-pref-email').checked, assessmentReminders: $('profile-pref-assessments').checked, profileVisibility: $('profile-pref-visibility').value } }; await persistProfile(payload, 'Preferences saved.'); };
    } else {
      panel.innerHTML = `<div class="profile-section-heading"><div><span class="profile-eyebrow">SECURITY</span><h3>Account security</h3><p>Manage your password and verification status.</p></div></div><div class="security-status"><span class="security-status-dot"></span><div><strong>Email verified</strong><small>${state.user?.email || ''} is verified for this account.</small></div></div><form class="password-form" id="profile-password-form"><label class="auth-field">Current password<input id="profile-current-password" type="password" autocomplete="current-password" required></label><label class="auth-field">New password<input id="profile-new-password" type="password" autocomplete="new-password" minlength="10" required></label><label class="auth-field">Confirm new password<input id="profile-confirm-password" type="password" autocomplete="new-password" minlength="10" required></label><div class="profile-tab-actions"><button class="auth-primary" type="submit">Change password</button></div><p class="profile-inline-message" id="profile-security-message"></p></form>`;
      $('profile-password-form').onsubmit = async event => { event.preventDefault(); const message = $('profile-security-message'); if ($('profile-new-password').value !== $('profile-confirm-password').value) { message.textContent = 'New passwords do not match.'; message.className = 'profile-inline-message error'; return; } try { await request('/api/auth/change-password', { currentPassword: $('profile-current-password').value, newPassword: $('profile-new-password').value }); message.textContent = 'Password changed successfully.'; message.className = 'profile-inline-message success'; event.target.reset(); } catch (error) { message.textContent = error.message; message.className = 'profile-inline-message error'; } };
    }
  }
  async function persistProfile(payload, successMessage) {
    const response = await fetch('/api/auth/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(payload) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Unable to save changes.');
    state.user = data.user; window.__profilePreferences = state.user.preferences || window.__profilePreferences; renderAccount();
    const button = $('profile-save-preferences'); if (button) { button.textContent = successMessage; setTimeout(() => { button.textContent = 'Save preferences'; }, 1800); }
  }
  function chooseCover(event) {
    const file = event.target.files?.[0]; if (!file || !file.type.startsWith('image/')) return;
    if (file.size > 2000000) return setMessage('Cover image must be smaller than 2 MB.', true);
    const reader = new FileReader(); reader.onload = () => { const cover = document.querySelector('.profile-cover-pattern'); if (cover) { cover.style.backgroundImage = `linear-gradient(90deg,rgba(7,20,12,.18),rgba(3,16,11,.08)),url(${reader.result})`; cover.style.backgroundSize = 'cover'; cover.style.backgroundPosition = 'center'; } window.__profileCoverData = reader.result; }; reader.readAsDataURL(file);
  }
  function addProfileLink(label = '', url = '') {
    const row = document.createElement('div'); row.className = 'profile-link-row';
    row.innerHTML = `<span class="profile-link-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9h-2a7 7 0 1 1-7-7V3Zm2 0v2h3.6L13 9.6 14.4 11 19 6.4V10h2V3h-7Z"/></svg></span><input class="profile-link-label" placeholder="LinkedIn / GitHub / LeetCode" value="${String(label).replace(/"/g, '&quot;')}"><input class="profile-link-url" placeholder="https://..." value="${String(url).replace(/"/g, '&quot;')}"><button type="button" aria-label="Remove link">×</button>`;
    row.querySelector('button').onclick = () => row.remove(); $('profile-links').appendChild(row);
  }
  function readProfileLinks() { return [...document.querySelectorAll('.profile-link-row')].map(row => ({ label: row.querySelector('.profile-link-label').value, url: row.querySelector('.profile-link-url').value })).filter(x => x.url); }
  function chooseAvatar(event) { const file = event.target.files?.[0]; if (!file || !file.type.startsWith('image/')) return; if (file.size > 1000000) return setMessage('Profile photo must be smaller than 1 MB.', true); const reader = new FileReader(); reader.onload = () => { $('profile-avatar').src = reader.result; if ($('profile-avatar-preview')) $('profile-avatar-preview').src = reader.result; $('profile-avatar-data').value = reader.result; }; reader.readAsDataURL(file); }
  async function searchProfiles() {
    const query = $('profile-directory-query')?.value.trim() || $('profile-search-query')?.value.trim() || ''; const target = $('profile-directory-results') || $('profile-search-results');
    if (query.length < 1) { target.innerHTML = '<div class="profile-search-empty">Start typing to discover CodeLeaf members.</div>'; return; }
    target.textContent = 'Searching…';
    const response = await fetch(`/api/auth/search?q=${encodeURIComponent(query)}`, { credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    const escape = value => String(value || '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character]));
    target.innerHTML = (data.users || []).map(user => `<button class="profile-directory-result" type="button" data-profile-id="${escape(user.id)}"><span class="profile-directory-avatar">${user.avatar ? `<img src="${escape(user.avatar)}" alt="">` : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0H5Z"/></svg>'}</span><span><strong>${escape(user.name || 'CodeLeaf member')}</strong><small>${escape(user.college || user.bio || 'CodeLeaf member')}</small></span><svg class="profile-directory-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6 1.4-1.4L17.8 12l-7.4 7.4L9 18Z"/></svg></button>`).join('') || '<div class="profile-search-empty">No matching profiles found.</div>';
    target.querySelectorAll('[data-profile-id]').forEach(result => { result.onclick = () => viewPublicProfile(result.dataset.profileId); });
  }
  async function viewPublicProfile(userId) {
    if (!userId) return;
    const preview = $('profile-public-preview'); if (!preview) return;
    preview.hidden = false; preview.innerHTML = '<div class="profile-preview-loading">Loading profile…</div>';
    const response = await fetch(`/api/auth/profile/${encodeURIComponent(userId)}`, { credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.profile) { preview.innerHTML = '<div class="profile-preview-loading">Unable to load this profile.</div>'; return; }
    const profile = data.profile; const escape = value => String(value || '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character]));
    const links = (profile.links || []).map(link => `<a href="${escape(link.url)}" target="_blank" rel="noopener noreferrer">${escape(link.label || 'Website')}</a>`).join('');
    const fallback = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" fill="#06110b"/><circle cx="40" cy="40" r="34" fill="#087d43" stroke="#00ed64" stroke-width="2"/><circle cx="40" cy="29" r="10" fill="#eafff0"/><path fill="#eafff0" d="M20 58c0-10 9-17 20-17s20 7 20 17v2H20v-2Z"/></svg>');
    preview.innerHTML = `<div class="profile-preview-head"><img src="${escape(profile.avatar || fallback)}" alt=""><div><h3>${escape(profile.name || 'CodeLeaf member')}</h3><p>${escape(profile.email)}</p></div><button type="button" aria-label="Close profile preview">×</button></div><div class="profile-preview-grid"><div><span>College / University</span><strong>${escape(profile.college || 'Not provided')}</strong></div><div><span>Phone number</span><strong>${escape(profile.phone || 'Not provided')}</strong></div></div><p class="profile-preview-bio">${escape(profile.bio || 'No introduction added yet.')}</p>${links ? `<div class="profile-preview-links">${links}</div>` : ''}`;
    preview.querySelector('button').onclick = () => { preview.hidden = true; };
  }
  function mountProfileDirectory() {
    if ($('profile-directory')) return;
    const actions = document.querySelector('.profile-actions'); if (!actions) return;
    const directory = document.createElement('section'); directory.id = 'profile-directory'; directory.className = 'profile-section profile-directory';
    directory.innerHTML = '<div class="profile-section-heading"><div><span class="profile-eyebrow">CODELEAF COMMUNITY</span><h3>Find people</h3><p>Search members by name, college, or bio.</p></div></div><div class="profile-directory-search"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 20-4.4-4.4a7 7 0 1 0-1.4 1.4L19.6 21 21 20ZM5 10a5 5 0 1 1 10 0A5 5 0 0 1 5 10Z"/></svg><input id="profile-directory-query" placeholder="Search profiles" autocomplete="off"><span class="profile-directory-hint">Results update as you type</span></div><div id="profile-directory-results" class="profile-directory-results"><div class="profile-search-empty">Start typing to discover CodeLeaf members.</div></div><div id="profile-public-preview" class="profile-public-preview" hidden></div>';
    actions.parentNode.insertBefore(directory, actions);
    $('profile-directory-query').addEventListener('input', (() => { let timer; return () => { clearTimeout(timer); timer = setTimeout(searchProfiles, 160); }; })());
  }
  function closeProfile() { const modal = $('profile-modal'); if (modal) { modal.hidden = true; modal.style.display = 'none'; } document.body.classList.remove('profile-open'); }
  async function saveProfile() {
    const response = await fetch('/api/auth/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ name: $('profile-name').value, phone: $('profile-phone').value, college: $('profile-college').value, bio: $('profile-bio').value, avatar: $('profile-avatar-data').value, cover: window.__profileCoverData || state.user.cover || '', links: readProfileLinks() }) });
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
      mountProfileDirectory();
      document.querySelector('.profile-cover-button')?.addEventListener('click', () => $('profile-cover-file')?.click());
      document.querySelector('.profile-photo-remove')?.addEventListener('click', () => { $('profile-avatar').src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" rx="40" fill="#087d43"/><path fill="#eafff0" d="M40 39a12 12 0 1 0 0-24 12 12 0 0 0 0 24Zm0 7c-12 0-22 7-22 16 0 2 2 3 4 3h36c2 0 4-1 4-3 0-9-10-16-22-16Z"/></svg>'); $('profile-avatar-preview').src = $('profile-avatar').src; $('profile-avatar-data').value = ''; });
      document.querySelectorAll('.profile-tabs button').forEach((tab, index) => tab.addEventListener('click', () => {
        document.querySelectorAll('.profile-tabs button').forEach(item => item.classList.remove('active'));
        tab.classList.add('active');
        renderTab(index);
      }));
      $('profile-search-query')?.addEventListener('input', (() => { let timer; return () => { clearTimeout(timer); timer = setTimeout(searchProfiles, 220); }; })());
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
    init, open, close, login, register, signOut, accountAction, openProfile, closeProfile, saveProfile, addProfileLink, chooseAvatar, chooseCover, setEditMode, searchProfiles, setMode,
    require(action) { if (state.user) return action(); open(action); },
    get user() { return state.user; },
  };
})();

// Keep the profile affordance functional even while authentication state is
// still being restored after a refresh. Auth data is populated independently.
window.__openCodeLeafProfile = event => {
  event?.preventDefault();
  event?.stopPropagation();
  const modal = document.getElementById('profile-modal');
  if (!modal) return;
  modal.hidden = false;
  modal.style.display = 'grid';
  document.body.classList.add('profile-open');
  window.Auth?.openProfile?.();
};

window.Auth = Auth;

document.addEventListener('DOMContentLoaded', () => Auth.init());
