/* Codexa AI — normal workspace editor assistant. */
const WorkspaceAIAssistant = (() => {
  let busy = false;

  const byId = id => document.getElementById(id);
  const escapeHtml = value => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function panel() { return byId('workspace-ai-panel'); }
  function launchButtons() {
    return [byId('workspace-ai-launch-toolbar'), byId('workspace-ai-launch')].filter(Boolean);
  }

  function syncContext() {
    const file = byId('workspace-ai-file');
    const active = typeof S !== 'undefined' && S.activeFile ? S.activeFile : 'Untitled editor';
    if (file) file.textContent = `${active} · entire file context`;
  }

  function toggle() {
    const p = panel();
    if (!p) return;
    p.hidden = !p.hidden;
    p.parentElement?.classList.toggle('workspace-ai-open', !p.hidden);
    launchButtons().forEach(button => button.setAttribute('aria-expanded', String(!p.hidden)));
    if (!p.hidden) {
      syncContext();
      byId('workspace-ai-request')?.focus();
    }
  }

  function close() {
    const p = panel();
    if (p) { p.hidden = true; p.parentElement?.classList.remove('workspace-ai-open'); launchButtons().forEach(button => button.setAttribute('aria-expanded', 'false')); }
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
    target.innerHTML = `<div class="workspace-ai-success"><span class="workspace-ai-result-icon">✓</span><div><strong>${escapeHtml(data.summary || 'Review complete')}</strong><p>${escapeHtml(data.suggestion || 'No additional suggestion.')}</p></div></div>${notes.length ? `<div class="workspace-ai-notes">${notes.map(note => `<div>• ${escapeHtml(note)}</div>`).join('')}</div>` : ''}${data.corrected_code ? `<div class="workspace-ai-correction"><span>Corrected version ready</span><button type="button" onclick="WorkspaceAIAssistant.applyCorrection()">Apply correction</button></div>` : ''}`;
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
    byId('workspace-ai-request')?.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); ask(); }
    });
  });

  return { toggle, close, preset, ask, applyCorrection };
})();
