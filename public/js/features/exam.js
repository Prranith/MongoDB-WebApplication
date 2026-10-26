/**
 * js/features/exam.js
 * Exam Portal — Full client-side logic
 * Mentor flow, Student flow, CodeMirror editor instances, Redis polling
 */

const ExamPortal = (() => {

  // ── State ──────────────────────────────────────────────────────────────────
  const state = {
    // Mentor
    mentor: {
      roomId: null,
      mentorId: null,
      title: '',
      timed: false,
      duration: 60,
      questions: [],       // array of question objects
      datasets: [],        // array of dataset objects
      currentQId: null,
      miniEditors: {},     // qId → CodeMirror instance
      leaderboardData: [],
      sortMode: 'score',   // 'score' | 'roll'
      status: 'waiting',
      startedAt: null,
      timerInterval: null,
      lbInterval: null,
      participantInterval: null,
      participantsOpen: false,
    },
    // Student
    student: {
      roomId: null,
      studentId: null,
      name: '',
      rollNo: '',
      branch: '',
      questions: [],
      datasets: [],
      currentQIdx: null,
      status: {}, // qId → 'unattempted'|'draft'|'submitted'
      roomStatus: 'waiting',
      lastRunOutput: null,
      expectedPreview: {},
      hasRunOnce: false,
      selectedOption: null,
      pollInterval: null,
      paperVersion: '',
      paperSyncInFlight: false,
      examEditor: null,
      timerInterval: null,
      fullscreenWatchInterval: null,
      ignoreFullscreenChange: false,
      finalSubmissionConfirmed: false,
      finalSubmissionInFlight: false,
    }
  };

  // ── Utility ────────────────────────────────────────────────────────────────
  function genId() {
    return Math.random().toString(36).substr(2, 8).toUpperCase();
  }

  function el(id) { return document.getElementById(id); }

  function isExecutionFailure(result) {
    if (!result) return true;
    if (result.executionFailure === true) return true;
    return result.code !== undefined && Number(result.code) !== 0;
  }

  function setExamExecutionOrigin(origin, running = true, reason = '') {
    if (state.student) {
      state.student.executionOrigin = origin;
      state.student.executionOriginReason = reason ? String(reason) : '';
      const currentQuestion = state.student.questions && state.student.questions[state.student.currentQIdx];
      state.student.executionOriginQuestionId = currentQuestion ? currentQuestion.id : '';
    }
    const status = el('student-console-status');
    if (!status) return;
    const local = origin === 'local';
    const label = local ? 'Local execution' : 'Remote execution';
    const detail = local
      ? 'CodeLeaf is running this program on your device.'
      : 'CodeLeaf is running this program on a dedicated execution worker.';
    const currentQuestion = state.student.questions && state.student.questions[state.student.currentQIdx];
    if (currentQuestion && currentQuestion.type === 'coding' && (running || reason)) {
      updateStudentExecutionCard(
        reason || (running ? (local ? 'Running program on this device…' : 'Running program on a remote worker…') : detail),
        { mode: local ? 'local' : 'remote', kind: reason ? 'error' : (running ? 'active' : 'done') }
      );
    }
    const reasonHtml = reason
      ? ` <span class="execution-phase execution-fallback-reason">· ${escapeExamHtml(String(reason).slice(0, 240))}</span>`
      : '';
    status.innerHTML = `<span class="execution-origin ${local ? 'execution-origin-local' : 'execution-origin-remote'}"><span class="execution-origin-dot"></span>${label}</span>${running ? ' <span class="execution-phase">· Running…</span>' : ` <span class="execution-phase">· ${detail}</span>`}${reasonHtml}`;
  }

  function updateStudentExecutionCard(message, options = {}) {
    const card = el('student-execution-card');
    if (!card) return;
    const mode = options.mode || state.student.executionCardMode || 'local';
    const kind = options.kind || 'active';
    state.student.executionCardMode = mode;
    state.student.executionCardSteps = state.student.executionCardSteps || [];
    if (message) {
      const last = state.student.executionCardSteps[state.student.executionCardSteps.length - 1];
      if (!last || last.message !== String(message) || last.kind !== kind) {
        state.student.executionCardSteps.push({ message: String(message), kind });
      }
    }
    card.hidden = false;
    card.classList.toggle('is-remote', mode === 'remote');
    card.classList.toggle('is-error', kind === 'error');
    const modeEl = el('student-execution-card-mode');
    const currentEl = el('student-execution-card-current');
    const stepsEl = el('student-execution-steps');
    const progressEl = el('student-execution-progress-bar');
    if (modeEl) modeEl.textContent = mode === 'remote' ? 'REMOTE WORKER' : 'ON DEVICE';
    if (currentEl) currentEl.textContent = String(message || 'Preparing execution…');
    if (progressEl) {
      const count = state.student.executionCardSteps.length;
      progressEl.style.width = `${Math.min(96, Math.max(12, count * 18))}%`;
    }
    if (stepsEl) {
      stepsEl.innerHTML = state.student.executionCardSteps.slice(-5).map(step =>
        `<span class="student-execution-step is-${step.kind}">${escapeExamHtml(step.message)}</span>`
      ).join('');
    }
  }

  function startStudentExecutionCard(language) {
    state.student.executionCardSteps = [];
    state.student.executionOriginReason = '';
    const card = el('student-execution-card');
    const toggle = el('student-execution-toggle');
    if (card) card.classList.remove('is-collapsed');
    if (toggle) {
      toggle.setAttribute('aria-expanded', 'true');
      toggle.setAttribute('title', 'Collapse execution log');
      toggle.textContent = '⌃';
    }
    updateStudentExecutionCard(`Starting ${String(language || 'program').toUpperCase()} on-device execution…`, { mode: 'local' });
  }

  function finishStudentExecutionCard() {
    const card = el('student-execution-card');
    const toggle = el('student-execution-toggle');
    if (!card) return;
    card.classList.add('is-collapsed');
    if (toggle) {
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('title', 'Expand execution log');
      toggle.textContent = '⌄';
    }
  }

  function langCommentPrefix(lang) {
    if (lang === 'python') return '#';
    if (lang === 'sql') return '--';
    return '//';
  }

  // ── Themed modal (replaces native alert/confirm) ─────────────────────────
  let examModalChain = Promise.resolve();

  function showExamModal({ title = 'Notice', message = '', buttons = [], danger = false }) {
    const run = examModalChain.then(() => new Promise(resolve => {
      const overlay = el('exam-modal-overlay');
      const box = el('exam-modal');
      const titleEl = el('exam-modal-title');
      const bodyEl = el('exam-modal-body');
      const actionsEl = el('exam-modal-actions');
      const closeBtn = el('exam-modal-close');
      if (!overlay || !box || !titleEl || !bodyEl || !actionsEl) { resolve(null); return; }

      titleEl.textContent = title;
      bodyEl.textContent = message;
      box.classList.toggle('danger', danger);
      actionsEl.innerHTML = '';

      const finish = value => {
        document.removeEventListener('keydown', onKey);
        overlay.style.display = 'none';
        resolve(value);
      };

      const cancelValue = () => {
        const cancelBtn = buttons.find(b => !b.primary && !b.danger);
        return cancelBtn ? cancelBtn.value : null;
      };

      const onKey = e => {
        if (e.key === 'Escape') {
          finish(cancelValue());
        } else if (e.key === 'Enter') {
          const primaryBtn = buttons.find(b => b.primary || b.danger);
          if (primaryBtn) finish(primaryBtn.value);
        }
      };

      buttons.forEach(cfg => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'exam-modal-btn' + (cfg.primary ? ' primary' : '') + (cfg.danger ? ' danger' : '');
        btn.textContent = cfg.label;
        btn.addEventListener('click', () => finish(cfg.value));
        actionsEl.appendChild(btn);
      });

      closeBtn.onclick = () => finish(cancelValue());
      overlay.onclick = e => { if (e.target === overlay) finish(cancelValue()); };
      document.addEventListener('keydown', onKey);

      overlay.style.display = 'flex';
      const focusTarget = actionsEl.querySelector('.primary, .danger') || actionsEl.querySelector('button');
      if (focusTarget) focusTarget.focus();
    }));
    examModalChain = run.then(() => {}, () => {});
    return run;
  }

  function showExamAlert(message, { title = 'Notice', danger = false } = {}) {
    return showExamModal({ title, message, danger, buttons: [{ label: 'OK', value: true, primary: !danger, danger }] });
  }

  function showExamConfirm(message, { title = 'Please Confirm', danger = false, confirmText = 'Confirm', cancelText = 'Cancel' } = {}) {
    return showExamModal({
      title, message, danger,
      buttons: [
        { label: cancelText, value: false },
        { label: confirmText, value: true, primary: !danger, danger },
      ]
    });
  }

  // CodeMirror is loaded from a CDN, so mentor editors may render before the
  // library has finished loading. Retry briefly instead of leaving a raw
  // textarea behind when that race occurs.
  function whenCodeMirrorReady(callback, attempt = 0) {
    if (typeof CodeMirror !== 'undefined' && typeof CodeMirror.fromTextArea === 'function') {
      callback();
      return;
    }
    if (attempt < 30) setTimeout(() => whenCodeMirrorReady(callback, attempt + 1), 100);
  }

  function fitMentorCodeMirror(cm) {
    if (!cm) return;
    const lineHeight = cm.defaultTextHeight ? cm.defaultTextHeight() : 18;
    const lineCount = Math.max(5, cm.lineCount ? cm.lineCount() : 5);
    cm.setSize('100%', `${Math.max(100, lineCount * lineHeight + 14)}px`);
    cm.refresh();
  }

  function isDataQuestion(q) {
    return !!q && (q.type === 'query' || q.type === 'sql');
  }

  function isSqlQuestion(q) {
    return !!q && q.type === 'sql';
  }

  function escapeExamHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // A solve-function Java question is stored as two editor buffers, but the
  // browser compiler receives one source file. Java requires imports to come
  // before every type declaration and permits only one public top-level type
  // per file. Keep the driver as Main.java's public entry point, move imports
  // to the file header, and make the editorial Solution type package-private.
  function assembleJavaExecutionSource(editorialCode, driverCode, templateType) {
    if (templateType !== 'solve_function' || !driverCode) return String(editorialCode || '');
    const editorial = String(editorialCode || '');
    const driver = String(driverCode || '');
    const imports = [];
    const stripImports = source => source.replace(/^\s*import\s+[^;]+;\s*$/gm, match => {
      const statement = match.trim();
      if (statement && !imports.includes(statement)) imports.push(statement);
      return '';
    });
    const normalizedEditorial = stripImports(editorial)
      .replace(/\bpublic\s+(?=(?:(?:abstract|final)\s+)?(?:class|interface|enum|record)\b)/g, '');
    const normalizedDriver = stripImports(driver);
    return `${imports.join('\n')}\n\n${normalizedDriver.trim()}\n\n${normalizedEditorial.trim()}\n`;
  }

// Mentor-side expected-output generation follows the same policy as normal
// coding runs: use the student's browser runtime first, and send the complete
// generation request to the authoritative remote worker only if the browser
// runtime is unavailable or produces an error. The server still freezes and
// stores the final outputs, so this optimization never changes grading rules.
async function generateCodingOutputsWithFallback(language, editorialCode, inputs, templateType, driverCode, onProgress) {
  const normalized = String(language || '').toLowerCase();
  const canRunLocally = typeof ClientExecution !== 'undefined' && ClientExecution.supports(normalized);
  const source = normalized === 'java'
    ? assembleJavaExecutionSource(editorialCode, driverCode, templateType)
    : (templateType === 'solve_function' && driverCode
      ? `${editorialCode}\n\n${driverCode}`
      : editorialCode);
  let localFailure = '';

  if (canRunLocally) {
    onProgress?.(`Preparing ${normalized.toUpperCase()} browser runtime…`);
    const outputs = [];
    for (let index = 0; index < inputs.length; index += 1) {
      onProgress?.(`Compiling test case ${index + 1}/${inputs.length} on this device…`);
      const result = await ClientExecution.run(normalized, source, inputs[index] || '', {
        timeoutMs: normalized === 'java' || normalized === 'c' || normalized === 'cpp' ? 60000 : 30000,
        fileName: normalized === 'java' ? 'Main.java' : `main.${normalized}`,
        // Forward the runtime's real worker events into the Test Cases log.
        // This keeps the mentor informed about actual setup/compile/run work
        // instead of displaying a guessed list of static phases.
        onProgress: progress => {
          if (progress && progress.detail) onProgress?.(progress.detail);
        }
      });
      if (isExecutionFailure(result)) {
        localFailure = String(result?.stderr || 'The browser runtime could not generate the expected output.');
        break;
      }
      outputs.push(String(result.stdout || ''));
      onProgress?.(`Test case ${index + 1}/${inputs.length} completed on this device.`);
    }
    if (!localFailure && outputs.length === inputs.length) {
      onProgress?.('All expected outputs generated on this device.');
      return { status: 'ok', outputs, executionOrigin: 'local' };
    }
    onProgress?.(`On-device generation failed${localFailure ? `: ${localFailure.slice(0, 160)}` : ''}`);
    onProgress?.('Submitting the test cases to a remote worker…');
  } else {
    onProgress?.('Browser runtime unavailable; submitting the test cases to a remote worker…');
  }

  onProgress?.('Remote worker is compiling and running the test cases…');
  const remote = await apiCall(`/api/exam/room/${state.mentor.roomId}/generate_test_cases`, 'POST', {
    language: normalized,
    editorialCode,
    inputs,
    templateType,
    driverCode
  });
  if (remote.status === 'ok' && remote.outputs) {
    onProgress?.('Remote worker completed expected-output generation.');
    return { ...remote, executionOrigin: 'remote', localFailure };
  }
  onProgress?.(`Remote output generation failed: ${remote.error || 'unknown error'}`);
  return remote;
}

  // Per-question generation logs stay in the browser UI only. They are not
  // persisted with the question paper because they describe this editor
  // session, not grading data.
  const generationLogs = new Map();
  const generationModes = new Map();

  function clearGenerationLog(qId) {
    generationLogs.set(qId, []);
    generationModes.set(qId, { text: 'RUNNING', className: 'is-running' });
    const log = el(`gen-log-${qId}`);
    const lines = el(`gen-log-lines-${qId}`);
    const mode = el(`gen-log-mode-${qId}`);
    if (log) log.hidden = false;
    if (lines) lines.innerHTML = '';
    if (mode) {
      mode.textContent = 'RUNNING';
      mode.className = 'exam-generation-log-mode is-running';
    }
  }

  function appendGenerationLog(qId, message, kind = 'active') {
    const entries = generationLogs.get(qId) || [];
    entries.push({ message: String(message || ''), kind });
    generationLogs.set(qId, entries.slice(-80));
    const log = el(`gen-log-${qId}`);
    const lines = el(`gen-log-lines-${qId}`);
    if (log) log.hidden = false;
    if (!lines) return;
    const row = document.createElement('div');
    row.className = `exam-generation-log-line is-${kind}`;
    row.textContent = `[codeleaf] ${String(message || '')}`;
    lines.appendChild(row);
    lines.scrollTop = lines.scrollHeight;
  }

  function finishGenerationLog(qId, ok, origin) {
    const modeState = ok
      ? { text: origin === 'remote' ? 'REMOTE WORKER' : 'ON DEVICE', className: origin === 'remote' ? 'is-remote' : 'is-success' }
      : { text: 'FAILED', className: 'is-error' };
    generationModes.set(qId, modeState);
    const mode = el(`gen-log-mode-${qId}`);
    if (!mode) return;
    mode.textContent = modeState.text;
    mode.className = `exam-generation-log-mode ${modeState.className}`;
  }

  function canonicalExamOutput(value) {
    if (Array.isArray(value)) return value.map(canonicalExamOutput);
    if (value && typeof value === 'object') {
      return Object.keys(value).sort().reduce((result, key) => {
        result[key] = canonicalExamOutput(value[key]);
        return result;
      }, {});
    }
    return value;
  }

  function examOutputsMatch(actual, expected) {
    return JSON.stringify(canonicalExamOutput(actual)) === JSON.stringify(canonicalExamOutput(expected));
  }

  function renderQuestionHtml(q) {
    const source = q && q.text ? q.text : '';
    let html = typeof marked !== 'undefined'
      ? marked.parse(source)
      : escapeExamHtml(source).replace(/\n/g, '<br>');
    (q && Array.isArray(q.media) ? q.media : []).forEach(media => {
      if (!media || !media.id) return;
      const token = escapeExamHtml(`[media:${media.id}]`);
      const url = escapeExamHtml(media.url || `/api/exam/room/${state.student.roomId || state.mentor.roomId}/media/${media.id}`);
      const label = escapeExamHtml(media.name || 'Question media');
      const tag = media.type === 'video' || String(media.mime || '').startsWith('video/')
        ? `<video class="exam-question-media exam-question-video" controls preload="metadata" aria-label="${label}" src="${url}"></video>`
        : `<img class="exam-question-media" loading="lazy" alt="${label}" src="${url}"/>`;
      html = html.split(token).join(tag);
    });
    return html;
  }

  function formatSqlTable(result) {
    if (typeof renderSqlResultTable === 'function') return renderSqlResultTable(result, 'exam-sql-result');
    return '<span style="color:var(--text3)">// SQL table renderer unavailable</span>';
  }

  // One execution path for SQL questions in both mentor and student views.
  // The server route is backed by SqlService, so SQL questions get the same
  // MySQL-compatible parser, constraints, joins, aggregates, and limits.
  async function runExamSql(roomId, datasetIds, query, limit = 10000) {
    return apiCall(`/api/exam/room/${roomId}/query`, 'POST', {
      datasetIds,
      query,
      queryType: 'sql',
      type: 'sql',
      limit,
    });
  }

  function renderExamSqlResult(result, emptyMessage = '-- No rows returned') {
    if (!result || result.status !== 'ok') {
      return `<span style="color:var(--red)">${escapeExamHtml((result && result.error) || '-- SQL execution failed')}</span>`;
    }
    if (!Array.isArray(result.columns) || result.columns.length === 0) {
      return `<span style="color:var(--green2)">${escapeExamHtml(emptyMessage)}</span>`;
    }
    return formatSqlTable(result);
  }

    function questionMediaControls(qId) {
    return `<div style="display:flex;align-items:center;gap:8px;margin-top:7px;flex-wrap:wrap">
      <button type="button" class="exam-btn exam-btn-secondary" style="font-size:11px;padding:5px 8px" onclick="document.getElementById('qmedia-${qId}').click()">Add image/video</button>
      <input id="qmedia-${qId}" type="file" accept="image/*,video/*" hidden onchange="ExamPortal.mentor.uploadQuestionMedia('${qId}',event)"/>
      <span style="font-size:10px;color:var(--text3)">Up to 30 MB; inserted at the cursor.</span>
    </div>
    <div id="qmedia-list-${qId}"></div>
    <div style="margin-top:10px;border-top:1px solid var(--border2);padding-top:8px">
      <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.4px;margin-bottom:5px">Live student preview</div>
      <div id="qmedia-preview-${qId}" class="exam-question-preview"></div>
    </div>`;
  }

  function showPanel(panelId) {
    const panels = document.querySelectorAll('.exam-overlay');
    panels.forEach(p => p.classList.remove('active'));
    const target = el(panelId);
    if (target) target.classList.add('active');

    // Prevent accidental page refresh during active exam sessions
    if (['exam-mentor-dash-panel', 'exam-student-wait-panel', 'exam-student-exam-panel'].includes(panelId)) {
      window.onbeforeunload = function(e) {
        const msg = "Do not refresh your screen, Site will auto-refresh, Else Test will be cancelled";
        if (e) e.returnValue = msg;
        return msg;
      };
    } else {
      window.onbeforeunload = null;
    }
  }

  function isStudentKicked(kicked, studentId) {
    if (!kicked || !studentId) return false;
    if (Array.isArray(kicked)) return kicked.includes(studentId);
    if (typeof kicked === 'object') return Object.prototype.hasOwnProperty.call(kicked, studentId);
    return false;
  }

  function showAppWarningModal(title, message, onConfirm) {
    if (el('warning-modal-title')) {
      el('warning-modal-title').textContent = title;
      el('warning-modal-title').style.color = '#ff4d4d';
    }
    if (el('warning-modal-message')) {
      el('warning-modal-message').textContent = message;
    }

    const btn = el('warning-modal-btn');
    if (btn) {
      btn.className = 'exam-btn exam-btn-red exam-btn-full';
      btn.style.cssText = '';
      btn.textContent = 'Acknowledge';
      btn.onclick = () => {
        const modal = el('exam-warning-modal');
        if (modal) modal.classList.remove('open');
        if (onConfirm) onConfirm();
      };
    }

    const modal = el('exam-warning-modal');
    if (modal) modal.classList.add('open');
  }

  // Cleanup room on mentor page unload/hide if they forcefully leave
  window.addEventListener('pagehide', function() {
    if (state.mentor && state.mentor.roomId && state.mentor.mentorId) {
      const url = `/api/exam/room/${state.mentor.roomId}/cleanup`;
      const data = JSON.stringify({ mentorId: state.mentor.mentorId });
      navigator.sendBeacon(url, data);
    }
  });

  function hideAllExam() {
    document.querySelectorAll('.exam-overlay').forEach(p => p.classList.remove('active'));
  }

  function formatTime(seconds) {
    if (seconds < 0) seconds = 0;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function timeAgo(ts) {
    if (!ts) return '';
    const diff = Math.floor((Date.now() / 1000) - ts);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
  }

  // Time remaining until a student's assessment window closes. The server
  // sends seconds left; we convert that to a local deadline so the label can
  // tick down between the 5-second leaderboard polls.
  function fmtTimeLeft(seconds) {
    if (seconds === null || seconds === undefined || isNaN(seconds)) return '—';
    const total = Math.max(0, Math.floor(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return (h > 0 ? h + ':' : '') + pad(m) + ':' + pad(s);
  }

  function tickLeaderboardCountdowns() {
    const cells = document.querySelectorAll('#mentor-lb-tbody .exam-lb-countdown[data-deadline]');
    if (!cells.length) return;
    const nowSecs = Date.now() / 1000;
    cells.forEach((cell) => {
      const deadline = Number(cell.getAttribute('data-deadline'));
      if (!deadline) return;
      const left = deadline - nowSecs;
      cell.textContent = fmtTimeLeft(left);
      cell.classList.toggle('is-low', left <= 60);
    });
  }

  setInterval(tickLeaderboardCountdowns, 1000);

  function copyText(text) {
    navigator.clipboard.writeText(text).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    });
  }

  function showMsg(elId, text, isError = false) {
    const e = el(elId);
    if (!e) return;
    e.textContent = text;
    e.className = isError ? 'exam-error-msg' : 'exam-info-msg';
    e.style.display = text ? 'block' : 'none';
  }

  function setStudentSaveState(label, tone = 'saved') {
    const saveEl = el('student-save-state');
    if (!saveEl) return;
    saveEl.textContent = label;
    saveEl.classList.remove('is-saving', 'is-dirty', 'is-error');
    if (tone === 'saving') saveEl.classList.add('is-saving');
    if (tone === 'dirty') saveEl.classList.add('is-dirty');
    if (tone === 'error') saveEl.classList.add('is-error');
  }

  async function apiCall(url, method = 'GET', body = null) {
    try {
      const opts = {
        method,
        headers: { 'Content-Type': 'application/json' },
      };
      if (body) opts.body = JSON.stringify(body);
      const res = await fetch(url, opts);
      return await res.json();
    } catch (e) {
      return { status: 'error', error: '// Connection error — retrying...' };
    }
  }

  function renderParticipants(participants, bodyId, countId) {
    const body = el(bodyId);
    const countEl = el(countId);
    if (!body) return;
    if (!participants || participants.length === 0) {
      body.innerHTML = '<div class="exam-participants-empty">// No participants yet</div>';
      if (countEl) countEl.textContent = '(0)';
      return;
    }
    if (countEl) countEl.textContent = `(${participants.length})`;
    const isMentor = bodyId === 'mentor-participants-body' && state.mentor.status !== 'waiting';
    body.innerHTML = participants.map(p => `
      <div class="exam-participant-row">
        <div class="exam-participant-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
        </div>
        <div class="exam-participant-info">
          <div class="exam-participant-name">${p.name || 'Unknown'}</div>
          <div class="exam-participant-meta">
            <span>${p.rollNo || '-'}</span>
            <span class="exam-participant-branch">${p.branch || '-'}${p.section ? ' (Sec ' + p.section + ')' : ''}</span>
          </div>
        </div>
        <span class="exam-participant-time">${timeAgo(p.joinedAt)}</span>
        ${isMentor ? `
          <div style="display:flex; gap:6px; width:100%; justify-content:flex-end; margin-top:4px;">
            <button class="phbtn" style="width:auto;height:auto;color:${(p.fullscreenExits || p.copyPasteAttempts) ? '#f59e0b' : '#858585'};padding:3px 7px;border:1px solid ${(p.fullscreenExits || p.copyPasteAttempts) ? 'rgba(245,158,11,0.3)' : 'var(--border)'};border-radius:4px;background:rgba(245,158,11,0.05);font-size:11px;display:flex;align-items:center;gap:3px;cursor:pointer"
              onclick="ExamPortal.mentor.showFlaggedDetails('${p.name.replace(/'/g, "\\'")}', ${p.fullscreenExits || 0}, ${p.copyPasteAttempts || 0}, ${p.lastFlaggedAt || 0})"
              title="View proctoring logs">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
              Flags: ${(p.fullscreenExits || 0) + (p.copyPasteAttempts || 0)}
            </button>
            
            <button class="phbtn" style="width:auto;height:auto;color:#ff4d4d;padding:3px 7px;border:1px solid rgba(255,77,77,0.3);border-radius:4px;background:rgba(255,77,77,0.1);font-size:11px;display:flex;align-items:center;gap:3px;cursor:pointer"
              onclick="ExamPortal.mentor.removeStudent('${p.studentId}', '${p.name.replace(/'/g, "\\'")}')"
              title="Remove student from test">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
              Remove
            </button>
          </div>
        ` : ''}
      </div>
    `).join('');
  }

  // ── Main navigation ────────────────────────────────────────────────────────
  function showRoleSelection() {
    // Keep every entry point protected, including command palette/menu and
    // direct calls from the console or other feature modules.
    if (window.Auth && !Auth.user) {
      Auth.open(() => showRoleSelection());
      return;
    }
    showPanel('exam-role-panel');
  }

  function resetStudentState() {
    // 1. Clear intervals & timeouts
    if (state.student.pollInterval) {
      clearInterval(state.student.pollInterval);
    }
    if (state.student.timerInterval) {
      clearInterval(state.student.timerInterval);
    }
    if (state.student.autoSaveTimeout) {
      clearTimeout(state.student.autoSaveTimeout);
    }

    // 2. Destroy CodeMirror instance
    if (state.student.examEditor) {
      try {
        state.student.examEditor.toTextArea();
      } catch (e) {}
      state.student.examEditor = null;
    }

    // 3. Clear localStorage credentials
    localStorage.removeItem('exam_student_id');
    localStorage.removeItem('exam_student_room');

    // 4. Reset entire student namespace object properties
    state.student.roomId = null;
    state.student.studentId = null;
    state.student.name = '';
    state.student.rollNo = '';
    state.student.branch = '';
    state.student.questions = [];
    state.student.datasets = [];
    state.student.roomStatus = 'live';
    state.student.fullscreenMode = false;
    state.student.fullscreenActive = false;
    state.student.blockCopyPaste = false;
    state.student.maxFullscreenExits = null;
    state.student.fullscreenExitCount = 0;
    state.student.status = {};
    state.student.pollInterval = null;
    state.student.timerInterval = null;
    clearInterval(state.student.fullscreenWatchInterval);
    state.student.fullscreenWatchInterval = null;
    state.student.currentQIdx = null;
    state.student.autoSaveTimeout = null;
    state.student.ignoreFullscreenChange = false;
    state.student.finalSubmissionConfirmed = false;
    state.student.finalSubmissionInFlight = false;
    state.student.copiedFromEditor = false;
    state.student.lastInternalCopiedText = '';
    state.student.isPasting = false;
    state.student.lastRunOutput = null;
    state.student.hasRunOnce = false;
    state.student.activeTab = 'readme';
    state.student.sampleCases = [];
    state.student.runResults = {};
    state.student.activeConsoleTab = null;
    state.student.customStdin = '';

    // 5. Clean up Exam Portal DOM elements completely to prevent visual artifacts
    const yoursPane = el('student-pane-yours');
    if (yoursPane) yoursPane.innerHTML = '<span style="color:var(--text3)">// Run a query to see output here</span>';

    const expectedPane = el('student-pane-expected');
    if (expectedPane) expectedPane.innerHTML = '<span style="color:var(--text3)">// Select or run a query to load expected preview</span>';

    const stdinInput = el('student-stdin-input');
    if (stdinInput) {
      stdinInput.value = '';
      stdinInput.readOnly = false;
      stdinInput.style.opacity = '1';
    }

    const consoleStatus = el('student-console-status');
    if (consoleStatus) {
      consoleStatus.textContent = '— Ready';
      consoleStatus.style.color = 'var(--text3)';
    }

    const tabsBar = el('student-console-tabs-bar');
    if (tabsBar) {
      tabsBar.innerHTML = '';
    }

    const qProgress = el('student-q-progress');
    if (qProgress) {
      qProgress.textContent = 'Q 0/0';
    }
  }

  function exitToHome() {
    hideAllExam();
    resetStudentState();
    // Ensure intro is shown
    showView('intro');
  }

  function selectRole(role) {
    state.mentor.isPlayback = false;
    if (role === 'mentor') {
      // Generate room ID preview and show create form
      _genPreviewRoomId();
      showPanel('exam-mentor-create-panel');
    } else {
      resetStudentState();
      showPanel('exam-student-join-panel');
    }
  }

  // ── Mentor: Room ID Generation ─────────────────────────────────────────────
  async function _genPreviewRoomId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const part2 = Array.from({ length: 3 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const roomId = `MNG-${part2}`;
    el('mentor-room-id-display').textContent = roomId;
    state.mentor.roomId = roomId;
  }

  // ── MENTOR NAMESPACE ───────────────────────────────────────────────────────
  const mentor = {

    copyRoomId() {
      const rid = state.mentor.roomId;
      if (rid) {
        copyText(rid);
        // Brief visual feedback
        const badge = el('mentor-room-id-badge') || el('mentor-dash-room-id');
        if (badge) {
          const prev = badge.textContent;
          badge.style.color = 'var(--green2)';
          setTimeout(() => badge.style.color = '', 800);
        }
      }
    },

    toggleParticipantsPanel() {
      mentor.setParticipantsOpen(!state.mentor.participantsOpen);
    },

    setParticipantsOpen(open) {
      state.mentor.participantsOpen = Boolean(open);
      const panel = el('mentor-participants-panel');
      const sidebar = document.querySelector('#exam-mentor-dash-panel .exam-dash-right');
      const button = el('btn-toggle-participants');
      const isWaiting = state.mentor.status === 'waiting';
      if (panel) panel.style.display = isWaiting && state.mentor.participantsOpen ? 'flex' : 'none';
      if (sidebar) sidebar.style.display = isWaiting && state.mentor.participantsOpen ? 'flex' : 'none';
      if (button) {
        button.style.display = isWaiting ? 'flex' : 'none';
        button.classList.toggle('active', state.mentor.participantsOpen);
        button.title = state.mentor.participantsOpen ? 'Hide participants' : 'Show participants';
      }
    },

    toggleTimed(checked) {
      el('mentor-duration-field').style.display = checked ? 'block' : 'none';
    },

    toggleFullscreenRule(checked) {
      el('mentor-max-exits-field').style.display = checked ? 'block' : 'none';
    },

    toggleCopyPasteRule(checked) {
      const field = el('mentor-max-copypaste-field');
      if (field) field.style.display = checked ? 'block' : 'none';
    },

    showFlaggedDetails(studentName, fullscreenExits, copyPasteAttempts, lastFlaggedAt) {
      const timeStr = lastFlaggedAt ? new Date(lastFlaggedAt * 1000).toLocaleString() : 'Never';
      const modal = el('exam-warning-modal');
      const title = el('warning-modal-title');
      const message = el('warning-modal-message');
      const btn = el('warning-modal-btn');
      if (!modal || !title || !message || !btn) return;
      title.textContent = `Proctoring log · ${studentName}`;
      title.style.color = '#dcb66a';
      message.innerHTML = `
        <div class="exam-proctor-summary">
          <div class="exam-proctor-metric"><span>Fullscreen exits</span><strong>${Number(fullscreenExits) || 0}</strong></div>
          <div class="exam-proctor-metric"><span>Copy / paste attempts</span><strong>${Number(copyPasteAttempts) || 0}</strong></div>
        </div>
        <div class="exam-proctor-last-flag"><span>Last flagged event</span><strong>${escapeExamHtml(timeStr)}</strong></div>
      `;
      btn.onclick = () => modal.classList.remove('open');
      modal.classList.add('exam-proctor-log-modal');
      modal.classList.add('open');
      if (btn) {
        btn.className = 'exam-btn exam-btn-secondary exam-btn-full';
        btn.style.cssText = '';
        btn.textContent = 'Close Log';
      }
    },

    async createRoom() {
      const title = el('mentor-title').value.trim();
      if (!title) {
        el('mentor-title').classList.add('has-err');
        el('mentor-title-err').textContent = '// Title is required';
        el('mentor-title-err').style.display = 'block';
        return;
      }
      el('mentor-title').classList.remove('has-err');
      el('mentor-title-err').style.display = 'none';

      const timed = el('mentor-timed-toggle').checked;
      const duration = parseInt(el('mentor-duration').value) || 60;
      const fullscreenMode = el('mentor-fullscreen-toggle').checked;
      const blockCopyPaste = el('mentor-block-copypaste-toggle').checked;
      const maxFullscreenExits = parseInt(el('mentor-max-exits').value) || 5;
      const maxCopyPasteAttempts = Math.max(1, Math.min(parseInt(el('mentor-max-copypaste').value) || 3, 50));
      const mentorId = state.mentor.mentorId || genId();
      const roomId = state.mentor.roomId;

      el('btn-create-room').disabled = true;
      el('btn-create-room').textContent = 'Creating...';

      const res = await apiCall('/api/exam/room/create', 'POST', {
        title, mentorId, timed, duration, roomId, fullscreenMode, blockCopyPaste, maxFullscreenExits, maxCopyPasteAttempts
      });

      if (res.status === 'ok') {
        state.mentor.roomId = res.roomId || roomId;
        state.mentor.mentorId = res.mentorId || mentorId;
        state.mentor.title = title;
        state.mentor.timed = timed;
        state.mentor.duration = duration;
        state.mentor.fullscreenMode = fullscreenMode;
        state.mentor.blockCopyPaste = blockCopyPaste;
        state.mentor.maxFullscreenExits = maxFullscreenExits;
        state.mentor.maxCopyPasteAttempts = maxCopyPasteAttempts;
        state.mentor.status = 'waiting';
        state.mentor.questions = [];
        state.mentor.datasets = [];

        // Persist to localStorage
        localStorage.setItem('exam_mentor_id', state.mentor.mentorId);
        localStorage.setItem('exam_room_id', state.mentor.roomId);

        // If a pre-loaded paper exists, import its questions & datasets now
        if (state.mentor.pendingPaper) {
          el('btn-create-room').textContent = 'Running & freezing template queries...';
          await mentor.loadPaperData(state.mentor.roomId, state.mentor.mentorId, state.mentor.pendingPaper);
          state.mentor.pendingPaper = null; // Clear it
        }

        el('btn-create-room').disabled = false;
        el('btn-create-room').innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="white"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg> Create Room';

        mentor.initDashboard();
      } else {
        el('btn-create-room').disabled = false;
        el('btn-create-room').innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="white"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg> Create Room';
        el('mentor-create-err').textContent = res.error || 'Failed to create room';
        el('mentor-create-err').style.display = 'block';
      }
    },

    loadPaperForCreate(input) {
      const file = input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const paper = JSON.parse(e.target.result);
          if (!paper.questions) {
            showExamAlert('Invalid quiz paper template file.', { title: 'Invalid Template', danger: true });
            return;
          }

          // Save pending paper configuration
          state.mentor.pendingPaper = paper;

          // Populate creation form fields
          el('mentor-title').value = paper.title || 'Imported Quiz';
          const isTimed = paper.timed === '1' || paper.timed === true;
          el('mentor-timed-toggle').checked = isTimed;
          mentor.toggleTimed(isTimed);
          el('mentor-duration').value = parseInt(paper.duration) || 60;

          // Populate proctoring configurations from imported paper
          const fullscreen = paper.fullscreenMode === '1' || paper.fullscreenMode === true;
          if (el('mentor-fullscreen-toggle')) el('mentor-fullscreen-toggle').checked = fullscreen;
          mentor.toggleFullscreenRule(fullscreen);

          const maxExits = parseInt(paper.maxFullscreenExits) || 5;
          if (el('mentor-max-exits')) el('mentor-max-exits').value = maxExits;

          const blockCopy = paper.blockCopyPaste === '1' || paper.blockCopyPaste === true;
          if (el('mentor-block-copypaste-toggle')) el('mentor-block-copypaste-toggle').checked = blockCopy;
          mentor.toggleCopyPasteRule(blockCopy);
          if (el('mentor-max-copypaste')) el('mentor-max-copypaste').value = parseInt(paper.maxCopyPasteAttempts) || 3;

          showExamAlert(`Successfully pre-loaded quiz template: "${paper.title || 'Imported'}" (${paper.questions.length} questions, ${paper.datasets ? paper.datasets.length : 0} datasets).\n\nClick "Create Room" to instantiate the test.`, { title: 'Template Loaded' });

        } catch (err) {
          showExamAlert('Failed to parse quiz template JSON: ' + err.message, { title: 'Parse Error', danger: true });
        }
      };
      reader.readAsText(file);
      input.value = '';
    },

    async loadPaperData(roomId, mentorId, paper) {
      try {
        const datasetIdMap = {};
        const paperDatasets = paper.datasets || [];

        // 1. Sequentially upload each dataset
        for (const ds of paperDatasets) {
          try {
            const res = await apiCall(`/api/exam/room/${roomId}/dataset`, 'POST', {
              mentorId,
              name: ds.name,
              docs: ds.docs || [],
            });
            if (res.status === 'ok') {
              datasetIdMap[ds.datasetId] = res.datasetId;
              state.mentor.datasets.push({
                datasetId: res.datasetId,
                name: res.name,
                collection: res.collection,
                docCount: res.docCount,
              });
            }
          } catch (e) {
            console.error("Failed to load dataset:", ds.name, e);
          }
        }

        // 2. Map dataset IDs inside questions
        const questions = (paper.questions || []).map(q => {
          const mappedQ = { ...q };
          if (!mappedQ.datasetIds) {
            mappedQ.datasetIds = mappedQ.datasetId ? [mappedQ.datasetId] : [];
          }
          mappedQ.datasetIds = mappedQ.datasetIds.map(id => datasetIdMap[id] || id);
          if (mappedQ.datasetId) {
            mappedQ.datasetId = datasetIdMap[mappedQ.datasetId] || mappedQ.datasetId;
          }
          return mappedQ;
        });

        // 2b. Detach embedded media payloads (re-uploaded after questions exist)
        const mediaByQId = {};
        questions.forEach(q => {
          if (Array.isArray(q.mediaData) && q.mediaData.length > 0) {
            mediaByQId[q.id] = q.mediaData;
            delete q.mediaData;
          }
        });

        // 3. Save the questions to Redis
        state.mentor.questions = questions;
        await apiCall(`/api/exam/room/${roomId}/questions`, 'POST', {
          mentorId,
          questions
        });

        // 4. Re-upload embedded media files and rewrite [media:<id>] tokens
        let mediaReuploaded = 0;
        for (const q of questions) {
          const mediaList = mediaByQId[q.id];
          if (!mediaList) continue;
          q.media = Array.isArray(q.media) ? q.media : [];
          for (const md of mediaList) {
            try {
              const blob = await (await fetch(md.dataUri)).blob();
              const form = new FormData();
              form.append('mentorId', mentorId);
              form.append('file', blob, md.filename || 'media');
              const uploadRes = await fetch(`/api/exam/room/${roomId}/question/${q.id}/media`, { method: 'POST', body: form });
              const uploadJson = await uploadRes.json().catch(() => ({}));
              if (uploadRes.ok && uploadJson.status === 'ok' && uploadJson.media) {
                const oldId = md.id;
                const newId = uploadJson.media.id;
                if (oldId !== newId) {
                  q.text = (q.text || '').split(`[media:${oldId}]`).join(`[media:${newId}]`);
                }
                q.media = q.media.filter(x => x.id !== oldId);
                q.media.push(uploadJson.media);
                mediaReuploaded++;
              }
            } catch (mediaErr) {
              console.error('Failed to re-upload media for question', q.id, mediaErr);
            }
          }
        }
        if (mediaReuploaded > 0) {
          await apiCall(`/api/exam/room/${roomId}/questions`, 'POST', {
            mentorId,
            questions
          });
        }

      } catch (err) {
        console.error("Error loading paper data:", err);
        showExamAlert("Failed to load paper questions completely: " + err.message, { title: 'Load Error', danger: true });
      }
    },


    async exportPaper() {
      if (!state.mentor.roomId || !state.mentor.mentorId) return;
      try {
        const res = await apiCall(`/api/exam/room/${state.mentor.roomId}/paper?mentorId=${state.mentor.mentorId}`);
        if (res.status === 'ok') {
          // Embed media files as base64 data URIs so the export is fully self-contained
          for (const q of res.questions || []) {
            if (!Array.isArray(q.media) || q.media.length === 0) continue;
            q.mediaData = [];
            for (const m of q.media) {
              try {
                const mediaRes = await fetch(`/api/exam/room/${state.mentor.roomId}/media/${m.id}`);
                if (!mediaRes.ok) continue;
                const blob = await mediaRes.blob();
                const dataUri = await new Promise((resolve, reject) => {
                  const reader = new FileReader();
                  reader.onload = () => resolve(reader.result);
                  reader.onerror = reject;
                  reader.readAsDataURL(blob);
                });
                q.mediaData.push({ id: m.id, filename: m.filename || 'media', contentType: m.contentType || blob.type, size: m.size || blob.size, dataUri });
              } catch (mediaErr) {
                console.error('Failed to embed media', m.id, mediaErr);
              }
            }
            if (q.mediaData.length === 0) delete q.mediaData;
          }
          const blob = new Blob([JSON.stringify(res, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${res.title.replace(/\s+/g, '_')}_questions.json`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        } else {
          showExamAlert(res.error || 'Failed to export question paper', { title: 'Export Failed', danger: true });
        }
      } catch (e) {
        showExamAlert('Failed to connect to export question paper', { title: 'Export Failed', danger: true });
      }
    },

    initDashboard() {
      const { roomId, title, status } = state.mentor;

      // Update header
      el('mentor-dash-title').textContent = `${title} — ${roomId}`;
      el('mentor-dash-room-id').textContent = roomId;
      if (el('mentor-dash-room-id')) el('mentor-dash-room-id').textContent = roomId;
      if (el('mentor-top-room-id')) el('mentor-top-room-id').textContent = roomId;

      // Update status chip
      mentor._updateStatusUI(status);

      // Counts
      mentor._updateQCounts();

      // Start polling participants
      mentor._startParticipantPoll();

      showPanel('exam-mentor-dash-panel');
      mentor.setParticipantsOpen(false);
      mentor.setTab('questions');

      // Auto-select first question if questions are loaded and none is currently active
      if (state.mentor.questions && state.mentor.questions.length > 0 && !state.mentor.currentQId) {
        mentor.selectQuestion(state.mentor.questions[0].id);
      }
    },

    _updateStatusUI(status) {
      state.mentor.status = status;
      const chips = [el('mentor-status-chip'), el('mentor-sidebar-chip')];
      chips.forEach(chip => {
        if (!chip) return;
        chip.className = 'exam-status-chip';
        if (status === 'waiting') {
          chip.classList.add('exam-chip-waiting');
          chip.textContent = 'WAITING';
        } else if (status === 'live') {
          chip.classList.add('exam-chip-live');
          chip.textContent = 'LIVE';
        } else {
          chip.classList.add('exam-chip-ended');
          chip.textContent = state.mentor.isPlayback ? 'PLAYBACK' : 'ENDED';
        }
      });

      const rightSidebar = document.querySelector('.exam-dash-right');

      // Buttons
      if (el('btn-view-removed')) el('btn-view-removed').style.display = 'none';
      if (status === 'waiting') {
        el('btn-start-exam').style.display = 'flex';
        el('btn-end-exam').style.display = 'none';
        el('mentor-participants-panel').style.display = state.mentor.participantsOpen ? 'flex' : 'none';
        el('mentor-export-panel').style.display = 'none';
        if (rightSidebar) rightSidebar.style.display = state.mentor.participantsOpen ? 'flex' : 'none';
        if (el('btn-toggle-participants')) el('btn-toggle-participants').style.display = 'flex';
      } else if (status === 'live') {
        el('btn-start-exam').style.display = 'none';
        el('btn-end-exam').style.display = 'flex';
        el('mentor-participants-panel').style.display = 'none';
        el('mentor-export-panel').style.display = 'none';
        if (rightSidebar) rightSidebar.style.display = 'none'; // Hide sidebar during live test
        if (el('btn-toggle-participants')) el('btn-toggle-participants').style.display = 'none';
        // Keep the question editor available so the mentor can update a live paper.
        el('mentor-tab-live').style.display = 'flex';
        el('mentor-tab-questions').style.display = 'flex';
        mentor.setTab('live');
        if (!state.mentor.isPlayback) {
          mentor._startLeaderboardPoll();
        }
        if (el('btn-view-removed')) el('btn-view-removed').style.display = 'flex';
        // Start timer if timed
        if (state.mentor.timed && state.mentor.startedAt) {
          mentor._startTimer();
        }
      } else if (status === 'ended') {
        el('btn-start-exam').style.display = 'none';
        el('btn-end-exam').style.display = 'none';
        // Show export panel
        el('mentor-participants-panel').style.display = 'none';
        el('mentor-export-panel').style.display = 'flex';
        if (rightSidebar) rightSidebar.style.display = 'flex'; // Show sidebar for results export
        if (el('btn-toggle-participants')) el('btn-toggle-participants').style.display = 'none';
        // Stop polls
        clearInterval(state.mentor.participantInterval);
        clearInterval(state.mentor.lbInterval);
        clearInterval(state.mentor.timerInterval);
      }
    },

    _startTimer() {
      const { startedAt, duration } = state.mentor;
      if (!startedAt || !state.mentor.timed) return;
      el('mentor-timer-row').style.display = 'flex';

      clearInterval(state.mentor.timerInterval);
      state.mentor.timerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() / 1000) - startedAt);
        const remaining = (duration * 60) - elapsed;
        const timerEl = el('mentor-timer-display');
        if (!timerEl) return;
        timerEl.textContent = formatTime(remaining);
        timerEl.className = 'exam-timer-display';
        if (remaining <= 60) timerEl.classList.add('exam-timer-critical');
        else if (remaining <= 300) timerEl.classList.add('exam-timer-warning');
        if (remaining <= 0) {
          clearInterval(state.mentor.timerInterval);
          mentor.endExam();
        }
      }, 1000);
    },

    _updateQCounts() {
      const qs = state.mentor.questions;
      const maxScore = qs.reduce((sum, q) => sum + (parseInt(q.marks) || 0), 0);
      if (el('mentor-q-count')) el('mentor-q-count').textContent = qs.length;
      if (el('mentor-max-score')) el('mentor-max-score').textContent = maxScore;
      if (el('mentor-questions-summary')) el('mentor-questions-summary').textContent = `${qs.length} · ${maxScore} pts`;
    },

    setTab(tab) {
      ['questions', 'dataset', 'live'].forEach(t => {
        const tabEl = el(`mentor-tab-${t}`);
        const paneEl = el(`mentor-pane-${t}`);
        if (tabEl) tabEl.classList.toggle('active', t === tab);
        if (paneEl) paneEl.classList.toggle('active', t === tab);
      });
      if (tab === 'questions') {
        mentor._renderQList();
      } else if (tab === 'dataset') {
        mentor._renderDatasetTable();
      } else if (tab === 'live') {
        mentor._startLeaderboardPoll();
      }
    },

    // ── Question Builder ───────────────────────────────────────────────────

    addQuestion(type) {
      const id = genId();
      const q = {
        id,
        type,
        text: '',
        marks: 10,
        datasetIds: [],
        datasetId: '',
        // Query specific
        expectedQuery: type === 'sql' ? 'SELECT * FROM users LIMIT 10;' : '',
        answerFrozen: false,
        answerDocCount: 0,
        media: [],
        // MCQ specific
        options: type === 'mcq' ? ['', '', '', ''] : [],
        correctOption: type === 'mcq' ? 0 : null,
        // Coding specific
        language: type === 'coding' ? 'python' : (type === 'sql' ? 'sql' : ''),
        starterCode: type === 'coding' ? '# write your code here\n' : '',
        testCases: type === 'coding' ? [{input: '', expectedOutput: ''}] : [],
      };
      state.mentor.questions.push(q);
      state.mentor.currentQId = id;
      mentor._renderQList();
      mentor._renderQEditor(id);
      mentor._saveQuestions();
    },

    deleteQuestion(qId) {
      state.mentor.questions = state.mentor.questions.filter(q => q.id !== qId);
      if (state.mentor.currentQId === qId) {
        state.mentor.currentQId = null;
        el('mentor-qeditor').innerHTML = '<div class="exam-qeditor-empty" id="mentor-qeditor-empty"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" stroke-width="1.5"><path stroke-linecap="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg><div style="font-size:13px;color:var(--text3);text-align:center;font-family:\'JetBrains Mono\',monospace">// Select or add a question to edit it</div></div>';
      }
      mentor._renderQList();
      mentor._updateQCounts();
      mentor._saveQuestions();
    },

    _renderQList() {
      const body = el('mentor-qlist-body');
      const qs = state.mentor.questions;
      if (qs.length === 0) {
        body.innerHTML = '<div class="exam-qlist-empty">// No questions yet<br/>Click button below to add questions</div>';
        return;
      }
      body.innerHTML = qs.map((q, i) => {
        let typeLabel = 'QUERY';
        let typeClass = 'exam-q-type-query';
        if (q.type === 'sql') {
          typeLabel = 'SQL';
          typeClass = 'exam-q-type-sql';
        } else if (q.type === 'mcq') {
          typeLabel = 'MCQ';
          typeClass = 'exam-q-type-mcq';
        } else if (q.type === 'coding') {
          typeLabel = 'CODING';
          typeClass = 'exam-q-type-coding';
        }
        return `
        <div class="exam-q-card ${state.mentor.currentQId === q.id ? 'active' : ''}"
             id="qcard-${q.id}" onclick="ExamPortal.mentor.selectQuestion('${q.id}')">
          <div class="exam-q-card-top">
            <span class="exam-q-num">Q${i + 1}</span>
            <span class="exam-q-type-chip ${typeClass}">${typeLabel}</span>
            <span class="exam-q-marks-badge">${q.marks}pts</span>
            <button class="phbtn" style="margin-left:auto;color:var(--red)" title="Delete"
              onclick="event.stopPropagation();ExamPortal.mentor.deleteQuestion('${q.id}')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>
          </div>
          <div class="exam-q-preview">${q.text ? q.text.substring(0, 60) + (q.text.length > 60 ? '...' : '') : '// No text yet'}</div>
          ${isDataQuestion(q) && q.answerFrozen ? `<span class="exam-frozen-chip" style="font-size:10px;padding:2px 8px;margin-top:4px">Answer frozen — ${q.answerDocCount} rows</span>` : ''}
        </div>
      `;
      }).join('');
    },

    selectQuestion(qId) {
      state.mentor.currentQId = qId;
      mentor._renderQList();
      mentor._renderQEditor(qId);
    },

    toggleQDataset(qId, datasetId, checked) {
      const q = state.mentor.questions.find(x => x.id === qId);
      if (!q) return;
      if (!q.datasetIds) {
        q.datasetIds = q.datasetId ? [q.datasetId] : [];
      }
      if (checked) {
        if (!q.datasetIds.includes(datasetId)) q.datasetIds.push(datasetId);
      } else {
        q.datasetIds = q.datasetIds.filter(id => id !== datasetId);
      }
      q.datasetId = q.datasetIds[0] || '';
      mentor._saveQDebounced();
    },


    _cleanupMentorMiniEditors() {
      if (state.mentor.miniEditors) {
        Object.keys(state.mentor.miniEditors).forEach(key => {
          try { state.mentor.miniEditors[key].toTextArea(); } catch(e) {}
          delete state.mentor.miniEditors[key];
        });
      } else {
        state.mentor.miniEditors = {};
      }
    },

    switchConfigLang(lang, qId) {
      state.mentor.activeConfigLang = lang;
      mentor._renderQEditor(qId);
    },

    _renderQEditor(qId) {
      const q = state.mentor.questions.find(x => x.id === qId);
      if (!q) return;
      mentor._cleanupMentorMiniEditors();
      const qeditor = el('mentor-qeditor');

      if (isDataQuestion(q)) {
        const datasetCheckboxes = state.mentor.datasets.map(ds => {
          const isChecked = (q.datasetIds && q.datasetIds.includes(ds.datasetId)) || q.datasetId === ds.datasetId ? 'checked' : '';
          return `
            <label style="display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer;padding:2px 0">
              <input type="checkbox" value="${ds.datasetId}" ${isChecked}
                onchange="ExamPortal.mentor.toggleQDataset('${qId}',this.value,this.checked)"/>
              <span style="font-family:'JetBrains Mono',monospace">${ds.name}</span>
            </label>
          `;
        }).join('') || '<span style="color:var(--text3);font-size:11px">// No datasets uploaded yet</span>';

        qeditor.innerHTML = `
          <div class="exam-fieldset">
            <div class="exam-fieldset-title">Question Text</div>
            <textarea class="exam-textarea" id="qtext-${qId}" oninput="ExamPortal.mentor.updateQField('${qId}','text',this.value)" placeholder="Write the question for students...">${q.text}</textarea>
            <div style="display:flex;align-items:center;gap:8px;margin-top:7px;flex-wrap:wrap">
              <button type="button" class="exam-btn exam-btn-secondary" style="font-size:11px;padding:5px 8px" onclick="document.getElementById('qmedia-${qId}').click()">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-1 14H6l3.5-4.5 2.5 3.01L15.5 11 18 14.01V17zM8.5 11A1.5 1.5 0 1 0 8.5 8a1.5 1.5 0 0 0 0 3z"/></svg>
                Add image/video
              </button>
              <input id="qmedia-${qId}" type="file" accept="image/*,video/*" hidden onchange="ExamPortal.mentor.uploadQuestionMedia('${qId}',event)"/>
              <span style="font-size:10px;color:var(--text3)">Images or videos up to 30 MB. The file is inserted at the cursor position.</span>
            </div>
            <div id="qmedia-list-${qId}" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px"></div>
          </div>
          <div style="display:flex;gap:12px;align-items:flex-start">
            <div class="exam-field" style="flex:1;margin:0">
              <label class="exam-label">Marks</label>
              <input class="exam-num-input" type="number" min="1" max="100" value="${q.marks}"
                oninput="ExamPortal.mentor.updateQField('${qId}','marks',parseInt(this.value)||0)"/>
            </div>
            <div class="exam-field" style="flex:2;margin:0">
              <label class="exam-label">Datasets (select multiple for joins/aggregates)</label>
              <div style="display:flex;flex-direction:column;gap:4px;background:var(--bg);border:1px solid var(--border2);border-radius:4px;padding:6px;max-height:100px;overflow-y:auto">
                ${datasetCheckboxes}
              </div>
            </div>
          </div>
          <div class="exam-fieldset">
            <div class="exam-fieldset-title">${q.type === 'sql' ? 'Expected SQL Query (Mentor\'s Solution)' : 'Expected MongoDB Query (Mentor\'s Solution)'}</div>
            <div class="exam-mini-editor ${q.type === 'sql' ? 'exam-sql-editor' : ''}" id="mini-editor-wrap-${qId}">
              <textarea id="mini-editor-${qId}">${q.expectedQuery || (q.type === 'sql' ? 'SELECT * FROM users LIMIT 10;' : '// db.collection.find({})')}</textarea>
            </div>
            <div style="display:flex;align-items:center;gap:10px;margin-top:8px">
              ${q.type === 'sql' ? `<button type="button" class="exam-btn exam-btn-secondary" onclick="ExamPortal.mentor.runSqlPreview('${qId}')" title="Execute with the exam SQL service">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                Run SQL
              </button>` : ''}
              <button type="button" class="exam-btn exam-btn-green" onclick="ExamPortal.mentor.freezeAnswer('${qId}')">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
                ${q.answerFrozen ? 'Re-run &amp; Update Frozen Answer' : 'Run &amp; Freeze Answer'}
              </button>
              ${q.answerFrozen
                ? `<span class="exam-frozen-chip"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>Answer frozen — ${q.answerDocCount} docs</span>`
                : ''
              }
            </div>
            <div id="freeze-status-${qId}" style="display:none"></div>
            <div id="freeze-output-${qId}" style="${(q.lastOutputPreview || q.lastOutputError) ? 'display:block' : 'display:none'};margin-top:8px;max-height:180px;overflow-y:auto;background:var(--bg);border:1px solid ${q.lastOutputError ? 'var(--red)' : 'var(--border2)'};border-radius:4px;padding:8px;font-family:'JetBrains Mono',monospace;font-size:11px;white-space:pre-wrap">
              ${q.lastOutputError
                ? `<span style="color:var(--red)">// Query execution failed:</span>\n${q.lastOutputError}`
                : q.lastOutputPreview
                  ? `<span style="color:var(--green2)">// Query executed successfully (${q.answerDocCount || 0} doc(s) returned). Output preview:</span>\n${JSON.stringify(q.lastOutputPreview, null, 2)}`
                  : ''
              }
            </div>
          </div>
        `;
        mentor._renderQuestionMediaList(qId);
        // Init mini CodeMirror
        whenCodeMirrorReady(() => {
          const ta = el(`mini-editor-${qId}`);
          if (ta) {
            if (state.mentor.miniEditors[qId]) {
              try { state.mentor.miniEditors[qId].toTextArea(); } catch(e) {}
              delete state.mentor.miniEditors[qId];
            }
            const cm = CodeMirror.fromTextArea(ta, {
               mode: q.type === 'sql' ? 'text/x-sql' : 'javascript',
              theme: 'default',
              lineNumbers: true,
              matchBrackets: true,
              autoCloseBrackets: true,
              readOnly: false,
              extraKeys: q.type === 'sql' ? {
                'Ctrl-Enter': () => mentor.runSqlPreview(qId),
                'Cmd-Enter': () => mentor.runSqlPreview(qId),
              } : {},
            });
            fitMentorCodeMirror(cm);
            cm.on('change', () => {
              fitMentorCodeMirror(cm);
              q.expectedQuery = cm.getValue();
              mentor.updateQField(qId, 'expectedQuery', cm.getValue());
            });
            state.mentor.miniEditors[qId] = cm;
            attachCodexaKeywordHints(cm, () => q.type === 'sql' ? 'sql' : 'mongodb');
          }
        });

      } else if (q.type === 'coding') {
        // Initialize coding features if missing
        if (!q.allowedLanguages) {
          q.allowedLanguages = ['python', 'cpp', 'c', 'java', 'javascript'];
        }
        if (!q.templateType) {
          q.templateType = 'scratch';
        }
        if (!q.templates) {
          q.templates = {
            python: { starterCode: q.starterCode || '', driverCode: '', editorialCode: '' },
            cpp: { starterCode: q.starterCode || '', driverCode: '', editorialCode: '' },
            c: { starterCode: q.starterCode || '', driverCode: '', editorialCode: '' },
            java: { starterCode: q.starterCode || '', driverCode: '', editorialCode: '' },
            javascript: { starterCode: q.starterCode || 'const value = Number(readline());\nconsole.log(value * 2);\n', driverCode: '', editorialCode: '' }
          };
        }
        // Ensure editorialCode is initialized on all template languages
        ['python', 'cpp', 'c', 'java', 'javascript'].forEach(lang => {
          if (!q.templates[lang]) q.templates[lang] = { starterCode: '', driverCode: '', editorialCode: '' };
          if (lang === 'javascript' && !q.templates[lang].starterCode) {
            q.templates[lang].starterCode = 'const value = Number(readline());\nconsole.log(value * 2);\n';
          }
          if (q.templates[lang].editorialCode === undefined) {
            q.templates[lang].editorialCode = '';
          }
        });
        q.expectedOutputMode = 'editorial';

        const activeLang = state.mentor.activeConfigLang || q.allowedLanguages[0] || 'python';
        state.mentor.activeConfigLang = activeLang;

        // Render Allowed Languages checkboxes
        const langCheckboxes = ['python', 'cpp', 'c', 'java', 'javascript'].map(lang => {
          const isAllowed = q.allowedLanguages.includes(lang);
          const labels = { python: 'Python 3', cpp: 'C++', c: 'C', java: 'Java', javascript: 'JavaScript' };
          return `
            <label style="display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer">
              <input type="checkbox" value="${lang}" ${isAllowed ? 'checked' : ''}
                onchange="ExamPortal.mentor.toggleAllowedLang('${qId}',this.value)"/>
              <span>${labels[lang]}</span>
            </label>
          `;
        }).join('');

        // Render template configuration tabs - triggers global ExamPortal switchConfigLang
        const langTabs = q.allowedLanguages.map(lang => {
          const labels = { python: 'Python 3', cpp: 'C++', c: 'C', java: 'Java', javascript: 'JavaScript' };
          return `
            <div class="exam-tab ${activeLang === lang ? 'active' : ''}" style="height:26px;padding:0 8px;font-size:11px;cursor:pointer"
                 onclick="ExamPortal.mentor.switchConfigLang('${lang}','${qId}');">
              ${labels[lang]}
            </div>
          `;
        }).join('');

        const isAuto = q.expectedOutputMode === 'editorial';
        const testCasesRows = (q.testCases || []).map((tc, idx) => `
          <div class="exam-mcq-option-row" style="gap:10px;margin-bottom:8px;align-items:flex-start" id="tc-row-${qId}-${idx}">
            <div style="flex:1">
              <label class="exam-label" style="font-size:10px;color:var(--text3);margin-bottom:2px">Input (stdin)</label>
              <textarea class="exam-textarea" style="height:45px;font-family:monospace;font-size:11px;padding:4px"
                placeholder="Test Case Stdin..."
                oninput="ExamPortal.mentor.updateTestCase('${qId}',${idx},'input',this.value)">${tc.input || ''}</textarea>
            </div>
            <div style="flex:1">
              <label class="exam-label" style="font-size:10px;color:var(--text3);margin-bottom:2px">Expected Output (Auto-generated)</label>
              <textarea class="exam-textarea" style="height:45px;font-family:monospace;font-size:11px;padding:4px;background:var(--bg3);opacity:0.8;"
                placeholder="Click Generate to populate..."
                readonly>${tc.expectedOutput || ''}</textarea>
            </div>
            <div style="display:flex;flex-direction:column;align-items:center;margin-top:15px;gap:4px">
              <label style="font-size:9px;color:var(--text2);cursor:pointer;display:flex;align-items:center;gap:2px">
                <input type="checkbox" ${tc.isSample ? 'checked' : ''}
                  onchange="ExamPortal.mentor.toggleTestCaseSample('${qId}',${idx},this.checked)"/>
                <span>Sample</span>
              </label>
              <button class="phbtn" style="color:var(--red)"
                onclick="ExamPortal.mentor.removeTestCase('${qId}',${idx})"
                ${(q.testCases || []).length <= 1 ? 'disabled title="Need at least 1 testcase"' : ''}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
              </button>
            </div>
          </div>
        `).join('');
        const generationLogEntries = generationLogs.get(qId) || [];
        const generationLogRows = generationLogEntries.map(entry =>
          `<div class="exam-generation-log-line is-${escapeExamHtml(entry.kind || 'active')}">${escapeExamHtml(`[codeleaf] ${entry.message}`)}</div>`
        ).join('');
        const generationMode = generationModes.get(qId) || { text: 'READY', className: '' };

        qeditor.innerHTML = `
          <div class="exam-fieldset">
            <div class="exam-fieldset-title">Question Text (Markdown allowed)</div>
            <textarea class="exam-textarea" id="qtext-${qId}" oninput="ExamPortal.mentor.updateQField('${qId}','text',this.value)" placeholder="Write the coding question for students...">${q.text}</textarea>
            ${questionMediaControls(qId)}
          </div>
          <div style="display:flex;gap:12px;align-items:flex-start;margin-bottom:12px">
            <div class="exam-field" style="width:100px;margin:0">
              <label class="exam-label">Marks</label>
              <input class="exam-num-input" type="number" min="1" max="100" value="${q.marks}"
                oninput="ExamPortal.mentor.updateQField('${qId}','marks',parseInt(this.value)||0)"/>
            </div>
            <div class="exam-field" style="flex:1;margin:0">
              <label class="exam-label">Allowed Languages</label>
              <div class="mentor-lang-checkboxes" style="background:var(--bg);border:1px solid var(--border2);border-radius:4px;padding:6px;min-height:30px">
                ${langCheckboxes}
              </div>
            </div>
            <div class="exam-field" style="flex:1;margin:0">
              <label class="exam-label">Workspace Mode</label>
              <select class="exam-input" onchange="ExamPortal.mentor.updateQField('${qId}','templateType',this.value); ExamPortal.mentor._renderQEditor('${qId}');" style="background:var(--bg);color:var(--text);border:1px solid var(--border);padding:4px;width:100%">
                <option value="scratch" ${q.templateType === 'scratch' ? 'selected' : ''}>Write from Scratch</option>
                <option value="solve_function" ${q.templateType === 'solve_function' ? 'selected' : ''}>Solve Function (with driver code)</option>
              </select>
            </div>
          </div>

          <!-- Configuration Tabs for each language -->
          <div class="exam-tabbar" style="height:28px;margin-bottom:8px;background:none;border-bottom:1px solid var(--border)">
            ${langTabs}
          </div>

          <div class="exam-fieldset">
            <div class="exam-fieldset-title">Starter Template (${activeLang})</div>
            <div class="exam-mini-editor" id="starter-wrap-${qId}">
              <textarea id="mini-editor-starter-${qId}">${(q.templates && q.templates[activeLang]) ? q.templates[activeLang].starterCode : ''}</textarea>
            </div>
          </div>

          ${q.templateType === 'solve_function' ? `
          <div class="exam-fieldset">
            <div class="exam-fieldset-title">Hidden Driver Code (${activeLang})</div>
            <div class="exam-mini-editor" id="driver-wrap-${qId}">
              <textarea id="mini-editor-driver-${qId}">${(q.templates && q.templates[activeLang]) ? q.templates[activeLang].driverCode : ''}</textarea>
            </div>
          </div>
          ` : ''}

          <div class="exam-fieldset">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
              <div class="exam-fieldset-title">Editorial Correct Code (${activeLang})</div>
            </div>
            <div class="exam-mini-editor" id="editorial-wrap-${qId}">
              <textarea id="mini-editor-editorial-${qId}">${(q.templates && q.templates[activeLang]) ? q.templates[activeLang].editorialCode : ''}</textarea>
            </div>
          </div>

          <div class="exam-fieldset">
            <div class="exam-testcases-header">
              <div class="exam-fieldset-title">Test Cases (for grading)</div>
              <div class="exam-testcases-actions">
                <button class="exam-btn exam-btn-green exam-generate-outputs-btn" style="font-size:11px;padding:4px 10px"
                  onclick="ExamPortal.mentor.generateCodingOutputs('${qId}')" id="btn-gen-outputs-${qId}">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style="margin-right:3px"><path d="M12 2C6.48 2 2 4.02 2 6.5v11c0 2.48 4.48 4.5 10 4.5s10-2.02 10-4.5v-11C22 4.02 17.52 2 12 2zm0 3c4.14 0 7.5 1.12 7.5 2.5S16.14 10 12 10 4.5 8.88 4.5 7.5 7.86 5 12 5z"/></svg>
                  Generate &amp; Freeze Outputs
                </button>
                <button class="exam-btn exam-btn-secondary" style="font-size:11px;padding:4px 10px"
                  onclick="ExamPortal.mentor.addTestCase('${qId}')">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
                  Add Test Case
                </button>
              </div>
            </div>
            <div id="test-cases-${qId}">
              ${testCasesRows}
            </div>
            <div class="exam-generation-log" id="gen-log-${qId}" ${generationLogEntries.length ? '' : 'hidden'}>
              <div class="exam-generation-log-head">
                <span>OUTPUT GENERATION</span>
                <span id="gen-log-mode-${qId}" class="exam-generation-log-mode ${generationMode.className}">${generationMode.text}</span>
              </div>
              <div class="exam-generation-log-lines" id="gen-log-lines-${qId}">${generationLogRows}</div>
            </div>
            <div id="gen-status-${qId}" style="display:none;font-size:11px;color:var(--text3);margin-top:6px"></div>
          </div>
        `;

        // Init CodeMirror instances
        whenCodeMirrorReady(() => {
          // 1. Starter editor
          const taStarter = el(`mini-editor-starter-${qId}`);
          if (taStarter) {
            if (state.mentor.miniEditors[`starter-${qId}`]) {
              try { state.mentor.miniEditors[`starter-${qId}`].toTextArea(); } catch(e) {}
              delete state.mentor.miniEditors[`starter-${qId}`];
            }
            let cmMode = 'python';
            if (activeLang === 'cpp' || activeLang === 'c') cmMode = 'text/x-c++src';
            if (activeLang === 'java') cmMode = 'text/x-java';
            if (activeLang === 'javascript') cmMode = 'javascript';

            const cmS = CodeMirror.fromTextArea(taStarter, {
              mode: cmMode,
              theme: 'default',
              lineNumbers: true,
              matchBrackets: true,
              autoCloseBrackets: true,
            });
            fitMentorCodeMirror(cmS);
            cmS.on('change', () => {
              fitMentorCodeMirror(cmS);
              q.templates[activeLang].starterCode = cmS.getValue();
              // Backwards compatibility sync
              q.starterCode = cmS.getValue();
              q.language = activeLang;
              mentor._saveQDebounced();
            });
            state.mentor.miniEditors[`starter-${qId}`] = cmS;
            attachCodexaKeywordHints(cmS, () => q.language || 'python');
          }

          // 2. Driver editor
          const taDriver = el(`mini-editor-driver-${qId}`);
          if (taDriver) {
            if (state.mentor.miniEditors[`driver-${qId}`]) {
              try { state.mentor.miniEditors[`driver-${qId}`].toTextArea(); } catch(e) {}
              delete state.mentor.miniEditors[`driver-${qId}`];
            }
            let cmMode = 'python';
            if (activeLang === 'cpp' || activeLang === 'c') cmMode = 'text/x-c++src';
            if (activeLang === 'java') cmMode = 'text/x-java';
            if (activeLang === 'javascript') cmMode = 'javascript';

            const cmD = CodeMirror.fromTextArea(taDriver, {
              mode: cmMode,
              theme: 'default',
              lineNumbers: true,
              matchBrackets: true,
              autoCloseBrackets: true,
            });
            fitMentorCodeMirror(cmD);
            cmD.on('change', () => {
              fitMentorCodeMirror(cmD);
              q.templates[activeLang].driverCode = cmD.getValue();
              mentor._saveQDebounced();
            });
            state.mentor.miniEditors[`driver-${qId}`] = cmD;
            attachCodexaKeywordHints(cmD, () => q.language || 'python');
          }

          // 3. Editorial editor
          const taEditorial = el(`mini-editor-editorial-${qId}`);
          if (taEditorial) {
            if (state.mentor.miniEditors[`editorial-${qId}`]) {
              try { state.mentor.miniEditors[`editorial-${qId}`].toTextArea(); } catch(e) {}
              delete state.mentor.miniEditors[`editorial-${qId}`];
            }
            let cmMode = 'python';
            if (activeLang === 'cpp' || activeLang === 'c') cmMode = 'text/x-c++src';
            if (activeLang === 'java') cmMode = 'text/x-java';
            if (activeLang === 'javascript') cmMode = 'javascript';

            const cmE = CodeMirror.fromTextArea(taEditorial, {
              mode: cmMode,
              theme: 'default',
              lineNumbers: true,
              matchBrackets: true,
              autoCloseBrackets: true,
            });
            fitMentorCodeMirror(cmE);
            cmE.on('change', () => {
              fitMentorCodeMirror(cmE);
              q.templates[activeLang].editorialCode = cmE.getValue();
              mentor._saveQDebounced();
            });
            state.mentor.miniEditors[`editorial-${qId}`] = cmE;
            attachCodexaKeywordHints(cmE, () => q.language || 'python');
          }
        });

      } else {
        // MCQ editor
        const opts = q.options || ['', '', '', ''];
        qeditor.innerHTML = `
          <div class="exam-fieldset">
            <div class="exam-fieldset-title">Question Text (Markdown allowed)</div>
            <textarea class="exam-textarea" id="qtext-${qId}" oninput="ExamPortal.mentor.updateQField('${qId}','text',this.value)" placeholder="Write the multiple-choice question...">${q.text}</textarea>
            ${questionMediaControls(qId)}
          </div>
          <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px">
            <div class="exam-field" style="width:100px;margin:0">
              <label class="exam-label">Marks</label>
              <input class="exam-num-input" type="number" min="1" max="100" value="${q.marks}"
                oninput="ExamPortal.mentor.updateQField('${qId}','marks',parseInt(this.value)||0)"/>
            </div>
            <div class="exam-field" style="flex:1;margin:0;display:flex;align-items:center;gap:16px;height:35px;margin-top:15px">
              <label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px">
                <input type="checkbox" ${q.isMultiSelect ? 'checked' : ''}
                  onchange="ExamPortal.mentor.updateQField('${qId}','isMultiSelect',this.checked); ExamPortal.mentor._renderQEditor('${qId}');"/>
                <span>Multiple Answers (Checkboxes)</span>
              </label>
              <label id="mcq-partial-wrap-${qId}" style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;${q.isMultiSelect ? '' : 'display:none'}">
                <input type="checkbox" ${q.partialGrading ? 'checked' : ''}
                  onchange="ExamPortal.mentor.updateQField('${qId}','partialGrading',this.checked)"/>
                <span>Partial Grading</span>
              </label>
            </div>
          </div>
          <div class="exam-fieldset">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <div class="exam-fieldset-title">Options (Markdown allowed)</div>
              <button class="exam-btn exam-btn-secondary" style="font-size:11px;padding:4px 10px"
                onclick="ExamPortal.mentor.addMCQOption('${qId}')">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
                Add Option
              </button>
            </div>
            <div id="mcq-options-${qId}">
              ${opts.map((opt, i) => mentor._renderMCQOptionRow(qId, i, opt, q.correctOption === i)).join('')}
            </div>
          </div>
        `;
      }
      mentor._renderQuestionMediaList(qId);
    },

    _renderMCQOptionRow(qId, idx, value, isCorrect) {
      const q = state.mentor.questions.find(x => x.id === qId);
      const isMulti = q ? q.isMultiSelect : false;
      const label = String.fromCharCode(65 + idx); // A, B, C...

      const checkInput = isMulti
        ? `<input type="checkbox" class="exam-mcq-correct-checkbox" style="margin-right:8px"
             ${(q.correctOptions || []).includes(idx) ? 'checked' : ''}
             onchange="ExamPortal.mentor.toggleCorrectOption('${qId}',${idx},this.checked)"/>`
        : `<input type="radio" class="exam-mcq-correct-radio" name="correct-${qId}" value="${idx}"
             ${isCorrect ? 'checked' : ''}
             onchange="ExamPortal.mentor.updateQField('${qId}','correctOption',${idx})"/>`;

      return `
        <div class="exam-mcq-option-row" id="mcq-opt-row-${qId}-${idx}">
          ${checkInput}
          <span class="exam-mcq-label">${label}</span>
          <input class="exam-input" style="flex:1" value="${value}"
            placeholder="Option ${label}..."
            oninput="ExamPortal.mentor.updateMCQOption('${qId}',${idx},this.value)"/>
          <button class="phbtn" style="color:var(--red)" onclick="ExamPortal.mentor.removeMCQOption('${qId}',${idx})"
            ${idx < 2 ? 'disabled title="Need at least 2 options"' : ''}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
          </button>
        </div>
      `;
    },

    addMCQOption(qId) {
      const q = state.mentor.questions.find(x => x.id === qId);
      if (!q) return;
      q.options.push('');
      const container = el(`mcq-options-${qId}`);
      const idx = q.options.length - 1;
      container.insertAdjacentHTML('beforeend', mentor._renderMCQOptionRow(qId, idx, '', false));
      mentor._saveQuestions();
    },

    removeMCQOption(qId, idx) {
      const q = state.mentor.questions.find(x => x.id === qId);
      if (!q || q.options.length <= 2) return;
      q.options.splice(idx, 1);
      if (q.correctOption >= q.options.length) q.correctOption = 0;
      mentor._renderQEditor(qId);
      mentor._saveQuestions();
    },

    updateMCQOption(qId, idx, value) {
      const q = state.mentor.questions.find(x => x.id === qId);
      if (q) {
        q.options[idx] = value;
        mentor._saveQDebounced();
      }
    },

    updateCodingLanguage(qId, lang) {
      const q = state.mentor.questions.find(x => x.id === qId);
      if (!q) return;
      q.language = lang;

      if (!q.starterCode || q.starterCode.trim() === '' || q.starterCode.includes('write your code here') || q.starterCode.includes('write your Python 3 code here')) {
        if (lang === 'python') {
          q.starterCode = "# write your Python 3 code here\nimport sys\n\nfor line in sys.stdin:\n    print(int(line) * 2)\n";
        } else if (lang === 'cpp') {
          q.starterCode = "#include <iostream>\nusing namespace std;\n\nint main() {\n    int n;\n    while (cin >> n) {\n        cout << n * 2 << std::endl;\n    }\n    return 0;\n}\n";
        } else if (lang === 'c') {
          q.starterCode = "#include <stdio.h>\n\nint main() {\n    int n;\n    while (scanf(\"%d\", &n) != EOF) {\n        printf(\"%d\\n\", n * 2);\n    }\n    return 0;\n}\n";
        } else if (lang === 'java') {
          q.starterCode = "import java.util.Scanner;\n\npublic class Solution {\n    public static void main(String[] args) {\n        Scanner sc = new Scanner(System.in);\n        while (sc.hasNextInt()) {\n            int n = sc.nextInt();\n            System.out.println(n * 2);\n        }\n    }\n}\n";
        } else if (lang === 'javascript') {
          q.starterCode = "const value = Number(readline());\nconsole.log(value * 2);\n";
        }
      }

      mentor._renderQEditor(qId);
      mentor._saveQuestions();
    },

    addTestCase(qId) {
      const q = state.mentor.questions.find(x => x.id === qId);
      if (!q) return;
      if (!q.testCases) q.testCases = [];
      q.testCases.push({input: '', expectedOutput: ''});
      mentor._renderQEditor(qId);
      mentor._saveQuestions();
    },

    removeTestCase(qId, idx) {
      const q = state.mentor.questions.find(x => x.id === qId);
      if (!q || !q.testCases || q.testCases.length <= 1) return;
      q.testCases.splice(idx, 1);
      mentor._renderQEditor(qId);
      mentor._saveQuestions();
    },

    updateTestCase(qId, idx, field, value) {
      const q = state.mentor.questions.find(x => x.id === qId);
      if (q && q.testCases && q.testCases[idx]) {
        q.testCases[idx][field] = value;
        mentor._saveQDebounced();
      }
    },

    toggleTestCaseSample(qId, idx, checked) {
      const q = state.mentor.questions.find(x => x.id === qId);
      if (q && q.testCases && q.testCases[idx]) {
        q.testCases[idx].isSample = checked;
        mentor._saveQDebounced();
      }
    },

    updateQField(qId, field, value) {
      const q = state.mentor.questions.find(x => x.id === qId);
      if (q) {
        q[field] = value;
        if (field === 'text') {
          mentor._renderQList();
          const preview = el(`qmedia-preview-${qId}`);
          if (preview) preview.innerHTML = renderQuestionHtml(q);
        }
        if (field === 'marks') {
          mentor._updateQCounts();
        }
        mentor._saveQDebounced();
      }
    },

    toggleAllowedLang(qId, lang) {
      const q = state.mentor.questions.find(x => x.id === qId);
      if (!q) return;
      if (!q.allowedLanguages) q.allowedLanguages = ['python', 'cpp', 'c', 'java', 'javascript'];
      if (!q.templates) {
        q.templates = {
          python: { starterCode: q.starterCode || '', driverCode: '', editorialCode: '' },
          cpp: { starterCode: q.starterCode || '', driverCode: '', editorialCode: '' },
          c: { starterCode: q.starterCode || '', driverCode: '', editorialCode: '' },
          java: { starterCode: q.starterCode || '', driverCode: '', editorialCode: '' }
        };
      }
      const idx = q.allowedLanguages.indexOf(lang);
      if (idx > -1) {
        if (q.allowedLanguages.length > 1) {
          q.allowedLanguages.splice(idx, 1);
        } else {
          showExamAlert("At least one language must be allowed.", { title: 'Language Required', danger: true });
          return;
        }
      } else {
        q.allowedLanguages.push(lang);
      }
      // Set active Config Lang to one of the allowed languages if current active is removed
      if (!q.allowedLanguages.includes(state.mentor.activeConfigLang)) {
        state.mentor.activeConfigLang = q.allowedLanguages[0];
      }
      mentor._renderQEditor(qId);
      mentor._saveQuestions();
    },

    toggleCorrectOption(qId, idx, checked) {
      const q = state.mentor.questions.find(x => x.id === qId);
      if (!q) return;
      if (!q.correctOptions) q.correctOptions = [];
      const idxPos = q.correctOptions.indexOf(idx);
      if (checked) {
        if (idxPos === -1) q.correctOptions.push(idx);
      } else {
        if (idxPos > -1) q.correctOptions.splice(idxPos, 1);
      }
      mentor._saveQuestions();
    },

    _saveQDebounced: (() => {
      let timer;
      return () => {
        clearTimeout(timer);
        timer = setTimeout(() => mentor._saveQuestions(), 600);
      };
    })(),

    _renderQuestionMediaList(qId) {
      const q = state.mentor.questions.find(x => x.id === qId);
      const target = el(`qmedia-list-${qId}`);
      if (!q || !target) return;
      target.innerHTML = (q.media || []).map(media => {
        const label = escapeExamHtml(media.name || 'media');
        const url = escapeExamHtml(media.url || `/api/exam/room/${state.mentor.roomId}/media/${media.id}`);
        return `<div class="exam-media-card">
          ${media.type === 'video' ? `<video src="${url}" muted preload="metadata" style="display:block;width:100%;height:68px;object-fit:cover"></video>` : `<img src="${url}" alt="${label}" style="display:block;width:100%;height:68px;object-fit:cover"/>`}
          <div title="${label}" style="padding:4px 5px;font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text2)">${label}</div>
          <button type="button" class="exam-media-remove" title="Remove media"
            onclick="event.stopPropagation();ExamPortal.mentor.deleteQuestionMedia('${qId}','${media.id}')">&times;</button>
        </div>`;
      }).join('');
      let preview = el(`qmedia-preview-${qId}`);
      if (!preview && target.parentElement) {
        target.insertAdjacentHTML('afterend', `<div style="margin-top:10px;border-top:1px solid var(--border2);padding-top:8px"><div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.4px;margin-bottom:5px">Live student preview</div><div id="qmedia-preview-${qId}" class="exam-question-preview"></div></div>`);
        preview = el(`qmedia-preview-${qId}`);
      }
      if (preview) preview.innerHTML = renderQuestionHtml(q);
    },

    // Media is uploaded in slices: the serverless host rejects request bodies
    // above ~4.5 MB, so a single POST made every real video fail with 413.
    async uploadQuestionMedia(qId, event) {
      const q = state.mentor.questions.find(x => x.id === qId);
      const file = event && event.target && event.target.files ? event.target.files[0] : null;
      if (!q || !file) return;
      event.target.value = '';
      const isImage = (file.type || '').startsWith('image/');
      const isVideo = (file.type || '').startsWith('video/');
      if (!isImage && !isVideo) {
        showExamAlert('Only image and video files are allowed.', { title: 'Invalid File', danger: true });
        return;
      }
      if (file.size > 30 * 1024 * 1024) {
        showExamAlert('Media files must be 30 MB or smaller.', { title: 'File Too Large', danger: true });
        return;
      }

      const roomId = state.mentor.roomId;
      const mentorId = state.mentor.mentorId || '';
      const uploadId = 'upl-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      const CHUNK_SIZE = 2 * 1024 * 1024;
      const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));

      try {
        for (let seq = 0; seq < totalChunks; seq++) {
          const slice = file.slice(seq * CHUNK_SIZE, Math.min(file.size, (seq + 1) * CHUNK_SIZE));
          const form = new FormData();
          form.append('mentorId', mentorId);
          form.append('uploadId', uploadId);
          form.append('seq', String(seq));
          form.append('file', slice, file.name);
          const res = await fetch(`/api/exam/room/${roomId}/question/${qId}/media/chunk`, { method: 'POST', body: form });
          let payload = {};
          try { payload = await res.json(); } catch (e) {}
          if (!res.ok || payload.status !== 'ok') {
            throw new Error(payload.error || `Upload failed on part ${seq + 1} of ${totalChunks}`);
          }
        }

        const completeRes = await fetch(`/api/exam/room/${roomId}/question/${qId}/media/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mentorId: mentorId,
            uploadId: uploadId,
            filename: file.name,
            contentType: file.type || (isVideo ? 'video/mp4' : 'image/png'),
            totalChunks: totalChunks,
          }),
        });
        let result = {};
        try { result = await completeRes.json(); } catch (e) {}
        if (!completeRes.ok || result.status !== 'ok' || !result.media) {
          throw new Error(result.error || 'Unable to finish the upload');
        }

        q.media = Array.isArray(q.media) ? q.media : [];
        q.media.push(result.media);
        const textarea = el(`qtext-${qId}`);
        const marker = `[media:${result.media.id}]`;
        if (textarea) {
          const start = Number.isInteger(textarea.selectionStart) ? textarea.selectionStart : textarea.value.length;
          const end = Number.isInteger(textarea.selectionEnd) ? textarea.selectionEnd : start;
          q.text = textarea.value.slice(0, start) + marker + textarea.value.slice(end);
        } else {
          q.text = `${q.text || ''}${marker}`;
        }
        await mentor._saveQuestions();
        mentor._renderQEditor(qId);
      } catch (error) {
        // Drop any buffered slices so a failed attempt cannot leak storage.
        fetch(`/api/exam/room/${roomId}/question/${qId}/media/abort`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mentorId: mentorId, uploadId: uploadId }),
        }).catch(() => {});
        showExamAlert((error && error.message) || 'Unable to upload media. Please try again.', { title: 'Upload Failed', danger: true });
      }
    },

    async deleteQuestionMedia(qId, mediaId) {
      const q = state.mentor.questions.find(x => x.id === qId);
      if (!q) return;
      
      // Confirm deletion
      if (!await showExamConfirm('Are you sure you want to remove this media?\n\nThis action cannot be undone.', { 
        title: 'Remove Media', 
        danger: true, 
        confirmText: 'Remove', 
        cancelText: 'Cancel' 
      })) return;

      try {
        const mentorId = encodeURIComponent(state.mentor.mentorId || '');
        const response = await fetch(`/api/exam/room/${state.mentor.roomId}/question/${qId}/media/${mediaId}?mentorId=${mentorId}`, {
          method: 'DELETE',
        });
        const result = await response.json();
        
        if (!response.ok || result.status !== 'ok') {
          showExamAlert(result.error || 'Failed to delete media.', { title: 'Delete Failed', danger: true });
          return;
        }
        
        // Remove from question's media array
        if (q.media && Array.isArray(q.media)) {
          q.media = q.media.filter(m => m.id !== mediaId);
          if (q.media.length === 0) delete q.media;
        }
        
        // Remove the media marker from question text
        const marker = `[media:${mediaId}]`;
        if (q.text && q.text.includes(marker)) {
          q.text = q.text.replace(marker, '').replace(/\s+/g, ' ').trim();
        }
        
        await mentor._saveQuestions();
        mentor._renderQEditor(qId);
      } catch (error) {
        showExamAlert('Unable to delete media. Please try again.', { title: 'Delete Failed', danger: true });
      }
    },

    async _saveQuestions() {
      if (!state.mentor.roomId || !state.mentor.mentorId) return;
      await apiCall(`/api/exam/room/${state.mentor.roomId}/questions`, 'POST', {
        mentorId: state.mentor.mentorId,
        questions: state.mentor.questions,
      });
      mentor._updateQCounts();
    },

    async runSqlPreview(qId) {
      const q = state.mentor.questions.find(x => x.id === qId);
      if (!q || !isSqlQuestion(q)) return;

      const cm = state.mentor.miniEditors[qId];
      const query = cm ? cm.getValue() : (q.expectedQuery || '');
      const datasetIds = q.datasetIds || (q.datasetId ? [q.datasetId] : []);
      const statusEl = el(`freeze-status-${qId}`);
      const outputEl = el(`freeze-output-${qId}`);

      if (!datasetIds.length) {
        showMsg(`freeze-status-${qId}`, '-- Select at least one dataset first', true);
        if (statusEl) statusEl.style.display = 'block';
        return;
      }
      if (!query.trim()) {
        showMsg(`freeze-status-${qId}`, '-- Write the SQL query first', true);
        if (statusEl) statusEl.style.display = 'block';
        return;
      }

      if (statusEl) {
        statusEl.textContent = '-- Running SQL with the exam sandbox...';
        statusEl.style.display = 'block';
        statusEl.style.color = 'var(--text3)';
      }

      const res = await runExamSql(state.mentor.roomId, datasetIds, query);
      if (res.status === 'ok') {
        q.lastOutputPreview = (res.rows || []).slice(0, 20);
        q.lastOutputError = null;
        if (statusEl) {
          statusEl.textContent = `-- SQL executed — ${(res.rows || []).length} row(s) returned`;
          statusEl.style.color = 'var(--green3)';
        }
        if (outputEl) {
          outputEl.style.display = 'block';
          outputEl.style.borderColor = 'var(--border2)';
          outputEl.innerHTML = `<span style="color:var(--green2)">-- Preview output</span>${renderExamSqlResult(res)}`;
        }
      } else {
        q.lastOutputError = res.error || '-- SQL execution failed';
        if (statusEl) {
          statusEl.textContent = q.lastOutputError;
          statusEl.style.color = 'var(--red)';
        }
        if (outputEl) {
          outputEl.style.display = 'block';
          outputEl.style.borderColor = 'var(--red)';
          outputEl.innerHTML = `<span style="color:var(--red)">-- SQL execution failed</span>\n${escapeExamHtml(q.lastOutputError)}`;
        }
      }
    },

    async freezeAnswer(qId) {
      const q = state.mentor.questions.find(x => x.id === qId);
      if (!q) return;

      const cmt = q.type === 'sql' ? '--' : '//';

      const cm = state.mentor.miniEditors[qId];
      const query = cm ? cm.getValue() : q.expectedQuery;

      const datasetIds = q.datasetIds || (q.datasetId ? [q.datasetId] : []);

      if (datasetIds.length === 0) {
        showMsg(`freeze-status-${qId}`, `${cmt} Select at least one dataset first`, true);
        el(`freeze-status-${qId}`).style.display = 'block';
        return;
      }
      if (!query || !query.trim()) {
        showMsg(`freeze-status-${qId}`, `${cmt} Write the expected query first`, true);
        el(`freeze-status-${qId}`).style.display = 'block';
        return;
      }

      showMsg(`freeze-status-${qId}`, `${cmt} Running query...`, false);
      el(`freeze-status-${qId}`).style.display = 'block';

      const res = await apiCall(`/api/exam/room/${state.mentor.roomId}/freeze`, 'POST', {
        mentorId: state.mentor.mentorId,
        questionId: qId,
        datasetIds,
         query,
         queryType: q.type === 'sql' ? 'sql' : 'query',
         type: q.type === 'sql' ? 'sql' : 'query',
      });

      if (res.status === 'ok') {
        q.answerFrozen = true;
        q.expectedQuery = query;
        q.answerDocCount = res.docCount;
        q.lastOutputPreview = res.preview || [];
        q.lastOutputError = null;
        await mentor._saveQuestions();
        mentor._renderQList();
        mentor._renderQEditor(qId);
      } else {
        q.lastOutputError = res.error || `${cmt} Error running query`;
        q.lastOutputPreview = null;
        showMsg(`freeze-status-${qId}`, res.error || `${cmt} Error running query`, true);
        mentor._renderQEditor(qId);
      }
    },

    async generateCodingOutputs(qId) {
      const q = state.mentor.questions.find(x => x.id === qId);
      if (!q) return;

      const activeLang = state.mentor.activeConfigLang || q.allowedLanguages[0] || 'python';
      const cmt = langCommentPrefix(activeLang);
      const cmE = state.mentor.miniEditors[`editorial-${qId}`];
      const editorialCode = cmE ? cmE.getValue() : (((q.templates && q.templates[activeLang]) ? q.templates[activeLang].editorialCode : null) || '');

      if (!editorialCode || !editorialCode.trim()) {
        showExamAlert("Please write the editorial correct solution code first.", { title: 'Editorial Required', danger: true });
        return;
      }

      if (!q.testCases || q.testCases.length === 0) {
        showExamAlert("Please add at least one testcase first.", { title: 'Test Cases Required', danger: true });
        return;
      }

      const statusEl = el(`gen-status-${qId}`);
      const btn = el(`btn-gen-outputs-${qId}`);
      const btnOriginal = btn ? btn.innerHTML : '';
      clearGenerationLog(qId);
      appendGenerationLog(qId, 'Starting expected-output generation…', 'active');
      if (statusEl) {
        statusEl.textContent = `${cmt} Running editorial code against inputs...`;
        statusEl.style.color = 'var(--text3)';
        statusEl.style.display = 'block';
      }
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<span class="exam-generation-spinner" aria-hidden="true"></span> Generating…`;
      }

      const inputs = q.testCases.map(tc => tc.input || '');
      const driverCode = ((q.templates && q.templates[activeLang]) ? q.templates[activeLang].driverCode : null) || '';

      const res = await generateCodingOutputsWithFallback(
        activeLang,
        editorialCode,
        inputs,
        q.templateType,
        driverCode,
        detail => {
          const detailText = String(detail || '');
          const detailKind = detailText.toLowerCase().includes('remote') ? 'remote' : (detailText.toLowerCase().includes('failed') ? 'error' : 'active');
          appendGenerationLog(qId, detailText, detailKind);
          if (statusEl) statusEl.textContent = `${cmt} ${detail}`;
        }
      );

      if (btn) {
        btn.disabled = false;
        btn.innerHTML = btnOriginal;
      }

      if (res.status === 'ok' && res.outputs) {
        appendGenerationLog(qId, 'Expected outputs generated and frozen successfully.', res.executionOrigin === 'remote' ? 'remote' : 'success');
        finishGenerationLog(qId, true, res.executionOrigin);
        if (statusEl) {
          statusEl.textContent = `${cmt} Expected outputs generated and frozen successfully!`;
          statusEl.style.color = 'var(--green3)';
        }
        res.outputs.forEach((out, idx) => {
          if (q.testCases[idx]) {
            q.testCases[idx].expectedOutput = out;
          }
        });
        q.templates[activeLang].editorialCode = editorialCode;
        await mentor._saveQuestions();
        mentor._renderQEditor(qId);
      } else {
        appendGenerationLog(qId, 'Generation failed: ' + (res.error || 'Failed to execute solution'), 'error');
        finishGenerationLog(qId, false, res.executionOrigin);
        if (statusEl) {
          statusEl.textContent = `${cmt} Error: ${res.error || 'Failed to execute solution'}`;
          statusEl.style.color = 'var(--red)';
        }
      }
    },

    // ── Dataset Upload ─────────────────────────────────────────────────────

    async uploadDataset(event) {
      const file = event.target.files[0];
      if (!file) return;

      showMsg('exam-upload-msg', '// Reading file...', false);
      el('exam-upload-msg').style.display = 'block';

      const text = await file.text();
      let docs;
      try {
        if (file.name.endsWith('.csv')) {
          docs = mentor._csvToJson(text);
        } else {
          docs = JSON.parse(text);
        }
        if (!Array.isArray(docs)) docs = [docs];
      } catch (e) {
        showMsg('exam-upload-msg', `// Parse error: ${e.message}`, true);
        return;
      }

      const name = file.name.replace(/\.(json|csv)$/i, '');
      showMsg('exam-upload-msg', `// Uploading ${docs.length} documents...`, false);

      const res = await apiCall(`/api/exam/room/${state.mentor.roomId}/dataset`, 'POST', {
        mentorId: state.mentor.mentorId,
        name,
        docs,
      });

      event.target.value = '';

      if (res.status === 'ok') {
        state.mentor.datasets.push({
          datasetId: res.datasetId,
          name: res.name,
          collection: res.collection,
          docCount: res.docCount,
        });
        mentor._renderDatasetTable();
        if (state.mentor.currentQId) mentor._renderQEditor(state.mentor.currentQId);
        showMsg('exam-upload-msg', `// "${res.name}" uploaded — ${res.docCount} documents`, false);
      } else {
        showMsg('exam-upload-msg', res.error || '// Upload failed', true);
      }
    },

    _csvToJson(csv) {
      const lines = csv.trim().split('\n');
      const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
      return lines.slice(1).map(line => {
        const vals = line.split(',').map(v => v.trim().replace(/"/g, ''));
        const obj = {};
        headers.forEach((h, i) => {
          const v = vals[i] || '';
          obj[h] = isNaN(v) ? v : parseFloat(v);
        });
        return obj;
      });
    },

    _renderDatasetTable() {
      const tbody = el('mentor-dataset-tbody');
      const datasets = state.mentor.datasets;
      if (datasets.length === 0) {
        tbody.innerHTML = '<tr id="mentor-dataset-empty-row"><td colspan="4" style="text-align:center;color:var(--text3);font-family:\'JetBrains Mono\',monospace;padding:20px">// No datasets uploaded yet</td></tr>';
        return;
      }
      tbody.innerHTML = datasets.map(ds => `
        <tr>
          <td><strong>${ds.name}</strong></td>
          <td class="exam-dataset-coll">${ds.collection}</td>
          <td>${ds.docCount}</td>
          <td>
            <button class="phbtn" style="color:var(--red)" onclick="ExamPortal.mentor.deleteDataset('${ds.datasetId}')" title="Delete dataset">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>
          </td>
        </tr>
      `).join('');
    },

    async deleteDataset(datasetId) {
      await apiCall(`/api/exam/room/${state.mentor.roomId}/dataset/${datasetId}`, 'DELETE', {
        mentorId: state.mentor.mentorId,
      });
      state.mentor.datasets = state.mentor.datasets.filter(d => d.datasetId !== datasetId);
      mentor._renderDatasetTable();
      if (state.mentor.currentQId) mentor._renderQEditor(state.mentor.currentQId);
    },

    // ── Room Lifecycle ─────────────────────────────────────────────────────

    async startExam() {
      if (state.mentor.questions.length === 0) {
        showExamAlert('Add at least one question before starting the exam.', { title: 'No Questions', danger: true });
        return;
      }

      const btn = el('btn-start-exam');
      const btnOriginal = btn ? btn.innerHTML : '';
      const freezeFailures = [];
      const qLabel = (q) => {
        const n = state.mentor.questions.indexOf(q);
        const title = (q.title || '').replace(/\s+/g, ' ').trim();
        const short = title.length > 40 ? title.slice(0, 40) + '…' : title;
        return `Q${n >= 0 ? n + 1 : '?'} (${q.type})${short ? ' — ' + short : ''}`;
      };

      // Auto-generate and freeze expected outputs for every question type
      try {
        for (const q of state.mentor.questions) {
          if (btn) { btn.disabled = true; btn.textContent = `Freezing: ${qLabel(q)}`.slice(0, 40); }

          if (isDataQuestion(q)) {
            if (q.answerFrozen) continue;
            const datasetIds = q.datasetIds || (q.datasetId ? [q.datasetId] : []);
            const query = q.expectedQuery || '';
            if (datasetIds.length === 0 || !query.trim()) {
              freezeFailures.push(`${qLabel(q)} — missing dataset or expected query`);
              continue;
            }
            try {
              const res = await apiCall(`/api/exam/room/${state.mentor.roomId}/freeze`, 'POST', {
                mentorId: state.mentor.mentorId,
                questionId: q.id,
                datasetIds,
                query,
                queryType: q.type === 'sql' ? 'sql' : 'query',
                type: q.type === 'sql' ? 'sql' : 'query',
              });
              if (res.status === 'ok') {
                q.answerFrozen = true;
                q.answerDocCount = res.docCount;
                q.lastOutputPreview = res.preview || [];
                q.lastOutputError = null;
              } else {
                q.lastOutputError = res.error || `${q.type === 'sql' ? '--' : '//'} Error running query`;
                freezeFailures.push(`${qLabel(q)} — ${res.error || 'freeze failed'}`);
              }
            } catch (freezeErr) {
              freezeFailures.push(`${qLabel(q)} — ${freezeErr.message || 'freeze failed'}`);
            }
          } else if (q.type === 'coding') {
            const inputs = (q.testCases || []).map(tc => tc.input || '');
            if (inputs.length === 0) {
              freezeFailures.push(`${qLabel(q)} — no test cases defined`);
              continue;
            }
            const langs = q.allowedLanguages && q.allowedLanguages.length ? q.allowedLanguages : ['python'];
            for (const lang of langs) {
              clearGenerationLog(q.id);
              const tpl = (q.templates && q.templates[lang]) ? q.templates[lang] : null;
              const editorialCode = tpl ? tpl.editorialCode : '';
              if (!editorialCode || !editorialCode.trim()) {
                freezeFailures.push(`${qLabel(q)} (${lang}) — no editorial solution code`);
                continue;
              }
              try {
                const res = await generateCodingOutputsWithFallback(
                  lang,
                  editorialCode,
                  inputs,
                  q.templateType,
                  (tpl && tpl.driverCode) || '',
                  detail => appendGenerationLog(q.id, `${lang.toUpperCase()}: ${detail}`, String(detail || '').toLowerCase().includes('remote') ? 'remote' : 'active')
                );
                if (res.status === 'ok' && res.outputs) {
                  appendGenerationLog(q.id, 'Expected outputs frozen for ' + lang.toUpperCase() + '.', res.executionOrigin === 'remote' ? 'remote' : 'success');
                  finishGenerationLog(q.id, true, res.executionOrigin);
                  res.outputs.forEach((out, idx) => {
                    if (q.testCases[idx]) q.testCases[idx].expectedOutput = out;
                  });
                } else {
                  appendGenerationLog(q.id, 'Output generation failed for ' + lang.toUpperCase() + ': ' + (res.error || 'unknown error'), 'error');
                  finishGenerationLog(q.id, false, res.executionOrigin);
                  freezeFailures.push(`${qLabel(q)} (${lang}) — ${res.error || 'output generation failed'}`);
                }
              } catch (genErr) {
                freezeFailures.push(`${qLabel(q)} (${lang}) — ${genErr.message || 'output generation failed'}`);
              }
            }
          } else if (q.type === 'mcq') {
            // MCQ answers are graded directly from correctOption(s); nothing to generate
            q.answerFrozen = true;
          }
        }

        await mentor._saveQuestions();
        mentor._renderQList();
        if (state.mentor.currentQId) mentor._renderQEditor(state.mentor.currentQId);
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = btnOriginal; }
      }

      const unfrozen = state.mentor.questions.filter(q => isDataQuestion(q) && !q.answerFrozen);
      if (freezeFailures.length > 0 || unfrozen.length > 0) {
        const lines = [];
        if (unfrozen.length > 0) lines.push(`${unfrozen.length} query question(s) still have no frozen answer — students will get 0 marks for those.`);
        if (freezeFailures.length > 0) lines.push('Freeze issues:\n' + freezeFailures.map(f => '• ' + f).join('\n'));
        const proceed = await showExamConfirm(`${lines.join('\n\n')}\n\nContinue starting the exam?`, {
          title: 'Freeze Warnings',
          confirmText: 'Continue',
          cancelText: 'Go Back'
        });
        if (!proceed) return;
      }

      const res = await apiCall(`/api/exam/room/${state.mentor.roomId}/start`, 'POST', {
        mentorId: state.mentor.mentorId,
      });
      if (res.status === 'ok') {
        state.mentor.startedAt = res.startedAt;
        mentor._updateStatusUI('live');
      }
    },

    async endExam() {
      if (!(await showExamConfirm('End the exam? Students will no longer be able to submit answers.', { title: 'End Exam', danger: true, confirmText: 'End Exam', cancelText: 'Cancel' }))) return;
      const res = await apiCall(`/api/exam/room/${state.mentor.roomId}/end`, 'POST', {
        mentorId: state.mentor.mentorId,
      });
      if (res.status === 'ok') {
        mentor._updateStatusUI('ended');
        // Final leaderboard fetch
        mentor.fetchLeaderboard();
      }
    },

    async deleteRoom() {
      if (!(await showExamConfirm('Are you sure you want to completely close and delete this exam room?\n\nAll room data and student submissions will be permanently wiped from the database.', { title: 'Delete Exam Room', danger: true, confirmText: 'Delete Room', cancelText: 'Cancel' }))) return;
      const res = await apiCall(`/api/exam/room/${state.mentor.roomId}?mentorId=${state.mentor.mentorId}`, 'DELETE');
      if (res.status === 'ok') {
        clearInterval(state.mentor.participantInterval);
        clearInterval(state.mentor.lbInterval);
        clearInterval(state.mentor.timerInterval);
        localStorage.removeItem('exam_room_id');
        localStorage.removeItem('exam_mentor_id');
        showPanel('exam-mentor-create-panel');
      } else {
        showExamAlert(res.error || 'Failed to delete room', { title: 'Delete Failed', danger: true });
      }
    },

    // ── Participants Polling ───────────────────────────────────────────────

    _startParticipantPoll() {
      if (state.mentor.isPlayback) return;
      clearInterval(state.mentor.participantInterval);
      mentor._fetchParticipants();
      state.mentor.participantInterval = setInterval(mentor._fetchParticipants, 5000);
    },

    async _fetchParticipants() {
      const roomId = state.mentor.roomId;
      if (!roomId) return;
      const res = await apiCall(`/api/exam/room/${roomId}`);
      if (res.status === 'ok') {
        renderParticipants(res.participants || [], 'mentor-participants-body', 'mentor-participants-count');
      }
    },

    // ── Leaderboard Polling ────────────────────────────────────────────────

    _startLeaderboardPoll() {
      clearInterval(state.mentor.lbInterval);
      mentor.fetchLeaderboard();
      state.mentor.lbInterval = setInterval(mentor.fetchLeaderboard, 4000);
    },

    async fetchLeaderboard() {
      const roomId = state.mentor.roomId;
      if (!roomId) return;

      if (state.mentor.isPlayback) {
        const maxScore = state.mentor.maxScore || 0;
        mentor.renderLeaderboard(state.mentor.leaderboardData, maxScore);
        return;
      }

      // Pulse animation
      const dot = el('lb-pulse-dot');
      if (dot) {
        dot.classList.remove('pulsing');
        setTimeout(() => dot.classList.add('pulsing'), 50);
      }

      const res = await apiCall(`/api/exam/room/${roomId}/leaderboard`);
      if (res.status !== 'ok') return;

      state.mentor.leaderboardData = res.leaderboard || [];
      const maxScore = res.maxScore || 0;
      const totalQ = res.totalQuestions || 0;

      if (el('lb-max-score-label')) el('lb-max-score-label').textContent = `Max: ${maxScore} pts | ${totalQ} questions`;

      mentor.renderLeaderboard(state.mentor.leaderboardData, maxScore);
    },

    renderLeaderboard(data, maxScore) {
      const tbody = el('mentor-lb-tbody');
      if (!tbody) return;

      if (!data || data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--text3);font-family:\'JetBrains Mono\',monospace;padding:20px">// Waiting for submissions...</td></tr>';
        return;
      }

      let sorted = [...data];
      if (state.mentor.sortMode === 'roll') {
        sorted.sort((a, b) => (a.rollNo || '').localeCompare(b.rollNo || ''));
      }
      // (default: already sorted by score from ZREVRANGE)

      tbody.innerHTML = sorted.map((row, i) => {
        const rank = i + 1;
        const rankClass = rank <= 3 ? `exam-lb-rank-${rank}` : '';
        const rowClass = rank <= 3 ? `exam-lb-row-${rank}` : '';
        const accuracy = row.answered > 0
          ? Math.round((row.correct / row.answered) * 100) + '%'
          : '—';
        const lastSub = row.lastSubmission ? timeAgo(row.lastSubmission) : '—';
        const fullscreenExits = Number(row.fullscreenExits || 0);
        const copyPasteAttempts = Number(row.copyPasteAttempts || 0);
        const flagCount = fullscreenExits + copyPasteAttempts;
        const flagClass = flagCount > 0 ? 'is-flagged' : 'is-clear';
        const flagsBadge = `<button class="exam-flag-badge ${flagClass}" onclick="ExamPortal.mentor.showFlaggedDetails('${String(row.name || 'Student').replace(/'/g, "\\'")}', ${fullscreenExits}, ${copyPasteAttempts}, ${Number(row.lastFlaggedAt || 0)})" title="View proctoring details"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16.999c-.77 1.333.192 3 1.732 3z"/></svg>${flagCount}</button>`;

        const blockedBadge = row.isBlocked ? `<span class="exam-status-chip exam-chip-ended" style="font-size: 10px; margin-left: 6px; padding: 2px 6px; background: rgba(255, 77, 77, 0.08); color: #ff4d4d; border: 1px solid rgba(255, 77, 77, 0.3);" title="Reason: ${esc(row.blockReason || 'Kicked')}">BLOCKED</span>` : '';
        const nameContent = row.isBlocked ? `<span style="text-decoration: line-through; opacity: 0.6;">${esc(row.name)}</span> ${blockedBadge}` : esc(row.name);

        const secsLeft = (row.remainingSeconds === null || row.remainingSeconds === undefined)
          ? null
          : Number(row.remainingSeconds);
        const deadline = secsLeft === null ? '' : (Date.now() / 1000 + secsLeft);
        const timeLeftCell = `<td class="exam-lb-time exam-lb-countdown${secsLeft !== null && secsLeft <= 60 ? ' is-low' : ''}" data-deadline="${deadline}">${secsLeft === null ? '—' : fmtTimeLeft(secsLeft)}</td>`;

        return `
          <tr class="${rowClass}">
            <td class="exam-lb-rank ${rankClass}">${rank}</td>
            <td class="exam-lb-name">${nameContent}</td>
            <td style="font-family:'JetBrains Mono',monospace">${esc(row.rollNo)}</td>
            <td><span class="exam-participant-branch">${esc(row.branch)}</span></td>
            <td class="exam-lb-score">${row.totalScore}/${maxScore}</td>
            <td class="exam-lb-accuracy">${row.answered}/${(state.mentor.questions || []).length}</td>
            <td class="exam-lb-accuracy">${accuracy}</td>
            <td class="exam-lb-flags">${flagsBadge}</td>
            <td class="exam-lb-time">${lastSub}</td>
            ${timeLeftCell}
            <td style="text-align:center;display:flex;gap:6px;justify-content:center">
              <button class="exam-btn exam-btn-secondary" style="padding:4px 8px;font-size:11px;height:auto"
                onclick="ExamPortal.mentor.viewSubmission('${row.studentId}')"
                title="View student's submissions">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4C7 4 2.73 7.11 1 12c1.73 4.89 6 8 11 8s9.27-3.11 11-8c-1.73-4.89-6-8-11-8zm0 13c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>
                View
              </button>
              ${state.mentor.isPlayback ? '' : `
              <button class="exam-btn exam-btn-red" style="padding:4px 8px;font-size:11px;height:auto"
                onclick="ExamPortal.mentor.removeStudent('${row.studentId}')"
                title="Remove student">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                Remove
              </button>
              `}
            </td>
          </tr>
        `;
      }).join('');
    },

    // ── Export ─────────────────────────────────────────────────────────────

    setSortMode(mode) {
      state.mentor.sortMode = mode;
      el('sort-btn-score').classList.toggle('active', mode === 'score');
      el('sort-btn-roll').classList.toggle('active', mode === 'roll');
    },

    async exportXLSX() {
      let data = [];
      let maxScore = 0;
      if (state.mentor.isPlayback) {
        data = state.mentor.leaderboardData || [];
        maxScore = state.mentor.maxScore || 0;
      } else {
        // Fetch final leaderboard
        const res = await apiCall(`/api/exam/room/${state.mentor.roomId}/leaderboard`);
        data = res.leaderboard || [];
        maxScore = res.maxScore || 0;
      }

      let formattedData = data.map((row, i) => ({
        Rank: i + 1,
        Name: row.name,
        'Roll No': row.rollNo,
        Branch: row.branch,
        Score: row.totalScore,
        'Max Score': maxScore,
        Percentage: maxScore > 0 ? `${Math.round((row.totalScore / maxScore) * 100)}%` : '0%',
        Answered: row.answered,
        Correct: row.correct,
      }));

      if (state.mentor.sortMode === 'roll') {
        formattedData.sort((a, b) => (a['Roll No'] || '').localeCompare(b['Roll No'] || ''));
        formattedData.forEach((row, i) => { row.Rank = i + 1; });
      }

      if (typeof XLSX === 'undefined') {
        showExamAlert('SheetJS not loaded. Please check your internet connection.', { title: 'Export Unavailable', danger: true });
        return;
      }

      const ws = XLSX.utils.json_to_sheet(formattedData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Results');
      const date = new Date().toISOString().split('T')[0];
      const filename = `${state.mentor.title.replace(/\s+/g, '_')}_${date}_results.xlsx`;
      XLSX.writeFile(wb, filename);
    },

    async cleanupRoom() {
      if (state.mentor.isPlayback) {
        state.mentor.isPlayback = false;
        state.mentor.roomId = null;
        state.mentor.title = null;
        state.mentor.status = null;
        state.mentor.questions = [];
        state.mentor.participants = [];
        state.mentor.leaderboardData = [];
        state.mentor.offlineSubmissions = {};
        showRoleSelection();
        return;
      }
      if (!(await showExamConfirm('Delete all room data from Redis? This cannot be undone.', { title: 'Clear Room Data', danger: true, confirmText: 'Delete Data', cancelText: 'Cancel' }))) return;
      await apiCall(`/api/exam/room/${state.mentor.roomId}/cleanup`, 'DELETE', {
        mentorId: state.mentor.mentorId,
      });
      localStorage.removeItem('exam_mentor_id');
      localStorage.removeItem('exam_room_id');
      showRoleSelection();
    },

    async exportArchive() {
      if (!state.mentor.roomId || !state.mentor.mentorId) return;
      try {
        const res = await apiCall(`/api/exam/room/${state.mentor.roomId}/archive?mentorId=${state.mentor.mentorId}`);
        if (res.status === 'ok') {
          const blob = new Blob([JSON.stringify(res, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${res.roomId}_playback_archive.json`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        } else {
          showExamAlert(res.error || 'Failed to download playback archive', { title: 'Export Failed', danger: true });
        }
      } catch (e) {
        showExamAlert('Failed to connect to export playback archive', { title: 'Export Failed', danger: true });
      }
    },

    importSession(fileInput) {
      const file = fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const archive = JSON.parse(e.target.result);
          if (!archive.roomId || !archive.meta || !archive.questions) {
            showExamAlert('Invalid session archive file', { title: 'Invalid Archive', danger: true });
            return;
          }

          // Clear any active intervals/state
          clearInterval(state.mentor.participantInterval);
          clearInterval(state.mentor.lbInterval);
          clearInterval(state.mentor.timerInterval);

          // Set playback state
          state.mentor.isPlayback = true;
          state.mentor.roomId = archive.roomId;
          state.mentor.mentorId = archive.meta.mentorId;
          state.mentor.title = archive.meta.title || 'Playback';
          state.mentor.status = 'ended'; // Treat playback as ended/read-only
          state.mentor.timed = archive.meta.timed === '1' || archive.meta.timed === true;
          state.mentor.duration = parseInt(archive.meta.duration) || 60;
          
          // Load questions, participants, datasets, leaderboard, and submissions
          state.mentor.questions = archive.questions || [];
          
          // Convert participants raw Hash to list for UI
          const participants = [];
          const pRaw = archive.participants || {};
          for (const [sid, pVal] of Object.entries(pRaw)) {
            try {
              const p = typeof pVal === 'string' ? JSON.parse(pVal) : pVal;
              p.studentId = sid;
              participants.push(p);
            } catch(err) {
              participants.push({ studentId: sid, name: 'Unknown' });
            }
          }
          state.mentor.participants = participants;
          
          // Store datasets
          state.mentor.datasets = archive.datasets || {};
          
          // Store offline submissions and parse nested JSON strings if they are strings
          const offlineSubmissions = {};
          const archiveSubs = archive.submissions || {};
          for (const [sid, subsRaw] of Object.entries(archiveSubs)) {
            const parsedSubs = {};
            for (const [qid, subVal] of Object.entries(subsRaw || {})) {
              try {
                parsedSubs[qid] = typeof subVal === 'string' ? JSON.parse(subVal) : subVal;
              } catch(e) {
                parsedSubs[qid] = subVal;
              }
            }
            offlineSubmissions[sid] = parsedSubs;
          }
          state.mentor.offlineSubmissions = offlineSubmissions;

          // Generate leaderboard data offline from the archive
          const leaderboardRaw = archive.leaderboard || {};
          const leaderboardData = [];
          
          // Construct leaderboardData exactly as backend rank list
          for (const [sid, score] of Object.entries(leaderboardRaw)) {
            const studentInfo = participants.find(p => p.studentId === sid) || { name: 'Unknown', rollNo: '-', branch: '-' };
            const subsRaw = offlineSubmissions[sid] || {};
            const answered = Object.keys(subsRaw).length;
            const correct = Object.values(subsRaw).reduce((acc, subVal) => {
              try {
                const sub = typeof subVal === 'string' ? JSON.parse(subVal) : subVal;
                return acc + (sub.score > 0 ? 1 : 0);
              } catch(e) { return acc; }
            }, 0);
            
            let lastSubTime = 0;
            Object.values(subsRaw).forEach(subVal => {
              try {
                const sub = typeof subVal === 'string' ? JSON.parse(subVal) : subVal;
                if (sub.submittedAt > lastSubTime) lastSubTime = sub.submittedAt;
              } catch(e) {}
            });

            leaderboardData.push({
              studentId: sid,
              name: studentInfo.name || 'Unknown',
              rollNo: studentInfo.rollNo || '-',
              branch: studentInfo.branch || '-',
              totalScore: parseInt(score) || 0,
              answered,
              correct,
              lastSubmission: lastSubTime,
              fullscreenExits: Number(studentInfo.fullscreenExits || 0),
              copyPasteAttempts: Number(studentInfo.copyPasteAttempts || 0),
              lastFlaggedAt: Number(studentInfo.lastFlaggedAt || 0)
            });
          }

          // Include any participants not yet in sorted set
          participants.forEach(p => {
            if (!leaderboardData.some(r => r.studentId === p.studentId)) {
              const subsRaw = offlineSubmissions[p.studentId] || {};
              const answered = Object.keys(subsRaw).length;
              const correct = Object.values(subsRaw).reduce((acc, subVal) => {
                try {
                  const sub = typeof subVal === 'string' ? JSON.parse(subVal) : subVal;
                  return acc + (sub.score > 0 ? 1 : 0);
                } catch(e) { return acc; }
              }, 0);

              let lastSubTime = 0;
              Object.values(subsRaw).forEach(subVal => {
                try {
                  const sub = typeof subVal === 'string' ? JSON.parse(subVal) : subVal;
                  if (sub.submittedAt > lastSubTime) lastSubTime = sub.submittedAt;
                } catch(e) {}
              });

              leaderboardData.push({
                studentId: p.studentId,
                name: p.name || 'Unknown',
                rollNo: p.rollNo || '-',
                branch: p.branch || '-',
                totalScore: 0,
                answered,
                correct,
                lastSubmission: lastSubTime,
                fullscreenExits: Number(p.fullscreenExits || 0),
                copyPasteAttempts: Number(p.copyPasteAttempts || 0),
                lastFlaggedAt: Number(p.lastFlaggedAt || 0)
              });
            }
          });

          leaderboardData.sort((a, b) => b.totalScore - a.totalScore || a.studentId.localeCompare(b.studentId));
          state.mentor.leaderboardData = leaderboardData;

          // Compute maxScore
          state.mentor.maxScore = (archive.questions || []).reduce((acc, q) => acc + (parseInt(q.marks) || 0), 0);

          // Render initial playback UI
          mentor.initDashboard();

          // Override UI elements for playback mode
          el('mentor-dash-title').innerHTML = `<span style="color:var(--yellow);margin-right:8px;font-weight:700">[OFFLINE PLAYBACK]</span> ${archive.meta.title} — ${archive.roomId}`;
          
          // Hide room controls
          el('btn-start-exam').style.display = 'none';
          el('btn-end-exam').style.display = 'none';
          el('mentor-timer-row').style.display = 'none';
          
          // Disable/hide editing functions
          const addQBtn = el('btn-add-query') || document.querySelector('.exam-qlist-hdr button');
          if (addQBtn) addQBtn.style.display = 'none';
          const saveQuestionsBtn = el('btn-save-questions');
          if (saveQuestionsBtn) saveQuestionsBtn.style.display = 'none';

          // Render questions list and first question if available
          mentor._renderQList();
          mentor._updateQCounts();

          // Hide participants panel and show export panel
          el('mentor-participants-panel').style.display = 'none';
          el('mentor-export-panel').style.display = 'flex';
          const rightSidebar = document.querySelector('.exam-dash-right');
          if (rightSidebar) rightSidebar.style.display = 'flex';

          // Force leaderboard render
          mentor.fetchLeaderboard();

        } catch (err) {
          showExamAlert('Failed to parse session archive JSON: ' + err.message, { title: 'Parse Error', danger: true });
        }
      };
      reader.readAsText(file);
      // Reset input
      fileInput.value = '';
    },

    async removeStudent(studentId, studentName) {
      if (!studentName) {
        const found = (state.mentor.leaderboardData || []).find(x => x.studentId === studentId);
        studentName = found ? found.name : 'this student';
      }
      if (!(await showExamConfirm(`Are you sure you want to remove ${studentName} from the test?\n\nThey will be blocked and notified immediately.`, { title: 'Remove Student', danger: true, confirmText: 'Remove', cancelText: 'Cancel' }))) return;

      const keepInLeaderboard = await showExamConfirm(`Do you want to KEEP ${studentName}'s score on the leaderboard after removing them?`, { title: 'Leaderboard Score', confirmText: 'Keep Score', cancelText: 'Remove Score' });
      const keepVal = keepInLeaderboard ? '1' : '0';

      const roomId = state.mentor.roomId;
      const mentorId = state.mentor.mentorId;
      const res = await apiCall(`/api/exam/room/${roomId}/student/${studentId}?mentorId=${mentorId}&keepInLeaderboard=${keepVal}`, 'DELETE');
      if (res.status === 'ok') {
        mentor._fetchParticipants();
        mentor.fetchLeaderboard();
      } else {
        showExamAlert(res.error || 'Failed to remove student', { title: 'Remove Failed', danger: true });
      }
    },

    // ── Removed Students ─────────────────────────────────────────────────────

    async viewRemoved() {
      const res = await apiCall(`/api/exam/room/${state.mentor.roomId}/kicked?mentorId=${state.mentor.mentorId}`);
      if (res.status === 'ok') {
        const kicked = res.kicked || [];
        const tbody = el('mentor-removed-tbody');
        if (kicked.length === 0) {
          tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--text3)">// No removed students</td></tr>';
        } else {
          tbody.innerHTML = kicked.map(student => `
            <tr>
              <td class="exam-lb-name">${esc(student.name)}</td>
              <td style="font-family:'JetBrains Mono',monospace">${esc(student.rollNo)}</td>
              <td style="color:#ff6b6b;font-size:12px">${esc(student.kickReason || 'Removed by Mentor')}</td>
              <td style="text-align:center">
                <button class="exam-btn exam-btn-green" style="padding:4px 8px;font-size:11px;height:auto"
                  onclick="ExamPortal.mentor.reallowStudent('${student.studentId}', '${esc(student.name)}')">
                  Re-allow
                </button>
              </td>
            </tr>
          `).join('');
        }
        showPanel('exam-mentor-removed-panel');
      }
    },

    closeRemovedView() {
      showPanel('exam-mentor-dash-panel');
    },

    async reallowStudent(studentId, studentName) {
      if (!(await showExamConfirm(`Are you sure you want to re-allow ${studentName} to join the test?`, { title: 'Re-allow Student', confirmText: 'Re-allow', cancelText: 'Cancel' }))) return;
      const res = await apiCall(`/api/exam/room/${state.mentor.roomId}/student/${studentId}/reallow`, 'POST', {
        mentorId: state.mentor.mentorId
      });
      if (res.status === 'ok') {
        mentor.viewRemoved();
        mentor.fetchLeaderboard();
      } else {
        showExamAlert(res.error || 'Failed to re-allow student', { title: 'Action Failed', danger: true });
      }
    },

    // ── Submission Viewing ───────────────────────────────────────────────────

    async viewSubmission(studentId) {
      const student = (state.mentor.leaderboardData || []).find(x => x.studentId === studentId);
      if (!student) return;

      let submissions = {};
      if (state.mentor.isPlayback) {
        submissions = state.mentor.offlineSubmissions[studentId] || {};
      } else {
        const roomId = state.mentor.roomId;
        const mentorId = state.mentor.mentorId;
        const res = await apiCall(`/api/exam/room/${roomId}/student/${studentId}/submissions?mentorId=${mentorId}`);
        if (res.status !== 'ok') {
          showExamAlert(res.error || 'Failed to load submissions', { title: 'Load Failed', danger: true });
          return;
        }
        submissions = res.submissions || {};
      }

      state.mentor.viewingStudent = student;
      state.mentor.viewingSubmissions = submissions;
      
      el('mentor-sub-title').textContent = `Viewing Submission: ${student.name} (${student.rollNo})`;
      
      // Initialize read-only editor if not exists
      if (!state.mentor.submissionEditor) {
        const ta = el('mentor-sub-editor');
        if (ta && typeof CodeMirror !== 'undefined') {
          state.mentor.submissionEditor = CodeMirror.fromTextArea(ta, {
            mode: 'javascript',
            theme: 'default',
            lineNumbers: true,
            readOnly: 'nocursor',
            matchBrackets: true
          });
          state.mentor.submissionEditor.setSize('100%', '100%');
          attachCodexaKeywordHints(state.mentor.submissionEditor);
        }
      }

      mentor._renderSubQNav();
      showPanel('exam-mentor-submission-panel');

      if (state.mentor.questions && state.mentor.questions.length > 0) {
        mentor.selectSubmissionQuestion(0);
      }
    },

    closeSubmissionView() {
      state.mentor.viewingStudent = null;
      state.mentor.viewingSubmissions = null;
      if (el('mentor-sub-question-display')) el('mentor-sub-question-display').style.display = 'none';
      if (el('mentor-sub-no-q')) el('mentor-sub-no-q').style.display = 'flex';
      if (el('mentor-sub-query-area')) el('mentor-sub-query-area').style.display = 'none';
      if (el('mentor-sub-mcq-area')) el('mentor-sub-mcq-area').style.display = 'none';
      if (el('resizer-mentor-sub-console')) el('resizer-mentor-sub-console').style.display = 'none';
      showPanel('exam-mentor-dash-panel');
    },

    _renderSubQNav() {
      const qs = state.mentor.questions || [];
      const body = el('mentor-sub-qnav-body');
      if (!body) return;
      if (qs.length === 0) {
        body.innerHTML = '<div class="exam-participants-empty">// No questions found</div>';
        return;
      }

      body.innerHTML = qs.map((q, i) => {
        const sub = state.mentor.viewingSubmissions[q.id];
        const statusClass = sub ? 'exam-q-status-submitted' : 'exam-q-status-unattempted';
        const scoreText = sub ? `${sub.score}/${q.marks}` : `0/${q.marks}`;
        
        let typeLabel = 'QUERY';
        let typeClass = 'exam-q-type-query';
        if (q.type === 'sql') {
          typeLabel = 'SQL';
          typeClass = 'exam-q-type-sql';
        } else if (q.type === 'mcq') {
          typeLabel = 'MCQ';
          typeClass = 'exam-q-type-mcq';
        } else if (q.type === 'coding') {
          typeLabel = 'CODING';
          typeClass = 'exam-q-type-coding';
        }

        return `
          <div class="exam-qnav-card ${state.mentor.currentSubQIdx === i ? 'active' : ''}"
               onclick="ExamPortal.mentor.selectSubmissionQuestion(${i})">
            <div class="exam-q-card-top">
              <span class="exam-q-num">Q${i + 1}</span>
              <span class="exam-q-type-chip ${typeClass}">${typeLabel}</span>
              <span class="exam-q-marks-badge" style="color:var(--text);font-weight:600">${scoreText}</span>
              <div class="exam-q-status-dot ${statusClass}" style="margin-left:auto"></div>
            </div>
            <div class="exam-q-preview">${q.text ? q.text.substring(0, 50) + '...' : ''}</div>
          </div>
        `;
      }).join('');
    },

    selectSubmissionQuestion(idx) {
      const qs = state.mentor.questions || [];
      if (!qs || !qs[idx]) return;

      state.mentor.currentSubQIdx = idx;
      const q = qs[idx];
      const sub = state.mentor.viewingSubmissions[q.id];

      // Re-render nav to highlight active
      mentor._renderSubQNav();

      let typeLabel = 'QUERY';
      let typeClass = 'exam-q-type-query';
      if (q.type === 'sql') {
        typeLabel = 'SQL';
        typeClass = 'exam-q-type-sql';
      } else if (q.type === 'mcq') {
        typeLabel = 'MCQ';
        typeClass = 'exam-q-type-mcq';
      } else if (q.type === 'coding') {
        typeLabel = 'CODING';
        typeClass = 'exam-q-type-coding';
      }

      el('mentor-sub-q-number').textContent = `Q${idx + 1}`;
      el('mentor-sub-q-type-chip').textContent = typeLabel;
      el('mentor-sub-q-type-chip').className = `exam-q-type-chip ${typeClass}`;
      el('mentor-sub-q-marks').textContent = sub ? `Score: ${sub.score} / ${q.marks}` : `Score: 0 / ${q.marks}`;
      const descHtml = renderQuestionHtml(q);
      el('mentor-sub-q-text').innerHTML = descHtml;
      
      el('mentor-sub-question-display').style.display = 'block';
      el('mentor-sub-no-q').style.display = 'none';
      if (el('resizer-mentor-sub-console')) el('resizer-mentor-sub-console').style.display = 'block';

      if (isDataQuestion(q) || q.type === 'coding') {
        el('mentor-sub-query-area').style.display = 'flex';
        el('mentor-sub-mcq-area').style.display = 'none';
        
        if (state.mentor.submissionEditor) {
          let codeVal = '';
          if (sub) {
             codeVal = q.type === 'coding' ? (sub.code || '// Empty submission') : (sub.query || (q.type === 'sql' ? '-- Empty submission' : '// Empty submission'));
          } else {
            codeVal = '// No submission provided';
          }
           let cmMode = q.type === 'sql' ? 'text/x-sql' : 'javascript';
          if (q.type === 'coding') {
            if (q.language === 'python') cmMode = 'python';
            else if (q.language === 'cpp' || q.language === 'c') cmMode = 'text/x-c++src';
            else if (q.language === 'java') cmMode = 'text/x-java';
            else if (q.language === 'javascript') cmMode = 'javascript';
          }
          state.mentor.submissionEditor.setOption('mode', cmMode);
          state.mentor.submissionEditor.setValue(codeVal);
          // Refresh needed when element becomes visible
          setTimeout(() => state.mentor.submissionEditor.refresh(), 50);
        }
      } else {
        el('mentor-sub-query-area').style.display = 'none';
        el('mentor-sub-mcq-area').style.display = 'flex';
        
        const labels = ['A', 'B', 'C', 'D', 'E', 'F'];
        const isMulti = q.isMultiSelect === true;
        const optionsHtml = (q.options || []).map((opt, i) => {
          let isCorrect = false;
          let isSelected = false;

          if (isMulti) {
            const correctArr = (q.correctOptions || []).map(x => String(x));
            isCorrect = correctArr.includes(String(i));
            
            const selectedArr = (sub && sub.selectedOptions || []).map(x => String(x));
            isSelected = selectedArr.includes(String(i));
          } else {
            isCorrect = String(i) === String(q.correctOption);
            isSelected = sub && String(sub.selectedOption) === String(i);
          }
          
          let cardStyle = 'background:var(--bg3);border:1px solid var(--border);opacity:0.8;';
          let indicatorHtml = '';
          let ringColor = 'var(--text3)';

          if (isSelected && isCorrect) {
            // Selected & Correct: Vibrant Green
            cardStyle = 'background:rgba(35,209,139,0.06);border:1px solid var(--green3);box-shadow:0 0 10px rgba(35,209,139,0.15);';
            ringColor = 'var(--green3)';
            indicatorHtml = `
              <span style="margin-left:auto;font-size:10px;font-weight:700;color:var(--green3);background:rgba(35,209,139,0.15);padding:3px 8px;border-radius:4px;text-transform:uppercase;letter-spacing:0.5px">
                ✓ Correct Selection
              </span>
            `;
          } else if (isSelected && !isCorrect) {
            // Selected & Wrong: Vibrant Red
            cardStyle = 'background:rgba(255,77,77,0.06);border:1px solid var(--red);box-shadow:0 0 10px rgba(255,77,77,0.1);';
            ringColor = 'var(--red)';
            indicatorHtml = `
              <span style="margin-left:auto;font-size:10px;font-weight:700;color:var(--red);background:rgba(255,77,77,0.15);padding:3px 8px;border-radius:4px;text-transform:uppercase;letter-spacing:0.5px">
                ✗ Wrong Selection
              </span>
            `;
          } else if (isCorrect) {
            // Correct answer but not selected: Dotted/Dashed Green
            cardStyle = 'background:rgba(78,201,176,0.03);border:1px dashed var(--green2);';
            ringColor = 'var(--green2)';
            indicatorHtml = `
              <span style="margin-left:auto;font-size:10px;font-weight:600;color:var(--green2);background:rgba(78,201,176,0.1);padding:3px 8px;border-radius:4px;text-transform:uppercase;letter-spacing:0.5px">
                Correct Answer
              </span>
            `;
          } else {
            // Neutral Option
            cardStyle = 'background:var(--bg3);border:1px solid var(--border);';
          }

          return `
            <div class="exam-mcq-opt" style="display:flex;align-items:center;padding:12px 16px;margin-bottom:8px;border-radius:6px;transition:all 0.2s;${cardStyle}">
              <div class="exam-mcq-ring" style="width:14px;height:14px;border:2px solid ${ringColor};border-radius:50%;margin-right:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0">
                ${isSelected ? `<div style="width:6px;height:6px;background:${ringColor};border-radius:50%"></div>` : ''}
              </div>
              <span style="font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:600;color:${ringColor};margin-right:8px">[${labels[i] || i}]</span>
              <div class="exam-mcq-text" style="font-size:13px;color:var(--text);font-family:'Segoe UI',system-ui,sans-serif">${esc(opt)}</div>
              ${indicatorHtml}
            </div>
          `;
        }).join('');
        el('mentor-sub-mcq-options').innerHTML = optionsHtml;
      }
    }
  }; // end mentor namespace

  // Execute a coding submission against the exam fixtures without sending
  // source code to a remote worker. Hidden expected outputs never enter this
  // function; only stdin fixtures are needed to produce a local transcript.
  async function executeCodingCasesLocally(question, studentCode, cases, onProgress) {
    const language = String(question.language || 'python').toLowerCase().trim();
    const runtimeTimeout = ['java', 'c', 'cpp'].includes(language) ? 120000 : 60000;
    const driver = (question.templates && question.templates[language])
      ? question.templates[language].driverCode || ''
      : '';
    const source = language === 'java'
      ? assembleJavaExecutionSource(studentCode, driver, question.templateType)
      : (question.templateType === 'solve_function' && driver
        ? `${studentCode}\n\n${driver}`
        : studentCode);
    if (typeof ClientExecution === 'undefined') {
      throw new Error(`Browser runtime module is not loaded for ${language}.`);
    }
    if (!ClientExecution.supports(language)) {
      throw new Error(`No browser runtime is available for ${language}.`);
    }

    const results = [];
    for (let index = 0; index < cases.length; index += 1) {
      const testCase = cases[index] || {};
      onProgress?.(`Running ${language.toUpperCase()} case ${index + 1}/${cases.length} on this device…`);
      const result = await ClientExecution.run(language, source, String(testCase.input || ''), {
        timeoutMs: runtimeTimeout,
        fileName: language === 'java' ? 'Main.java' : `main.${language}`,
        onProgress: progress => {
          if (progress && progress.detail) onProgress?.(progress.detail);
        }
      });
      if (!result) throw new Error(`The ${language} browser runtime did not return a result.`);
      if (isExecutionFailure(result)) {
        const detail = String(result.stderr || `exit code ${result.code}`).trim();
        throw new Error(`${language.toUpperCase()} case ${index + 1} failed: ${detail.slice(0, 800)}`);
      }
      results.push({
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        code: result.code === undefined ? 1 : result.code,
      });
    }
    return results;
  }

  // ── STUDENT NAMESPACE ──────────────────────────────────────────────────────
  const studentNS = {

    formatRoomId(input) {
      let val = input.value.toUpperCase().replace(/[^A-Z0-9-]/g, '');
      // Auto-insert hyphen after MNG
      if (val.length > 3 && val[3] !== '-') {
        val = val.slice(0, 3) + '-' + val.slice(3);
      }
      input.value = val.slice(0, 7); // MNG-XXX = 7 chars
    },

    async reportFlaggedViolation(violationType) {
      if (!state.student.roomId || !state.student.studentId) return;
      try {
        try {
          await studentNS.autoSaveAllResponses();
        } catch (saveError) {
          console.error('Could not save exam responses before reporting a violation:', saveError);
        }
        const res = await apiCall(`/api/exam/room/${state.student.roomId}/student/${state.student.studentId}/violation`, 'POST', {
          violationType: violationType
        });
        if (res && res.status === 'ok' && violationType === 'copy_paste_attempt') {
          state.student.copyPasteAttempts = Number(res.copyPasteAttempts || 0);
          if (res.blocked) {
            clearInterval(state.student.pollInterval);
            clearInterval(state.student.timerInterval);
            studentNS.handleKicked(res.blockedReason || `Copy/paste attempt limit reached (${res.copyPasteLimit || state.student.maxCopyPasteAttempts || 3}).`);
          }
        }
        return res;
      } catch (err) {
        console.error("Failed to report proctoring violation:", err);
        return null;
      }
    },

    async joinRoom() {
      const name = el('student-name').value.trim();
      const rollNo = el('student-roll').value.trim().toUpperCase();
      const branch = el('student-branch').value;
      const section = (el('student-section') ? el('student-section').value.trim().toUpperCase() : 'A') || 'A';
      const roomId = el('student-room-id').value.trim().toUpperCase();

      // Strict Validation
      let valid = true;
      
      // Name: minimum 3 chars, letters/spaces/dots/hyphens only
      if (!name || name.length < 3) {
        el('student-name').classList.add('has-err');
        el('student-name-err').textContent = '// Full Name must be at least 3 characters';
        el('student-name-err').style.display = 'block';
        valid = false;
      } else if (!/^[a-zA-Z\s\.\-']+$/.test(name)) {
        el('student-name').classList.add('has-err');
        el('student-name-err').textContent = '// Name can only contain letters, spaces, or dots';
        el('student-name-err').style.display = 'block';
        valid = false;
      } else {
        el('student-name').classList.remove('has-err');
        el('student-name-err').style.display = 'none';
      }

      // Roll Number: alphanumeric, 3-20 chars
      if (!rollNo || rollNo.length < 3) {
        el('student-roll').classList.add('has-err');
        el('student-roll-err').textContent = '// Valid Roll number required (min 3 chars)';
        el('student-roll-err').style.display = 'block';
        valid = false;
      } else if (!/^[A-Z0-9\-]+$/.test(rollNo)) {
        el('student-roll').classList.add('has-err');
        el('student-roll-err').textContent = '// Roll number must be alphanumeric (no special symbols)';
        el('student-roll-err').style.display = 'block';
        valid = false;
      } else {
        el('student-roll').classList.remove('has-err');
        el('student-roll-err').style.display = 'none';
      }

      // Branch
      if (!branch) {
        el('student-branch').classList.add('has-err');
        el('student-branch-err').textContent = '// Select a branch';
        el('student-branch-err').style.display = 'block';
        valid = false;
      } else {
        el('student-branch').classList.remove('has-err');
        el('student-branch-err').style.display = 'none';
      }

      // Section
      if (!section || !/^[A-Z0-9\-]+$/.test(section)) {
        if (el('student-section')) el('student-section').classList.add('has-err');
        if (el('student-section-err')) {
          el('student-section-err').textContent = '// Enter a valid Section';
          el('student-section-err').style.display = 'block';
        }
        valid = false;
      } else {
        if (el('student-section')) el('student-section').classList.remove('has-err');
        if (el('student-section-err')) el('student-section-err').style.display = 'none';
      }

      // Room ID
      if (!roomId || roomId.length < 7) {
        el('student-room-id').classList.add('has-err');
        el('student-room-err').textContent = '// Enter a valid Room ID (e.g. MNG-4X9)';
        el('student-room-err').style.display = 'block';
        valid = false;
      } else {
        el('student-room-id').classList.remove('has-err');
        el('student-room-err').style.display = 'none';
      }

      if (!valid) return;

      el('btn-join-room').disabled = true;
      el('btn-join-room').textContent = 'Verifying & Joining...';

      const res = await apiCall(`/api/exam/room/${roomId}/join`, 'POST', {
        name, rollNo, branch, section
      });

      el('btn-join-room').disabled = false;
      el('btn-join-room').innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="white"><path d="M10 17l5-5-5-5v10zm-5 0l5-5-5-5v10z"/></svg> Join Room';

      if (res.status === 'ok') {
        state.student.roomId = roomId;
        state.student.studentId = res.studentId;
        state.student.name = name;
        state.student.rollNo = rollNo;
        state.student.branch = branch;
        state.student.section = section;

        // Persist
        localStorage.setItem('exam_student_id', res.studentId);
        localStorage.setItem('exam_student_room', roomId);

        if (res.roomStatus === 'live') {
          // Exam already started — go directly to exam
          await studentNS.initExam(roomId);
        } else {
          // Go to waiting room
          studentNS.initWaitingRoom(roomId, res.roomTitle);
        }
      } else {
        if (res.error === 'already_submitted') {
          showPanel('exam-thankyou-panel');
          return;
        }
        el('student-join-err').textContent = res.message || res.error || '// Verification Failed: Unable to join room';
        el('student-join-err').style.display = 'block';
      }
    },

    initWaitingRoom(roomId, roomTitle) {
      if (el('wait-room-id-display')) el('wait-room-id-display').textContent = roomId;
      if (el('wait-room-name')) el('wait-room-name').textContent = roomTitle || roomId;
      if (el('wait-room-title')) el('wait-room-title').textContent = roomTitle || roomId;

      showPanel('exam-student-wait-panel');
      studentNS._startWaitPoll(roomId);
    },

    _startWaitPoll(roomId) {
      clearInterval(state.student.pollInterval);
      state.student.pollInterval = setInterval(async () => {
        const res = await apiCall(`/api/exam/room/${roomId}`);
        if (res.status === 'ok') {
          if (isStudentKicked(res.kicked, state.student.studentId)) {
            const reason = res.kicked[state.student.studentId];
            clearInterval(state.student.pollInterval);
            await studentNS.autoSaveAllResponses();
            studentNS.handleKicked(reason);
            return;
          }
          renderParticipants(res.participants || [], 'wait-participants-body', 'wait-participants-count');
          if (res.meta && res.meta.status === 'live') {
            clearInterval(state.student.pollInterval);
            await studentNS.initExam(roomId);
          }
        }
      }, 3000);
    },

    async initExam(roomId) {
      const res = await apiCall(`/api/exam/room/${roomId}`);
      if (res.status !== 'ok') return;
      if (isStudentKicked(res.kicked, state.student.studentId)) {
        const reason = res.kicked[state.student.studentId];
        await studentNS.autoSaveAllResponses();
        studentNS.handleKicked(reason);
        return;
      }

      state.student.roomId = roomId;
      state.student.questions = res.questions || [];
      state.student.datasets = res.datasets || [];
      state.student.roomStatus = (res.meta && res.meta.status) ? res.meta.status : 'live';
      state.student.paperVersion = (res.meta && res.meta.paperVersion) || '';

      // Setup proctoring settings
      state.student.fullscreenMode = (res.meta && (res.meta.fullscreenMode === '1' || res.meta.fullscreenMode === true));
      state.student.blockCopyPaste = (res.meta && (res.meta.blockCopyPaste === '1' || res.meta.blockCopyPaste === true));
      state.student.maxFullscreenExits = (res.meta && parseInt(res.meta.maxFullscreenExits)) || 5;
      state.student.maxCopyPasteAttempts = (res.meta && parseInt(res.meta.maxCopyPasteAttempts)) || 3;
      state.student.copyPasteAttempts = 0;
      state.student.fullscreenExitCount = 0;
      state.student.fullscreenActive = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
      state.student.fullscreenWarningOpen = false;

      // Initialize question status
      state.student.status = {};
      state.student.questions.forEach(q => {
        state.student.status[q.id] = 'unattempted';
      });

      // Fetch existing submissions for the student to restore their state
      try {
        const subsRes = await apiCall(`/api/exam/room/${roomId}/student/${state.student.studentId}/submissions?isStudent=1`);
        if (subsRes.status === 'ok' && subsRes.submissions) {
          state.student.questions.forEach(q => {
            const sub = subsRes.submissions[q.id];
            if (sub) {
              const isAutoSave = sub.isAutoSave === true || sub.isAutoSave === 'true' || sub.isAutoSave === 1;
              state.student.status[q.id] = isAutoSave ? 'draft' : 'submitted';
              if (isDataQuestion(q)) {
                q._studentDraft = sub.query !== undefined ? sub.query : (q.type === 'sql' ? 'SELECT * FROM users LIMIT 10;' : `// Question\ndb.`);
              } else if (q.type === 'mcq') {
                if (q.isMultiSelect) {
                  q._studentSelectedOptions = (sub.selectedOptions || []).map(x => parseInt(x));
                } else {
                  q._studentSelectedOption = sub.selectedOption !== undefined && sub.selectedOption !== null ? parseInt(sub.selectedOption) : null;
                }
              } else if (q.type === 'coding') {
                q._studentDrafts = q._studentDrafts || {};
                q._studentDraft = sub.code || '';
                if (sub.language) {
                  q.language = sub.language;
                  q._studentDrafts[sub.language] = sub.code || '';
                }
              }
            }
          });
        }
      } catch (err) {
        console.error("Failed to restore previous submissions:", err);
      }

      // Update header
      if (el('student-exam-room-title')) el('student-exam-room-title').textContent = (res.meta && res.meta.title) ? res.meta.title : roomId;

      // Timer
      if (res.meta && res.meta.timed === '1' && res.meta.startedAt) {
        studentNS._startExamTimer(parseInt(res.meta.startedAt), parseInt(res.meta.duration));
      }

      // Render question nav
      studentNS._renderQNav();

      showPanel('exam-student-exam-panel');

      if (state.student.fullscreenMode) {
        syncFullscreenEnforcement(true);
        clearInterval(state.student.fullscreenWatchInterval);
        state.student.fullscreenWatchInterval = setInterval(() => syncFullscreenEnforcement(false), 750);
      }

      // Poll for exam end & kicked status using optimized status check
      clearInterval(state.student.pollInterval);
      state.student.pollInterval = setInterval(async () => {
        const statusRes = await apiCall(`/api/exam/room/${roomId}/status`);
        if (statusRes.status === 'ok') {
          if (isStudentKicked(statusRes.kicked, state.student.studentId)) {
            const reason = statusRes.kicked[state.student.studentId];
            clearInterval(state.student.pollInterval);
            clearInterval(state.student.timerInterval);
            await studentNS.autoSaveAllResponses();
            studentNS.handleKicked(reason);
            return;
          }
          if (statusRes.roomStatus === 'ended') {
            clearInterval(state.student.pollInterval);
            clearInterval(state.student.timerInterval);
            await studentNS.autoSaveAllResponses();
            studentNS._lockExam();
            return;
          }
          if (statusRes.paperVersion && statusRes.paperVersion !== state.student.paperVersion) {
            await studentNS._syncUpdatedPaper(statusRes.paperVersion);
          }
        }
      }, 3000);

      // Init student editor and select first question immediately
      studentNS._initStudentEditor();
      if (state.student.questions.length > 0) {
        studentNS.selectQuestion(0);
      }
    },

    async _syncUpdatedPaper() {
      if (state.student.paperSyncInFlight || !state.student.roomId) return;
      state.student.paperSyncInFlight = true;
      try {
        clearTimeout(state.student.autoSaveTimeout);
        studentNS.saveCurrentActiveDraft();
        await studentNS.autoSaveAllResponses();

        const res = await apiCall(`/api/exam/room/${state.student.roomId}`);
        if (res.status !== 'ok') return;
        const previousQuestions = state.student.questions || [];
        const previousStatus = state.student.status || {};
        const previousQuestion = previousQuestions[state.student.currentQIdx];
        const previousIndex = state.student.currentQIdx || 0;
        const previousById = new Map(previousQuestions.map(question => [question.id, question]));
        const nextQuestions = res.questions || [];
        const nextStatus = {};

        nextQuestions.forEach(question => {
          const previous = previousById.get(question.id);
          if (previous && previous.type === question.type) {
            for (const key of [
              '_studentDraft', '_studentDrafts', '_studentSelectedOption',
              '_studentSelectedOptions', '_studentResult'
            ]) {
              if (previous[key] !== undefined) question[key] = previous[key];
            }
            nextStatus[question.id] = previousStatus[question.id] || 'unattempted';
          } else {
            nextStatus[question.id] = 'unattempted';
          }
        });

        state.student.questions = nextQuestions;
        state.student.datasets = res.datasets || [];
        state.student.status = nextStatus;
        state.student.paperVersion = (res.meta && res.meta.paperVersion) || '';
        const nextIndex = previousQuestion
          ? nextQuestions.findIndex(question => question.id === previousQuestion.id)
          : -1;
        const selectedIndex = nextIndex >= 0
          ? nextIndex
          : Math.min(previousIndex, Math.max(0, nextQuestions.length - 1));

        studentNS._renderQNav();
        state.student.currentQIdx = null;
        if (nextQuestions.length) studentNS.selectQuestion(selectedIndex);
        setStudentSaveState('Paper updated · your saved work was retained', 'saved');
      } catch (error) {
        console.error('Failed to synchronize updated exam paper:', error);
        setStudentSaveState('Paper update could not be loaded; retrying', 'error');
      } finally {
        state.student.paperSyncInFlight = false;
      }
    },

    _startExamTimer(startedAt, durationMin) {
      const timerEl = el('student-exam-timer');
      if (!timerEl) return;
      startedAt = parseInt(startedAt);
      durationMin = parseInt(durationMin);
      if (isNaN(startedAt) || isNaN(durationMin) || durationMin <= 0) return;

      timerEl.style.display = 'flex';
      timerEl.style.fontFamily = "'JetBrains Mono',monospace";
      timerEl.style.fontSize = '12px';

      clearInterval(state.student.timerInterval);
      state.student.timerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() / 1000) - startedAt);
        const remaining = (durationMin * 60) - elapsed;
        timerEl.textContent = formatTime(Math.max(0, remaining));
        timerEl.style.color = remaining <= 60 ? 'var(--red)' : remaining <= 300 ? 'var(--yellow)' : 'var(--green2)';
        if (remaining <= 0) {
          clearInterval(state.student.timerInterval);
          studentNS.autoSaveAllResponses().then(function() {
            studentNS._lockExam();
          });
        }
      }, 1000);
    },

    _initStudentEditor() {
      const ta = el('student-raw-editor');
      if (!ta || typeof CodeMirror === 'undefined') return;
      if (state.student.examEditor) return; // already inited

      const cm = CodeMirror.fromTextArea(ta, {
        mode: 'javascript',
        theme: 'default',
        lineNumbers: true,
        matchBrackets: true,
        autoCloseBrackets: true,
        styleActiveLine: true,
        indentUnit: 4,
        tabSize: 4,
        indentWithTabs: false,
        smartIndent: true,
        extraKeys: {
          'Ctrl-Enter': () => studentNS.runQuery(),
          'Enter': (cm) => {
            const cursor = cm.getCursor();
            const line = cm.getLine(cursor.line);
            if (cursor.ch > 0 && cursor.ch <= line.length) {
              const before = line.charAt(cursor.ch - 1);
              const after = line.charAt(cursor.ch);
              if (before === '{' && after === '}') {
                cm.replaceRange('\n\n', cursor);
                cm.setCursor({ line: cursor.line + 1, ch: 0 });
                cm.indentLine(cursor.line + 1, 'smart');
                cm.indentLine(cursor.line + 2, 'smart');
                const middleLine = cm.getLine(cursor.line + 1);
                cm.setCursor({ line: cursor.line + 1, ch: middleLine.length });
                return;
              }
            }
            return CodeMirror.Pass;
          }
        },
      });
      cm.setSize('100%', '100%');
      cm.on('change', () => {
        const currentQ = state.student.questions[state.student.currentQIdx];
        if (currentQ) {
          if (currentQ.type === 'query') {
            currentQ._studentDraft = cm.getValue();
          } else if (currentQ.type === 'coding') {
            currentQ._studentDrafts = currentQ._studentDrafts || {};
            currentQ._studentDrafts[currentQ.language || 'python'] = cm.getValue();
            currentQ._studentDraft = cm.getValue();
          }
          if (state.student.status[currentQ.id] !== 'submitted') {
            state.student.status[currentQ.id] = 'draft';
            studentNS._renderQNav();
          }
          setStudentSaveState('Unsaved', 'dirty');
          
          // Debounce auto-save to Redis
          clearTimeout(state.student.autoSaveTimeout);
          state.student.autoSaveTimeout = setTimeout(() => {
            studentNS.autoSaveSingleQuestion(currentQ);
          }, 500);
        }
      });
      cm.on('paste', (instance, e) => {
        if (state.student.roomId && state.student.blockCopyPaste) {
          const pastedText = (e.clipboardData || window.clipboardData).getData('text') || "";
          const cleanPasted = pastedText.replace(/\r/g, '').trim();
          const cleanInternal = (state.student.lastInternalCopiedText || "").replace(/\r/g, '').trim();

          if (state.student.copiedFromEditor && cleanPasted && cleanPasted === cleanInternal) {
            return;
          }

          // Mark as pasting to block inside beforeChange in case preventDefault is bypassed
          state.student.isPasting = true;
          setTimeout(() => { state.student.isPasting = false; }, 100);

          // Cancel the paste event inside CodeMirror
          e.preventDefault();
          e.stopPropagation();
          return true;
        }
      });
      cm.on('beforeChange', (instance, change) => {
        if (change.origin === 'paste' || state.student.isPasting) {
          if (state.student.roomId && state.student.blockCopyPaste) {
            const pastedText = change.text.join('\n');
            const cleanPasted = pastedText.replace(/\r/g, '').trim();
            const cleanInternal = (state.student.lastInternalCopiedText || '').replace(/\r/g, '').trim();

            if (state.student.copiedFromEditor && cleanPasted && cleanPasted === cleanInternal) {
              // Allow pasting text that was copied from the code editor itself
              return;
            }

            // Otherwise block it!
            change.cancel();
            state.student.isPasting = false;
          }
        }
      });
      state.student.examEditor = cm;
      attachCodexaKeywordHints(cm, () => {
        const q = state.student.questions[state.student.currentQIdx];
        return q && q.type === 'sql' ? 'sql' : (q && q.type === 'query' ? 'mongodb' : ((q && q.language) || 'python'));
      });
      
      // Initialize styling settings (restore saved preferences first)
      studentNS.loadEditorSettings();
      studentNS.updateEditorSettings();

      // If a question was selected before editor initialization, load its value now
      if (state.student.currentQIdx !== null) {
        const q = state.student.questions[state.student.currentQIdx];
        if (q) {
          if (isDataQuestion(q)) {
            cm.setOption('mode', q.type === 'sql' ? 'text/x-sql' : 'javascript');
            cm.setValue(q._studentDraft !== undefined ? q._studentDraft : (q.type === 'sql' ? 'SELECT * FROM users LIMIT 10;' : `// Write your MongoDB query here\ndb.collection.find({})`));
            cm.clearHistory();
          } else if (q.type === 'coding') {
            let currentCode = q._studentDrafts ? q._studentDrafts[q.language] : undefined;
            if (currentCode === undefined) {
              currentCode = ((q.templates && q.templates[q.language]) ? q.templates[q.language].starterCode : null) || q.starterCode || '';
            }
            let cmMode = 'python';
            if (q.language === 'cpp' || q.language === 'c') cmMode = 'text/x-c++src';
            if (q.language === 'java') cmMode = 'text/x-java';
            if (q.language === 'javascript') cmMode = 'javascript';
            cm.setOption('mode', cmMode);
            cm.setValue(currentCode);
            cm.clearHistory();
          }
        }
      }
    },

    _renderQNav() {
      const body = el('student-qnav-body');
      const qs = state.student.questions;
      if (!body) return;
      if (qs.length === 0) {
        body.innerHTML = '<div class="exam-participants-empty">// No questions</div>';
        return;
      }
      if (el('student-q-progress')) el('student-q-progress').textContent = `Q ${state.student.currentQIdx !== null ? state.student.currentQIdx + 1 : 0}/${qs.length}`;
      const questionCount = el('student-question-count');
      if (questionCount) questionCount.textContent = qs.length;
      const footerProgress = el('student-footer-progress');
      if (footerProgress) footerProgress.textContent = `Question ${state.student.currentQIdx !== null ? state.student.currentQIdx + 1 : 0} of ${qs.length}`;
      const progressFill = el('student-progress-fill');
      if (progressFill) progressFill.style.width = `${state.student.currentQIdx !== null ? ((state.student.currentQIdx + 1) / qs.length) * 100 : 0}%`;
      const prevBtn = el('student-prev-btn');
      const nextBtn = el('student-next-btn');
      if (prevBtn) prevBtn.disabled = state.student.currentQIdx === null || state.student.currentQIdx <= 0;
      if (nextBtn) nextBtn.disabled = state.student.currentQIdx === null || state.student.currentQIdx >= qs.length - 1;
      body.innerHTML = qs.map((q, i) => {
        const statusKey = state.student.status[q.id] || 'unattempted';
        const dotClass = statusKey === 'submitted' ? 'exam-q-status-submitted'
          : statusKey === 'draft' ? 'exam-q-status-draft'
          : 'exam-q-status-unattempted';
        let typeLabel = 'QUERY';
        let typeClass = 'exam-q-type-query';
        if (q.type === 'sql') {
          typeLabel = 'SQL';
          typeClass = 'exam-q-type-sql';
        } else if (q.type === 'mcq') {
          typeLabel = 'MCQ';
          typeClass = 'exam-q-type-mcq';
        } else if (q.type === 'coding') {
          typeLabel = 'CODING';
          typeClass = 'exam-q-type-coding';
        }
        return `
          <div class="exam-qnav-card ${state.student.currentQIdx === i ? 'active' : ''}"
               onclick="ExamPortal.student.selectQuestion(${i})">
            <div class="exam-q-card-top" style="margin-bottom:0">
              <span class="exam-q-num">Q${i + 1}</span>
              <span class="exam-q-type-chip ${typeClass}">${typeLabel}</span>
              <span class="exam-q-marks-badge">${q.marks}pts</span>
              <div class="exam-q-status-dot ${dotClass}" style="margin-left:auto"></div>
            </div>
          </div>
        `;
      }).join('');
    },

    previousQuestion() {
      const current = Number(state.student.currentQIdx);
      if (!Number.isFinite(current) || current <= 0) return;
      studentNS.selectQuestion(current - 1);
    },

    nextQuestion() {
      const current = Number(state.student.currentQIdx);
      if (!Number.isFinite(current) || current >= state.student.questions.length - 1) return;
      studentNS.selectQuestion(current + 1);
    },

    selectQuestion(idx) {
      const qs = state.student.questions;
      if (!qs || !qs[idx]) return;
      const selectedQuestion = qs[idx];
      const examPanel = el('exam-student-exam-panel');
      if (examPanel) examPanel.classList.toggle('exam-mcq-active', selectedQuestion.type === 'mcq');

      // Preserve current draft before switching
      const currentQ = state.student.currentQIdx !== null ? state.student.questions[state.student.currentQIdx] : null;
      if (currentQ && state.student.examEditor) {
        if (currentQ.type === 'coding') {
          currentQ._studentDrafts = currentQ._studentDrafts || {};
          currentQ._studentDrafts[currentQ.language || 'python'] = state.student.examEditor.getValue();
          currentQ._studentDraft = state.student.examEditor.getValue();
        } else {
          currentQ._studentDraft = state.student.examEditor.getValue();
        }
      }

      state.student.currentQIdx = idx;
      const q = qs[idx];

      // Update header
      let typeLabel = 'QUERY';
      let typeClass = 'exam-q-type-query';
      if (q.type === 'sql') {
        typeLabel = 'SQL';
        typeClass = 'exam-q-type-sql';
      } else if (q.type === 'mcq') {
        typeLabel = 'MCQ';
        typeClass = 'exam-q-type-mcq';
      } else if (q.type === 'coding') {
        typeLabel = 'CODING';
        typeClass = 'exam-q-type-coding';
      }

      el('student-q-number').textContent = `Q${idx + 1}`;
      el('student-q-type-chip').textContent = typeLabel;
      el('student-q-type-chip').className = `exam-q-type-chip ${typeClass}`;
      el('student-q-marks').textContent = `${q.marks} marks`;

      // Render Markdown question description
      const descHtml = renderQuestionHtml(q);
      el('student-q-text').innerHTML = descHtml;
      el('student-no-q-selected').style.display = 'none';

      if (el('student-q-progress')) el('student-q-progress').textContent = `Q ${idx + 1}/${qs.length}`;

      // Reset default student activeTab to README for query/coding
      state.student.activeTab = 'readme';

      // Show/hide areas
      if (isDataQuestion(q) || q.type === 'coding') {
        el('student-mcq-area').style.display = 'none';
        el('resizer-student-description').style.display = 'block';
        el('exam-student-exam-panel').querySelector('.exam-student-main').style.gridTemplateColumns = '';

        const isQuery = isDataQuestion(q);
        el('btn-inspect-dataset').style.display = isQuery ? 'flex' : 'none';
        el('student-lang-selector-wrap').style.display = isQuery ? 'none' : 'flex';
        const editorWrap = document.querySelector('#student-query-area .exam-editor-wrap');
        if (editorWrap) editorWrap.classList.toggle('exam-sql-editor-wrap', isSqlQuestion(q));

        if (isQuery) {
          el('student-console-title-text').textContent = 'Query Output Comparison';
          el('student-console-tabs-bar').style.display = 'none';
          el('student-pane-left-title').textContent = 'Your Output';
          el('student-pane-right-title').textContent = 'Expected Output (Preview)';
          el('student-pane-expected').style.display = 'block';
          el('student-pane-yours').style.display = 'block';
          el('student-stdin-input').style.display = 'none';
          state.student.sqlResult = null;
          state.student.lastRunOutput = null;

          // Set editor content
          const cm = state.student.examEditor;
          if (cm) {
            cm.setOption('mode', q.type === 'sql' ? 'text/x-sql' : 'javascript');
            cm.setValue(q._studentDraft !== undefined ? q._studentDraft : (q.type === 'sql' ? 'SELECT * FROM users LIMIT 10;' : `// Question ${idx + 1}\ndb.`));
            cm.clearHistory();
          }

          // Reset console
          el('student-pane-yours').innerHTML = '<span style="color:var(--text3)">// Run a query to see output here</span>';
          el('student-console-status').textContent = '— Ready';
          el('student-console-status').style.color = 'var(--text3)';
          state.student.hasRunOnce = false;

          if (state.student.status[q.id] === 'submitted') {
            el('student-submit-query-btn').disabled = false;
            el('student-submit-query-btn').style.opacity = '1';
          } else {
            el('student-submit-query-btn').disabled = true;
            el('student-submit-query-btn').style.opacity = '0.4';
          }

          // Automatically fetch expected preview on question select
          studentNS._fetchExpectedPreview(q.id);
        } else {
          // Coding question
          el('student-console-title-text').textContent = 'Coding Console';
          el('student-console-tabs-bar').style.display = 'flex';

          // Populate allowed languages select dropdown
          const langSelect = el('student-lang-select');
          const allowed = q.allowedLanguages || ['python', 'cpp', 'c', 'java', 'javascript'];
          const labels = { python: 'Python 3', cpp: 'C++', c: 'C', java: 'Java', javascript: 'JavaScript' };
          langSelect.innerHTML = allowed.map(lang => `
            <option value="${lang}">${labels[lang]}</option>
          `).join('');

          // Select first allowed language or keep active if allowed
          if (!q.language || !allowed.includes(q.language)) {
            q.language = allowed[0] || 'python';
          }
          langSelect.value = q.language;

          if (!q.templates) {
            q.templates = {
              python: { starterCode: q.starterCode || '# write your Python 3 code here\nimport sys\n\nfor line in sys.stdin:\n    print(int(line) * 2)\n', driverCode: '' },
              cpp: { starterCode: '#include <iostream>\nusing namespace std;\n\nint main() {\n    int n;\n    while (cin >> n) {\n        cout << n * 2 << endl;\n    }\n    return 0;\n}', driverCode: '' },
              c: { starterCode: '#include <stdio.h>\n\nint main() {\n    int n;\n    while (scanf("%d", &n) != EOF) {\n        printf("%d\\n", n * 2);\n    }\n    return 0;\n}', driverCode: '' },
              java: { starterCode: 'import java.util.Scanner;\n\npublic class Solution {\n    public static void main(String[] args) {\n        Scanner sc = new Scanner(System.in);\n        while (sc.hasNextInt()) {\n            int n = sc.nextInt();\n            System.out.println(n * 2);\n        }\n    }\n}', driverCode: '' },
              javascript: { starterCode: 'const value = Number(readline());\nconsole.log(value * 2);\n', driverCode: '' }
            };
          }

          // Set editor content based on active language draft or template
          q._studentDrafts = q._studentDrafts || {};
          let currentCode = q._studentDrafts[q.language];
          if (currentCode === undefined) {
            currentCode = ((q.templates && q.templates[q.language]) ? q.templates[q.language].starterCode : null) || q.starterCode || '';
          }

          const cm = state.student.examEditor;
          if (cm) {
            let cmMode = 'python';
            if (q.language === 'cpp' || q.language === 'c') cmMode = 'text/x-c++src';
            if (q.language === 'java') cmMode = 'text/x-java';
            if (q.language === 'javascript') cmMode = 'javascript';
            cm.setOption('mode', cmMode);
            cm.setValue(currentCode);
            cm.clearHistory();
          }

          // Reset console
          el('student-console-status').textContent = '— Ready';
          el('student-console-status').style.color = 'var(--text3)';
          state.student.hasRunOnce = false;

          // Initialize case tabs & select first tab
          studentNS.initConsoleTabs(q);

          // Always enable submit button for coding questions
          el('student-submit-query-btn').disabled = false;
          el('student-submit-query-btn').style.opacity = '1';
        }

        // Show tabs & select README by default
        studentNS.selectWorkspaceTab('readme');

      } else {
        // MCQ type
        el('student-workspace-tabs').style.display = 'none';
        el('student-question-display').style.display = 'none';
        el('student-query-area').style.display = 'none';
        el('student-no-q-selected').style.display = 'none';
        el('resizer-student-description').style.display = 'none';
        el('exam-student-exam-panel').querySelector('.exam-student-main').style.gridTemplateColumns = '1fr';
        el('student-mcq-area').style.display = 'flex';
        el('btn-inspect-dataset').style.display = 'none';
        
        el('student-mcq-q-number').textContent = `Q${idx + 1}`;
        el('student-mcq-q-marks').textContent = `${q.marks} marks`;
        const descHtml = renderQuestionHtml(q);
        el('student-mcq-question-text').innerHTML = descHtml;
        
        if (q.isMultiSelect) {
          state.student.selectedOptions = q._studentSelectedOptions !== undefined && q._studentSelectedOptions !== null ? [...q._studentSelectedOptions] : [];
        } else {
          state.student.selectedOption = q._studentSelectedOption !== undefined && q._studentSelectedOption !== null ? q._studentSelectedOption : null;
        }

        if (state.student.status[q.id] === 'submitted') {
          el('student-mcq-status').textContent = '// Answer submitted.';
          el('student-mcq-status').style.color = 'var(--green3)';
        } else {
          el('student-mcq-status').textContent = '';
        }
        studentNS._renderMCQOptions(q);
      }

      studentNS._renderQNav();
    },

    _renderMCQOptions(q) {
      const container = el('student-mcq-options');
      const labels = ['A', 'B', 'C', 'D', 'E', 'F'];
      const isMulti = q.isMultiSelect;

      container.innerHTML = (q.options || []).map((opt, i) => {
        const isSelected = isMulti
          ? (state.student.selectedOptions || []).includes(i)
          : state.student.selectedOption === i;

        const optTextHtml = typeof marked !== 'undefined' ? marked.parse(opt) : opt;

        const checkMark = isMulti
          ? (isSelected ? '[x]' : '[ ]')
          : (isSelected ? '[x]' : `[${labels[i] || i}]`);

        return `
          <div class="exam-mcq-option-item ${isSelected ? 'selected' : ''}"
               data-idx="${i}"
               tabindex="0"
               onclick="ExamPortal.student.selectMCQOption(${i})"
               onkeydown="ExamPortal.student.mcqKeyNav(event,${i},${(q.options || []).length})">
            <span class="exam-mcq-option-indicator">${checkMark}</span>
            <span class="exam-mcq-option-text">${optTextHtml}</span>
          </div>
        `;
      }).join('');
    },

    mcqKeyNav(event, currentIdx, total) {
      if (!total || total <= 0) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        const next = (currentIdx + 1) % total;
        studentNS.selectMCQOption(next);
        const nextEl = document.querySelector(`.exam-mcq-option-item[data-idx="${next}"]`);
        if (nextEl) nextEl.focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        const prev = (currentIdx - 1 + total) % total;
        studentNS.selectMCQOption(prev);
        const prevEl = document.querySelector(`.exam-mcq-option-item[data-idx="${prev}"]`);
        if (prevEl) prevEl.focus();
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        studentNS.selectMCQOption(currentIdx);
      }
    },

    selectMCQOption(idx) {
      const q = state.student.questions[state.student.currentQIdx];
      if (!q) return;

      state.student.status[q.id] = 'draft';

      if (q.isMultiSelect) {
        state.student.selectedOptions = state.student.selectedOptions || [];
        const pos = state.student.selectedOptions.indexOf(idx);
        if (pos > -1) {
          state.student.selectedOptions.splice(pos, 1);
        } else {
          state.student.selectedOptions.push(idx);
        }
        q._studentSelectedOptions = [...state.student.selectedOptions];
      } else {
        state.student.selectedOption = idx;
        q._studentSelectedOption = idx;
      }

      studentNS._renderMCQOptions(q);
      studentNS._renderQNav();
      setStudentSaveState('Saving…', 'saving');

      // Debounce auto-save to Redis
      clearTimeout(state.student.autoSaveTimeout);
      state.student.autoSaveTimeout = setTimeout(() => {
        studentNS.autoSaveSingleQuestion(q);
      }, 500);
    },

    toggleFocusMode() {
      const panel = el('exam-student-exam-panel');
      if (!panel) return;
      const active = panel.classList.toggle('exam-focus-mode-active');
      const button = el('student-focus-button');
      if (button) {
        button.setAttribute('aria-pressed', String(active));
        button.title = active ? 'Exit focus mode' : 'Toggle focus mode';
        button.classList.toggle('active', active);
      }
      setTimeout(() => {
        if (state.student.examEditor) state.student.examEditor.refresh();
      }, 60);
    },

    changeLanguage(newLang) {
      const q = state.student.questions[state.student.currentQIdx];
      if (!q || q.type !== 'coding') return;
      
      // Save current code to active language draft
      if (state.student.examEditor) {
        q._studentDrafts = q._studentDrafts || {};
        q._studentDrafts[q.language || 'python'] = state.student.examEditor.getValue();
      }
      
      q.language = newLang;
      let nextCode = q._studentDrafts ? q._studentDrafts[newLang] : undefined;
      if (nextCode === undefined) {
        nextCode = ((q.templates && q.templates[newLang]) ? q.templates[newLang].starterCode : null) || q.starterCode || '';
      }
      
      const cm = state.student.examEditor;
      if (cm) {
        let cmMode = 'python';
        if (newLang === 'cpp' || newLang === 'c') cmMode = 'text/x-c++src';
        if (newLang === 'java') cmMode = 'text/x-java';
        if (newLang === 'javascript') cmMode = 'javascript';
        cm.setOption('mode', cmMode);
        cm.setValue(nextCode);
        cm.clearHistory();
      }
      
      // Auto-save the new draft immediately
      studentNS.autoSaveSingleQuestion(q);
    },

    setConsoleTab(tab) {
      ['yours', 'expected'].forEach(function(t) {
        const tabBtn = el(`student-ctab-${t}`);
        if (tabBtn) tabBtn.classList.toggle('active', t === tab);
        const pane = el(`student-pane-${t}`);
        if (pane) pane.classList.toggle('active', t === tab);
      });
    },

    toggleExecutionLog() {
      const card = el('student-execution-card');
      const toggle = el('student-execution-toggle');
      if (!card) return;
      const collapsed = card.classList.toggle('is-collapsed');
      if (toggle) {
        toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        toggle.setAttribute('title', collapsed ? 'Expand execution log' : 'Collapse execution log');
        toggle.textContent = collapsed ? '⌄' : '⌃';
      }
    },

    async runQuery() {
      const cm = state.student.examEditor;
      if (!cm) return;
      const query = cm.getValue();
      const q = state.student.questions[state.student.currentQIdx];
      if (!q) return;

      if (q.type === 'sql') {
        const datasetIds = q.datasetIds || (q.datasetId ? [q.datasetId] : []);
        if (datasetIds.length === 0) {
          el('student-pane-yours').innerHTML = '<span style="color:var(--red)">// No dataset linked to this question</span>';
          return;
        }
        el('student-run-btn').textContent = 'Running...';
        el('student-run-btn').disabled = true;
        setExamExecutionOrigin('remote');
        const res = await runExamSql(state.student.roomId, datasetIds, query);
        el('student-run-btn').innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg> Run';
        el('student-run-btn').disabled = false;
        if (res.status === 'ok') {
          state.student.sqlResult = res;
          q._studentResult = res;
          state.student.lastRunOutput = { columns: res.columns || [], rows: res.rows || [] };
          el('student-console-status').textContent = `— ${(res.rows || []).length} row(s)`;
          el('student-console-status').style.color = 'var(--text3)';
          el('student-pane-yours').innerHTML = renderExamSqlResult(res);
          state.student.hasRunOnce = true;
          el('student-submit-query-btn').disabled = false;
          el('student-submit-query-btn').style.opacity = '1';
        } else {
          el('student-console-status').textContent = '— Error';
          el('student-console-status').style.color = 'var(--red)';
          el('student-pane-yours').innerHTML = `<span style="color:var(--red)">${escapeExamHtml(res.error || '// Unknown error')}</span>`;
        }
        studentNS._fetchExpectedPreview(q.id);
        studentNS._checkQueryAnswer(q, query, datasetIds);
        return;
      }

      if (q.type === 'coding') {
        const sampleCases = state.student.sampleCases || [];
        const stdins = sampleCases.map(tc => tc.input || '');
        const customInputVal = el('student-stdin-input') ? el('student-stdin-input').value : '';
        // The stdin textarea also displays the selected sample case. Only
        // input entered while the Custom Input tab is active may trigger the
        // intentional remote custom-verification path.
        const hasCustomInput = state.student.activeConsoleTab === 'custom' && customInputVal.trim().length > 0;

        el('student-run-btn').textContent = 'Running...';
        el('student-run-btn').disabled = true;
        startStudentExecutionCard(q.language);
        setExamExecutionOrigin('local');
        el('student-console-status').style.color = 'var(--text3)';
        const codingLanguage = String(q.language || 'python').toLowerCase().trim();

        let codeToExecute = query;
        if (q.templateType === 'solve_function') {
          const driver = (q.templates && q.templates[q.language]) ? q.templates[q.language].driverCode : '';
          if (driver) {
            codeToExecute = q.language === 'java'
              ? assembleJavaExecutionSource(query, driver, q.templateType)
              : `${query}\n\n${driver}`;
          }
        }

        // Run Python in the same isolated browser worker runtime used by the
        // compiled languages. This avoids Skulpt's exam-specific input and
        // execution-limit behaviour while keeping Python on-device.
        if (codingLanguage === 'python' && typeof ClientExecution !== 'undefined' && ClientExecution.supports('python')) {
          const runLocalCases = async () => {
            const results = [];
            for (const inp of stdins) {
              const res = await ClientExecution.run('python', codeToExecute, inp, {
                timeoutMs: 60000,
                onProgress: progress => {
                  if (progress && progress.detail) {
                    console.info('[CodeLeaf exam]', progress.detail);
                    updateStudentExecutionCard(progress.detail, { mode: 'local' });
                  }
                }
              });
              if (!res) throw new Error('The Python browser runtime returned no result.');
              results.push({
                stdout: res.stdout || '',
                stderr: res.stderr || '',
                code: res.code,
                executionFailure: res.executionFailure === true,
                output: res.stdout || res.stderr || ''
              });
            }
            return results;
          };

          runLocalCases().then(async results => {
            let finalResults = results;
            let usedRemoteFallback = false;
            const localFailed = results.some(isExecutionFailure);
            if (localFailed && stdins.length > 0) {
              usedRemoteFallback = true;
              const failedResult = results.find(isExecutionFailure);
              const reason = failedResult?.stderr || `on-device Python exited with code ${failedResult?.code ?? 'unknown'}`;
              setExamExecutionOrigin('remote', true, `On-device execution failed: ${reason}`);
              updateStudentExecutionCard(`Remote fallback started: ${reason}`, { mode: 'remote', kind: 'error' });
              const fallback = await apiCall(`/api/exam/room/${state.student.roomId}/run`, 'POST', {
                studentId: state.student.studentId,
                questionId: q.id,
                language: q.language,
                code: query,
                stdins
              });
              if (fallback.status === 'ok' && fallback.results) {
                finalResults = fallback.results;
                updateStudentExecutionCard('Remote worker completed execution.', { mode: 'remote', kind: 'done' });
              } else {
                updateStudentExecutionCard(`Remote worker failed: ${fallback.error || 'unknown error'}`, { mode: 'remote', kind: 'error' });
              }
            }
            el('student-run-btn').innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg> Run';
            el('student-run-btn').disabled = false;

            state.student.runResults = state.student.runResults || {};
            sampleCases.forEach((tc, i) => {
              state.student.runResults[`${q.id}-case-${i}`] = finalResults[i];
            });

            if (hasCustomInput) {
              setExamExecutionOrigin('remote');
              const customResult = await apiCall(`/api/exam/room/${state.student.roomId}/question/${q.id}/custom-verify`, 'POST', {
                studentId: state.student.studentId,
                language: q.language,
                code: query,
                stdin: customInputVal
              });
              if (customResult.status === 'ok' && customResult.results && customResult.results[0]) {
                state.student.runResults[`${q.id}-custom`] = {
                  ...customResult.results[0],
                  customVerdict: customResult.verdict,
                  expectedOutput: customResult.expectedOutput || ''
                };
              }
            } else {
              setExamExecutionOrigin(usedRemoteFallback ? 'remote' : 'local', false);
            }

            finishStudentExecutionCard();
            studentNS.initConsoleTabs();
            const tabId = state.student.activeConsoleTab || 'case-0';
            studentNS.selectConsoleTab(tabId);
          });
          return;
        }

        // C/C++ sample runs can use the same browser-side WebAssembly
        // compiler as the normal workspace. Submission/grading still uses
        // the authoritative server path below, so local execution cannot
        // affect the exam verdict.
        let localFailureReason = '';
        if (['c', 'cpp', 'java'].includes(codingLanguage) &&
            typeof ClientExecution !== 'undefined' && ClientExecution.supports(codingLanguage)) {
          const localResults = [];
          let localRuntimeAvailable = true;
          for (const inp of stdins) {
            const local = await ClientExecution.run(codingLanguage, codeToExecute, inp, {
              timeoutMs: 120000,
              onProgress: progress => {
                if (progress && progress.detail) {
                  console.info('[CodeLeaf exam]', progress.detail);
                  updateStudentExecutionCard(progress.detail, { mode: 'local' });
                }
              }
            });
            if (!local) {
              localRuntimeAvailable = false;
              localFailureReason = 'The browser runtime returned no result.';
              break;
            }
            if (Number(local.code) !== 0 || String(local.stderr || '').trim()) {
              localFailureReason = String(local.stderr || `on-device ${codingLanguage.toUpperCase()} exited with code ${local.code}`).trim();
            }
            localResults.push({
              stdout: local.stdout || '',
              stderr: local.stderr || '',
              code: local.code,
              output: local.stdout || local.stderr || ''
            });
          }

          const localExecutionFailed = localResults.some(isExecutionFailure);
          if (localRuntimeAvailable && !localExecutionFailed) {
            el('student-run-btn').innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg> Run';
            el('student-run-btn').disabled = false;
            setExamExecutionOrigin('local', false);
            state.student.runResults = state.student.runResults || {};
            sampleCases.forEach((tc, i) => {
              state.student.runResults[`${q.id}-case-${i}`] = localResults[i];
            });
            if (hasCustomInput) {
              setExamExecutionOrigin('remote');
              const customResult = await apiCall(`/api/exam/room/${state.student.roomId}/question/${q.id}/custom-verify`, 'POST', {
                studentId: state.student.studentId,
                language: q.language,
                code: query,
                stdin: customInputVal
              });
              if (customResult.status === 'ok' && customResult.results && customResult.results[0]) {
                state.student.runResults[`${q.id}-custom`] = {
                  ...customResult.results[0],
                  customVerdict: customResult.verdict,
                  expectedOutput: customResult.expectedOutput || ''
                };
              }
            }
            studentNS.initConsoleTabs();
            const tabId = state.student.activeConsoleTab || 'case-0';
            studentNS.selectConsoleTab(tabId);
            finishStudentExecutionCard();
            return;
          }
        }

        if (stdins.length === 0 && !hasCustomInput) {
          el('student-run-btn').innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg> Run';
          el('student-run-btn').disabled = false;
          studentNS.initConsoleTabs();
          studentNS.selectConsoleTab('custom');
          return;
        }

        console.warn('[CodeLeaf exam] On-device run unavailable or failed; using remote fallback.', {
          language: codingLanguage || q.language,
          sampleCount: stdins.length,
          runtimeAvailable: typeof ClientExecution !== 'undefined' && ClientExecution.supports(codingLanguage)
        });
        const fallbackReason = typeof ClientExecution === 'undefined'
          ? 'Browser execution runtime was not loaded.'
          : (localFailureReason || `On-device ${codingLanguage.toUpperCase() || 'code'} runtime failed or timed out.`);
        setExamExecutionOrigin('remote', true, `On-device execution failed: ${fallbackReason}`);
        updateStudentExecutionCard(`Remote fallback started: ${fallbackReason}`, { mode: 'remote', kind: 'error' });
        const res = await apiCall(`/api/exam/room/${state.student.roomId}/run`, 'POST', {
          studentId: state.student.studentId,
          questionId: q.id,
          language: q.language,
          code: query,
          stdins: stdins
        });

        el('student-run-btn').innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg> Run';
        el('student-run-btn').disabled = false;

        state.student.runResults = state.student.runResults || {};

        if (res.status === 'ok' && res.results) {
          updateStudentExecutionCard('Remote worker completed execution.', { mode: 'remote', kind: 'done' });
          sampleCases.forEach((tc, i) => {
            state.student.runResults[`${q.id}-case-${i}`] = res.results[i];
          });
          if (hasCustomInput) {
            const customResult = await apiCall(`/api/exam/room/${state.student.roomId}/question/${q.id}/custom-verify`, 'POST', {
              studentId: state.student.studentId,
              language: q.language,
              code: query,
              stdin: customInputVal
            });
            if (customResult.status === 'ok' && customResult.results && customResult.results[0]) {
              state.student.runResults[`${q.id}-custom`] = {
                ...customResult.results[0],
                customVerdict: customResult.verdict,
                expectedOutput: customResult.expectedOutput || ''
              };
            }
          }

          studentNS.initConsoleTabs();

          const tabId = state.student.activeConsoleTab || 'case-0';
          studentNS.selectConsoleTab(tabId);
          finishStudentExecutionCard();
        } else {
          updateStudentExecutionCard(`Remote worker failed: ${res.error || 'unknown error'}`, { mode: 'remote', kind: 'error' });
          finishStudentExecutionCard();
          showExamAlert('Failed to run: ' + (res.error || 'Unknown error'), { title: 'Run Failed', danger: true });
        }
        return;
      }

      const datasetIds = q.datasetIds || (q.datasetId ? [q.datasetId] : []);
      if (datasetIds.length === 0) {
        el('student-pane-yours').innerHTML = '<span style="color:var(--red)">// No dataset linked to this question</span>';
        return;
      }

      el('student-run-btn').textContent = 'Running...';
      el('student-run-btn').disabled = true;
      setExamExecutionOrigin('remote');
      el('student-console-status').style.color = 'var(--text3)';

      const res = await apiCall(`/api/exam/room/${state.student.roomId}/query`, 'POST', {
        datasetIds,
        query,
        limit: 100,
      });

      el('student-run-btn').innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg> Run';
      el('student-run-btn').disabled = false;

      if (res.status === 'ok' || res.data || res.results) {
        const results = res.results !== undefined ? res.results : (res.data || []);
        state.student.lastRunOutput = results;
        el('student-console-status').textContent = `— ${results.length} doc(s)`;
        el('student-console-status').style.color = 'var(--text3)';
        el('student-pane-yours').innerHTML = `<pre style="color:var(--text);font-size:11px;white-space:pre-wrap">${JSON.stringify(results, null, 2)}</pre>`;
        state.student.hasRunOnce = true;
        el('student-submit-query-btn').disabled = false;
        el('student-submit-query-btn').style.opacity = '1';
      } else {
        el('student-console-status').textContent = '— Error';
        el('student-console-status').style.color = 'var(--red)';
        el('student-pane-yours').innerHTML = `<span style="color:var(--red)">${res.error || '// Unknown error'}</span>`;
      }

      // Keep the preview visible, but use the authoritative server grader for
      // the immediate Run verdict because the preview is intentionally truncated.
      studentNS._fetchExpectedPreview(q.id);
      studentNS._checkQueryAnswer(q, query, datasetIds);
    },

    clearEditor() {
      if (state.student.examEditor) {
        state.student.examEditor.setValue('');
        state.student.examEditor.focus();
      }
    },

    async inspectDataset() {
      const q = state.student.questions[state.student.currentQIdx];
      if (!q) return;
      const datasetIds = q.datasetIds || (q.datasetId ? [q.datasetId] : []);
      if (datasetIds.length === 0) return;

      el('exam-schema-content').textContent = 'Loading schema details...';
      openModal('exam-schema-modal');

      const loadedDatasets = [];
      for (const dId of datasetIds) {
        const res = await apiCall(`/api/exam/room/${state.student.roomId}/dataset/${dId}/schema`);
        if (res.status === 'ok') {
          loadedDatasets.push({
            id: dId,
            name: res.collection || dId,
            collection: res.collection,
            docCount: res.docCount,
            schema: res.schema || {},
            sampleDocs: res.sampleDocs || [],
          });
        }
      }

      if (loadedDatasets.length === 0) {
        el('exam-schema-content').innerHTML = '<span style="color:var(--red)">// Failed to load schemas</span>';
        return;
      }

      window._inspectDatasets = loadedDatasets;
      window._activeInspectTabIdx = 0;
      studentNS.renderInspectModal();
    },

    renderInspectModal() {
      const datasets = window._inspectDatasets || [];
      const idx = window._activeInspectTabIdx || 0;
      const ds = datasets[idx];
      if (!ds) return;

      const tabs = datasets.map((d, i) => `
        <div class="exam-console-tab ${i === idx ? 'active' : ''}" style="height:28px"
             onclick="window._activeInspectTabIdx = ${i}; ExamPortal.student.renderInspectModal();">
          ${d.name}
        </div>
      `).join('');

      const rows = Object.entries(ds.schema).map(([field, type]) =>
        `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04)">
          <span style="color:var(--cyan)">${field}</span>
          <span style="color:var(--green2)">${type}</span>
        </div>`
      ).join('') || '<div style="color:var(--text3);font-size:11px">// No fields inferred</div>';

      const firstDoc = (ds.sampleDocs && ds.sampleDocs.length > 0) ? ds.sampleDocs[0] : null;
      const previewHTML = firstDoc 
        ? `<pre style="font-size:11px;color:var(--text);white-space:pre-wrap;background:var(--bg);padding:8px;border-radius:4px;max-height:220px;overflow-y:auto;text-align:left">${JSON.stringify(firstDoc, null, 2)}</pre>`
        : '<div style="color:var(--text3);font-size:11px">// No documents in this dataset</div>';

      el('exam-schema-content').innerHTML = `
        <div class="exam-console-hdr" style="margin-bottom:12px;background:none;border-bottom:1px solid var(--border)">
          ${tabs}
        </div>
        <div style="margin-bottom:12px;color:var(--text2)">Collection name: <span style="color:var(--cyan);font-weight:700">${ds.collection}</span> — ${ds.docCount} documents</div>
        <div style="display:flex;gap:20px;flex-wrap:wrap">
          <div style="flex:1;min-width:200px;text-align:left">
            <div style="font-size:10px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px">Field Schema</div>
            <div style="max-height:220px;overflow-y:auto;padding-right:6px">${rows}</div>
          </div>
          <div style="flex:1.2;min-width:260px;text-align:left">
            <div style="font-size:10px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px">First Document Entry</div>
            ${previewHTML}
          </div>
        </div>
      `;
    },

    async submitAnswer() {
      const q = state.student.questions[state.student.currentQIdx];
      if (!q) return;

      let body = {
        studentId: state.student.studentId,
        questionId: q.id,
        type: q.type,
        marks: q.marks,
      };

      const isMCQ = q.type === 'mcq';
      const submitBtn = isMCQ ? el('student-submit-mcq-btn') : el('student-submit-query-btn');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Submitting...';
      }

      if (isMCQ) {
        if (q.isMultiSelect) {
          if (!state.student.selectedOptions || state.student.selectedOptions.length === 0) {
            el('student-mcq-status').textContent = '// Select at least one option first';
            el('student-mcq-status').style.color = 'var(--red)';
            if (submitBtn) {
              submitBtn.disabled = false;
              submitBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="white"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> Submit Answer';
            }
            return;
          }
          body.selectedOptions = state.student.selectedOptions;
        } else {
          if (state.student.selectedOption === null) {
            el('student-mcq-status').textContent = '// Select an option first';
            el('student-mcq-status').style.color = 'var(--red)';
            if (submitBtn) {
              submitBtn.disabled = false;
              submitBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="white"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> Submit Answer';
            }
            return;
          }
          body.selectedOption = state.student.selectedOption;
        }
      } else if (q.type === 'coding') {
        const cm = state.student.examEditor;
        body.code = cm ? cm.getValue() : '';
        body.language = q.language;

        // Official coding submissions use the browser runtime first. The
        // server receives only the execution transcript and compares it with
        // its private frozen answers; it does not execute the editorial code
        // or consume a remote worker for a healthy local run.
        try {
          if (submitBtn) submitBtn.textContent = 'Running locally...';
          startStudentExecutionCard(q.language);
          setExamExecutionOrigin('local');
          console.info('[CodeLeaf exam] Starting on-device grading transcript.', {
            questionId: q.id,
            language: q.language,
            sourceLength: body.code.length
          });
          const gradingInputs = await apiCall(
            `/api/exam/room/${state.student.roomId}/question/${q.id}/grading-inputs`,
            'POST',
            { studentId: state.student.studentId }
          );
          if (gradingInputs.status !== 'ok' || !Array.isArray(gradingInputs.cases)) {
            throw new Error(gradingInputs.error || 'Unable to prepare grading inputs.');
          }
          const localResults = await executeCodingCasesLocally(
            q,
            body.code,
            gradingInputs.cases,
            detail => updateStudentExecutionCard(detail, { mode: 'local' })
          );
          const localFailed = localResults.some(isExecutionFailure);
          if (!localFailed && localResults.length === gradingInputs.cases.length) {
            body.clientResults = localResults;
            body.clientExecution = 'on-device';
            console.info('[CodeLeaf exam] On-device grading transcript complete.', {
              questionId: q.id,
              cases: localResults.length
            });
          } else {
            body.clientExecution = 'remote-fallback';
            setExamExecutionOrigin('remote', true, 'On-device grading returned an incomplete or failed transcript.');
            console.warn('[CodeLeaf exam] On-device grading returned an incomplete/failed transcript.', {
              questionId: q.id,
              expectedCases: gradingInputs.cases.length,
              actualResults: localResults.length,
              failed: localFailed
            });
          }
        } catch (localError) {
          // The backend will use its rate-limited emergency worker path when
          // the browser cannot produce a complete local transcript.
          body.clientExecution = 'remote-fallback';
          body.clientExecutionError = String(localError.message || localError).slice(0, 500);
          setExamExecutionOrigin('remote', true, `On-device grading failed: ${body.clientExecutionError}`);
          console.error('[CodeLeaf exam] On-device grading failed; remote fallback will be used.', {
            questionId: q.id,
            language: q.language,
            error: body.clientExecutionError
          });
        }
      } else {
        const cm = state.student.examEditor;
        body.query = cm ? cm.getValue() : '';
        body.datasetIds = q.datasetIds || (q.datasetId ? [q.datasetId] : []);
        if (q.type === 'sql') {
          body.queryType = 'sql';
          body.studentResult = state.student.sqlResult || state.student.lastRunOutput || { columns: [], rows: [] };
        } else {
          body.studentOutput = state.student.lastRunOutput || [];
        }
      }

      // Optimistic UI: immediately mark as submitted
      state.student.status[q.id] = 'submitted';
      studentNS._renderQNav();
      if (isMCQ) {
        el('student-mcq-status').textContent = '// Submitting...';
        el('student-mcq-status').style.color = 'var(--text3)';
      }

      const res = await apiCall(`/api/exam/room/${state.student.roomId}/submit`, 'POST', body);

      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> Submit Answer';
      }

      if (res.status === 'ok') {
        const isCorrect = res.correct;
        if (isMCQ) {
          el('student-mcq-status').textContent = '// Answer submitted.';
          el('student-mcq-status').style.color = 'var(--green3)';
          if (q.isMultiSelect) {
            q._studentSelectedOptions = [...state.student.selectedOptions];
          } else {
            q._studentSelectedOption = state.student.selectedOption;
          }
        } else if (q.type === 'coding') {
          const passed = res.passedCount !== undefined ? res.passedCount : (isCorrect ? (q.testCases || []).length : 0);
          const total = res.totalCount !== undefined ? res.totalCount : (q.testCases || []).length;
          
          el('student-console-status').textContent = isCorrect ? `— Accepted (${passed}/${total} passed)` : `— Wrong Answer (${passed}/${total} passed)`;
          el('student-console-status').style.color = isCorrect ? 'var(--green3)' : 'var(--red)';
          
          q._studentDrafts = q._studentDrafts || {};
          q._studentDrafts[q.language] = body.code;
          q._studentDraft = body.code;

          // Render summary inside output pane
          const outputArea = el('student-pane-expected');
          if (outputArea) {
            if (isCorrect) {
              outputArea.innerHTML = `
                <div style="color:var(--green3);font-weight:bold;margin-bottom:8px;font-size:12px">Accepted</div>
                <div style="margin-bottom:6px;font-size:11px">All ${total} test cases passed successfully!</div>
                <div style="font-size:11px;color:var(--green2)">Score: ${res.score} / ${q.marks}</div>
              `;
            } else {
              outputArea.innerHTML = `
                <div style="color:var(--red);font-weight:bold;margin-bottom:8px;font-size:12px">Wrong Answer</div>
                <div style="margin-bottom:6px;font-size:11px">Only ${passed} / ${total} test cases passed.</div>
                <div style="font-size:11px;color:var(--text3)">Score: ${res.score} / ${q.marks}</div>
              `;
            }
          }
        } else {
          el('student-console-status').textContent = isCorrect ? '— Accepted' : '— Wrong Answer';
          el('student-console-status').style.color = isCorrect ? 'var(--green3)' : 'var(--red)';
          q._studentDraft = body.query;
          studentNS._fetchExpectedPreview(q.id);
        }
        state.student.status[q.id] = 'submitted';
      } else {
        if (res.error === 'kicked' || res.status === 403) {
          studentNS.handleKicked(res.message);
          return;
        }
        // Revert optimistic update on error
        state.student.status[q.id] = 'draft';
        if (isMCQ) {
          el('student-mcq-status').textContent = res.error || '// Submission failed';
          el('student-mcq-status').style.color = 'var(--red)';
        } else {
          el('student-console-status').textContent = '— Submission failed';
          el('student-console-status').style.color = 'var(--red)';
        }
      }
      studentNS._renderQNav();
    },

    saveCurrentActiveDraft() {
      if (state.student.currentQIdx === null || state.student.currentQIdx === undefined) return;
      const q = state.student.questions[state.student.currentQIdx];
      if (!q) return;
      const cm = state.student.examEditor;
      if (!cm) return;
      
      if (isDataQuestion(q)) {
        q._studentDraft = cm.getValue();
      } else if (q.type === 'coding') {
        q._studentDrafts = q._studentDrafts || {};
        q._studentDrafts[q.language || 'python'] = cm.getValue();
        q._studentDraft = cm.getValue();
      }
    },

    async autoSaveAllResponses() {
      // 1. Sync current active editor value to drafts
      studentNS.saveCurrentActiveDraft();
      
      // 2. Prepare submission payloads for all modified questions
      const promises = [];
      
      if (state.student.questions && state.student.questions.length > 0) {
        state.student.questions.forEach(function(q) {
          let body = {
            studentId: state.student.studentId,
            questionId: q.id,
            type: q.type,
            marks: q.marks,
            isAutoSave: true
          };
          
          let hasValue = false;
          
          if (q.type === 'mcq') {
            if (q.isMultiSelect) {
              if (state.student.selectedOptions && state.student.selectedOptions.length > 0) {
                body.selectedOptions = state.student.selectedOptions;
                hasValue = true;
              } else if (q._studentSelectedOptions && q._studentSelectedOptions.length > 0) {
                body.selectedOptions = q._studentSelectedOptions;
                hasValue = true;
              }
            } else {
              if (state.student.selectedOption !== null && state.student.selectedOption !== undefined) {
                body.selectedOption = state.student.selectedOption;
                hasValue = true;
              } else if (q._studentSelectedOption !== null && q._studentSelectedOption !== undefined) {
                body.selectedOption = q._studentSelectedOption;
                hasValue = true;
              }
            }
          } else if (q.type === 'coding') {
            const draft = q._studentDrafts ? q._studentDrafts[q.language] : q._studentDraft;
            if (draft && draft.trim()) {
              body.code = draft;
              body.language = q.language;
              hasValue = true;
            }
          } else if (isDataQuestion(q)) {
            const draft = q._studentDraft;
            if (draft && draft.trim()) {
              body.query = draft;
              body.datasetIds = q.datasetIds || (q.datasetId ? [q.datasetId] : []);
              if (q.type === 'sql') {
                body.queryType = 'sql';
                body.studentResult = q._studentResult || (state.student.currentQIdx === state.student.questions.indexOf(q) ? state.student.sqlResult : null) || { columns: [], rows: [] };
              } else {
                body.studentOutput = (state.student.currentQIdx === state.student.questions.indexOf(q)) ? (state.student.lastRunOutput || []) : [];
              }
              hasValue = true;
            }
          }
          
          if (hasValue) {
            promises.push(
              apiCall(`/api/exam/room/${state.student.roomId}/submit`, 'POST', body)
                .catch(function(err) { console.error("Auto-save failed for question " + q.id, err); })
            );
          }
        });
      }
      
      if (promises.length > 0) {
        setStudentSaveState('Saving…', 'saving');
        await Promise.all(promises);
        setStudentSaveState('Saved', 'saved');
      }
    },

    async autoSaveSingleQuestion(q) {
      if (!q) return;
      let body = {
        studentId: state.student.studentId,
        questionId: q.id,
        type: q.type,
        marks: q.marks,
        isAutoSave: true
      };
      
      let hasValue = false;
      if (q.type === 'mcq') {
        if (q.isMultiSelect) {
          const opts = (state.student.currentQIdx === state.student.questions.indexOf(q)) ? state.student.selectedOptions : q._studentSelectedOptions;
          if (opts && opts.length > 0) {
            body.selectedOptions = opts;
            hasValue = true;
          }
        } else {
          const opt = (state.student.currentQIdx === state.student.questions.indexOf(q)) ? state.student.selectedOption : q._studentSelectedOption;
          if (opt !== null && opt !== undefined) {
            body.selectedOption = opt;
            hasValue = true;
          }
        }
      } else if (q.type === 'coding') {
        const draft = q._studentDrafts ? q._studentDrafts[q.language] : q._studentDraft;
        if (draft && draft.trim()) {
          body.code = draft;
          body.language = q.language;
          hasValue = true;
        }
      } else if (isDataQuestion(q)) {
        const draft = q._studentDraft;
        if (draft && draft.trim()) {
          body.query = draft;
          body.datasetIds = q.datasetIds || (q.datasetId ? [q.datasetId] : []);
          if (q.type === 'sql') {
            body.queryType = 'sql';
            body.studentResult = q._studentResult || (state.student.currentQIdx === state.student.questions.indexOf(q) ? state.student.sqlResult : null) || { columns: [], rows: [] };
          } else {
            body.studentOutput = (state.student.currentQIdx === state.student.questions.indexOf(q)) ? (state.student.lastRunOutput || []) : [];
          }
          hasValue = true;
        }
      }
      
      if (hasValue) {
        setStudentSaveState('Saving…', 'saving');
        apiCall(`/api/exam/room/${state.student.roomId}/submit`, 'POST', body)
          .then(function(res) {
            if (res && res.status === 'ok') setStudentSaveState('Saved', 'saved');
            else setStudentSaveState('Offline', 'error');
          })
          .catch(function(err) {
            console.error("Debounced auto-save failed for question " + q.id, err);
            setStudentSaveState('Offline', 'error');
          });
      }
    },

    handleKicked(reason) {
      resetStudentState();
      window.onbeforeunload = null;
      state.student.ignoreFullscreenChange = true;

      const isSystem = reason && reason !== 'Removed by Mentor';
      
      if (isSystem) {
        if (el('kicked-status-chip')) {
          el('kicked-status-chip').textContent = 'BLOCKED BY SYSTEM';
          el('kicked-status-chip').style.background = 'rgba(255, 77, 77, 0.15)';
          el('kicked-status-chip').style.color = '#ff4d4d';
          el('kicked-status-chip').style.borderColor = 'rgba(255, 77, 77, 0.4)';
        }
        if (el('kicked-title')) {
          el('kicked-title').textContent = 'Access Blocked';
          el('kicked-title').style.color = '#ff4d4d';
        }
        if (el('kicked-message')) {
          el('kicked-message').innerHTML = `
            <strong style="color:#ffffff;font-size:15px;display:block;margin-bottom:8px">Test Blocked by System</strong>
            Your test has been blocked by the proctoring system due to multiple violations (tab exits or copy-paste attempts). Please contact your mentor for further actions.
          `;
        }
      } else {
        if (el('kicked-status-chip')) {
          el('kicked-status-chip').textContent = 'BLOCKED BY MENTOR';
          el('kicked-status-chip').style.background = 'rgba(255, 77, 77, 0.15)';
          el('kicked-status-chip').style.color = '#ff4d4d';
          el('kicked-status-chip').style.borderColor = 'rgba(255, 77, 77, 0.4)';
        }
        if (el('kicked-title')) {
          el('kicked-title').textContent = 'Access Blocked';
          el('kicked-title').style.color = '#ff4d4d';
        }
        if (el('kicked-message')) {
          el('kicked-message').innerHTML = `
            <strong style="color:#ffffff;font-size:15px;display:block;margin-bottom:8px">Test Blocked by Mentor</strong>
            Your test has been blocked by the mentor. Please contact your mentor for further actions.
          `;
        }
      }

      // Exit fullscreen if active
      if (document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement) {
        if (document.exitFullscreen) {
          document.exitFullscreen().catch(() => {});
        } else if (document.webkitExitFullscreen) {
          document.webkitExitFullscreen();
        } else if (document.mozCancelFullScreen) {
          document.mozCancelFullScreen();
        } else if (document.msExitFullscreen) {
          document.msExitFullscreen();
        }
      }

      showPanel('exam-student-kicked-panel');
      setTimeout(() => {
        state.student.ignoreFullscreenChange = false;
      }, 1000);
    },

    async forceSubmitAndBlock(reason) {
      clearInterval(state.student.pollInterval);
      clearInterval(state.student.timerInterval);
      state.student.ignoreFullscreenChange = true;

      // Auto save all current responses first!
      await studentNS.autoSaveAllResponses();

      // Submit the exam
      try {
        await apiCall(`/api/exam/room/${state.student.roomId}/student/${state.student.studentId}/self-kick`, 'POST', { reason });
      } catch (err) {
        console.error("Self-kick submission failed:", err);
      }

      studentNS.handleKicked(reason);
    },

    requestFullscreen() {
      const docEl = document.documentElement;
      const requestFs = docEl.requestFullscreen || docEl.mozRequestFullScreen || docEl.webkitRequestFullscreen || docEl.msRequestFullscreen;
      if (requestFs) {
        requestFs.call(docEl).then(() => {
          syncFullscreenEnforcement(false);
        }).catch(err => {
          console.error("Fullscreen request failed:", err);
          showExamAlert("Fullscreen mode is required to start the exam. Please click the button again or allow browser fullscreen permissions.", { title: 'Fullscreen Required', danger: true });
        });
      } else {
        state.student.fullscreenActive = false;
        const overlay = el('student-fullscreen-overlay');
        if (overlay) overlay.style.display = 'flex';
        showExamAlert("This browser does not support fullscreen enforcement. Please use an up-to-date browser to start the exam.", { title: 'Fullscreen Unsupported', danger: true });
      }
    },

    async _fetchExpectedPreview(questionId) {
      const pane = el('student-pane-expected');
      if (!pane) return;
      pane.innerHTML = '<span style="color:var(--text3)">// Fetching expected output preview...</span>';

      const res = await apiCall(`/api/exam/room/${state.student.roomId}/question/${questionId}/expected-preview`);
      if (res.status === 'ok') {
        const docs = res.preview || [];
        const count = res.docCount || 0;
        state.student.expectedPreview[questionId] = docs;
        pane.innerHTML = `
          <pre style="color:var(--text);font-size:11px;white-space:pre-wrap">${JSON.stringify(docs, null, 2)}</pre>
          <div class="exam-console-hint">// Showing first ${docs.length} of ${count} documents — full result hidden</div>
        `;
      } else {
        delete state.student.expectedPreview[questionId];
        pane.innerHTML = '<span style="color:var(--text3)">// Expected output preview not available</span>';
      }
    },

    _updateQueryVerdict(questionId, results) {
      const expected = state.student.expectedPreview[questionId];
      const status = el('student-console-status');
      if (!status || !Array.isArray(expected)) return;
      const correct = examOutputsMatch(results, expected);
      status.textContent = correct ? '— Accepted' : '— Wrong Answer';
      status.style.color = correct ? 'var(--green3)' : 'var(--red)';
      status.classList.toggle('exam-query-verdict', true);
      status.classList.toggle('is-accepted', correct);
      status.classList.toggle('is-wrong', !correct);
    },

    async _checkQueryAnswer(q, query, datasetIds) {
      const status = el('student-console-status');
      if (!status) return;
      const res = await apiCall(`/api/exam/room/${state.student.roomId}/submit`, 'POST', {
        studentId: state.student.studentId,
        questionId: q.id,
        type: q.type,
        marks: q.marks,
        datasetIds,
        query,
        dryRun: true,
      });
      if (res.status !== 'ok' || res.dryRun !== true) return;
      const correct = Boolean(res.correct);
      status.textContent = correct ? '— Accepted' : '— Wrong Answer';
      status.style.color = correct ? 'var(--green3)' : 'var(--red)';
      status.classList.add('exam-query-verdict');
      status.classList.toggle('is-accepted', correct);
      status.classList.toggle('is-wrong', !correct);
    },

    async finishExam() {
      const modal = el('exam-confirm-submit-modal');
      if (modal) {
        state.student.ignoreFullscreenChange = true;
        const total = state.student.questions.length;
        const answered = state.student.questions.filter(q => {
          if (state.student.status[q.id] === 'submitted') return true;
          if (q.type === 'mcq') return q.isMultiSelect
            ? Array.isArray(q._studentSelectedOptions) && q._studentSelectedOptions.length > 0
            : q._studentSelectedOption !== null && q._studentSelectedOption !== undefined;
          return Boolean((q._studentDraft || '').trim() || (q._studentDrafts && Object.values(q._studentDrafts).some(value => String(value || '').trim())));
        }).length;
        const summary = el('student-submit-summary');
        if (summary) {
          summary.innerHTML = `
            <div class="exam-submit-count"><strong>${answered}</strong><span>Answered</span></div>
            <div class="exam-submit-count is-pending"><strong>${Math.max(0, total - answered)}</strong><span>Unanswered</span></div>
            <div class="exam-submit-total"><span>Total questions</span><strong>${total}</strong></div>
          `;
        }
        
        const okBtn = el('confirm-submit-ok-btn');
        if (okBtn) {
          okBtn.onclick = async (event) => {
            // Final submission must originate from this visible confirmation
            // button. Do not allow synthetic/programmatic clicks to submit an
            // assessment while the student is still working.
            if (event && event.isTrusted === false) return;
            if (state.student.finalSubmissionInFlight) return;
            state.student.finalSubmissionConfirmed = true;
            closeModal('exam-confirm-submit-modal');
            await studentNS._executeSubmission();
          };
        }
        
        const closeBtn = modal.querySelector('.modal-close-btn');
        const cancelBtn = modal.querySelector('.exam-btn-secondary');
        
        const onCancel = () => {
          state.student.ignoreFullscreenChange = false;
        };
        
        if (closeBtn) closeBtn.onclick = () => { closeModal('exam-confirm-submit-modal'); onCancel(); };
        if (cancelBtn) cancelBtn.onclick = () => { closeModal('exam-confirm-submit-modal'); onCancel(); };
        
        modal.classList.add('open');
      }
    },

    async _executeSubmission() {
      // This method is intentionally guarded: only the explicit confirmation
      // action above may finalize an exam. Timer/proctoring/autosave paths must
      // never be able to enter the final submission state.
      if (!state.student.finalSubmissionConfirmed || state.student.finalSubmissionInFlight) return;
      state.student.finalSubmissionConfirmed = false;
      state.student.finalSubmissionInFlight = true;
      state.student.ignoreFullscreenChange = true;
      const btn = el('btn-student-submit-exam');
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Submitting...';
      }

      // Auto save all responses (including current active question's draft)!
      await studentNS.autoSaveAllResponses();

      const res = await apiCall(`/api/exam/room/${state.student.roomId}/student/${state.student.studentId}/finish`, 'POST');
      if (res.status === 'ok') {
        studentNS._lockExam();
      } else {
        showExamAlert(res.error || 'Failed to submit final exam. Please try again.', { title: 'Submission Failed', danger: true });
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = 'Review &amp; submit <span>↗</span>';
        }
        state.student.finalSubmissionInFlight = false;
        state.student.ignoreFullscreenChange = false;
      }
    },

    renderWorkspaceTabs(q) {
      const tabsBar = el('student-workspace-tabs');
      if (!tabsBar) return;
      // Keep the statement and editor visible together; the old file tabs
      // consume vertical space and imply a separate document workspace.
      tabsBar.innerHTML = '';
      tabsBar.style.display = 'none';
      return;
      tabsBar.style.display = 'flex';

      const activeTab = state.student.activeTab || 'readme';

      // Find code file extension name
       let codeFilename = q.type === 'sql' ? 'query.sql' : 'query.mongo';
      if (q.type === 'coding') {
        const ext = { python: 'py', cpp: 'cpp', c: 'c', java: 'java' }[q.language || 'python'] || 'py';
        const name = q.language === 'java' ? 'Solution' : 'solution';
        codeFilename = `${name}.${ext}`;
      }

      tabsBar.innerHTML = `
        <div class="workspace-tab ${activeTab === 'readme' ? 'active' : ''}" onclick="ExamPortal.student.selectWorkspaceTab('readme')">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="margin-right:2px"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
          README.md
        </div>
        <div class="workspace-tab ${activeTab === 'code' ? 'active' : ''}" onclick="ExamPortal.student.selectWorkspaceTab('code')">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="margin-right:2px"><path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg>
          ${codeFilename}
        </div>
      `;
    },

    selectWorkspaceTab(tabId) {
      state.student.activeTab = tabId;
      const q = state.student.questions[state.student.currentQIdx];
      if (!q) return;

      studentNS.renderWorkspaceTabs(q);

      // Keep the problem statement and editor visible together, matching a
      // professional assessment workspace. The tabs remain useful as a
      // context indicator, but changing them no longer hides the statement.
      el('student-question-display').style.display = 'block';
      el('student-question-display').classList.add('workspace-readme-active');
      el('student-query-area').style.display = 'flex';
      setTimeout(() => {
        if (state.student.examEditor) state.student.examEditor.refresh();
      }, 50);
    },

    changeLanguage(newLang) {
      const q = state.student.questions[state.student.currentQIdx];
      if (!q || q.type !== 'coding') return;

      q._studentDrafts = q._studentDrafts || {};
      const currentCode = state.student.examEditor ? state.student.examEditor.getValue() : '';
      q._studentDrafts[q.language || 'python'] = currentCode;

      q.language = newLang;

      let newCode = q._studentDrafts[newLang];
      if (newCode === undefined) {
        newCode = ((q.templates && q.templates[newLang]) ? q.templates[newLang].starterCode : null) || q.starterCode || '';
      }

      let cmMode = 'python';
      if (newLang === 'cpp' || newLang === 'c') cmMode = 'text/x-c++src';
      if (newLang === 'java') cmMode = 'text/x-java';
      if (newLang === 'javascript') cmMode = 'javascript';

      const cm = state.student.examEditor;
      if (cm) {
        cm.setOption('mode', cmMode);
        cm.setValue(newCode);
        cm.clearHistory();
        setTimeout(() => cm.refresh(), 50);
      }

      studentNS.renderWorkspaceTabs(q);
    },

    initConsoleTabs(q) {
      if (!q) {
        q = state.student.questions[state.student.currentQIdx];
      }
      if (!q) return;

      // Only explicitly marked sample cases are exposed in the student UI.
      // Never fall back to the first hidden cases: their inputs must remain
      // undisclosed until an authenticated submission is being prepared.
      const sampleCases = (q.testCases || []).filter(tc => tc.isSample);
      state.student.sampleCases = sampleCases;

      const tabsBar = el('student-console-tabs-bar');
      if (tabsBar) {
        let tabsHtml = '';
        sampleCases.forEach((tc, i) => {
          const cached = state.student.runResults && state.student.runResults[`${q.id}-case-${i}`];
          let statusBadge = '';
          if (cached) {
            const expected = (tc.expectedOutput || '').trim();
            const actual = (cached.stdout || '').trim();
            const exitCode = cached.code !== undefined ? cached.code : 0;
            const isError = isExecutionFailure(cached);

            const actualLines = actual.split('\n').map(l => l.trim()).filter(Boolean);
            const expectedLines = expected.split('\n').map(l => l.trim()).filter(Boolean);
            const matched = (actualLines.join('\n') === expectedLines.join('\n')) && !isError;

            statusBadge = matched 
              ? '<span style="color:var(--green3);margin-left:6px;font-size:10px;font-weight:bold">✓</span>' 
              : '<span style="color:var(--red);margin-left:6px;font-size:10px;font-weight:bold">✗</span>';
          }

          tabsHtml += `<div class="console-tabbar-item" id="c-tab-case-${i}" onclick="ExamPortal.student.selectConsoleTab('case-${i}')" style="display:flex;align-items:center">Case ${i+1}${statusBadge}</div>`;
        });

        const customCached = state.student.runResults && state.student.runResults[`${q.id}-custom`];
        let customBadge = '';
        if (customCached) {
          const customExitCode = customCached.code !== undefined ? customCached.code : 0;
          const customIsError = isExecutionFailure(customCached);
          customBadge = customIsError
            ? '<span style="color:var(--red);margin-left:6px;font-size:10px;font-weight:bold">✗</span>'
            : '<span style="color:var(--green3);margin-left:6px;font-size:10px;font-weight:bold">✓</span>';
        }

        tabsHtml += `<div class="console-tabbar-item" id="c-tab-custom" onclick="ExamPortal.student.selectConsoleTab('custom')" style="display:flex;align-items:center">Custom Input${customBadge}</div>`;
        tabsBar.innerHTML = tabsHtml;
      }

      const defaultTab = state.student.activeConsoleTab || (sampleCases.length > 0 ? 'case-0' : 'custom');
      studentNS.selectConsoleTab(defaultTab);
    },

    selectConsoleTab(tabId) {
      state.student.activeConsoleTab = tabId;

      document.querySelectorAll('.console-tabbar-item').forEach(el => el.classList.remove('active'));
      const tabEl = el(`c-tab-${tabId}`);
      if (tabEl) tabEl.classList.add('active');

      const stdinArea = el('student-stdin-input');
      const outputArea = el('student-pane-expected');

      if (stdinArea) {
        stdinArea.style.display = 'block';
        if (!stdinArea._boundOninput) {
          stdinArea._boundOninput = true;
          stdinArea.addEventListener('input', (e) => {
            if (state.student.activeConsoleTab === 'custom') {
              state.student.customStdin = e.target.value;
            }
          });
        }
      }
      const yoursPane = el('student-pane-yours');
      if (yoursPane) yoursPane.style.display = 'none';

      if (outputArea) outputArea.style.display = 'block';

      const leftH = el('student-pane-left-title');
      if (leftH) leftH.textContent = tabId.startsWith('case-') ? 'Sample Input' : 'Custom Input (stdin)';
      const rightH = el('student-pane-right-title');
      if (rightH) rightH.textContent = 'Console Output';

      if (tabId.startsWith('case-')) {
        const idx = parseInt(tabId.split('-')[1]);
        const tc = state.student.sampleCases[idx];
        if (tc && stdinArea) {
          stdinArea.value = tc.input || '';
          stdinArea.readOnly = true;
          stdinArea.style.opacity = '0.8';
        }
      } else {
        if (stdinArea) {
          stdinArea.readOnly = false;
          stdinArea.style.opacity = '1';
          stdinArea.value = state.student.customStdin || '';
        }
      }

      const q = state.student.questions[state.student.currentQIdx];
      if (!q) return;

      const cmt = langCommentPrefix(q.language || 'python');

      const cached = state.student.runResults && state.student.runResults[`${q.id}-${tabId}`];
      
      const statusEl = el('student-console-status');
      if (statusEl) {
        if (cached) {
          if (tabId.startsWith('case-')) {
            const idx = parseInt(tabId.split('-')[1]);
            const tc = state.student.sampleCases[idx];
            const expected = tc ? (tc.expectedOutput || '').trim() : '';
            const actual = (cached.stdout || '').trim();
            const exitCode = cached.code !== undefined ? cached.code : 0;
            const isError = isExecutionFailure(cached);

            const actualLines = actual.split('\n').map(l => l.trim()).filter(Boolean);
            const expectedLines = expected.split('\n').map(l => l.trim()).filter(Boolean);
            const matched = (actualLines.join('\n') === expectedLines.join('\n')) && !isError;

            let resultTitle = '';
            let resultColor = '';
            if (isError) {
              resultTitle = cached.stderr.includes('compile') ? 'Compilation Error' : 'Runtime Error';
              resultColor = 'var(--red)';
            } else {
              resultTitle = matched ? 'Accepted' : 'Wrong Answer';
              resultColor = matched ? 'var(--green3)' : 'var(--red)';
            }

            const verdictClass = isError ? 'error' : matched ? 'accepted' : 'wrong';
            const fallbackReason = state.student.executionOriginQuestionId === q.id ? (state.student.executionOriginReason || '') : '';
            statusEl.innerHTML = `— <span class="exam-verdict exam-verdict-${verdictClass}">${resultTitle}</span>${fallbackReason ? ` <span class="execution-phase execution-fallback-reason" title="${escapeExamHtml(fallbackReason)}">· ${escapeExamHtml(fallbackReason)}</span>` : ''}`;
            statusEl.style.color = '';
          } else {
            if (cached.customVerdict) {
              const accepted = cached.customVerdict === 'accepted';
              const verdictClass = accepted ? 'accepted' : 'wrong';
              const title = accepted ? 'Accepted' : (cached.customVerdict === 'runtime_error' ? 'Runtime Error' : 'Wrong Answer');
              const fallbackReason = state.student.executionOriginQuestionId === q.id ? (state.student.executionOriginReason || '') : '';
              statusEl.innerHTML = `— <span class="exam-verdict exam-verdict-${verdictClass}">${title}</span>${fallbackReason ? ` <span class="execution-phase execution-fallback-reason" title="${escapeExamHtml(fallbackReason)}">· ${escapeExamHtml(fallbackReason)}</span>` : ''}`;
              statusEl.style.color = '';
            } else {
              const exitCode = cached.code !== undefined ? cached.code : 0;
              const isError = isExecutionFailure(cached);
              statusEl.textContent = `— Exit Code: ${exitCode}`;
              statusEl.style.color = isError ? 'var(--red)' : 'var(--text3)';
            }
          }
        } else {
          statusEl.textContent = '';
        }
      }

      if (cached) {
        studentNS.renderRunResult(cached, tabId);
      } else {
        if (outputArea) {
          if (tabId.startsWith('case-')) {
            const idx = parseInt(tabId.split('-')[1]);
            const tc = state.student.sampleCases[idx];
            const expected = tc ? (tc.expectedOutput || '').trim() : '';
            outputArea.innerHTML = `
              <div class="exam-console-preview-label">Expected output</div>
              <pre class="exam-console-preview-value">${expected || `${cmt} No expected output configured`}</pre>
              <div class="exam-console-hint">${cmt} Run the sample to compare your output</div>
            `;
          } else {
            outputArea.innerHTML = `<span style="color:var(--text3)">${cmt} Run the program to see console output</span>`;
          }
        }
      }
    },

    renderRunResult(res, tabId) {
      const outputArea = el('student-pane-expected');
      if (!outputArea) return;

      const curQ = state.student.questions[state.student.currentQIdx];
      const cmt = langCommentPrefix((curQ && curQ.language) || 'python');

      const stderr = (res.stderr || '').trim();
      const stdout = (res.stdout || '').trim();
      const exitCode = res.code !== undefined ? res.code : 0;
      const isError = isExecutionFailure(res);

      if (tabId.startsWith('case-')) {
        const idx = parseInt(tabId.split('-')[1]);
        const tc = state.student.sampleCases[idx];
        const expected = tc ? (tc.expectedOutput || '').trim() : '';

        const actualLines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
        const expectedLines = expected.split('\n').map(l => l.trim()).filter(Boolean);
        const matched = (actualLines.join('\n') === expectedLines.join('\n')) && !isError;

        let resultTitle = '';
        let resultColor = '';
        if (isError) {
          resultTitle = stderr.includes('compile') ? 'Compilation Error' : 'Runtime Error';
          resultColor = 'var(--red)';
        } else {
          resultTitle = matched ? 'Accepted' : 'Wrong Answer';
          resultColor = matched ? 'var(--green3)' : 'var(--red)';
        }

        outputArea.innerHTML = `
          <div style="color:${resultColor};font-weight:bold;margin-bottom:8px;font-size:12px;text-transform:uppercase">${resultTitle}</div>
          
          ${isError ? `
            <div style="margin-bottom:12px;border:1px solid var(--red);border-radius:4px;background:rgba(239, 68, 68, 0.08);padding:10px;overflow-x:auto">
              <div style="color:var(--red);font-weight:700;font-size:10px;margin-bottom:4px;text-transform:uppercase">Error Output:</div>
              <pre style="color:#fca5a5;font-family:monospace;white-space:pre-wrap;font-size:11px;margin:0">${stderr}</pre>
            </div>
          ` : ''}

          <div style="margin-bottom:6px"><strong>Expected Output:</strong><pre style="background:var(--bg3);padding:6px;border-radius:4px;font-family:monospace;margin:4px 0">${expected || `${cmt} No output`}</pre></div>
          <div style="margin-bottom:6px"><strong>Your Output:</strong><pre style="background:var(--bg3);padding:6px;border-radius:4px;font-family:monospace;margin:4px 0;color:${isError ? 'var(--red)' : matched ? 'var(--green2)' : 'var(--red)'}">${stdout || `${cmt} No output`}</pre></div>
        `;
      } else {
        if (res.customVerdict) {
          const accepted = res.customVerdict === 'accepted';
          const title = accepted ? 'Accepted' : (res.customVerdict === 'runtime_error' ? 'Runtime Error' : 'Wrong Answer');
          const color = accepted ? 'var(--green3)' : 'var(--red)';
          outputArea.innerHTML = `
            <div style="color:${color};font-weight:bold;margin-bottom:8px;font-size:12px;text-transform:uppercase">${title}</div>
            <div style="margin-bottom:6px"><strong>Reference output:</strong><pre style="background:var(--bg3);padding:6px;border-radius:4px;font-family:monospace;margin:4px 0;white-space:pre-wrap">${escapeExamHtml(res.expectedOutput || `${cmt} No output`)}</pre></div>
            <div style="margin-bottom:6px"><strong>Your output:</strong><pre style="background:var(--bg3);padding:6px;border-radius:4px;font-family:monospace;margin:4px 0;white-space:pre-wrap;color:${color}">${escapeExamHtml(stdout || `${cmt} No output`)}</pre></div>
          `;
          return;
        }
        if (isError) {
          outputArea.innerHTML = `
            <div style="color:var(--red);font-weight:bold;margin-bottom:8px;font-size:12px;text-transform:uppercase">Execution Error</div>
            <div style="margin-bottom:12px;border:1px solid var(--red);border-radius:4px;background:rgba(239, 68, 68, 0.08);padding:10px;overflow-x:auto">
              <div style="color:var(--red);font-weight:700;font-size:10px;margin-bottom:4px;text-transform:uppercase">Error Output:</div>
              <pre style="color:#fca5a5;font-family:monospace;white-space:pre-wrap;font-size:11px;margin:0">${stderr}</pre>
            </div>
            ${stdout ? `<div><strong>Stdout:</strong><pre style="background:var(--bg3);padding:6px;border-radius:4px;font-family:monospace;margin:4px 0">${stdout}</pre></div>` : ''}
          `;
        } else {
          outputArea.innerHTML = `
            <div style="margin-bottom:6px"><strong>Stdout:</strong><pre style="background:var(--bg3);padding:6px;border-radius:4px;font-family:monospace;margin:4px 0">${stdout || `${cmt} No output`}</pre></div>
          `;
        }
      }
    },

    updateEditorSettings() {
      const fontEl = el('editor-font-family');
      const sizeEl = el('editor-font-size');
      const themeEl = el('editor-theme');
      if (!fontEl || !sizeEl || !themeEl) return;

      const font = fontEl.value;
      const size = sizeEl.value;
      const theme = themeEl.value;

      // Keep the exam controls and the normal workspace settings in sync.
      // This also means a preference chosen in the main Settings dialog is
      // reflected by the exam editor on its next refresh.
      const numericSize = parseInt(size, 10);
      if (window.S && S.settings && font) {
        S.settings.fontFamily = font;
        if (Number.isFinite(numericSize)) {
          S.settings.fontSizeVal = numericSize;
          S.settings.fontSizeUnit = 'px';
          S.settings.fontSize = `${numericSize}px`;
        }
        try { localStorage.setItem(accountStorageKey('mongosandbox_settings'), JSON.stringify(S.settings)); } catch (err) { /* storage unavailable */ }
      }

      try {
        localStorage.setItem('codexa.editor.font', font);
        localStorage.setItem('codexa.editor.fontSize', size);
        localStorage.setItem('codexa.editor.theme', theme);
      } catch (err) { /* storage unavailable */ }

      const cm = state.student.examEditor;
      if (cm) {
        const wrapper = cm.getWrapperElement();
        wrapper.className = wrapper.className.replace(/\bcm-theme-\S+/g, '');
        wrapper.classList.add(`cm-theme-${theme}`);
        studentNS._applyEditorTypography(cm, font, size);
        wrapper.dataset.editorFont = font;
        wrapper.dataset.editorFontSize = size;
        cm.refresh();
      }
    },

    _applyEditorTypography(cm, font, size) {
      if (!cm) return;
      const wrapper = cm.getWrapperElement();
      const targets = [wrapper, ...wrapper.querySelectorAll(
        '.CodeMirror-lines, .CodeMirror-code, .CodeMirror-line, .CodeMirror-line span, .CodeMirror-linenumber, .CodeMirror pre'
      )];
      targets.forEach(node => {
        node.style.setProperty('font-family', font, 'important');
        node.style.setProperty('font-size', size, 'important');
      });
      wrapper.dataset.editorFont = font;
      wrapper.dataset.editorFontSize = size;
    },

    applySharedEditorSettings() {
      const cm = state.student.examEditor;
      const settings = window.S && S.settings;
      if (!cm || !settings) return;

      const fontEl = el('editor-font-family');
      const sizeEl = el('editor-font-size');
      if (fontEl && settings.fontFamily) fontEl.value = settings.fontFamily;
      if (sizeEl && settings.fontSizeVal) {
        const preferred = `${settings.fontSizeVal}${settings.fontSizeUnit || 'px'}`;
        const option = [...sizeEl.options].find(item => item.value === preferred);
        if (option) sizeEl.value = preferred;
      }
      studentNS.updateEditorSettings();
    },

    loadEditorSettings() {
      const fontEl = el('editor-font-family');
      const sizeEl = el('editor-font-size');
      const themeEl = el('editor-theme');
      if (!fontEl || !sizeEl || !themeEl) return;
      try {
        // Prefer the canonical normal-workspace preference so opening an exam
        // never resets the exam editor back to its own control defaults.
        const sharedSettings = window.S && S.settings ? S.settings : {};
        const font = sharedSettings.fontFamily || localStorage.getItem('codexa.editor.font');
        const sharedSize = sharedSettings.fontSizeVal && sharedSettings.fontSizeUnit
          ? `${sharedSettings.fontSizeVal}${sharedSettings.fontSizeUnit}`
          : '';
        const size = sharedSize || localStorage.getItem('codexa.editor.fontSize');
        const theme = localStorage.getItem('codexa.editor.theme');
        if (font) {
          const normalizeFont = value => String(value).split(',')[0].trim().replace(/^['"]|['"]$/g, '').toLowerCase();
          let match = [...fontEl.options].find(o => normalizeFont(o.value) === normalizeFont(font));
          if (!match) {
            match = document.createElement('option');
            match.value = font;
            match.textContent = normalizeFont(font).replace(/\b\w/g, char => char.toUpperCase());
            fontEl.appendChild(match);
          }
          fontEl.value = match.value;
        }
        if (size) {
          let match = [...sizeEl.options].find(o => o.value === size);
          if (!match) {
            match = document.createElement('option');
            match.value = size;
            match.textContent = size;
            sizeEl.appendChild(match);
          }
          sizeEl.value = size;
        }
        if (theme && [...themeEl.options].some(o => o.value === theme)) themeEl.value = theme;
      } catch (err) { /* storage unavailable */ }
    },

    toggleEditorSettingsPopover(event) {
      if (event) {
        event.stopPropagation();
      }
      const popover = el('editor-settings-popover');
      if (popover) {
        const isHidden = popover.style.display === 'none';
        popover.style.display = isHidden ? 'flex' : 'none';

        if (isHidden) {
          studentNS.loadEditorSettings();
          const hidePopover = () => {
            popover.style.display = 'none';
            document.removeEventListener('click', hidePopover);
          };
          setTimeout(() => {
            document.addEventListener('click', hidePopover);
          }, 50);
        }
      }
    },

    _lockExam() {
      state.student.ignoreFullscreenChange = true;
      // Lock editor
      if (state.student.examEditor) {
        state.student.examEditor.setOption('readOnly', 'nocursor');
      }
      // Redirect to thank you card panel
      showPanel('exam-thankyou-panel');
    },
  }; // end student namespace

  // ── Public API ─────────────────────────────────────────────────────────────
  // ── Drag Resizers Initializer ──────────────────────────────────────────────
  function initResizers() {
    initVerticalResizer('resizer-mentor-left', '.exam-dash-left', 180, 500);
    initDescriptionResizer('resizer-student-description');
    initHorizontalResizer('resizer-student-console', '.exam-student-console', 100, 600);
    initPaneSplitter('resizer-student-panes', 'box-pane-left', 'box-pane-right');
    
    // Mentor submission panels
    initVerticalResizer('resizer-mentor-sub-qnav', '#exam-mentor-submission-panel .exam-qnav', 180, 500);
    initMentorSubSplitter('resizer-mentor-sub-console', 'mentor-sub-question-display');
  }

  function initVerticalResizer(handleId, leftElSelector, minWidth, maxWidth) {
    const handle = el(handleId);
    if (!handle) return;
    let startX, startWidth;

    const onMouseMove = (e) => {
      const leftEl = document.querySelector(leftElSelector);
      if (!leftEl) return;
      const dx = e.clientX - startX;
      const newWidth = Math.min(Math.max(startWidth + dx, minWidth), maxWidth);
      leftEl.style.width = newWidth + 'px';
    };

    const onMouseUp = () => {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    handle.addEventListener('mousedown', (e) => {
      const leftEl = document.querySelector(leftElSelector);
      if (!leftEl) return;
      startX = e.clientX;
      startWidth = leftEl.getBoundingClientRect().width;
      handle.classList.add('dragging');
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  function initDescriptionResizer(handleId) {
    const handle = el(handleId);
    if (!handle) return;
    let startX;
    let startLeft;

    const onMouseMove = (event) => {
      const grid = handle.parentElement;
      if (!grid) return;
      const delta = event.clientX - startX;
      const total = grid.getBoundingClientRect().width;
      const left = Math.max(280, Math.min(total - 500, startLeft + delta));
      const right = Math.max(420, total - left - 3);
      grid.style.gridTemplateColumns = `${left}px 3px ${right}px`;
    };

    const onMouseUp = () => {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    handle.addEventListener('mousedown', (event) => {
      const grid = handle.parentElement;
      const columns = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ') : [];
      if (!grid || columns.length < 3) return;
      startX = event.clientX;
      startLeft = parseFloat(columns[0]) || grid.getBoundingClientRect().width * 0.45;
      handle.classList.add('dragging');
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  function initHorizontalResizer(handleId, bottomElSelector, minHeight, maxHeight) {
    const handle = el(handleId);
    if (!handle) return;
    let startY, startHeight;

    const onMouseMove = (e) => {
      const bottomEl = document.querySelector(bottomElSelector);
      if (!bottomEl) return;
      const dy = startY - e.clientY;
      const newHeight = Math.min(Math.max(startHeight + dy, minHeight), maxHeight);
      bottomEl.style.setProperty('height', newHeight + 'px', 'important');
      bottomEl.style.setProperty('flex', '0 0 auto', 'important');
    };

    const onMouseUp = () => {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    handle.addEventListener('mousedown', (e) => {
      const bottomEl = document.querySelector(bottomElSelector);
      if (!bottomEl) return;
      startY = e.clientY;
      startHeight = bottomEl.getBoundingClientRect().height;
      handle.classList.add('dragging');
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  function initPaneSplitter(handleId, leftBoxId, rightBoxId) {
    const handle = el(handleId);
    if (!handle) return;
    let startX, startLeftFlex, startRightFlex;

    const onMouseMove = (e) => {
      const leftBox = el(leftBoxId);
      const rightBox = el(rightBoxId);
      const container = handle.parentElement;
      if (!leftBox || !rightBox || !container) return;
      const dx = e.clientX - startX;
      const containerWidth = container.getBoundingClientRect().width;
      const deltaRatio = dx / containerWidth;
      const newLeftFlex = Math.max(0.1, Math.min(0.9, startLeftFlex + deltaRatio));
      const newRightFlex = Math.max(0.1, Math.min(0.9, startRightFlex - deltaRatio));
      leftBox.style.flex = newLeftFlex;
      rightBox.style.flex = newRightFlex;
    };

    const onMouseUp = () => {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    handle.addEventListener('mousedown', (e) => {
      const leftBox = el(leftBoxId);
      const rightBox = el(rightBoxId);
      if (!leftBox || !rightBox) return;
      startX = e.clientX;
      const leftW = leftBox.getBoundingClientRect().width;
      const rightW = rightBox.getBoundingClientRect().width;
      const total = leftW + rightW;
      startLeftFlex = leftW / total;
      startRightFlex = rightW / total;
      handle.classList.add('dragging');
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  function initMentorSubSplitter(handleId, topBoxId) {
    const handle = el(handleId);
    if (!handle) return;
    let startY, startTopFlex, startBottomFlex, activeBottomBox;

    const onMouseMove = (e) => {
      const topBox = el(topBoxId);
      const bottomBox = activeBottomBox;
      const container = handle.parentElement;
      if (!topBox || !bottomBox || !container) return;
      const dy = e.clientY - startY;
      const containerHeight = container.getBoundingClientRect().height;
      const deltaRatio = dy / containerHeight;
      const newTopFlex = Math.max(0.1, Math.min(0.9, startTopFlex + deltaRatio));
      const newBottomFlex = Math.max(0.1, Math.min(0.9, startBottomFlex - deltaRatio));
      topBox.style.flex = newTopFlex;
      bottomBox.style.flex = newBottomFlex;
    };

    const onMouseUp = () => {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    handle.addEventListener('mousedown', (e) => {
      const topBox = el(topBoxId);
      let bottomBox = el('mentor-sub-query-area');
      if (bottomBox && bottomBox.style.display === 'none') {
        bottomBox = el('mentor-sub-mcq-area');
      }
      if (!topBox || !bottomBox || bottomBox.style.display === 'none') return;

      activeBottomBox = bottomBox;
      startY = e.clientY;
      const topH = topBox.getBoundingClientRect().height;
      const bottomH = bottomBox.getBoundingClientRect().height;
      const total = topH + bottomH;
      startTopFlex = topH / (total || 1);
      startBottomFlex = bottomH / (total || 1);
      handle.classList.add('dragging');
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  // ── PROCTORING EVENT HANDLERS ────────────────────────────────────────────────
  function isDocumentFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
  }

  function syncFullscreenEnforcement(initialCheck) {
    if (!state.student.roomId || !state.student.fullscreenMode) return;
    const isFs = isDocumentFullscreen();
    if (isFs) {
      state.student.fullscreenActive = true;
      state.student.fullscreenWarningOpen = false;
      const overlay = el('student-fullscreen-overlay');
      if (overlay) overlay.style.display = 'none';
      return;
    }

    // Keep the entry gate visible whenever the exam has not successfully
    // entered fullscreen yet. This closes the gap where a rejected/unsupported
    // request could leave the exam usable in a normal browser window.
    if (!state.student.fullscreenActive) {
      const overlay = el('student-fullscreen-overlay');
      if (overlay) overlay.style.display = 'flex';
      return;
    }

    handleFullscreenChange();
  }

  async function handleFullscreenChange() {
    if (!state.student.roomId || !state.student.fullscreenMode) return;

    const isFs = isDocumentFullscreen();
    if (isFs) {
      state.student.fullscreenActive = true;
      state.student.fullscreenWarningOpen = false;
      return;
    }
    if (!isFs) {
      // Exited fullscreen!
      // Fullscreen enforcement starts with an entry overlay. That initial
      // non-fullscreen state is not an exit and must not trigger a warning.
      if (!state.student.fullscreenActive) return;
      state.student.fullscreenActive = false;
      if (state.student.ignoreFullscreenChange) {
        return;
      }
      const panelKicked = el('exam-student-kicked-panel');
      const kickedActive = panelKicked ? panelKicked.classList.contains('active') : false;
      const panelThankYou = el('exam-thankyou-panel');
      const thankYouActive = panelThankYou ? panelThankYou.classList.contains('active') : false;
      if (kickedActive || thankYouActive) {
        return;
      }

      // Browsers can emit fullscreenchange and a vendor-prefixed event for
      // the same transition. Keep one acknowledgement modal per exit.
      if (state.student.fullscreenWarningOpen) return;
      state.student.fullscreenWarningOpen = true;

      state.student.fullscreenExitCount = (state.student.fullscreenExitCount || 0) + 1;
      const limit = state.student.maxFullscreenExits || 5;

      const violation = await studentNS.reportFlaggedViolation('fullscreen_exit');
      if (violation && violation.status === 'ok') {
        state.student.fullscreenExitCount = Number(violation.fullscreenExits || state.student.fullscreenExitCount);
        state.student.maxFullscreenExits = Number(violation.fullscreenLimit || limit);
        if (violation.blocked) {
          clearInterval(state.student.pollInterval);
          clearInterval(state.student.timerInterval);
          studentNS.handleKicked(violation.blockedReason || `Fullscreen exit limit reached (${state.student.maxFullscreenExits}).`);
          return;
        }
      } else if (state.student.fullscreenExitCount >= limit) {
        studentNS.forceSubmitAndBlock(`You crossed the fullscreen exits threshold (${state.student.fullscreenExitCount}/${limit}). Your assessment has been auto-submitted and access has been terminated.`);
        return;
      }

      if (state.student.fullscreenExitCount >= state.student.maxFullscreenExits) {
        studentNS.forceSubmitAndBlock(`You crossed the fullscreen exits threshold (${state.student.fullscreenExitCount}/${state.student.maxFullscreenExits}). Your assessment has been auto-submitted and access has been terminated.`);
      } else {
        // Themed acknowledgement modal (blocks the whole screen until the student returns)
        showExamModal({
          title: 'Access Terminated',
          message: `You exited fullscreen mode! Exit ${state.student.fullscreenExitCount} of ${state.student.maxFullscreenExits}. You must return to fullscreen immediately or your access will be terminated.`,
          danger: true,
          buttons: [{ label: 'Return to Fullscreen', value: true, danger: true }],
        }).then(() => studentNS.requestFullscreen());
      }
    }
  }

  function handleCopy(e) {
    if (!state.student.roomId) return;
    
    // Check if the copy is coming from a CodeMirror instance (or editor wrapper)
    const activeEl = document.activeElement;
    const insideEditor = activeEl && (activeEl.closest('.CodeMirror') || activeEl.closest('.cm-editor'));
    
    if (insideEditor) {
      const text = window.getSelection().toString() || 
                   (state.student.examEditor && state.student.examEditor.getSelection()) || "";
      if (text) {
        state.student.lastInternalCopiedText = text;
        state.student.copiedFromEditor = true;
      }
    } else {
      state.student.lastInternalCopiedText = "";
      state.student.copiedFromEditor = false;
    }
  }

  function handlePaste(e) {
    if (state.student.roomId && state.student.blockCopyPaste) {
      const pastedText = (e.clipboardData || window.clipboardData).getData('text') || "";
      const cleanPasted = pastedText.replace(/\r/g, '').trim();
      const cleanInternal = (state.student.lastInternalCopiedText || "").replace(/\r/g, '').trim();

      if (state.student.copiedFromEditor && cleanPasted && cleanPasted === cleanInternal) {
        // Allow pasting text that was copied from the code editor itself
        return;
      }

      // Block external or non-editor clipboard paste immediately
      e.preventDefault();
      e.stopPropagation();

      // Mark as pasting to block inside beforeChange in case preventDefault is bypassed
      state.student.isPasting = true;
      setTimeout(() => { state.student.isPasting = false; }, 100);
      
      // Report violation and show modal asynchronously to avoid blocking browser's event loop
      setTimeout(async () => {
        const violation = await studentNS.reportFlaggedViolation('copy_paste_attempt');
        if (!violation || !violation.blocked) {
          showAppWarningModal(
            "Paste Restricted",
            "Copying and pasting is only allowed for text copied directly from within the code editor."
          );
        }
      }, 50);
    }
  }

  document.addEventListener('fullscreenchange', handleFullscreenChange);
  document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
  document.addEventListener('mozfullscreenchange', handleFullscreenChange);
  document.addEventListener('MSFullscreenChange', handleFullscreenChange);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') setTimeout(() => syncFullscreenEnforcement(false), 0);
  });
  window.addEventListener('focus', () => syncFullscreenEnforcement(false));
  window.addEventListener('pageshow', () => syncFullscreenEnforcement(false));

  document.addEventListener('copy', handleCopy, true);
  document.addEventListener('cut', handleCopy, true);
  document.addEventListener('paste', handlePaste, true);

  // Initialize resizers once DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initResizers);
  } else {
    setTimeout(initResizers, 100);
  }

  return {
    showRoleSelection,
    exitToHome,
    selectRole,
    mentor,
    student: studentNS,
  };
})(); // end ExamPortal IIFE

window.ExamPortal = ExamPortal;
