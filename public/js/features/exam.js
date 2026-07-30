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
      hasRunOnce: false,
      selectedOption: null,
      pollInterval: null,
      examEditor: null,
      timerInterval: null,
    }
  };

  // ── Utility ────────────────────────────────────────────────────────────────
  function genId() {
    return Math.random().toString(36).substr(2, 8).toUpperCase();
  }

  function el(id) { return document.getElementById(id); }

  function showPanel(panelId) {
    const panels = document.querySelectorAll('.exam-overlay');
    panels.forEach(p => p.classList.remove('active'));
    const target = el(panelId);
    if (target) target.classList.add('active');
  }

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
    body.innerHTML = participants.map(p => `
      <div class="exam-participant-row">
        <div class="exam-participant-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
        </div>
        <div class="exam-participant-info">
          <div class="exam-participant-name">${p.name || 'Unknown'}</div>
          <div class="exam-participant-meta">
            <span>${p.rollNo || '-'}</span>
            <span class="exam-participant-branch">${p.branch || '-'}</span>
          </div>
        </div>
        <span class="exam-participant-time">${timeAgo(p.joinedAt)}</span>
      </div>
    `).join('');
  }

  // ── Main navigation ────────────────────────────────────────────────────────
  function showRoleSelection() {
    showPanel('exam-role-panel');
  }

  function exitToHome() {
    hideAllExam();
    // Ensure intro is shown
    showView('intro');
  }

  function selectRole(role) {
    if (role === 'mentor') {
      // Generate room ID preview and show create form
      _genPreviewRoomId();
      showPanel('exam-mentor-create-panel');
    } else {
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

    toggleTimed(checked) {
      el('mentor-duration-field').style.display = checked ? 'block' : 'none';
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
      const mentorId = state.mentor.mentorId || genId();
      const roomId = state.mentor.roomId;

      el('btn-create-room').disabled = true;
      el('btn-create-room').textContent = 'Creating...';

      const res = await apiCall('/api/exam/room/create', 'POST', {
        title, mentorId, timed, duration, roomId
      });

      el('btn-create-room').disabled = false;
      el('btn-create-room').innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="white"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg> Create Room';

      if (res.status === 'ok') {
        state.mentor.roomId = res.roomId || roomId;
        state.mentor.mentorId = res.mentorId || mentorId;
        state.mentor.title = title;
        state.mentor.timed = timed;
        state.mentor.duration = duration;
        state.mentor.status = 'waiting';

        // Persist to localStorage
        localStorage.setItem('exam_mentor_id', state.mentor.mentorId);
        localStorage.setItem('exam_room_id', state.mentor.roomId);

        mentor.initDashboard();
      } else {
        el('mentor-create-err').textContent = res.error || 'Failed to create room';
        el('mentor-create-err').style.display = 'block';
      }
    },

    initDashboard() {
      const { roomId, title, status } = state.mentor;

      // Update header
      el('mentor-dash-title').textContent = `${title} — ${roomId}`;
      el('mentor-dash-room-id').textContent = roomId;
      if (el('mentor-dash-room-id')) el('mentor-dash-room-id').textContent = roomId;

      // Update status chip
      mentor._updateStatusUI(status);

      // Counts
      mentor._updateQCounts();

      // Start polling participants
      mentor._startParticipantPoll();

      showPanel('exam-mentor-dash-panel');
      mentor.setTab('questions');
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
          chip.textContent = 'ENDED';
        }
      });

      // Buttons
      if (status === 'waiting') {
        el('btn-start-exam').style.display = 'flex';
        el('btn-end-exam').style.display = 'none';
      } else if (status === 'live') {
        el('btn-start-exam').style.display = 'none';
        el('btn-end-exam').style.display = 'flex';
        // Show leaderboard tab, hide questions tab
        el('mentor-tab-live').style.display = 'flex';
        el('mentor-tab-questions').style.display = 'none';
        mentor.setTab('live');
        mentor._startLeaderboardPoll();
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
    },

    setTab(tab) {
      ['questions', 'dataset', 'live'].forEach(t => {
        const tabEl = el(`mentor-tab-${t}`);
        const paneEl = el(`mentor-pane-${t}`);
        if (tabEl) tabEl.classList.toggle('active', t === tab);
        if (paneEl) paneEl.classList.toggle('active', t === tab);
      });
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
        expectedQuery: '',
        answerFrozen: false,
        answerDocCount: 0,
        // MCQ specific
        options: type === 'mcq' ? ['', '', '', ''] : [],
        correctOption: type === 'mcq' ? 0 : null,
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
        body.innerHTML = '<div class="exam-qlist-empty">// No questions yet<br/>Click + to add Query or MCQ questions</div>';
        return;
      }
      body.innerHTML = qs.map((q, i) => `
        <div class="exam-q-card ${state.mentor.currentQId === q.id ? 'active' : ''}"
             id="qcard-${q.id}" onclick="ExamPortal.mentor.selectQuestion('${q.id}')">
          <div class="exam-q-card-top">
            <span class="exam-q-num">Q${i + 1}</span>
            <span class="exam-q-type-chip ${q.type === 'query' ? 'exam-q-type-query' : 'exam-q-type-mcq'}">${q.type === 'query' ? 'QUERY' : 'MCQ'}</span>
            <span class="exam-q-marks-badge">${q.marks}pts</span>
            <button class="phbtn" style="margin-left:auto;color:var(--red)" title="Delete"
              onclick="event.stopPropagation();ExamPortal.mentor.deleteQuestion('${q.id}')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>
          </div>
          <div class="exam-q-preview">${q.text ? q.text.substring(0, 60) + (q.text.length > 60 ? '...' : '') : '// No text yet'}</div>
          ${q.type === 'query' && q.answerFrozen ? `<span class="exam-frozen-chip" style="font-size:10px;padding:2px 8px;margin-top:4px">Answer frozen — ${q.answerDocCount} docs</span>` : ''}
        </div>
      `).join('');
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

    _renderQEditor(qId) {
      const q = state.mentor.questions.find(x => x.id === qId);
      if (!q) return;
      const qeditor = el('mentor-qeditor');

      if (q.type === 'query') {
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
            <div class="exam-fieldset-title">Expected Query (Mentor's Solution)</div>
            <div class="exam-mini-editor ${q.answerFrozen ? 'frozen' : ''}" id="mini-editor-wrap-${qId}">
              <textarea id="mini-editor-${qId}">${q.expectedQuery || '// db.collection.find({})'}</textarea>
              ${q.answerFrozen ? '<div class="exam-frozen-overlay"><svg width="18" height="18" viewBox="0 0 24 24"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg></div>' : ''}
            </div>
            ${q.answerFrozen
              ? `<span class="exam-frozen-chip"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>Answer frozen — ${q.answerDocCount} docs</span>`
              : `<button class="exam-btn exam-btn-green" onclick="ExamPortal.mentor.freezeAnswer('${qId}')">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
                  Run &amp; Freeze Answer
                </button>`
            }
            <div id="freeze-status-${qId}" style="display:none"></div>
            <div id="freeze-output-${qId}" style="display:none;margin-top:8px;max-height:160px;overflow-y:auto;background:var(--bg);border:1px solid var(--border2);border-radius:4px;padding:8px;font-family:'JetBrains Mono',monospace;font-size:11px;white-space:pre-wrap"></div>
          </div>
        `;
        // Init mini CodeMirror
        setTimeout(() => {
          const ta = el(`mini-editor-${qId}`);
          if (ta && typeof CodeMirror !== 'undefined' && !state.mentor.miniEditors[qId]) {
            const cm = CodeMirror.fromTextArea(ta, {
              mode: 'javascript',
              theme: 'default',
              lineNumbers: true,
              matchBrackets: true,
              autoCloseBrackets: true,
              readOnly: q.answerFrozen,
            });
            cm.setSize('100%', '120px');
            cm.on('change', () => {
              mentor.updateQField(qId, 'expectedQuery', cm.getValue());
            });
            state.mentor.miniEditors[qId] = cm;
          }
        }, 50);

      } else {
        // MCQ editor
        const opts = q.options || ['', '', '', ''];
        qeditor.innerHTML = `
          <div class="exam-fieldset">
            <div class="exam-fieldset-title">Question Text</div>
            <textarea class="exam-textarea" id="qtext-${qId}" oninput="ExamPortal.mentor.updateQField('${qId}','text',this.value)" placeholder="Write the multiple-choice question...">${q.text}</textarea>
          </div>
          <div class="exam-field" style="margin:0">
            <label class="exam-label">Marks</label>
            <input class="exam-num-input" type="number" min="1" max="100" value="${q.marks}"
              oninput="ExamPortal.mentor.updateQField('${qId}','marks',parseInt(this.value)||0)"/>
          </div>
          <div class="exam-fieldset">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <div class="exam-fieldset-title">Options</div>
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
    },

    _renderMCQOptionRow(qId, idx, value, isCorrect) {
      const label = String.fromCharCode(65 + idx); // A, B, C...
      return `
        <div class="exam-mcq-option-row" id="mcq-opt-row-${qId}-${idx}">
          <input type="radio" class="exam-mcq-correct-radio" name="correct-${qId}" value="${idx}"
            ${isCorrect ? 'checked' : ''}
            onchange="ExamPortal.mentor.updateQField('${qId}','correctOption',${idx})"/>
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

    updateQField(qId, field, value) {
      const q = state.mentor.questions.find(x => x.id === qId);
      if (q) {
        q[field] = value;
        if (field === 'text') {
          mentor._renderQList();
        }
        if (field === 'marks') {
          mentor._updateQCounts();
        }
        mentor._saveQDebounced();
      }
    },

    _saveQDebounced: (() => {
      let timer;
      return () => {
        clearTimeout(timer);
        timer = setTimeout(() => mentor._saveQuestions(), 600);
      };
    })(),

    async _saveQuestions() {
      if (!state.mentor.roomId || !state.mentor.mentorId) return;
      await apiCall(`/api/exam/room/${state.mentor.roomId}/questions`, 'POST', {
        mentorId: state.mentor.mentorId,
        questions: state.mentor.questions,
      });
      mentor._updateQCounts();
    },

    async freezeAnswer(qId) {
      const q = state.mentor.questions.find(x => x.id === qId);
      if (!q) return;

      const cm = state.mentor.miniEditors[qId];
      const query = cm ? cm.getValue() : q.expectedQuery;

      const datasetIds = q.datasetIds || (q.datasetId ? [q.datasetId] : []);

      if (datasetIds.length === 0) {
        showMsg(`freeze-status-${qId}`, '// Select at least one dataset first', true);
        el(`freeze-status-${qId}`).style.display = 'block';
        return;
      }
      if (!query || query.startsWith('//')) {
        showMsg(`freeze-status-${qId}`, '// Write the expected query first', true);
        el(`freeze-status-${qId}`).style.display = 'block';
        return;
      }

      showMsg(`freeze-status-${qId}`, '// Running query...', false);
      el(`freeze-status-${qId}`).style.display = 'block';

      const res = await apiCall(`/api/exam/room/${state.mentor.roomId}/freeze`, 'POST', {
        mentorId: state.mentor.mentorId,
        questionId: qId,
        datasetIds,
        query,
      });

      const out = el(`freeze-output-${qId}`);
      if (res.status === 'ok') {
        q.answerFrozen = true;
        q.expectedQuery = query;
        q.answerDocCount = res.docCount;
        await mentor._saveQuestions();
        mentor._renderQList();
        mentor._renderQEditor(qId);

        if (out) {
          out.style.display = 'block';
          out.style.borderColor = 'var(--green2)';
          out.innerHTML = `<span style="color:var(--green2)">// Query executed successfully. Showing sample document preview:</span>\n${JSON.stringify(res.preview || [], null, 2)}`;
        }
      } else {
        showMsg(`freeze-status-${qId}`, res.error || '// Error running query', true);
        if (out) {
          out.style.display = 'block';
          out.style.borderColor = 'var(--red)';
          out.innerHTML = `<span style="color:var(--red)">// Query execution failed:</span>\n${res.error || 'Unknown query error'}`;
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
    },

    // ── Room Lifecycle ─────────────────────────────────────────────────────

    async startExam() {
      if (state.mentor.questions.length === 0) {
        alert('Add at least one question before starting the exam.');
        return;
      }
      const unfrozen = state.mentor.questions.filter(q => q.type === 'query' && !q.answerFrozen);
      if (unfrozen.length > 0) {
        if (!confirm(`${unfrozen.length} query question(s) have no frozen answer. Students will get 0 marks for those. Continue?`)) return;
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
      if (!confirm('End the exam? Students will no longer be able to submit answers.')) return;
      const res = await apiCall(`/api/exam/room/${state.mentor.roomId}/end`, 'POST', {
        mentorId: state.mentor.mentorId,
      });
      if (res.status === 'ok') {
        mentor._updateStatusUI('ended');
        // Final leaderboard fetch
        mentor.fetchLeaderboard();
      }
    },

    // ── Participants Polling ───────────────────────────────────────────────

    _startParticipantPoll() {
      clearInterval(state.mentor.participantInterval);
      mentor._fetchParticipants();
      state.mentor.participantInterval = setInterval(mentor._fetchParticipants, 3000);
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
      state.mentor.lbInterval = setInterval(mentor.fetchLeaderboard, 5000);
    },

    async fetchLeaderboard() {
      const roomId = state.mentor.roomId;
      if (!roomId) return;

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
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text3);font-family:\'JetBrains Mono\',monospace;padding:20px">// Waiting for submissions...</td></tr>';
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

        return `
          <tr class="${rowClass}">
            <td class="exam-lb-rank ${rankClass}">${rank}</td>
            <td class="exam-lb-name">${row.name}</td>
            <td style="font-family:'JetBrains Mono',monospace">${row.rollNo}</td>
            <td><span class="exam-participant-branch">${row.branch}</span></td>
            <td class="exam-lb-score">${row.totalScore}/${maxScore}</td>
            <td class="exam-lb-accuracy">${row.answered}/${(state.mentor.questions || []).length}</td>
            <td class="exam-lb-accuracy">${accuracy}</td>
            <td class="exam-lb-time">${lastSub}</td>
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
      // Fetch final leaderboard
      const res = await apiCall(`/api/exam/room/${state.mentor.roomId}/leaderboard`);
      let data = (res.leaderboard || []).map((row, i) => ({
        Rank: i + 1,
        Name: row.name,
        'Roll No': row.rollNo,
        Branch: row.branch,
        Score: row.totalScore,
        'Max Score': res.maxScore || 0,
        Percentage: res.maxScore > 0 ? `${Math.round((row.totalScore / res.maxScore) * 100)}%` : '0%',
        Answered: row.answered,
        Correct: row.correct,
      }));

      if (state.mentor.sortMode === 'roll') {
        data.sort((a, b) => (a['Roll No'] || '').localeCompare(b['Roll No'] || ''));
        data.forEach((row, i) => { row.Rank = i + 1; });
      }

      if (typeof XLSX === 'undefined') {
        alert('SheetJS not loaded. Please check your internet connection.');
        return;
      }

      const ws = XLSX.utils.json_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Results');
      const date = new Date().toISOString().split('T')[0];
      const filename = `${state.mentor.title.replace(/\s+/g, '_')}_${date}_results.xlsx`;
      XLSX.writeFile(wb, filename);
    },

    async cleanupRoom() {
      if (!confirm('Delete all room data from Redis? This cannot be undone.')) return;
      await apiCall(`/api/exam/room/${state.mentor.roomId}/cleanup`, 'DELETE', {
        mentorId: state.mentor.mentorId,
      });
      localStorage.removeItem('exam_mentor_id');
      localStorage.removeItem('exam_room_id');
      showRoleSelection();
    },
  }; // end mentor namespace

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

    async joinRoom() {
      const name = el('student-name').value.trim();
      const rollNo = el('student-roll').value.trim();
      const branch = el('student-branch').value;
      const roomId = el('student-room-id').value.trim().toUpperCase();

      // Validation
      let valid = true;
      if (!name) { el('student-name').classList.add('has-err'); el('student-name-err').textContent='// Name is required'; el('student-name-err').style.display='block'; valid=false; }
      else { el('student-name').classList.remove('has-err'); el('student-name-err').style.display='none'; }
      if (!rollNo) { el('student-roll').classList.add('has-err'); el('student-roll-err').textContent='// Roll number is required'; el('student-roll-err').style.display='block'; valid=false; }
      else { el('student-roll').classList.remove('has-err'); el('student-roll-err').style.display='none'; }
      if (!branch) { el('student-branch').classList.add('has-err'); el('student-branch-err').textContent='// Select a branch'; el('student-branch-err').style.display='block'; valid=false; }
      else { el('student-branch').classList.remove('has-err'); el('student-branch-err').style.display='none'; }
      if (!roomId || roomId.length < 7) { el('student-room-id').classList.add('has-err'); el('student-room-err').textContent='// Enter a valid Room ID (e.g. MNG-4X9)'; el('student-room-err').style.display='block'; valid=false; }
      else { el('student-room-id').classList.remove('has-err'); el('student-room-err').style.display='none'; }
      if (!valid) return;

      el('btn-join-room').disabled = true;
      el('btn-join-room').textContent = 'Joining...';

      const res = await apiCall(`/api/exam/room/${roomId}/join`, 'POST', {
        name, rollNo, branch,
      });

      el('btn-join-room').disabled = false;
      el('btn-join-room').innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="white"><path d="M10 17l5-5-5-5v10zm-5 0l5-5-5-5v10z"/></svg> Join Room';

      if (res.status === 'ok') {
        state.student.roomId = roomId;
        state.student.studentId = res.studentId;
        state.student.name = name;
        state.student.rollNo = rollNo;
        state.student.branch = branch;

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
        el('student-join-err').textContent = res.error || '// Failed to join room';
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

      state.student.roomId = roomId;
      state.student.questions = res.questions || [];
      state.student.datasets = res.datasets || [];
      state.student.roomStatus = res.meta?.status || 'live';

      // Initialize question status
      state.student.status = {};
      state.student.questions.forEach(q => {
        state.student.status[q.id] = 'unattempted';
      });

      // Update header
      if (el('student-exam-room-title')) el('student-exam-room-title').textContent = res.meta?.title || roomId;

      // Timer
      if (res.meta?.timed === '1' && res.meta?.startedAt) {
        studentNS._startExamTimer(parseInt(res.meta.startedAt), parseInt(res.meta.duration));
      }

      // Render question nav
      studentNS._renderQNav();

      showPanel('exam-student-exam-panel');

      // Poll for exam end
      clearInterval(state.student.pollInterval);
      state.student.pollInterval = setInterval(async () => {
        const statusRes = await apiCall(`/api/exam/room/${roomId}`);
        if (statusRes.status === 'ok' && statusRes.meta?.status === 'ended') {
          clearInterval(state.student.pollInterval);
          clearInterval(state.student.timerInterval);
          studentNS._lockExam();
        }
      }, 5000);

      // Init student editor
      setTimeout(() => studentNS._initStudentEditor(), 100);

      // Select first question if available
      if (state.student.questions.length > 0) {
        studentNS.selectQuestion(0);
      }
    },

    _startExamTimer(startedAt, durationMin) {
      const timerEl = el('student-exam-timer');
      if (!timerEl) return;
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
          studentNS._lockExam();
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
        extraKeys: {
          'Ctrl-Enter': () => studentNS.runQuery(),
        },
      });
      cm.setSize('100%', '100%');
      cm.on('change', () => {
        if (state.student.status[state.student.questions[state.student.currentQIdx]?.id] !== 'submitted') {
          const qId = state.student.questions[state.student.currentQIdx]?.id;
          if (qId && state.student.status[qId] !== 'submitted') {
            state.student.status[qId] = 'draft';
            studentNS._renderQNav();
          }
        }
      });
      state.student.examEditor = cm;
    },

    _renderQNav() {
      const body = el('student-qnav-body');
      const qs = state.student.questions;
      if (!body) return;
      if (qs.length === 0) {
        body.innerHTML = '<div class="exam-participants-empty">// No questions</div>';
        return;
      }
      el('student-q-progress').textContent = `Q ${state.student.currentQIdx !== null ? state.student.currentQIdx + 1 : 0}/${qs.length}`;
      body.innerHTML = qs.map((q, i) => {
        const statusKey = state.student.status[q.id] || 'unattempted';
        const dotClass = statusKey === 'submitted' ? 'exam-q-status-submitted'
          : statusKey === 'draft' ? 'exam-q-status-draft'
          : 'exam-q-status-unattempted';
        return `
          <div class="exam-qnav-card ${state.student.currentQIdx === i ? 'active' : ''}"
               onclick="ExamPortal.student.selectQuestion(${i})">
            <div class="exam-q-card-top">
              <span class="exam-q-num">Q${i + 1}</span>
              <span class="exam-q-type-chip ${q.type === 'query' ? 'exam-q-type-query' : 'exam-q-type-mcq'}">${q.type === 'query' ? 'QUERY' : 'MCQ'}</span>
              <span class="exam-q-marks-badge">${q.marks}pts</span>
              <div class="exam-q-status-dot ${dotClass}" style="margin-left:auto"></div>
            </div>
            <div class="exam-q-preview">${q.text ? q.text.substring(0, 50) + (q.text.length > 50 ? '...' : '') : '// No text'}</div>
          </div>
        `;
      }).join('');
    },

    selectQuestion(idx) {
      const qs = state.student.questions;
      if (idx < 0 || idx >= qs.length) return;

      state.student.currentQIdx = idx;
      const q = qs[idx];

      // Update header
      el('student-q-number').textContent = `Q${idx + 1}`;
      el('student-q-type-chip').textContent = q.type === 'query' ? 'QUERY' : 'MCQ';
      el('student-q-type-chip').className = `exam-q-type-chip ${q.type === 'query' ? 'exam-q-type-query' : 'exam-q-type-mcq'}`;
      el('student-q-marks').textContent = `${q.marks} marks`;
      el('student-q-text').textContent = q.text;
      el('student-question-display').style.display = 'block';
      el('student-no-q-selected').style.display = 'none';

      el('student-q-progress').textContent = `Q ${idx + 1}/${qs.length}`;

      // Show/hide areas
      if (q.type === 'query') {
        el('student-query-area').style.display = 'flex';
        el('student-mcq-area').style.display = 'none';
        el('btn-inspect-dataset').style.display = q.datasetId ? 'flex' : 'none';

        // Set editor content
        const cm = state.student.examEditor;
        if (cm) {
          cm.setValue(q._studentDraft || `// Question ${idx + 1}\ndb.`);
          cm.focus();
        }

        // Reset console
        el('student-pane-yours').innerHTML = '<span style="color:var(--text3)">// Run a query to see output here</span>';
        el('student-console-status').textContent = '— Ready';
        state.student.hasRunOnce = false;
        el('student-submit-query-btn').disabled = true;
        el('student-submit-query-btn').style.opacity = '0.4';

      } else {
        el('student-query-area').style.display = 'none';
        el('student-mcq-area').style.display = 'flex';
        el('btn-inspect-dataset').style.display = 'none';
        state.student.selectedOption = null;
        el('student-mcq-status').textContent = '';
        studentNS._renderMCQOptions(q);
      }

      studentNS._renderQNav();
    },

    _renderMCQOptions(q) {
      const container = el('student-mcq-options');
      const labels = ['A', 'B', 'C', 'D', 'E', 'F'];
      container.innerHTML = (q.options || []).map((opt, i) => `
        <div class="exam-mcq-option-item ${state.student.selectedOption === i ? 'selected' : ''}"
             data-idx="${i}"
             tabindex="0"
             onclick="ExamPortal.student.selectMCQOption(${i})"
             onkeydown="ExamPortal.student.mcqKeyNav(event,${i},${(q.options || []).length})">
          <span class="exam-mcq-option-indicator">${state.student.selectedOption === i ? '[x]' : `[${labels[i] || i}]`}</span>
          <span class="exam-mcq-option-text">${opt}</span>
        </div>
      `).join('');
    },

    mcqKeyNav(event, currentIdx, total) {
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
      state.student.selectedOption = idx;
      const q = state.student.questions[state.student.currentQIdx];
      if (q) {
        state.student.status[q.id] = 'draft';
        studentNS._renderMCQOptions(q);
        studentNS._renderQNav();
      }
    },

    setConsoleTab(tab) {
      ['yours', 'expected'].forEach(t => {
        el(`student-ctab-${t}`)?.classList.toggle('active', t === tab);
        el(`student-pane-${t}`)?.classList.toggle('active', t === tab);
      });
    },

    async runQuery() {
      const cm = state.student.examEditor;
      if (!cm) return;
      const query = cm.getValue();
      const q = state.student.questions[state.student.currentQIdx];
      const datasetIds = q.datasetIds || (q.datasetId ? [q.datasetId] : []);
      if (!q || datasetIds.length === 0) {
        el('student-pane-yours').innerHTML = '<span style="color:var(--red)">// No dataset linked to this question</span>';
        return;
      }

      el('student-run-btn').textContent = 'Running...';
      el('student-run-btn').disabled = true;
      el('student-console-status').textContent = '— Running...';

      const res = await apiCall(`/api/exam/room/${state.student.roomId}/query`, 'POST', {
        datasetIds,
        query,
        limit: 100,
      });

      el('student-run-btn').innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg> Run';
      el('student-run-btn').disabled = false;

      if (res.status === 'ok') {
        const results = res.results || [];
        state.student.lastRunOutput = results;
        el('student-console-status').textContent = `— ${results.length} doc(s)`;
        el('student-pane-yours').innerHTML = `<pre style="color:var(--text);font-size:11px;white-space:pre-wrap">${JSON.stringify(results, null, 2)}</pre>`;
        state.student.hasRunOnce = true;
        el('student-submit-query-btn').disabled = false;
        el('student-submit-query-btn').style.opacity = '1';
      } else {
        el('student-console-status').textContent = '— Error';
        el('student-pane-yours').innerHTML = `<span style="color:var(--red)">${res.error || '// Unknown error'}</span>`;
      }
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

      const firstDoc = ds.sampleDocs?.[0];
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

      if (q.type === 'mcq') {
        if (state.student.selectedOption === null) {
          el('student-mcq-status').textContent = '// Select an option first';
          el('student-mcq-status').style.color = 'var(--red)';
          return;
        }
        body.selectedOption = state.student.selectedOption;
      } else {
        const cm = state.student.examEditor;
        body.query = cm ? cm.getValue() : '';
        body.datasetIds = q.datasetIds || (q.datasetId ? [q.datasetId] : []);
        body.studentOutput = state.student.lastRunOutput || [];
      }

      // Optimistic UI: immediately mark as submitted
      state.student.status[q.id] = 'submitted';
      studentNS._renderQNav();
      if (q.type === 'mcq') {
        el('student-mcq-status').textContent = '// Submitting...';
        el('student-mcq-status').style.color = 'var(--text3)';
      }

      const res = await apiCall(`/api/exam/room/${state.student.roomId}/submit`, 'POST', body);

      if (res.status === 'ok') {
        if (q.type === 'mcq') {
          el('student-mcq-status').textContent = '// Answer submitted.';
          el('student-mcq-status').style.color = 'var(--green2)';
        } else {
          el('student-console-status').textContent = '— Answer submitted.';
          // Show expected output preview (max 5 docs)
          studentNS._fetchExpectedPreview(q.id);
        }
        state.student.status[q.id] = 'submitted';
      } else {
        // Revert optimistic update on error
        state.student.status[q.id] = 'draft';
        if (q.type === 'mcq') {
          el('student-mcq-status').textContent = res.error || '// Submission failed';
          el('student-mcq-status').style.color = 'var(--red)';
        }
      }
      studentNS._renderQNav();
    },

    async _fetchExpectedPreview(questionId) {
      const pane = el('student-pane-expected');
      if (!pane) return;
      pane.innerHTML = '<span style="color:var(--text3)">// Fetching expected output preview...</span>';

      const res = await apiCall(`/api/exam/room/${state.student.roomId}/question/${questionId}/expected-preview`);
      if (res.status === 'ok') {
        const docs = res.preview || [];
        const count = res.docCount || 0;
        pane.innerHTML = `
          <pre style="color:var(--text);font-size:11px;white-space:pre-wrap">${JSON.stringify(docs, null, 2)}</pre>
          <div class="exam-console-hint">// Showing first ${docs.length} of ${count} documents — full result hidden</div>
        `;
      } else {
        pane.innerHTML = '<span style="color:var(--text3)">// Expected output preview not available</span>';
      }
    },

    async finishExam() {
      if (!confirm('Are you sure you want to submit the final exam? You will not be able to modify your answers after this.')) return;
      const btn = el('btn-student-submit-exam');
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Submitting...';
      }
      const res = await apiCall(`/api/exam/room/${state.student.roomId}/student/${state.student.studentId}/finish`, 'POST');
      if (res.status === 'ok') {
        studentNS._lockExam();
      } else {
        alert(res.error || 'Failed to submit final exam. Please try again.');
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="white" style="margin-right:3px"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> Submit Exam';
        }
      }
    },

    _lockExam() {
      // Lock editor
      if (state.student.examEditor) {
        state.student.examEditor.setOption('readOnly', 'nocursor');
      }
      // Redirect to thank you card panel
      showPanel('exam-thankyou-panel');
    },
  }; // end student namespace

  // ── Public API ─────────────────────────────────────────────────────────────
  return {
    showRoleSelection,
    exitToHome,
    selectRole,
    mentor,
    student: studentNS,
  };

})(); // end ExamPortal IIFE
