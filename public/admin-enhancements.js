(() => {
  'use strict';

  const drawer = document.getElementById('detail-drawer');
  const body = document.getElementById('drawer-body');
  const title = document.getElementById('drawer-title');
  const eyebrow = document.getElementById('drawer-eyebrow');
  const esc = (value) => String(value ?? '—').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));
  const fmt = (value) => {
    if (!value) return '—';
    const raw = String(value);
    const timestamp = /^\d+$/.test(raw) ? Number(raw) * (Number(raw) < 1e12 ? 1000 : 1) : value;
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? esc(value) : date.toLocaleString();
  };
  const toast = (message, error = false) => {
    const region = document.getElementById('toast-region');
    const node = document.createElement('div');
    node.className = `toast${error ? ' error' : ''}`;
    node.textContent = message;
    region.appendChild(node);
    setTimeout(() => node.remove(), 4200);
  };
  const api = async (path, options = {}) => {
    const response = await fetch(path, {
      credentials: 'same-origin',
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || result.code || `Request failed (${response.status})`);
    return result;
  };
  const csrf = async () => (await api('/api/admin/auth/me')).csrfToken || '';
  const detail = (label, value) => `<div class="detail-field"><label>${esc(label)}</label><strong>${esc(value)}</strong></div>`;
  const section = (label, content) => `<section class="detail-section"><h3>${esc(label)}</h3>${content}</section>`;
  const empty = '<div class="empty-state">No records were persisted for this room.</div>';
  const records = (items, render) => items.length
    ? `<div class="admin-record-list">${items.map(render).join('')}</div>`
    : empty;

  function show(heading, roomTitle, content) {
    eyebrow.textContent = heading;
    title.textContent = roomTitle || 'Room details';
    body.innerHTML = content;
    drawer.hidden = false;
  }

  function submissionCards(participant) {
    return Object.entries(participant.submissions || {}).map(([questionId, submission]) => {
      submission = submission && typeof submission === 'object' ? submission : { answer: submission };
      const code = submission.code || submission.query || submission.answer || '';
      const payload = code || JSON.stringify(submission, null, 2);
      return `<article class="admin-record-card"><div class="record-card-heading"><strong>Question ${esc(questionId)}</strong><span>${esc(submission.type || 'submission')}</span></div><div class="record-card-meta">${esc(submission.language || 'No language')} · ${fmt(submission.submittedAt)}${submission.score !== undefined ? ` · Score ${esc(submission.score)}` : ''}</div><details class="submission-code"><summary>View saved code / query</summary><pre>${esc(payload)}</pre></details><details><summary>View complete submission record</summary><pre>${esc(JSON.stringify(submission, null, 2))}</pre></details></article>`;
    }).join('');
  }

  async function openExam(roomId) {
    try {
      const data = await api(`/api/admin/exams/${encodeURIComponent(roomId)}`);
      const room = data.room || {};
      const participants = data.participants || [];
      const participantCards = participants.map((student) => {
        const flags = (student.fullscreenExits || 0) + (student.copyPasteAttempts || 0);
        const submissions = submissionCards(student);
        return `<article class="admin-record-card"><div class="record-card-heading"><div><strong>${esc(student.name || 'Student')}</strong><div class="record-card-meta">${esc(student.rollNo || 'No roll number')} · ${esc(student.branch || 'No branch')} · ${esc(student.studentId)}</div></div><span class="status-pill ${flags ? 'pill-failed' : 'pill-healthy'}">${flags ? `${flags} proctor flags` : 'No flags'}</span></div><div class="record-card-meta">${esc(student.status || 'Status not recorded')} · ${student.finished ? 'Finished' : 'In progress'} · ${esc(student.submissionCount || 0)} submissions</div>${submissions ? `<details class="student-submissions"><summary>Submissions (${esc(student.submissionCount || 0)})</summary><div class="admin-record-list">${submissions}</div></details>` : '<p class="record-card-meta">No submissions yet.</p>'}</article>`;
      });
      const questionCards = (data.questions || []).map((question, index) => `<article class="admin-record-card"><div class="record-card-heading"><strong>Q${index + 1} · ${esc(question.title || question.id)}</strong><span>${esc(question.type || 'question')}</span></div><div class="record-card-meta">${esc(question.id)} · ${esc(question.marks ?? '—')} marks</div><details><summary>View complete question record</summary><pre>${esc(JSON.stringify((data.questionDetails || [])[index] || question, null, 2))}</pre></details></article>`);
      const auditCards = (room.paperAudit || []).slice(-20).reverse().map((entry) => `<article class="admin-record-card"><div class="record-card-heading"><strong>Paper revision ${esc(entry.paperVersion || '')}</strong><span>${fmt(entry.createdAt ? entry.createdAt * 1000 : '')}</span></div><div class="record-card-meta">Mentor ${esc(entry.mentorId)} · ${esc(entry.questionCount)} questions · Changed: ${esc((entry.changedQuestionIds || []).join(', ') || 'none')} · Removed: ${esc((entry.removedQuestionIds || []).join(', ') || 'none')}</div></article>`);
      const telemetry = data.telemetry || {};
      show('EXAM ROOM · LIVE DATABASE', room.title || roomId,
        `<div class="detail-grid">${detail('Room ID', roomId)}${detail('Status', room.status)}${detail('Mentor', room.mentorId)}${detail('Created', fmt(room.createdAt))}${detail('Started', fmt(room.startedAt))}${detail('Ended', fmt(room.endedAt))}${detail('Participants', participants.length)}${detail('Stored submissions', telemetry.submissionCount || 0)}${detail('Proctoring flags', telemetry.flaggedParticipants || 0)}</div>` +
        section('Student activity and submissions', records(participantCards, card => card)) +
        section('Question paper', records(questionCards, card => card)) +
        section('Paper revision audit', records(auditCards, card => card)) +
        `<div class="admin-drawer-actions"><button class="danger-button" data-enhanced-delete="exam" data-room-id="${esc(roomId)}">Delete exam permanently</button></div>`);
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function openMeeting(roomId) {
    try {
      const data = await api(`/api/admin/meetings/${encodeURIComponent(roomId)}`);
      const room = data.room || {};
      const participants = Object.entries(room.participants || {});
      const participantCards = participants.map(([peerId, participant]) => `<article class="admin-record-card"><div class="record-card-heading"><strong>${esc(participant.name || 'Participant')}</strong><span>${participant.isCreator ? 'Host' : 'Participant'}</span></div><div class="record-card-meta">${esc(peerId)} · ${esc(participant.accountId || 'anonymous')} · Joined ${fmt(participant.joinedAt)} · Last active ${fmt(participant.lastSeenAt)}</div></article>`);
      const renderActivity = (event) => `<article class="admin-record-card"><div class="record-card-heading"><strong>${esc(event.name || event.peerId || 'Meeting activity')}</strong><span>${fmt(event.createdAt || event.at)}</span></div><div class="record-card-meta">${esc(event.message || event.reaction || event.eventType || 'Activity recorded')}</div><details><summary>View event payload</summary><pre>${esc(JSON.stringify(event, null, 2))}</pre></details></article>`;
      show('MEETING ROOM · LIVE DATABASE', room.roomTitle || roomId,
        `<div class="detail-grid">${detail('Room ID', room.roomId || roomId)}${detail('Host', room.hostName)}${detail('Owner account', room.ownerAccountId)}${detail('State', room.isOpen ? 'Live' : 'Closed')}${detail('Created', fmt(room.createdAt))}${detail('Last active', fmt(room.activeAt))}${detail('Chat messages', (room.chatMessages || []).length)}${detail('Events', (room.participantEvents || []).length)}</div>` +
        section('Participants', records(participantCards, card => card)) +
        section('Chat history', records((room.chatMessages || []).slice(-100).reverse(), renderActivity)) +
        section('Reactions', records((room.reactions || []).slice(-100).reverse(), renderActivity)) +
        section('Participant events', records((room.participantEvents || []).slice(-100).reverse(), renderActivity)) +
        `<div class="admin-drawer-actions"><button class="danger-button" data-enhanced-delete="meeting" data-room-id="${esc(room.roomId || roomId)}">Delete meeting permanently</button></div>`);
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function deleteRoom(kind, roomId) {
    const label = kind === 'exam' ? 'exam and all stored submissions' : 'meeting and all retained activity';
    if (!window.confirm(`Permanently delete this ${label}? This cannot be undone.`)) return;
    try {
      await api(`/api/admin/${kind === 'exam' ? 'exams' : 'meetings'}/${encodeURIComponent(roomId)}`, {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': await csrf() }
      });
      drawer.hidden = true;
      toast(`${kind === 'exam' ? 'Exam' : 'Meeting'} deleted permanently.`);
      document.getElementById('refresh-button').click();
    } catch (error) {
      toast(error.message, true);
    }
  }

  document.addEventListener('click', (event) => {
    const deleteButton = event.target.closest('[data-enhanced-delete]');
    if (deleteButton) {
      event.preventDefault();
      event.stopPropagation();
      deleteRoom(deleteButton.dataset.enhancedDelete, deleteButton.dataset.roomId);
      return;
    }
    const examRow = event.target.closest('[data-exam-id]');
    if (examRow) {
      event.preventDefault();
      event.stopImmediatePropagation();
      openExam(examRow.dataset.examId);
      return;
    }
    const meetingRow = event.target.closest('[data-meeting-id]');
    if (meetingRow) {
      event.preventDefault();
      event.stopImmediatePropagation();
      openMeeting(meetingRow.dataset.meetingId);
    }
  }, true);

})();
