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
    const date = new Date(value);
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
  const table = (headers, rows) => rows.length
    ? `<div class="table-wrap"><table class="data-table"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    : '<div class="empty-state">No records were persisted for this room.</div>';

  function show(heading, roomTitle, content) {
    eyebrow.textContent = heading;
    title.textContent = roomTitle || 'Room details';
    body.innerHTML = content;
    drawer.hidden = false;
  }

  function submissionRows(participants) {
    return participants.flatMap((participant) => Object.entries(participant.submissions || {}).map(([questionId, submission]) => {
      const code = submission.code || submission.query || submission.answer || '';
      return `<tr><td class="mono">${esc(participant.studentId)}</td><td class="mono">${esc(questionId)}</td><td>${esc(submission.type || 'submission')}</td><td>${esc(submission.language || '—')}</td><td>${fmt(submission.submittedAt ? submission.submittedAt * 1000 : '')}</td><td><details class="submission-code"><summary>View payload</summary><pre>${esc(code || JSON.stringify(submission, null, 2))}</pre></details></td></tr>`;
    }));
  }

  async function openExam(roomId) {
    try {
      const data = await api(`/api/admin/exams/${encodeURIComponent(roomId)}`);
      const room = data.room || {};
      const participants = data.participants || [];
      const participantRows = participants.map((student) => `<tr><td class="mono">${esc(student.studentId)}</td><td><strong>${esc(student.name)}</strong><br><span class="muted">${esc(student.rollNo || student.accountId || '—')}</span></td><td>${esc(student.status || '—')}</td><td>${student.finished ? 'Yes' : 'No'}</td><td>${esc(student.submissionCount || 0)}</td><td>${esc((student.fullscreenExits || 0) + (student.copyPasteAttempts || 0))}</td></tr>`);
      const telemetry = data.telemetry || {};
      show('EXAM ROOM · LIVE DATABASE', room.title || roomId,
        `<div class="detail-grid">${detail('Room ID', roomId)}${detail('Status', room.status)}${detail('Mentor', room.mentorId)}${detail('Created', fmt(room.createdAt))}${detail('Started', fmt(room.startedAt))}${detail('Ended', fmt(room.endedAt))}${detail('Participants', participants.length)}${detail('Stored submissions', telemetry.submissionCount || 0)}${detail('Proctoring flags', telemetry.flaggedParticipants || 0)}</div>` +
        section('Participants and proctoring', table(['Student', 'Identity', 'Status', 'Finished', 'Submissions', 'Flags'], participantRows)) +
        section('Student code and query submissions', table(['Student', 'Question', 'Type', 'Language', 'Submitted', 'Payload'], submissionRows(participants))) +
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
      const participantRows = participants.map(([peerId, participant]) => `<tr><td class="mono">${esc(peerId)}</td><td>${esc(participant.name)}</td><td>${esc(participant.accountId || 'anonymous')}</td><td>${fmt(participant.joinedAt)}</td><td>${fmt(participant.lastSeenAt)}</td></tr>`);
      show('MEETING ROOM · LIVE DATABASE', room.roomTitle || roomId,
        `<div class="detail-grid">${detail('Room ID', room.roomId || roomId)}${detail('Host', room.hostName)}${detail('Owner account', room.ownerAccountId)}${detail('State', room.isOpen ? 'Live' : 'Closed')}${detail('Created', fmt(room.createdAt))}${detail('Last active', fmt(room.activeAt))}${detail('Chat messages', (room.chatMessages || []).length)}${detail('Events', (room.participantEvents || []).length)}</div>` +
        section('Participants', table(['Peer', 'Name', 'Account', 'Joined', 'Last seen'], participantRows)) +
        section('Recent activity', table(['Time', 'Type', 'Peer', 'Payload'], (room.participantEvents || []).slice(-50).reverse().map((event) => `<tr><td>${fmt(event.at || event.createdAt)}</td><td>${esc(event.type)}</td><td class="mono">${esc(event.peerId)}</td><td><pre class="inline-json">${esc(JSON.stringify(event.payload || {}, null, 2))}</pre></td></tr>`))) +
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

  setInterval(() => {
    const app = document.getElementById('admin-app');
    if (!app.hidden) document.getElementById('refresh-button').click();
  }, 12000);
})();
