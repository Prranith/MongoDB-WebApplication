/* Codexa AI — normal workspace editor assistant. */
const WorkspaceAIAssistant = (() => {
  let busy = false;
  let resizing = false;

  const byId = id => document.getElementById(id);
  const escapeHtml = value => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function panel() { return byId('workspace-ai-panel'); }
  function resizer() { return byId('workspace-ai-resizer'); }
  function launchButtons() {
    return [byId('workspace-ai-launch-toolbar'), byId('workspace-ai-launch')].filter(Boolean);
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
    return byId('workspace-lang-select')?.value || 'mongodb';
  }

  function renderResult(data) {
    const target = byId('workspace-ai-result');
    if (!target) return;
    const notes = Array.isArray(data.line_notes) ? data.line_notes : [];
    const currentCode = typeof editor !== 'undefined' && editor ? editor.getValue() : '';
    target.innerHTML = `<div class="workspace-ai-success"><span class="workspace-ai-result-icon">✓</span><div><strong>${escapeHtml(data.summary || 'Review complete')}</strong><p>${escapeHtml(data.suggestion || 'No additional suggestion.')}</p></div></div>${notes.length ? `<div class="workspace-ai-notes">${notes.map(note => `<div>• ${escapeHtml(note)}</div>`).join('')}</div>` : ''}${data.corrected_code ? `<div class="workspace-ai-correction"><span>Suggested changes</span><button type="button" onclick="WorkspaceAIAssistant.applyCorrection()">Keep changes</button></div><details class="workspace-ai-diff" open><summary><span>Changes</span><small>Review before applying</small></summary><div class="workspace-ai-diff-code">${diffPreview(currentCode, data.corrected_code)}</div></details>` : ''}`;
    window.__codexaAiCorrection = data.corrected_code || '';
  }

  function setBusy(value) {
    busy = value;
    const button = byId('workspace-ai-send');
    if (button) { button.disabled = value; button.querySelector('span').textContent = value ? 'Thinking…' : 'Ask Codexa AI'; }
    const target = byId('workspace-ai-result');
    if (value && target) target.innerHTML = '<div class="workspace-ai-thinking"><span></span><span></span><span></span>Reading the entire file…</div>';
  }

  async function ask() {
    if (busy || typeof editor === 'undefined' || !editor) return;
    const code = editor.getValue();
    const requestText = byId('workspace-ai-request')?.value.trim() || 'Review this code for bugs and suggest improvements.';
    const autoFill = Boolean(byId('workspace-ai-autofill')?.checked);
    const active = typeof S !== 'undefined' && S.activeFile ? S.activeFile : 'Untitled';
    setBusy(true);
    try {
      const response = await fetch('/api/ai/editor-assist', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, language: language(), filename: active, request: requestText, autoFill })
      });
      const data = await response.json();
      if (!response.ok || data.status !== 'ok') throw new Error(data.error || 'AI request failed');
      renderResult(data);
      if (autoFill && data.corrected_code && data.corrected_code !== code) applyCorrection();
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
      target.querySelector('.workspace-ai-applied')?.remove();
      target.insertAdjacentHTML('afterbegin', '<div class="workspace-ai-applied">✓ Correction applied · undo remains available</div>');
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    resizer()?.addEventListener('pointerdown', startResize);
    restorePanelWidth();
    byId('workspace-ai-request')?.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); ask(); }
    });
  });

  return { toggle, close, preset, ask, applyCorrection };
})();
