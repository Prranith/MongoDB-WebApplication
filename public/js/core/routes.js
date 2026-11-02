/* Page-wise URLs for the existing feature-complete CodeLeaf shell. */
(function () {
  const PATHS = {
    home: '/', workspace: '/workspaceide', db: '/dbexplorer', history: '/history',
    guide: '/guide', search: '/search', examportal: '/examportal',
    'create-room': '/createRoom', 'create-exam': '/createExam', leaderboard: '/liveLeaderBoard',
    'join-exam': '/joinexam', 'exam-paper': '/exampaper', 'offline-viewer': '/offlineViewer',
    meeting: '/meeting', 'create-meeting': '/createMeet', 'join-meeting': '/joinmeet'
  };

  function navigate(name, replace) {
    const path = PATHS[name] || name || '/';
    if (window.location.pathname !== path) {
      window.history[replace ? 'replaceState' : 'pushState']({ codeleafRoute: path }, '', path);
    }
  }

  function setPanel(name) {
    if (typeof showView === 'function') showView(name === 'home' ? 'intro' : 'ide');
    if (name !== 'home' && typeof setSidePanel === 'function') setSidePanel(name === 'workspace' ? 'files' : name);
  }

  function bootRoute() {
    const route = window.__CODELEAF_ROUTE || { initial: 'home' };
    switch (route.initial) {
      case 'home': return setPanel('home');
      case 'workspace': return setPanel('workspace');
      case 'db': return setPanel('db');
      case 'history': return setPanel('history');
      case 'guide': return setPanel('snippets');
      case 'search': return setPanel('search');
      case 'examportal': return window.ExamPortal?.showRoleSelection?.();
      case 'create-room': return window.ExamPortal?.selectRole?.('mentor');
      case 'create-exam': window.ExamPortal?.selectRole?.('mentor'); return navigate('create-exam', true);
      case 'join-exam': return window.ExamPortal?.selectRole?.('student');
      case 'exam-paper': window.ExamPortal?.selectRole?.('student'); return navigate('exam-paper', true);
      case 'offline-viewer':
        window.ExamPortal?.showRoleSelection?.();
        return document.getElementById('file-import-session')?.click();
      case 'leaderboard': window.ExamPortal?.showRoleSelection?.(); return navigate('leaderboard', true);
      case 'meeting': return window.MeetingRoom?.toggleMeeting?.();
      case 'create-meeting': window.MeetingRoom?.toggleMeeting?.(); return window.MeetingRoom?.showCreateScreen?.();
      case 'join-meeting':
        window.MeetingRoom?.toggleMeeting?.();
        window.MeetingRoom?.showJoinScreen?.();
        if (window.__CODELEAF_MEETING_ROOM?.meetingId) {
          const input = document.getElementById('meeting-room-id');
          if (input) input.value = window.__CODELEAF_MEETING_ROOM.meetingId.toUpperCase();
        }
        return;
      default: return setPanel('home');
    }
  }

  function installNavigationHooks() {
    const originalShowView = window.showView;
    if (originalShowView && !originalShowView.__codeleafRouted) {
      const wrapped = function (name) {
        const result = originalShowView.apply(this, arguments);
        if (name === 'intro') navigate('home');
        else if (name === 'ide' && !['db', 'history', 'snippets', 'search'].includes(typeof S !== 'undefined' ? S.sidePanel : '')) navigate('workspace');
        return result;
      };
      wrapped.__codeleafRouted = true;
      window.showView = wrapped;
    }
    const originalPanel = window.setSidePanel;
    if (originalPanel && !originalPanel.__codeleafRouted) {
      const wrapped = function (name) {
        const result = originalPanel.apply(this, arguments);
        const route = name === 'files' ? 'workspace' : name === 'snippets' ? 'guide' : name;
        if (PATHS[route]) navigate(route);
        return result;
      };
      wrapped.__codeleafRouted = true;
      window.setSidePanel = wrapped;
    }
    if (window.ExamPortal && !window.ExamPortal.__codeleafRouted) {
      const originalRole = window.ExamPortal.showRoleSelection;
      const originalSelect = window.ExamPortal.selectRole;
      window.ExamPortal.showRoleSelection = function () { navigate('examportal'); return originalRole.apply(this, arguments); };
      window.ExamPortal.selectRole = function (role) { navigate(role === 'mentor' ? 'create-room' : 'join-exam'); return originalSelect.apply(this, arguments); };
      window.ExamPortal.__codeleafRouted = true;
    }
    if (window.MeetingRoom && !window.MeetingRoom.__codeleafRouted) {
      const originalToggle = window.MeetingRoom.toggleMeeting;
      const originalCreate = window.MeetingRoom.showCreateScreen;
      const originalJoin = window.MeetingRoom.showJoinScreen;
      window.MeetingRoom.toggleMeeting = function () { navigate('meeting'); return originalToggle.apply(this, arguments); };
      window.MeetingRoom.showCreateScreen = function () { navigate('create-meeting'); return originalCreate.apply(this, arguments); };
      window.MeetingRoom.showJoinScreen = function () { navigate('join-meeting'); return originalJoin.apply(this, arguments); };
      window.MeetingRoom.__codeleafRouted = true;
    }
  }

  window.CodeLeafRouter = { navigate, bootRoute };
  window.addEventListener('DOMContentLoaded', () => setTimeout(() => { installNavigationHooks(); bootRoute(); }, 0), { once: true });
  window.addEventListener('popstate', () => window.location.reload());
})();
