/* CodeLeaf AI — normal workspace editor assistant. */
const WorkspaceAIAssistant = (() => {
  let busy = false;
  let resizing = false;

  const byId = id => document.getElementById(id);
  const escapeHtml = value => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function panel() { return byId('workspace-ai-panel'); }
  function resizer() { return byId('workspace-ai-resizer'); }
  function syncLauncherVisibility() {
    const button = byId('workspace-ai-launch-floating');
    if (!button) return;
    const intro = byId('intro-panel');
    const auth = byId('auth-overlay');
    const homeVisible = Boolean(intro?.classList.contains('active'));
    const authVisible = Boolean(auth && !auth.hidden);
    button.hidden = homeVisible || authVisible;
  }
  function launchButtons() {
    return [byId('workspace-ai-launch-floating'), byId('workspace-ai-launch')].filter(Boolean);
  }

  function syncContext() {
    const file = byId('workspace-ai-file');
    const active = typeof S !== 'undefined' && S.activeFile ? S.activeFile : 'Untitled editor';
    if (file) file.textContent = `${active} · entire file context`;
  }

  function setPanelWidth(width) {
    const value = Math.max(300, Math.min(560, Math.round(width)));
    const p = panel();
    if (p) { p.style.flexBasis = value + 'px'; p.style.width = value + 'px'; }
    try { localStorage.setItem('codexa-ai-panel-width', String(value)); } catch (_) {}
  }

  function restorePanelWidth() {
    try {
      const saved = Number(localStorage.getItem('codexa-ai-panel-width'));
      if (Number.isFinite(saved) && saved >= 300) setPanelWidth(saved);
    } catch (_) {}
  }

  function startResize(event) {
    const frame = byId('editor-inspector');
    if (!frame || !panel()) return;
    resizing = true;
    event.preventDefault();
    resizer()?.setPointerCapture?.(event.pointerId);
    const move = moveEvent => {
      if (!resizing) return;
      const bounds = frame.getBoundingClientRect();
      setPanelWidth(bounds.right - moveEvent.clientX);
    };
    const stop = () => {
      resizing = false;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', stop);
      document.body.classList.remove('workspace-ai-resizing');
    };
    document.body.classList.add('workspace-ai-resizing');
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', stop, { once: true });
  }

  function diffPreview(before, after) {
    const oldLines = String(before || '').split('\n');
    const newLines = String(after || '').split('\n');
    if (oldLines.length > 240 || newLines.length > 240) {
      return '<div class="workspace-ai-diff-summary">Updated file preview is ready. Apply correction to review it with editor undo.</div>';
    }
    const rows = [];
    const limit = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < limit; i += 1) {
      const oldLine = oldLines[i];
      const newLine = newLines[i];
      if (oldLine === newLine) {
        rows.push('<div class="workspace-ai-diff-row"><span class="workspace-ai-diff-gutter"> </span><code>  ' + escapeHtml(oldLine || '') + '</code></div>');
      } else {
        if (oldLine !== undefined) rows.push('<div class="workspace-ai-diff-row is-removed"><span class="workspace-ai-diff-gutter">−</span><code>- ' + escapeHtml(oldLine) + '</code></div>');
        if (newLine !== undefined) rows.push('<div class="workspace-ai-diff-row is-added"><span class="workspace-ai-diff-gutter">+</span><code>+ ' + escapeHtml(newLine) + '</code></div>');
      }
    }
    return rows.join('');
  }

  function typeAnswer(node, text) {
    if (!node) return;
    const value = String(text || '');
    node.textContent = '';
    let index = 0;
    const tick = () => {
      if (!node.isConnected) return;
      node.textContent = value.slice(0, index);
      if (index < value.length) {
        index += 1;
        window.setTimeout(tick, 10);
      }
    };
    tick();
  }

  function showEditorSuggestion(corrected) {
    let bar = byId('workspace-ai-editor-suggestion');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'workspace-ai-editor-suggestion';
      bar.innerHTML = '<span class="workspace-ai-editor-suggestion-icon">✦</span><span class="workspace-ai-editor-suggestion-text"></span><button type="button" class="workspace-ai-editor-keep">Keep</button><button type="button" class="workspace-ai-editor-undo" hidden>Undo</button>';
      byId('cm-wrap')?.appendChild(bar);
      bar.querySelector('.workspace-ai-editor-keep')?.addEventListener('click', applyCorrection);
      bar.querySelector('.workspace-ai-editor-undo')?.addEventListener('click', undoCorrection);
    }
    window.__codexaAiCorrection = corrected || '';
    bar.hidden = !corrected;
    bar.dataset.state = 'suggested';
    bar.querySelector('.workspace-ai-editor-suggestion-text').textContent = corrected ? 'CodeLeaf AI prepared a change for the active editor' : '';
    bar.querySelector('.workspace-ai-editor-keep').hidden = false;
    bar.querySelector('.workspace-ai-editor-undo').hidden = true;
  }

  function toggle() {
    const p = panel();
    if (!p) return;
    p.hidden = !p.hidden;
    p.parentElement?.classList.toggle('workspace-ai-open', !p.hidden);
    if (resizer()) resizer().hidden = p.hidden;
    launchButtons().forEach(button => button.setAttribute('aria-expanded', String(!p.hidden)));
    if (!p.hidden) {
      restorePanelWidth();
      syncContext();
      byId('workspace-ai-request')?.focus();
    }
  }

  function close() {
    const p = panel();
    if (p) { p.hidden = true; p.parentElement?.classList.remove('workspace-ai-open'); if (resizer()) resizer().hidden = true; launchButtons().forEach(button => button.setAttribute('aria-expanded', 'false')); }
  }

  function preset(text) {
    const input = byId('workspace-ai-request');
    if (input) { input.value = text; input.focus(); }
  }

  function language() {
    return typeof getWorkspaceLanguage === 'function' ? getWorkspaceLanguage() : 'mongodb';
  }

  function renderResult(data, requestText) {
    const target = byId('workspace-ai-result');
    if (!target) return;
    const notes = Array.isArray(data.line_notes) ? data.line_notes : [];
    target.innerHTML = `<div class="workspace-ai-user-message">${escapeHtml(requestText || 'Review this file')}</div><div class="workspace-ai-message"><div class="workspace-ai-success"><span class="workspace-ai-result-icon">✓</span><div><strong>${escapeHtml(data.summary || 'Review complete')}</strong><p class="workspace-ai-answer"></p></div></div>${notes.length ? `<div class="workspace-ai-notes">${notes.map(note => `<div>• ${escapeHtml(note)}</div>`).join('')}</div>` : ''}</div>`;
    typeAnswer(target.querySelector('.workspace-ai-answer'), data.suggestion || 'No additional suggestion.');
    window.__codexaAiCorrection = data.corrected_code || '';
    showEditorSuggestion(data.corrected_code || '');
  }

  function setBusy(value, requestText) {
    busy = value;
    const button = byId('workspace-ai-send');
    if (button) { button.disabled = value; button.querySelector('span').textContent = value ? 'Thinking…' : 'Ask'; }
    const target = byId('workspace-ai-result');
    if (value && target) target.innerHTML = `<div class="workspace-ai-user-message">${escapeHtml(requestText || 'Review this file')}</div><div class="workspace-ai-thinking"><span></span><span></span><span></span>Thinking…</div>`;
  }

  async function ask() {
    if (busy || typeof editor === 'undefined' || !editor) return;
    const code = editor.getValue();
    const input = byId('workspace-ai-request');
    const requestText = input?.value.trim() || 'Review this code for bugs and suggest improvements.';
    const autoFill = Boolean(byId('workspace-ai-autofill')?.checked);
    const active = typeof S !== 'undefined' && S.activeFile ? S.activeFile : 'Untitled';
    setBusy(true, requestText);
    try {
      const response = await fetch('/api/ai/editor-assist', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, language: language(), filename: active, request: requestText, autoFill })
      });
      const data = await response.json();
      if (!response.ok || data.status !== 'ok') throw new Error(data.error || 'AI request failed');
      renderResult(data, requestText);
      if (input) input.value = '';
    } catch (error) {
      const target = byId('workspace-ai-result');
      if (target) target.innerHTML = `<div class="workspace-ai-error"><strong>Assistant unavailable</strong><p>${escapeHtml(error.message)}</p></div>`;
    } finally { setBusy(false); }
  }

  function applyCorrection() {
    const corrected = window.__codexaAiCorrection;
    if (!corrected || typeof editor === 'undefined' || !editor) return;
    editor.operation(() => editor.setValue(corrected));
    const target = byId('workspace-ai-result');
    if (target) {
      target.insertAdjacentHTML('afterbegin', '<div class="workspace-ai-applied">✓ Change kept in the editor · undo remains available</div>');
    }
    const bar = byId('workspace-ai-editor-suggestion');
    if (bar) {
      bar.dataset.state = 'applied';
      bar.querySelector('.workspace-ai-editor-suggestion-text').textContent = 'Change kept in the active editor';
      bar.querySelector('.workspace-ai-keep').hidden = true;
      bar.querySelector('.workspace-ai-undo').hidden = false;
    }
  }

  function undoCorrection() {
    if (typeof editor === 'undefined' || !editor) return;
    editor.undo();
    const bar = byId('workspace-ai-editor-suggestion');
    if (bar) bar.hidden = true;
  }

  function initFloatingLauncher() {
    const button = byId('workspace-ai-launch-floating');
    if (!button) return;
    let drag = null;
    let moved = false;
    try {
      const saved = JSON.parse(localStorage.getItem('codeleaf-ai-launcher-position') || 'null');
      if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
        button.style.left = `${saved.left}px`;
        button.style.top = `${saved.top}px`;
        button.style.right = 'auto';
        button.style.bottom = 'auto';
      }
    } catch (_) {}
    button.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      const rect = button.getBoundingClientRect();
      drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: rect.left, top: rect.top };
      moved = false;
      button.setPointerCapture?.(event.pointerId);
    });
    button.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      if (!moved) return;
      const maxLeft = Math.max(8, window.innerWidth - button.offsetWidth - 8);
      const maxTop = Math.max(8, window.innerHeight - button.offsetHeight - 8);
      button.style.left = `${Math.min(maxLeft, Math.max(8, drag.left + dx))}px`;
      button.style.top = `${Math.min(maxTop, Math.max(8, drag.top + dy))}px`;
      button.style.right = 'auto';
      button.style.bottom = 'auto';
    });
    button.addEventListener('pointerup', event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (moved) {
        try { localStorage.setItem('codeleaf-ai-launcher-position', JSON.stringify({ left: button.offsetLeft, top: button.offsetTop })); } catch (_) {}
      }
      drag = null;
    });
    button.addEventListener('click', event => {
      if (moved) { event.preventDefault(); event.stopPropagation(); moved = false; }
    }, true);
  }

  window.addEventListener('DOMContentLoaded', () => {
    resizer()?.addEventListener('pointerdown', startResize);
    restorePanelWidth();
    initFloatingLauncher();
    syncLauncherVisibility();
    const visibilityObserver = new MutationObserver(syncLauncherVisibility);
    ['intro-panel', 'auth-overlay'].forEach(id => {
      const target = byId(id);
      if (target) visibilityObserver.observe(target, { attributes: true, attributeFilter: ['class', 'hidden'] });
    });
    byId('workspace-ai-request')?.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); ask(); }
    });
  });

  return { toggle, close, preset, ask, applyCorrection, undoCorrection, syncLauncherVisibility };
})();
