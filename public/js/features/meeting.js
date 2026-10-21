/*
 * meeting.js
 * Real-time video call, screen sharing, and in-meeting chat
 * using PeerJS (WebRTC P2P) + lightweight REST room management.
 *
 * Designed as an IDE collaboration dock — dark-mode, glassmorphism controls,
 * emerald-green active indicators, and a presentation mode layout.
 */

const MeetingRoom = (() => {
  "use strict";

  // ─── State ────────────────────────────────────────────────────────────
  const state = {
    roomId: "",
  roomTitle: "CodeLeaf Meeting",
    peerId: "",
    peer: null,
  userName: "CodeLeaf User",
    localStream: null,       // camera+audio
    screenStream: null,      // screen share
    screenCalls: {},         // peerId -> dedicated screen-share MediaConnection (no-camera fallback)
    isMicOn: true,
    isCamOn: true,
    isScreenSharing: false,
    isEditorSharing: false,
    editorPeerId: "",
    editorSyncTimer: null,
    editorSyncHandlers: [],
    editorSendTimer: null,
    editorSnapshotSignature: "",
    editorShareSeq: 0,
    editorFollowMuted: false,
    editorScreenStream: null, // dedicated capture of the sharer's CodeLeaf tab
    editorScreenCalls: {},     // peerId -> editor presentation MediaConnection
    screenPeerId: "",          // peerId whose stream is in the screen stage
    isConnected: false,
    participants: {},        // peerId -> { name, stream, dataConnection }
    dataConnections: {},     // peerId -> PeerJS data connection (independent of video)
    editorConnections: {},   // peerId -> dedicated reliable editor channel
    callActive: false,
    chatOpen: false,
    chatTargetPeerId: "",
    chatTargetName: "Everyone",
    participantSearch: "",
    participantsOpen: false,
    handRaised: false,
    spotlightId: null,     // "self" | peerId | null — user pinned as MY main stage
    localTileMoved: false, // true if the last PiP gesture was a drag
    layoutMode: "gallery",
    meetingMinimized: false,
    localViewHidden: false,
    joining: false,        // true while a join/create call is starting
    isHost: false,
    _prevPeers: 0,
    hostToken: "",
  };

  // ─── DOM refs ──────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const els = {
    joinBtn:      $("btn-join-meeting"),
    modal:        $("meeting-modal"),
    choiceScreen: $("meeting-screen-choice"),
    createScreen: $("meeting-screen-create"),
    joinScreen:   $("meeting-screen-join"),
    createNameInput: $("meeting-create-name"),
    createTitleInput: $("meeting-create-title"),
    createRoomInput: $("meeting-create-room"),
    container:    $("meeting-container"),
    videoArea:    $("meeting-video-area"),
    localTile:    $("meeting-local-video"),
    localVideo:   $("local-video-el"),
    localInitials:$("local-initials"),
    localInitialsText: $("local-initials-text"),
    localUserLabel: $("local-user-label"),
    remoteGrid:   $("meeting-remote-grid"),
    roomLabel:    $("meeting-room-label"),
    roomTitle:    $("meeting-room-title"),
    participantCount: $("meeting-participant-count"),
    micBtn:       $("meeting-mic-btn"),
    camBtn:       $("meeting-cam-btn"),
    shareBtn:     $("meeting-share-btn"),
    editorShareBtn: $("meeting-editor-share-btn"),
    chatBtn:      $("meeting-chat-btn"),
    endBtn:       $("meeting-end-btn"),
    chatDrawer:   $("meeting-chat-drawer"),
    chatMessages:$("meeting-chat-messages"),
    chatInput:    $("meeting-chat-input"),
    userNameInput:$("meeting-user-name"),
    roomIdInput:  $("meeting-room-id"),
    statusMsg:    $("meeting-status-msg"),
    topbar:       document.querySelector(".meeting-topbar"),
    handBtn:      $("meeting-hand-btn"),
    moreBtn:      $("meeting-more-btn"),
    moreMenu:     $("meeting-more-menu"),
    leaveMenu:    $("meeting-leave-menu"),
    participantsBtn: $("meeting-participants-btn"),
    participantsPanel: $("meeting-participants-panel"),
    participantList: $("meeting-participant-list"),
    panelSectionTitle: $("meeting-panel-section-title"),
    inviteInput:  $("meeting-invite-input"),
    participantSearch: $("meeting-participant-search"),
    chatRecipient: $("meeting-chat-recipient"),
    timerEl:      $("meeting-timer"),
    localHandBadge: $("local-hand-badge"),
    localTileMic: $("local-tile-mic"),
    screenStage: $("meeting-screen-stage"),
    screenVideo: $("meeting-screen-video"),
    screenLabel: $("meeting-screen-label"),
    editorStage: $("meeting-editor-stage"),
    editorShareTitle: $("meeting-editor-share-title"),
    editorShareMeta: $("meeting-editor-share-meta"),
    editorShareTabs: $("meeting-editor-share-tabs"),
    editorShareCode: $("meeting-editor-share-code"),
    editorShareStatus: $("meeting-editor-share-status"),
    editorFollowBanner: $("meeting-editor-follow-banner"),
    editorFollowLabel: $("meeting-editor-follow-label"),
    editorFollowFile: $("meeting-editor-follow-file"),
    editorFollowAction: $("meeting-editor-follow-action"),
    fullscreenBtn: $("meeting-fullscreen-btn"),
    endHostItem: $("meeting-end-host-item"),
    exitScreen: $("meeting-exit-screen"),
    exitTitle: $("meeting-exit-title"),
    exitMessage: $("meeting-exit-message"),
    exitReturnBtn: $("meeting-exit-return-btn"),
    othersOverlay: $("meeting-others-overlay"),
    othersGrid: $("meeting-others-grid"),
    othersTitle: $("meeting-others-title"),
    othersPageEl: $("meeting-others-page"),
    othersPrev: $("meeting-others-prev"),
    othersNext: $("meeting-others-next"),
    createSubmit: $("meeting-create-submit"),
    joinSubmit:   $("meeting-join-submit"),
  };

  // ─── Helpers ───────────────────────────────────────────────────────────
  function initials(name) {
    if (!name) return "?";
    const parts = name.trim().split(/[\s_-]+/).filter(Boolean);
    if (parts.length === 0) return "?";
    if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  }

  // Status message lives inside whichever form screen is currently visible
  function statusEl() {
    const screens = [els.createScreen, els.joinScreen];
    for (const s of screens) {
      if (s && s.style.display !== "none") {
        return s.querySelector(".meeting-status-msg");
      }
    }
    return els.statusMsg;
  }

  function showStatus(msg, type) {
    const el = statusEl();
    if (!el) return;
    el.textContent = msg;
    el.className = "meeting-status-msg " + (type || "");
    el.style.display = "block";
  }

  function hideStatus() {
    const el = statusEl();
    if (!el) return;
    el.style.display = "none";
  }

  // Single-slot toast queue: notifications play one at a time in one compact
  // pill instead of stacking into a ladder of toasts.
  const toastQueue = [];
  let toastTimer = null;
  let toastEl = null;

  function ensureToastEl() {
    const container = document.getElementById("toast-container");
    if (!container) return null;
    if (!toastEl || !toastEl.isConnected) {
      toastEl = document.createElement("div");
      toastEl.className = "toast";
      container.appendChild(toastEl);
    }
    return toastEl;
  }

  function pumpToast() {
    const item = toastQueue.shift();
    const el = ensureToastEl();
    if (!item || !el) {
      toastTimer = null;
      return;
    }
    el.className = "toast toast-in" + (item.type ? " " + item.type : "");
    el.textContent = item.msg;
    // Exactly 2 seconds on screen: 1700ms visible + 300ms fade-out
    toastTimer = setTimeout(() => {
      el.classList.add("toast-out");
      toastTimer = setTimeout(() => {
        el.classList.remove("toast-in");
        el.textContent = "";
        if (toastQueue.length > 0) {
          pumpToast(); // re-triggers toast-in via className reset
        } else {
          toastTimer = null; // stays hidden (toast-out) until the next toast
        }
      }, 300);
    }, 1700);
  }

  function toast(msg, type) {
    toastQueue.push({ msg: msg, type: type || "" });
    if (toastTimer === null) pumpToast();
  }

  function updateLocalInitials() {
    const name = state.userName || "You";
    els.localInitialsText.textContent = initials(name);
    els.localUserLabel.textContent = name;
  }

  function updateParticipantCount() {
    const peers = Object.keys(state.participants).length;
    const total = peers + 1; // include self
    if (els.participantCount) {
      els.participantCount.textContent =
        total === 1 ? "1 participant" : total + " participants";
    }

    // Solo mode: self-view is the main stage (full video). Multi mode: gallery.
    if (els.videoArea) {
      els.videoArea.classList.toggle("meeting-solo", peers === 0);
    }

    // Spotlight behavior:
    // - A screen share is active → the shared screen owns the stage.
    // - Alone → the solo CSS fills the area with the self-view (no spotlight).
    // - If the spotlighted user left the call → back to the gallery grid.
    const prevPeers = state._prevPeers || 0;
    state._prevPeers = peers;
    if (state.screenPeerId) {
      clearSpotlight();
    } else if (peers === 0) {
      clearSpotlight();
    } else if (state.spotlightId && state.spotlightId !== "self" && !state.participants[state.spotlightId]) {
      clearSpotlight();
    }

    renderGrid();
    renderParticipants();
    if (othersOpen) renderOthersOverlay();
  }

  function copyTextToClipboard(text) {
    const fallback = () => {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      let copied = false;
      try { copied = document.execCommand("copy"); } catch (_) {}
      area.remove();
      return copied;
    };
    const modern = navigator.clipboard && typeof navigator.clipboard.writeText === "function"
      ? navigator.clipboard.writeText(text).then(() => true).catch(() => false)
      : Promise.resolve(false);
    return modern.then((copied) => copied || fallback());
  }

  function copyRoomId() {
    if (!state.roomId) return;
    const text = state.roomId;
    copyTextToClipboard(text).then((ok) => {
      toast(ok ? "Room ID copied to clipboard: " + text : "Room ID: " + text, ok ? "success" : "error");
    });
  }

  function copyRoomLink() {
    if (!state.roomId) return;
    const link = window.location.origin + window.location.pathname + "?room=" + encodeURIComponent(state.roomId);
    copyTextToClipboard(link).then((ok) => {
      toast(ok ? "Invite link copied to clipboard" : "Invite link: " + link, ok ? "success" : "error");
    });
  }

  // ─── Controls ──────────────────────────────────────────────────────────
  function updateControlUI() {
    // Mic / camera off → strike-through slash over the icon (Teams style)
    if (els.micBtn) els.micBtn.classList.toggle("off", !state.isMicOn);
    if (els.camBtn) els.camBtn.classList.toggle("off", !state.isCamOn);
    if (els.shareBtn) els.shareBtn.classList.toggle("active", state.isScreenSharing);
    if (els.editorShareBtn) els.editorShareBtn.classList.toggle("active", state.isEditorSharing);
    if (els.chatBtn) els.chatBtn.classList.toggle("active", state.chatOpen);
    if (els.participantsBtn) els.participantsBtn.classList.toggle("active", state.participantsOpen);
    if (els.handBtn) els.handBtn.classList.toggle("hand-up", state.handRaised);
    if (els.endHostItem) els.endHostItem.style.display = state.isHost ? "flex" : "none";
    // Update activity bar button state
    const actBtn = els.joinBtn;
    if (actBtn) actBtn.classList.toggle("active", state.callActive);
  }

  // Freeze the Join / Create buttons while a call is starting so rapid
  // clicks cannot spawn duplicate calls.
  function setJoining(v) {
    state.joining = v;
    [els.createSubmit, els.joinSubmit].forEach((btn) => {
      if (!btn) return;
      btn.disabled = v;
      btn.textContent = v
        ? (btn === els.createSubmit ? "Creating..." : "Joining...")
        : (btn === els.createSubmit ? "Create & Start Meeting" : "Join Meeting");
    });
  }

  // ─── Toast / leave cleanup on tab close ──────────────────────────────
  function notifyMeetingLeave() {
    if (!state.callActive || !state.roomId || leaveNotificationSent) return;
    leaveNotificationSent = true;
    const payload = JSON.stringify({ roomId: state.roomId, peerId: state.peerId });
    let sent = false;
    if (navigator.sendBeacon) {
      try {
        sent = navigator.sendBeacon(
          "/api/meeting/leave",
          new Blob([payload], { type: "application/json" })
        );
      } catch (_) {}
    }
    if (!sent) {
      fetch("/api/meeting/leave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true,
      }).catch(() => {});
    }
  }

  // ─── CodeLeaf editor sharing ──────────────────────────────────────────
  // Editor sharing is intentionally data-channel based. It shares only the
  // active CodeLeaf editor state; it never requests browser display capture.
  function editorHash(value) {
    let hash = 2166136261;
    const text = String(value || "");
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function getEditorSnapshot() {
    let content = "";
    try {
      if (typeof editor !== "undefined" && editor && typeof editor.getValue === "function") {
        content = editor.getValue();
      } else {
        const textarea = document.getElementById("raw-editor");
        content = textarea ? textarea.value : "";
      }
    } catch (_) {}

    let activePath = "Untitled";
    let tabs = [];
    try {
      if (typeof S !== "undefined" && S) {
        activePath = S.activeFile || activePath;
        tabs = Array.isArray(S.tabs) ? S.tabs.slice(0, 40) : [];
      }
    } catch (_) {}

    const language = typeof getWorkspaceLanguage === "function" ? getWorkspaceLanguage() : "mongodb";
    let cursor = { line: 0, ch: 0 };
    let scroll = { top: 0, left: 0 };
    try {
      if (typeof editor !== "undefined" && editor) {
        if (typeof editor.getCursor === "function") cursor = editor.getCursor();
        if (typeof editor.getScrollInfo === "function") {
          const info = editor.getScrollInfo();
          scroll = { top: Math.max(0, info.top || 0), left: Math.max(0, info.left || 0) };
        }
      }
    } catch (_) {}
    const maxChars = 500000;
    const truncated = content.length > maxChars;
    content = content.slice(0, maxChars);
    return {
      type: "editor-snapshot",
      version: 1,
      seq: ++state.editorShareSeq,
      senderPeerId: state.peerId,
      senderName: state.userName,
      fileName: String(activePath).split("/").pop() || "Untitled",
      path: activePath,
      language,
      tabs,
      content,
      truncated,
      lineCount: content ? content.split("\n").length : 1,
      cursor,
      scroll,
    };
  }

  function editorConnectionIsOpen(connection) {
    return !!(connection && connection.open && !connection.closed);
  }

  function sendEditorMessage(payload, targetPeerId) {
    const connections = targetPeerId
      ? [state.editorConnections[targetPeerId]]
      : Object.values(state.editorConnections);
    connections.forEach((connection) => {
      if (editorConnectionIsOpen(connection)) {
        try { connection.send(payload); } catch (_) {}
      }
    });
  }

  function handleEditorMessage(peerId, connection, data) {
    if (!data || typeof data !== "object") return;
    const participant = state.participants[peerId] || (state.participants[peerId] = { name: "Peer" });
    if (data.type === "editor-share-toggle") {
      participant.isEditor = !!data.sharing;
      if (data.name) participant.name = data.name;
      if (data.sharing) {
        state.editorFollowMuted = false;
        document.body.classList.add("meeting-editor-following");
        setEditorFollowBanner(false, true);
        try { if (editorConnectionIsOpen(connection)) connection.send({ type: "editor-share-request" }); } catch (_) {}
      } else if (state.editorPeerId === peerId) {
        state.editorPeerId = "";
        clearEditorShareStage();
        stopEditorFollow();
        document.body.classList.remove("meeting-editor-following");
      }
    } else if (data.type === "editor-share-request") {
      // Editor mode now shares the real CodeLeaf tab as a media stream. Keep
      // this message type reserved for compatibility with older clients.
    }
  }

  function handleEditorDataConnection(connection) {
    const peerId = connection.peer;
    const register = () => {
      state.editorConnections[peerId] = connection;
      if (!state.participants[peerId]) state.participants[peerId] = { name: "Peer" };
      if (state.isEditorSharing && editorConnectionIsOpen(connection)) {
        try {
          connection.send({ type: "editor-share-toggle", sharing: true, name: state.userName });
        } catch (_) {}
        openEditorScreenCall(peerId);
      }
    };
    connection.on("open", register);
    connection.on("data", (data) => handleEditorMessage(peerId, connection, data));
    connection.on("close", () => {
      if (state.editorConnections[peerId] === connection) delete state.editorConnections[peerId];
    });
    connection.on("error", () => {
      if (state.editorConnections[peerId] === connection) delete state.editorConnections[peerId];
    });
    if (connection.open) register();
  }

  function connectEditorPeer(peerId) {
    if (!state.peer || !peerId || peerId === state.peerId) return;
    const existing = state.editorConnections[peerId];
    if (existing && !existing.closed) return;
    try {
      const connection = state.peer.connect(peerId, {
        reliable: true,
        serialization: "json",
        metadata: { kind: "codexa-editor", version: 1 },
      });
      if (connection) handleEditorDataConnection(connection);
    } catch (_) {}
  }

  function connectEditorPeers() {
    if (!state.peer || !state.roomId) return;
    fetch("/api/meeting/peers?roomId=" + encodeURIComponent(state.roomId) + "&peerId=" + encodeURIComponent(state.peerId))
      .then((response) => response.json())
      .then((data) => {
        (data && Array.isArray(data.peerIds) ? data.peerIds : []).forEach((peerId) => {
          if (peerId && peerId !== state.peerId) connectEditorPeer(peerId);
        });
      })
      .catch(() => {});
  }

  function sendEditorSnapshot(targetPeerId, force) {
    if (!state.isEditorSharing || !state.peer) return;
    const snapshot = getEditorSnapshot();
    const signature = [
      snapshot.path,
      snapshot.language,
      snapshot.content.length,
      editorHash(snapshot.content),
      snapshot.cursor && snapshot.cursor.line,
      snapshot.cursor && snapshot.cursor.ch,
      snapshot.scroll && snapshot.scroll.top,
      snapshot.scroll && snapshot.scroll.left,
    ].join("|");
    if (!force && signature === state.editorSnapshotSignature) return;
    state.editorSnapshotSignature = signature;

    const payload = Object.assign({}, snapshot, { from: state.userName });
    const connections = targetPeerId
      ? [state.editorConnections[targetPeerId] || state.dataConnections[targetPeerId] || (state.participants[targetPeerId] && state.participants[targetPeerId].dataConnection)]
      : Object.values(state.editorConnections).concat(Object.values(state.dataConnections));
    connections.forEach((conn) => {
      if (conn && conn.open) {
        try { conn.send(payload); } catch (_) {}
      }
    });
    renderEditorShare(snapshot, state.userName, true);
  }

  function startEditorSync() {
    if (state.editorSyncTimer) clearInterval(state.editorSyncTimer);
    state.editorSyncHandlers.forEach(({ target, event, handler }) => {
      try { target.off(event, handler); } catch (_) {}
    });
    state.editorSyncHandlers = [];

    const queue = () => {
      if (state.editorSendTimer) return;
      state.editorSendTimer = setTimeout(() => {
        state.editorSendTimer = null;
        sendEditorSnapshot();
      }, 70);
    };
    try {
      if (typeof editor !== "undefined" && editor && typeof editor.on === "function") {
        ["change", "cursorActivity", "scroll"].forEach((event) => {
          editor.on(event, queue);
          state.editorSyncHandlers.push({ target: editor, event, handler: queue });
        });
      }
    } catch (_) {}
    state.editorSyncTimer = setInterval(() => {
      if (!state.callActive || !state.isEditorSharing) return;
      sendEditorSnapshot();
    }, 350);
    sendEditorSnapshot(null, true);
  }

  function stopEditorSync() {
    if (state.editorSyncTimer) clearInterval(state.editorSyncTimer);
    state.editorSyncTimer = null;
    if (state.editorSendTimer) clearTimeout(state.editorSendTimer);
    state.editorSendTimer = null;
    state.editorSyncHandlers.forEach(({ target, event, handler }) => {
      try { target.off(event, handler); } catch (_) {}
    });
    state.editorSyncHandlers = [];
    state.editorSnapshotSignature = "";
  }

  function escapeEditorHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderEditorShare(snapshot, name, local) {
    if (!snapshot || !els.editorStage) return;
    if (els.editorShareTitle) {
      els.editorShareTitle.textContent = local
        ? "You're sharing the CodeLeaf editor"
        : (name || "Participant") + " is sharing the CodeLeaf editor";
    }
    if (els.editorShareMeta) {
      const path = snapshot.path || snapshot.fileName || "Untitled";
      const suffix = snapshot.truncated ? " · preview truncated for performance" : "";
      els.editorShareMeta.textContent =
        path + " · " + (snapshot.language || "text") + " · " +
        (snapshot.lineCount || 1) + " lines" + suffix;
    }
    if (els.editorShareTabs) {
      els.editorShareTabs.innerHTML = "";
      (snapshot.tabs || []).forEach((tab) => {
        const item = document.createElement("span");
        item.className = "meeting-editor-share-tab";
        item.textContent = String(tab).split("/").pop() || tab;
        if (tab === snapshot.path) item.classList.add("active");
        els.editorShareTabs.appendChild(item);
      });
    }
    if (els.editorShareCode) {
      const lines = String(snapshot.content || "").split("\n");
      const maxVisibleLines = 12000;
      const visibleLines = lines.slice(0, maxVisibleLines);
      const cursorLine = Number(snapshot.cursor && snapshot.cursor.line);
      els.editorShareCode.innerHTML = visibleLines.map((line, index) => {
        const active = Number.isFinite(cursorLine) && index === cursorLine ? " active" : "";
        return `<span class="meeting-editor-share-line${active}" data-line="${index + 1}">${escapeEditorHtml(line) || " "}</span>`;
      }).join("");
      if (lines.length > maxVisibleLines) {
        const omitted = lines.length - maxVisibleLines;
        els.editorShareCode.insertAdjacentHTML(
          "beforeend",
          `<span class="meeting-editor-share-line meeting-editor-share-omitted" data-line="…">… ${omitted} more lines omitted</span>`,
        );
      }
      requestAnimationFrame(() => {
        if (!els.editorShareCode || !snapshot.scroll) return;
        els.editorShareCode.scrollTop = Math.max(0, Number(snapshot.scroll.top) || 0);
        els.editorShareCode.scrollLeft = Math.max(0, Number(snapshot.scroll.left) || 0);
      });
    }
    if (els.editorShareStatus) {
      els.editorShareStatus.textContent = local
        ? "LIVE · viewers are read-only"
        : "LIVE · read-only synchronized view";
    }
    els.editorStage.style.display = "flex";
    els.container.classList.add("editor-share-active");
  }

  function clearEditorShareStage() {
    if (els.editorStage) els.editorStage.style.display = "none";
    if (els.editorShareCode) els.editorShareCode.textContent = "";
    if (els.editorShareTabs) els.editorShareTabs.innerHTML = "";
    els.container.classList.remove("editor-share-active");
  }

  function sharedLanguageMode(language) {
    return ({
      mongodb: "javascript",
      python: "python",
      cpp: "text/x-c++src",
      c: "text/x-c++src",
      java: "text/x-java",
      sql: "text/x-sql",
    })[language] || "javascript";
  }

  function captureEditorFollowBackup() {
    if (state.editorFollowBackup || typeof editor === "undefined" || !editor) return;
    let cursor = { line: 0, ch: 0 };
    let scroll = { top: 0, left: 0 };
    try {
      cursor = editor.getCursor();
      const info = editor.getScrollInfo();
      scroll = { top: info.top || 0, left: info.left || 0 };
    } catch (_) {}
    state.editorFollowBackup = {
      content: editor.getValue(),
      mode: editor.getOption("mode"),
      readOnly: editor.getOption("readOnly"),
      cursor,
      scroll,
    };
  }

  function setEditorFollowBanner(active, remote, snapshot) {
    if (!els.editorFollowBanner) return;
    els.editorFollowBanner.style.display = active ? "flex" : "none";
    if (!active) return;
    if (els.editorFollowLabel) {
      els.editorFollowLabel.textContent = remote
        ? "Following " + (snapshot && snapshot.senderName ? snapshot.senderName : "shared CodeLeaf workspace")
        : "Sharing your CodeLeaf workspace with participants";
    }
    if (els.editorFollowFile) {
      els.editorFollowFile.textContent = snapshot && (snapshot.path || snapshot.fileName)
        ? " · " + (snapshot.path || snapshot.fileName)
        : "";
    }
    if (els.editorFollowAction) {
      els.editorFollowAction.textContent = remote ? "Return to my workspace" : "Back to meeting";
      els.editorFollowAction.onclick = remote ? stopEditorFollow : toggleEditorShare;
    }
  }

  function enterEditorWorkspace(snapshot, remote) {
    captureEditorFollowBackup();
    state.editorFollowing = !!remote;
    if (typeof window.showView === "function") window.showView("ide");
    document.body.classList.add("meeting-editor-following");
    if (els.container) {
      state.editorMeetingDisplay = els.container.style.display || "flex";
      els.container.style.display = "none";
    }
    setEditorFollowBanner(true, remote, snapshot);

    if (!remote || !snapshot || typeof editor === "undefined" || !editor) return;
    try {
      window.__codexaEditorShareApplying = true;
      editor.setOption("mode", sharedLanguageMode(snapshot.language));
      editor.setOption("readOnly", true);
      editor.setValue(snapshot.content || "");
      if (snapshot.cursor) editor.setCursor(snapshot.cursor);
      editor.scrollTo(
        snapshot.scroll ? Number(snapshot.scroll.left) || 0 : 0,
        snapshot.scroll ? Number(snapshot.scroll.top) || 0 : 0,
      );
      editor.refresh();
    } catch (_) {
      // The meeting must remain usable even if an editor mode is unavailable.
    } finally {
      window.__codexaEditorShareApplying = false;
    }
  }

  function stopEditorFollow() {
    if (!state.editorFollowBackup && !state.editorFollowing) return;
    const wasRemoteFollow = !!state.editorFollowing;
    if (state.editorFollowing && typeof editor !== "undefined" && editor && state.editorFollowBackup) {
      try {
        window.__codexaEditorShareApplying = true;
        editor.setOption("mode", state.editorFollowBackup.mode);
        editor.setOption("readOnly", state.editorFollowBackup.readOnly);
        editor.setValue(state.editorFollowBackup.content);
        editor.setCursor(state.editorFollowBackup.cursor);
        editor.scrollTo(
          state.editorFollowBackup.scroll.left || 0,
          state.editorFollowBackup.scroll.top || 0,
        );
        editor.refresh();
      } catch (_) {
      } finally {
        window.__codexaEditorShareApplying = false;
      }
    }
    state.editorFollowBackup = null;
    state.editorFollowing = false;
    state.editorFollowMuted = wasRemoteFollow;
    document.body.classList.remove("meeting-editor-following");
    setEditorFollowBanner(false, false);
    if (els.container && state.callActive) {
      els.container.style.display = state.editorMeetingDisplay || "flex";
    }
    state.editorMeetingDisplay = "";
  }

  function showRemoteEditorShare(peerId, snapshot) {
    // A snapshot can arrive before the media/participant metadata. Keep the
    // editor channel independent from video so viewers still get the shared
    // workspace even when camera negotiation is delayed or unavailable.
    const participant = state.participants[peerId] || (state.participants[peerId] = { name: "Peer" });
    if (state.editorFollowMuted) return;
    participant.editorSnapshot = snapshot;
    participant.isEditor = true;
    state.editorPeerId = peerId;
    clearSpotlight();
    enterEditorWorkspace(snapshot, true);
  }

  function openEditorScreenCall(targetPeerId) {
    if (!state.peer || !targetPeerId || !state.editorScreenStream) return;
    if (state.editorScreenCalls[targetPeerId]) return;
    try {
      const call = state.peer.call(targetPeerId, state.editorScreenStream, {
        metadata: { kind: "editor-screen", name: state.userName },
      });
      if (!call) return;
      state.editorScreenCalls[targetPeerId] = call;
      boostCallBitrates(call, 5000000);
      call.on("close", () => {
        if (state.editorScreenCalls[targetPeerId] === call) delete state.editorScreenCalls[targetPeerId];
      });
      call.on("error", (err) => {
        console.warn("[Meeting] Editor screen call error from", targetPeerId, err);
        if (state.editorScreenCalls[targetPeerId] === call) delete state.editorScreenCalls[targetPeerId];
      });
    } catch (err) {
      console.warn("[Meeting] Could not open editor screen call", targetPeerId, err);
    }
  }

  function stopEditorScreenShare() {
    if (state.editorScreenStream) {
      state.editorScreenStream.getTracks().forEach((track) => track.stop());
      state.editorScreenStream = null;
    }
    Object.values(state.editorScreenCalls).forEach((call) => {
      try { call.close(); } catch (_) {}
    });
    state.editorScreenCalls = {};
    clearScreenStage();
    document.body.classList.remove("meeting-editor-following");
    setEditorFollowBanner(false, false);
  }

  function stopEditorShare() {
    if (!state.isEditorSharing) return;
    state.isEditorSharing = false;
    state.editorPeerId = "";
    stopEditorSync();
    sendEditorMessage({
      type: "editor-share-toggle",
      sharing: false,
      name: state.userName,
    });
    stopEditorScreenShare();
    clearEditorShareStage();
    stopEditorFollow();
    state.editorFollowMuted = false;
    updateControlUI();
    toast("Editor sharing stopped", "success");
  }

  async function toggleEditorShare() {
    if (!state.callActive || !state.peer) {
      toast("Join the meeting before sharing the editor.", "error");
      return;
    }
    if (state.isEditorSharing) {
      stopEditorShare();
      return;
    }
    if (state.isScreenSharing) stopScreenShare();
    try {
      toast("Choose this CodeLeaf browser tab in the sharing dialog to share the complete workspace.", "success");
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: "always",
          displaySurface: "browser",
          frameRate: { ideal: 30, max: 30 },
          width: { ideal: 1920, max: 2560 },
          height: { ideal: 1080, max: 1440 },
        },
        audio: true,
      });
      const track = stream.getVideoTracks()[0];
      if (track) track.addEventListener("ended", stopEditorShare);
      state.editorScreenStream = stream;
      state.isEditorSharing = true;
      state.editorFollowMuted = false;
      state.editorPeerId = state.peerId;
      state.editorShareSeq = 0;
      document.body.classList.add("meeting-editor-following");
      if (typeof window.showView === "function") window.showView("ide");
      if (els.container) {
        state.editorMeetingDisplay = els.container.style.display || "flex";
        els.container.style.display = "none";
      }
      setEditorFollowBanner(true, false);
      sendEditorMessage({
        type: "editor-share-toggle",
        sharing: true,
        name: state.userName,
      });
      Object.keys(state.participants).forEach(openEditorScreenCall);
      connectEditorPeers();
      updateControlUI();
      toast("Complete CodeLeaf workspace sharing started", "success");
    } catch (err) {
      if (err && (err.name === "NotAllowedError" || err.name === "PermissionDeniedError")) {
        toast("Workspace sharing was cancelled. Choose the current CodeLeaf tab to continue.", "error");
      } else {
        toast("Workspace sharing failed: " + ((err && err.message) || "browser capture is unavailable"), "error");
      }
      state.isEditorSharing = false;
      state.editorScreenStream = null;
      updateControlUI();
    }
  }

  window.addEventListener("beforeunload", () => {
    notifyMeetingLeave();
    disconnectPeer();
  });
  window.addEventListener("pagehide", notifyMeetingLeave);

  // ─── Overlay / screen navigation (Exam-Portal style) ───────────────────
  function showChoiceScreen() {
    hideStatus();
    if (els.createScreen) els.createScreen.style.display = "none";
    if (els.joinScreen) els.joinScreen.style.display = "none";
    if (els.choiceScreen) els.choiceScreen.style.display = "flex";
  }

  function showCreateScreen() {
    hideStatus();
    if (els.choiceScreen) els.choiceScreen.style.display = "none";
    if (els.joinScreen) els.joinScreen.style.display = "none";
    if (els.createScreen) els.createScreen.style.display = "flex";
    els.createNameInput.value = state.userName || "Developer";
    if (els.createTitleInput) els.createTitleInput.value = "";
    // The room ID is assigned by the server after creation.
    if (els.createRoomInput) els.createRoomInput.value = "";
    if (els.createNameInput) {
      els.createNameInput.focus();
      els.createNameInput.select();
    }
  }

  function showJoinScreen() {
    hideStatus();
    if (els.choiceScreen) els.choiceScreen.style.display = "none";
    if (els.createScreen) els.createScreen.style.display = "none";
    if (els.joinScreen) els.joinScreen.style.display = "flex";
    els.userNameInput.value = state.userName || "Developer";
    // Prefer URL ?room= param (invite link), fall back to localStorage
    const urlRoom = getInviteRoomId();
    if (urlRoom) {
      els.roomIdInput.value = urlRoom.toUpperCase();
    } else if (!els.roomIdInput.value.trim()) {
      const existing = localStorage.getItem("meeting_last_room");
      if (existing) els.roomIdInput.value = existing;
    }
    if (els.userNameInput) {
      els.userNameInput.focus();
      els.userNameInput.select();
    }
  }

  function getInviteRoomId() {
    const params = new URLSearchParams(window.location.search || "");
    const queryRoom = params.get("room");
    if (queryRoom) return queryRoom.trim().toUpperCase();
    // Keep invite links usable if a host copies a hash-style SPA URL.
    const hash = (window.location.hash || "").replace(/^#/, "");
    const hashParams = new URLSearchParams(hash);
    return (hashParams.get("room") || "").trim().toUpperCase();
  }

  function openInviteJoin() {
    const inviteRoom = getInviteRoomId();
    if (!inviteRoom || state.callActive) return;
    if (els.modal) els.modal.classList.add("active");
    showJoinScreen();
    if (els.roomIdInput) {
      els.roomIdInput.value = inviteRoom;
      els.roomIdInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function toggleMeeting() {
    if (state.callActive) {
      endMeeting();
      return;
    }
    if (!els.modal) return;
    const opening = !els.modal.classList.contains("active");
    els.modal.classList.toggle("active", opening);
    if (opening) showChoiceScreen();
  }

  function closeMeeting() {
    if (els.modal) els.modal.classList.remove("active");
    hideStatus();
  }

  window.MeetingRoom = {
    toggleMeeting,
    closeMeeting,
    showChoiceScreen,
    showCreateScreen,
    showJoinScreen,
    stopEditorFollow,
    toggleEditorShare,
    copyRoomId,
    copyRoomLink,
    clearChatTarget,
    openParticipantChat,
    toggleHand,
    sendReaction,
    openOthers,
    closeOthers,
    othersPage,
    toggleFullscreen,
    exitSpotlight,
    toggleParticipants,
    toggleMoreMenu,
    toggleLeaveMenu,
  };

  function generateRoomIdText() {
    return "MTG-" + Math.random().toString(36).substring(2, 8).toUpperCase();
  }

  function generateRoomId() {
    // Fill whichever room input is currently visible
    const target = els.createScreen && els.createScreen.style.display !== "none"
      ? els.createRoomInput
      : els.roomIdInput;
    if (!target) return;
    target.value = generateRoomIdText();
    target.focus();
    target.select();
  }

  window.MeetingRoom.generateRoomId = generateRoomId;

  // ─── Create flow ───────────────────────────────────────────────────────
  async function createMeeting() {
    if (state.joining) return;
    const name = (els.createNameInput.value || "").trim() || "Developer";
    const roomTitle = (els.createTitleInput && els.createTitleInput.value || "").trim() || "CodeLeaf Meeting";
    state.userName = name;
    state.roomTitle = roomTitle;
    state.hostToken = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : "host-" + Math.random().toString(36).slice(2) + Date.now().toString(36);

    showStatus("Creating room...", "success");
    setJoining(true);
    try {
      const res = await fetch("/api/meeting/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostName: name, roomTitle: roomTitle, hostToken: state.hostToken }),
      });
      const data = await res.json();
      if (data.status !== "ok") {
        showStatus("Failed to create room: " + (data.error || "unknown"), "error");
        setJoining(false);
        return;
      }
      const roomId = data.roomId;
      state.roomTitle = data.roomTitle || roomTitle;
      els.createRoomInput.value = roomId;
      localStorage.setItem("meeting_host_token_" + roomId, state.hostToken);
      localStorage.setItem("meeting_host_name_" + roomId, name);
      localStorage.setItem("meeting_last_room", roomId);
      hideStatus();
      await startCall(roomId, name, state.hostToken);
    } catch (err) {
      showStatus("Network error creating room.", "error");
      setJoining(false);
    }
  }

  window.MeetingRoom.createMeeting = createMeeting;

  // ─── Join flow ─────────────────────────────────────────────────────────
  async function joinMeeting() {
    if (state.joining) return;
    const name = els.userNameInput.value.trim() || "Developer";
    const roomId = els.roomIdInput.value.trim().toUpperCase();

    if (!name) {
      showStatus("Please enter your name.", "error");
      els.userNameInput.focus();
      return;
    }
    if (!roomId) {
      showStatus("Please enter the Room ID shared by the host.", "error");
      els.roomIdInput.focus();
      return;
    }

    state.userName = name;
    const savedHostName = localStorage.getItem("meeting_host_name_" + roomId) || "";
    // A host token is a creator-reclaim credential, not a device credential.
    // Only the creator's matching name may present it; another person using
    // the same browser must join as a normal participant.
    state.hostToken = savedHostName && savedHostName.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase()
      ? localStorage.getItem("meeting_host_token_" + roomId) || ""
      : "";
    localStorage.setItem("meeting_last_room", roomId);
    hideStatus();
    setJoining(true);
    await startCall(roomId, name, state.hostToken);
  }

  window.MeetingRoom.joinMeeting = joinMeeting;

  // ─── PeerJS / WebRTC ───────────────────────────────────────────────────

  // Capture settings tuned for low-latency 720p/1080p conferencing. Asking for
  // 8K/60 caused needless camera negotiation and encoder back-pressure on
  // ordinary devices, which increased delay without improving the tile view.
  const VIDEO_CONSTRAINTS = {
    width: { ideal: 1280, max: 1920 },
    height: { ideal: 720, max: 1080 },
    frameRate: { ideal: 30, max: 30 },
    facingMode: "user",
    advanced: [
      { width: 1920, height: 1080, frameRate: 30 },
      { width: 1280, height: 720, frameRate: 30 },
    ],
  };
  const AUDIO_CONSTRAINTS = {
    channelCount: 1,
    sampleRate: 48000,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };

  function mediaErrorMessage(err, kindLabel) {
    const name = err && err.name;
    if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
      return "Access to " + kindLabel + " was blocked. Click the camera/mic icon in the browser address bar, choose Allow, then try again.";
    }
    if (name === "NotFoundError") {
      return "No " + kindLabel + " was detected on this device. Connect one or check your system privacy settings.";
    }
    if (name === "NotReadableError" || name === "AbortError") {
      return "The " + kindLabel + " is in use by another app. Close apps using it (Zoom, Teams, Camera) and try again.";
    }
    if (name === "OverconstrainedError") {
      return "The " + kindLabel + " doesn't support the requested settings. Try a different device.";
    }
    return "Could not access " + kindLabel + (err && err.message ? ": " + err.message : ".");
  }

  function requestMediaStream(needVideo, needAudio) {
    const constraints = {};
    if (needVideo) constraints.video = VIDEO_CONSTRAINTS;
    if (needAudio) constraints.audio = AUDIO_CONSTRAINTS;
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  // Request media the user is missing and wire it into the live call.
  // Called from the mic/camera buttons, so the browser shows its permission
  // prompt exactly when the user asks for the device (fresh user gesture).
  async function requestMissingMedia(needVideo, needAudio) {
    try {
      const stream = await requestMediaStream(needVideo, needAudio);
      if (!state.localStream) {
        state.localStream = stream;
      } else {
        const wanted = stream.getTracks().filter((t) =>
          (needVideo && t.kind === "video") || (needAudio && t.kind === "audio")
        );
        wanted.forEach((t) => state.localStream.addTrack(t));
        stream.getTracks().forEach((t) => { if (!wanted.includes(t)) t.stop(); });
      }
      // Calls that were set up without this track kind (e.g. joined mic-only)
      // have no sender to replace — reach those peers with a dedicated call
      // carrying the full stream instead.
      const openedCalls = new Set();
      const openDedicatedCall = (pid) => {
        if (pid === state.peerId || openedCalls.has(pid)) return;
        openedCalls.add(pid);
        try {
          const dc = state.peer.call(pid, state.localStream);
          if (dc) boostCallBitrates(dc);
        } catch (_) {}
      };
      if (needVideo) {
        state.isCamOn = true;
        const vTrack = state.localStream.getVideoTracks()[0] || null;
        replaceTrackForPeers("video", vTrack).forEach(openDedicatedCall);
        renderLocalVideo();
      }
      if (needAudio) {
        state.isMicOn = true;
        const aTrack = state.localStream.getAudioTracks()[0] || null;
        replaceTrackForPeers("audio", aTrack).forEach(openDedicatedCall);
      }
      updateControlUI();
      updateMicIndicators();
      renderParticipants();
      return true;
    } catch (err) {
      const label = needVideo && needAudio
        ? "camera and microphone"
        : needVideo ? "camera" : "microphone";
      toast(mediaErrorMessage(err, label), "error");
      return false;
    }
  }

  // Bump encoder bitrate on every sender of a call so remote peers receive
  // high-clarity video (2.5 Mbps) and audio (96 kbps) instead of the WebRTC
  // default, which throttles aggressively on variable networks.
  function boostCallBitrates(call, videoBitrate) {
    try {
      const pc = call.peerConnection;
      if (!pc) return;
      pc.getSenders().forEach((s) => {
        if (!s.track) return;
        const params = s.getParameters();
        if (!params || !params.encodings || !params.encodings.length) return;
        params.encodings = params.encodings.map((e) =>
          Object.assign({}, e, {
            maxBitrate: s.track.kind === "video" ? (videoBitrate || 2800000) : 96000,
            minBitrate: s.track.kind === "video" ? 300000 : 32000,
            maxFramerate: s.track.kind === "video" ? 30 : undefined,
            scalabilityMode: s.track.kind === "video" ? "L1T2" : undefined,
          })
        );
        if (s.track.kind === "video") params.degradationPreference = "maintain-framerate";
        s.setParameters(params).catch(() => {});
      });
    } catch (_) {}
  }

  // Presentation media is intentionally kept on a separate one-way call.
  // This prevents replaceTrack() on the camera call from leaving remote
  // clients attached to a stale/black video element.
  function isScreenStream(stream) {
    const track = stream && stream.getVideoTracks && stream.getVideoTracks()[0];
    if (!track) return false;
    const settings = track.getSettings ? (track.getSettings() || {}) : {};
    const label = String(track.label || "").toLowerCase();
    return settings.displaySurface === "monitor" ||
      settings.displaySurface === "window" ||
      settings.displaySurface === "browser" ||
      label.includes("screen") || label.includes("display") || label.includes("window");
  }

  function openScreenCall(targetPeerId) {
    if (!state.peer || !targetPeerId || !state.screenStream) return;
    if (state.screenCalls[targetPeerId]) return;
    try {
      const call = state.peer.call(targetPeerId, state.screenStream, {
        metadata: { kind: "screen", name: state.userName },
      });
      if (!call) return;
      state.screenCalls[targetPeerId] = call;
      boostCallBitrates(call, 4500000);
      call.on("close", () => {
        if (state.screenCalls[targetPeerId] === call) delete state.screenCalls[targetPeerId];
      });
      call.on("error", (err) => {
        console.warn("[Meeting] Screen call error from", targetPeerId, err);
        if (state.screenCalls[targetPeerId] === call) delete state.screenCalls[targetPeerId];
      });
    } catch (err) {
      console.warn("[Meeting] Could not open screen call", targetPeerId, err);
    }
  }

  async function startCall(roomId, name, hostToken) {
    state.roomId = roomId;
    leaveNotificationSent = false;
    state.peerId = "peer-" + Math.random().toString(36).substring(2, 10);

    // Close any previous call
    disconnectPeer();

    // Get local media. Request camera+mic together first (one permission
    // prompt); if that fails — e.g. the machine has a mic but no camera —
    // retry mic-only, then camera-only, so a single missing/busy device
    // never blocks the whole call.
    let mediaError = null;
    try {
      state.localStream = await requestMediaStream(true, true);
    } catch (err) {
      mediaError = err;
      try {
        state.localStream = await requestMediaStream(false, true);
        state.isCamOn = false;
      } catch (_) {
        try {
          state.localStream = await requestMediaStream(true, false);
          state.isMicOn = false;
        } catch (err3) {
          state.localStream = null;
          state.isCamOn = false;
          state.isMicOn = false;
          mediaError = err3;
        }
      }
    }
    if (state.localStream) {
      if (!state.localStream.getVideoTracks().length) state.isCamOn = false;
      if (!state.localStream.getAudioTracks().length) state.isMicOn = false;
    } else if (mediaError) {
      // Still allow call without media — show initials avatar. The mic /
      // camera buttons re-request permission on click.
      toast(mediaErrorMessage(mediaError, "camera and microphone") + " You can retry from the mic/camera buttons.", "error");
      showStatus("Could not access camera/microphone. You can still join and retry from the controls.", "error");
    }

    // Render local video / initials
    renderLocalVideo();

    // Init PeerJS
    try {
      state.peer = new Peer(state.peerId, {
        debug: 0,
        config: { iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
        ]},
      });
    } catch (err) {
      toast("Failed to initialize PeerJS: " + err.message, "error");
      showStatus("WebRTC initialization failed.", "error");
      setJoining(false);
      return;
    }

    // Safety net: never leave the button frozen if something goes wrong
    setTimeout(() => {
      if (state.joining) setJoining(false);
    }, 20000);

    // Attach local stream to peer so remote peers can call us
    if (state.peer && state.localStream) {
      state.peer._stream = state.localStream;
    }

    state.peer.on("open", (peerId) => {
      state.peerId = peerId;
      state.isConnected = true;
      state.callActive = true;
      document.body.classList.add("meeting-active");
      setJoining(false);

      // Open the meeting UI
      if (els.modal) els.modal.classList.remove("active");
      els.container.style.display = "flex";
      els.roomLabel.textContent = "Room: " + state.roomId;
      if (els.roomTitle) els.roomTitle.textContent = state.roomTitle || "CodeLeaf Meeting";
      updateLocalInitials();
      updateParticipantCount();
      updateControlUI();
      startMeetingTimer();

      // Join room on backend with real peer ID
      fetch("/api/meeting/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomId: state.roomId,
          participantName: state.userName,
          peerId: state.peerId,
          hostToken: hostToken || state.hostToken || "",
        }),
      })
      .then((r) => r.json())
      .then((data) => {
        if (!data || data.status !== "ok") {
          disconnectPeer();
          if (els.modal) els.modal.classList.add("active");
          showJoinScreen();
          showStatus(data && data.error ? data.error : "Meeting room not found.", "error");
          return;
        }
        state.isHost = !!data.isHost;
        state.roomTitle = data.roomTitle || state.roomTitle || "CodeLeaf Meeting";
        if (els.roomTitle) els.roomTitle.textContent = state.roomTitle;
        if (data && data.hostPeerId && data.hostPeerId !== state.peerId) {
          connectToPeer(data.hostPeerId);
        }
        // Start peer discovery polling to find all other participants in the room
        startPeerDiscovery(state.roomId);
        startMeetingStatusPolling(state.roomId);
        updateControlUI();
      })
      .catch(() => {
        disconnectPeer();
        if (els.modal) els.modal.classList.add("active");
        showJoinScreen();
        showStatus("Unable to join this meeting right now.", "error");
      });

      toast("Connected to " + state.roomId, "success");
      addSystemMessage("You joined " + state.roomId);
    });

    state.peer.on("call", (call) => {
      handleIncomingCall(call);
    });

    // Data connections for chat / signaling
    state.peer.on("connection", (conn) => {
      const metadata = conn && (conn.metadata || (conn.options && conn.options.metadata));
      if (metadata && metadata.kind === "codexa-editor") {
        handleEditorDataConnection(conn);
      } else {
        handleDataConnection(conn);
      }
    });

    // If the PeerJS signaling connection drops, reconnect instead of
    // silently losing the ability to discover/join peers.
    state.peer.on("disconnected", () => {
      if (state.callActive && state.peer && !state.peer.destroyed) {
        try {
          state.peer.reconnect();
        } catch (_) {}
      }
    });

    state.peer.on("error", (err) => {
      console.warn("[Meeting] PeerJS error:", err.type, err.message);
      if (err.type === "peer-unavailable") {
        // Only surface this error if we were expecting to connect to a host
        // and haven't already established a call. Transient failures during
        // connectToPeer are handled inline and should not spam the user.
        if (_pendingHostConnect && state.participants[err.message || ""]) {
          toast("Peer unavailable. Share the Room ID and try again.", "error");
        }
      }
    });

    // Heartbeat: re-join on reconnect to keep room alive on the server.
    // This maintains the participant count and _activePeers set on the server.
    if (meetingHeartbeatTimer) clearInterval(meetingHeartbeatTimer);
    meetingHeartbeatTimer = setInterval(() => {
      if (state.callActive && state.roomId && state.peer && !state.peer.destroyed) {
        fetch("/api/meeting/join", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roomId: state.roomId, participantName: state.userName, peerId: state.peerId, hostToken: hostToken || state.hostToken || "" }),
        }).then((r) => r.json()).then((data) => {
          if (data && data.status === "ok") {
            const wasHost = state.isHost;
            state.isHost = !!data.isHost;
            if (wasHost !== state.isHost) {
              updateControlUI();
              renderParticipants();
              toast(state.isHost ? "You are now the meeting host" : "Host role transferred", "success");
            }
          }
        }).catch(() => {});
      }
    }, 15000);
  }

  // ─── Peer Discovery ────────────────────────────────────────────────────
  let peerDiscoveryTimer = null;
  let meetingStatusTimer = null;
  let meetingHeartbeatTimer = null;
  let leaveNotificationSent = false;
  let dragState = null; // active PiP drag session
  const pendingCalls = new Set(); // track peer IDs we're currently connecting to
  let _pendingHostConnect = false; // true while we expect an outgoing call to complete

  function startMeetingStatusPolling(roomId) {
    if (meetingStatusTimer) clearInterval(meetingStatusTimer);
    meetingStatusTimer = setInterval(() => {
      if (!state.callActive) return;
      fetch("/api/meeting/status/" + encodeURIComponent(roomId) + "?peerId=" + encodeURIComponent(state.peerId))
        .then((r) => r.json())
        .then((data) => {
          if (data && data.status === "ok" && data.isOpen === false) {
            handleMeetingEnded(data.endedBy || "the host");
          } else if (data && data.status === "ok") {
            const wasHost = state.isHost;
            state.isHost = !!data.isHost;
            if (wasHost !== state.isHost) {
              updateControlUI();
              renderParticipants();
              toast(state.isHost ? "You are now the meeting host" : "Host role transferred", "success");
            }
          } else if (data && data.status === "error" && /not found/i.test(data.error || "")) {
            handleMeetingEnded("the host");
          }
        })
        .catch(() => {});
    }, 4000);
  }

  function startPeerDiscovery(roomId) {
    if (peerDiscoveryTimer) {
      clearInterval(peerDiscoveryTimer);
    }
    // Poll every 5s to discover new peers who joined the room.
    // The server's _activePeers set is updated on each /join call,
    // so this tells us about peers we haven't connected to yet.
    peerDiscoveryTimer = setInterval(() => {
      if (!state.callActive || !state.roomId || !state.peer || state.peer.destroyed) {
        clearInterval(peerDiscoveryTimer);
        peerDiscoveryTimer = null;
        return;
      }
      fetch("/api/meeting/peers?roomId=" + encodeURIComponent(state.roomId) + "&peerId=" + encodeURIComponent(state.peerId))
        .then((r) => r.json())
        .then((data) => {
          if (!data || data.status !== "ok") return;
          // Connect to any peer IDs we haven't seen yet
          if (data.peerIds && Array.isArray(data.peerIds)) {
            data.peerIds.forEach((pid) => {
              if (state.isEditorSharing && pid && pid !== state.peerId) {
                connectEditorPeer(pid);
              }
              if (pid && pid !== state.peerId && !state.participants[pid]) {
                connectToPeer(pid);
              }
            });
          }
        })
        .catch(() => {});
    }, 5000);
  }

  function connectToPeer(targetPeerId) {
    if (!state.peer || !targetPeerId) return;
    if (state.participants[targetPeerId] && state.participants[targetPeerId].call) return;
    if (pendingCalls.has(targetPeerId)) return; // already connecting to this peer

    // Mark that we are trying to reach this peer so the global error handler
    // can distinguish a transient connectToPeer failure from a real problem.
    _pendingHostConnect = true;
    pendingCalls.add(targetPeerId);

    const stream = state.localStream || new MediaStream();
    const call = state.peer.call(targetPeerId, stream, {
      metadata: { kind: "camera", name: state.userName },
    });
    if (call) {
      boostCallBitrates(call, state.isScreenSharing ? 4000000 : 2500000);
      call.on("stream", (remoteStream) => {
        _pendingHostConnect = false;
        pendingCalls.delete(targetPeerId);
        handleRemoteStream(targetPeerId, remoteStream, call);
      });
      call.on("close", () => {
        _pendingHostConnect = false;
        pendingCalls.delete(targetPeerId);
        removeParticipant(targetPeerId);
      });
      call.on("error", (err) => {
        _pendingHostConnect = false;
        pendingCalls.delete(targetPeerId);
        if (state.participants[targetPeerId]) {
          delete state.participants[targetPeerId];
        }
      });
    }

    const conn = state.peer.connect(targetPeerId);
    if (conn) {
      conn.on("error", (err) => {
        _pendingHostConnect = false;
      });
      handleDataConnection(conn);
      // If we're sharing a screen, tell the new peer about it once the data
      // connection opens — otherwise they receive the screen media but never
      // get the screen-toggle signal that shows it in the stage.
      conn.on("open", () => {
        if (state.isScreenSharing && conn.open) {
          try {
            conn.send({ type: "screen-toggle", sharing: true, name: state.userName });
          } catch (_) {}
          openScreenCall(targetPeerId);
        }
      });
    }
    if (state.isScreenSharing) openScreenCall(targetPeerId);

    // During active screen sharing, also notify the remote peer via the data
    // channel that a screen share is in progress so they can show it immediately
    // without waiting for the stream event.
    if (state.isScreenSharing && state.peer && state.screenStream) {
      try {
        const existingConn = state.peer._connections.get(targetPeerId);
        if (existingConn && existingConn.length) {
          existingConn.forEach((c) => {
            if (c.type === "data" && c.open) {
              try { c.send({ type: "screen-toggle", sharing: true, name: state.userName }); } catch (_) {}
            }
          });
        }
      } catch (_) {}
    }
  }

  function handleIncomingCall(call) {
    const isEditorScreenCall = call.metadata && call.metadata.kind === "editor-screen";
    const isScreenCall = call.metadata && call.metadata.kind === "screen";
    // Answer with local stream if available
    if (isScreenCall || isEditorScreenCall) {
      call.answer(new MediaStream());
    } else if (state.localStream) {
      call.answer(state.localStream);
    } else {
      // Create a dummy stream with no tracks so the call can be established
      const dest = new MediaStream();
      call.answer(dest);
    }
    boostCallBitrates(call);

    call.on("stream", (remoteStream) => {
      if (isEditorScreenCall) {
        const p = state.participants[call.peer] || (state.participants[call.peer] = { name: "Peer" });
        p.editorScreenStream = remoteStream;
        p.editorScreenCall = call;
        p.isEditor = true;
        state.editorPeerId = call.peer;
        document.body.classList.add("meeting-editor-following");
        setEditorFollowBanner(false, true);
        showScreenInStage(call.peer, remoteStream, (call.metadata && call.metadata.name) || p.name || "Someone");
        return;
      }
      if (isScreenCall) {
        const p = state.participants[call.peer] || (state.participants[call.peer] = { name: "Peer" });
        p.screenStream = remoteStream;
        p.screenCall = call;
        p.isScreen = true;
        showScreenInStage(call.peer, remoteStream, (call.metadata && call.metadata.name) || p.name || "Someone");
        return;
      }
      handleRemoteStream(call.peer, remoteStream, call);
      // If an incoming call delivers a screen stream (the host is sharing)
      // we may not have received the screen-toggle data message yet.
      // Detect it here and stage it so the remote sees the shared content
      // immediately without waiting for the data channel.
      const vTrack = remoteStream.getVideoTracks()[0];
      const settings = vTrack && vTrack.getSettings ? (vTrack.getSettings() || {}) : {};
      const incomingIsScreen = isScreenStream(remoteStream);
      if (incomingIsScreen && state.screenPeerId !== call.peer) {
        showScreenInStage(call.peer, remoteStream, "Someone");
      }
    });

    // Listen for track replacements: when the sender switches between camera
    // and screen share mid-call, the media connection stays open but the video
    // track is replaced via replaceTrack(). This fires for each new track.
    call.on("track", (event) => {
      if (isScreenCall) return;
      event.streams.forEach((stream) => {
        const vTrack = stream.getVideoTracks()[0];
        // Use the same robust detection as handleRemoteStream: check displaySurface,
        // resolution, and label. This catches screen shares that the label-only check misses.
        const isScreen = isScreenStream(stream);
        if (isScreen && state.screenPeerId !== call.peer) {
          if (!state.participants[call.peer]) state.participants[call.peer] = {};
          state.participants[call.peer].stream = stream;
          state.participants[call.peer].isScreen = true;
          showScreenInStage(call.peer, stream, state.participants[call.peer].name || "Someone");
        } else if (!isScreen && vTrack && !stream.getVideoTracks().some((t) => t.label.toLowerCase().includes("screen"))) {
          // Camera came back — update the participant tile with camera video
          if (state.participants[call.peer]) {
            state.participants[call.peer].stream = stream;
            state.participants[call.peer].isScreen = false;
            attachRemoteAudio(call.peer, stream);
          }
          const tile = document.querySelector(`.meeting-remote-tile[data-peer="${call.peer}"]`);
          if (tile) {
            const vid = tile.querySelector("video");
            if (vid) { vid.srcObject = stream; vid.style.display = "block"; }
            const ov = tile.querySelector("[data-peer-initials]");
            if (ov) ov.style.display = "none";
          }
        }
      });
    });

    call.on("close", () => {
      if (isEditorScreenCall) {
        const p = state.participants[call.peer];
        if (p && p.editorScreenCall === call) {
          p.editorScreenCall = null;
          p.editorScreenStream = null;
          p.isEditor = false;
        }
        if (state.editorPeerId === call.peer) {
          state.editorPeerId = "";
          clearScreenStage();
          document.body.classList.remove("meeting-editor-following");
          setEditorFollowBanner(false, false);
        }
        return;
      }
      if (isScreenCall) {
        const p = state.participants[call.peer];
        if (p && p.screenCall === call) {
          p.screenCall = null;
          p.screenStream = null;
          p.isScreen = false;
        }
        if (state.screenPeerId === call.peer) clearScreenStage();
        return;
      }
      // Remove the participant entirely — peer discovery will reconnect them
      // within a few seconds if they are still in the room.
      removeParticipant(call.peer);
    });

    call.on("error", (err) => {
      if (isEditorScreenCall) {
        if (state.editorPeerId === call.peer) {
          state.editorPeerId = "";
          clearScreenStage();
          document.body.classList.remove("meeting-editor-following");
          setEditorFollowBanner(false, false);
        }
        return;
      }
      if (isScreenCall) {
        if (state.screenPeerId === call.peer) clearScreenStage();
        return;
      }
      console.warn("[Meeting] Call error from", call.peer, err);
    });
  }

  // Keep microphone playback independent from the camera tile. A camera tile
  // is hidden while another participant presents, and some browsers suspend
  // audio from a display:none video element. A dedicated audio element keeps
  // normal participant audio alive alongside shared-system audio.
  function attachRemoteAudio(peerId, stream) {
    const participant = state.participants[peerId];
    if (!participant || !stream || !stream.getAudioTracks || !stream.getAudioTracks().length) return;
    let audio = participant.audioEl;
    if (!audio) {
      audio = document.createElement("audio");
      audio.autoplay = true;
      audio.playsInline = true;
      audio.muted = false;
      audio.volume = 1;
      audio.dataset.meetingRemoteAudio = peerId;
      audio.style.position = "fixed";
      audio.style.width = "1px";
      audio.style.height = "1px";
      audio.style.opacity = "0";
      audio.style.pointerEvents = "none";
      document.body.appendChild(audio);
      participant.audioEl = audio;
    }
    if (audio.srcObject !== stream) audio.srcObject = stream;
    const playPromise = audio.play();
    if (playPromise && playPromise.catch) playPromise.catch(() => {});
  }

  function unlockRemoteAudio() {
    document.querySelectorAll("audio[data-meeting-remote-audio]").forEach((audio) => {
      const playPromise = audio.play();
      if (playPromise && playPromise.catch) playPromise.catch(() => {});
    });
  }

  document.addEventListener("pointerdown", unlockRemoteAudio, { passive: true });
  document.addEventListener("keydown", unlockRemoteAudio, { passive: true });

  function handleRemoteStream(peerId, stream, call) {
    // Detect screen shares reliably: Chrome exposes displaySurface on
    // getDisplayMedia captures; fall back to resolution/label heuristics.
    const vTrack = stream.getVideoTracks()[0];
    const settings = vTrack && vTrack.getSettings ? (vTrack.getSettings() || {}) : {};
    const isScreen = isScreenStream(stream);

    state.participants[peerId] = state.participants[peerId] || {};
    state.participants[peerId].stream = stream;
    state.participants[peerId].call = call;
    state.participants[peerId].isScreen = isScreen;
    state.participants[peerId].name = state.participants[peerId].name || "Peer";

    boostCallBitrates(call);
    if (!isScreen) attachRemoteAudio(peerId, stream);
    renderRemoteVideo(peerId);
    attachVolumeMeter(peerId, stream);

    // If this peer told us they're sharing (or the stream looks like a
    // screen), stage it. Also covers the case where the screen-toggle data
    // message arrived before the media stream.
    if (!state.isScreenSharing && (isScreen || state.participants[peerId].isScreen)) {
      showScreenInStage(peerId, stream, state.participants[peerId].name);
    }
  }

  function handleDataConnection(conn) {
    conn.on("open", () => {
      // Store data connection for chat
      const peerId = conn.peer;
      state.dataConnections[peerId] = conn;
      if (!state.participants[peerId]) {
        state.participants[peerId] = { name: "Peer" };
      }
      state.participants[peerId].dataConnection = conn;

      // Introduce ourselves so the remote side shows our real name
      try {
        conn.send({ type: "hello", name: state.userName });
      } catch (_) {}

      // A participant can arrive after a presentation has started. Re-send
      // the active presentation signal from the host's incoming data path and
      // establish the dedicated screen call for that late joiner.
      if (state.isScreenSharing && state.screenStream && conn.open) {
        try {
          conn.send({ type: "screen-toggle", sharing: true, name: state.userName });
        } catch (_) {}
        openScreenCall(peerId);
      }
      if (state.isEditorSharing && conn.open) {
        connectEditorPeer(peerId);
        openEditorScreenCall(peerId);
      }

      conn.on("data", (data) => {
        if (!data || typeof data !== "object") return;
        if (data.type === "hello" && data.name) {
          if (!state.participants[peerId]) {
            state.participants[peerId] = {};
          }
          state.participants[peerId].name = data.name;
          renderRemoteVideo(peerId);
        } else if (data.type === "chat") {
          // Direct messages are addressed to the recipient peer. Do not leak
          // them into the room chat or display another person's conversation.
          if (data.targetPeerId && data.targetPeerId !== state.peerId) return;
          if (state.chatTargetPeerId && peerId !== state.chatTargetPeerId) return;
          addChatMessage(
            data.from || peerId,
            data.message,
            data.system || false,
            data.targetPeerId || "",
            data.targetName || (data.targetPeerId ? state.userName : "Everyone"),
          );
        } else if (data.type === "screen-toggle") {
          // The peer swapped its camera/screen track; reflect it in the UI
          const p = state.participants[peerId];
          if (p) {
            p.isScreen = !!data.sharing;
            if (data.sharing && p.screenStream) {
              showScreenInStage(peerId, p.screenStream, data.name || p.name);
            } else if (!data.sharing) {
              p.screenStream = null;
              p.screenCall = null;
              renderRemoteVideo(peerId);
              if (!Object.values(state.participants).some((x) => x.isScreen)) {
                clearScreenStage();
              }
            }
          }
        } else if (data.type === "editor-share-toggle") {
          const p = state.participants[peerId] || (state.participants[peerId] = { name: data.name || "Peer" });
          p.isEditor = !!data.sharing;
          if (data.name) p.name = data.name;
          if (data.sharing) {
            // Request a fresh snapshot so a viewer that joined after the
            // original broadcast receives the complete current workspace.
            try { if (conn.open) conn.send({ type: "editor-share-request" }); } catch (_) {}
          } else if (state.editorPeerId === peerId) {
            state.editorPeerId = "";
            clearEditorShareStage();
            stopEditorFollow();
          }
        } else if (data.type === "editor-share-request") {
          if (state.isEditorSharing) sendEditorSnapshot(peerId, true);
        } else if (data.type === "editor-snapshot") {
          showRemoteEditorShare(peerId, data);
        } else if (data.type === "video-toggle") {
          // Peer toggled their camera — swap between video and initials
          const p = state.participants[peerId];
          if (p) {
            p.videoOn = !!data.videoOn;
            const tile = document.querySelector(`.meeting-remote-tile[data-peer="${peerId}"]`);
            if (tile) {
              const vid = tile.querySelector("video");
              const ov = tile.querySelector("[data-peer-initials]");
              if (data.videoOn && p.stream && p.stream.getVideoTracks().length > 0) {
                if (vid) { vid.srcObject = p.stream; vid.style.display = "block"; }
                if (ov) { ov.style.display = "none"; }
              } else {
                if (vid) { vid.srcObject = null; vid.style.display = "none"; }
                if (ov) { ov.style.display = "flex"; }
              }
            }
            renderParticipants();
          }
        } else if (data.type === "hand") {
          handlePeerHand(peerId, !!data.handUp, data.name);
        } else if (data.type === "reaction") {
          showReactionBurst(data.emoji || "👍", peerId, data.name);
        } else if (data.type === "mic-toggle") {
          const p = state.participants[peerId];
          if (p) {
            p.micOn = !!data.micOn;
            updateMicIndicators();
            renderParticipants();
          }
        } else if (data.type === "meeting-ended") {
          handleMeetingEnded(data.endedBy || "the host");
        } else if (data.type === "force-leave") {
          // Host kicked you from the meeting
          toast("You were removed from the meeting by the host", "error");
          endMeeting();
        }
      });

      conn.on("close", () => {
        delete state.dataConnections[peerId];
        if (state.participants[peerId]) {
          state.participants[peerId].dataConnection = null;
        }
      });
    });

    conn.on("error", (err) => {
      console.warn("[Meeting] Data connection error:", err);
    });
  }

  // PeerJS 1.5.x stores BOTH data and media connections in peer._connections
  // (Map: peerId -> array of connections, each with .type "data" | "media").
  // There is no peer._calls — iterating it silently did nothing, which is why
  // replaced tracks (screen share / camera) never reached remote peers.
  function getActiveMediaCalls() {
    const calls = [];
    if (!state.peer || !state.peer._connections) return calls;
    const conns = state.peer._connections;
    if (conns instanceof Map) {
      conns.forEach((list) => {
        (list || []).forEach((c) => {
          if (c && c.type === "media" && c.peerConnection) calls.push(c);
        });
      });
    }
    return calls;
  }

  // Find the RTCRtpSender for a track kind on a call. Uses transceivers so
  // senders whose track was previously replaced with null (camera off) are
  // still found — getSenders() + s.track.kind silently misses those.
  function findSenderForKind(call, kind) {
    try {
      const pc = call.peerConnection;
      if (!pc) return null;
      const trx = pc.getTransceivers().find(
        (t) => t.receiver && t.receiver.track && t.receiver.track.kind === kind
      );
      return trx ? trx.sender : null;
    } catch (_) {
      return null;
    }
  }

  // Replace the local track (camera or screen) on every active call so remote
  // peers see the new track. sender.replaceTrack() is the correct mechanism.
  // Returns the list of peer IDs whose calls had NO video sender (e.g. a peer
  // joined without a camera), so callers can fall back to a dedicated call.
  function replaceTrackForPeers(kind, track) {
    const missing = [];
    getActiveMediaCalls().forEach((call) => {
      const sender = findSenderForKind(call, kind);
      if (sender) {
        try { sender.replaceTrack(track || null); } catch (_) {}
      } else if (track && kind === "video") {
        missing.push(call.peer);
      }
    });
    return missing;
  }

  // Mix the microphone with shared system/tab audio so remote peers hear
  // both at once (Teams-style). The mixed track replaces the mic on every
  // call; muting the mic still silences just the microphone.
  let audioMixer = null;

  function startAudioMix(displayStream) {
    stopAudioMix();
    const sysTrack = displayStream && displayStream.getAudioTracks()[0];
    if (!sysTrack || !state.localStream) return;
    const micTrack = state.localStream.getAudioTracks()[0];
    if (!micTrack) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const dest = ctx.createMediaStreamDestination();
      ctx.createMediaStreamSource(new MediaStream([micTrack])).connect(dest);
      ctx.createMediaStreamSource(new MediaStream([sysTrack])).connect(dest);
      audioMixer = ctx;
      replaceTrackForPeers("audio", dest.stream.getAudioTracks()[0] || null);
    } catch (_) {
      // Mixing unsupported — fall back to mic-only
    }
  }

  function stopAudioMix() {
    if (!audioMixer) return;
    try { audioMixer.close(); } catch (_) {}
    audioMixer = null;
    const micTrack = state.localStream && state.localStream.getAudioTracks()[0];
    replaceTrackForPeers("audio", micTrack || null);
  }

  function disconnectPeer() {
    if (peerDiscoveryTimer) {
      clearInterval(peerDiscoveryTimer);
      peerDiscoveryTimer = null;
    }
    if (meetingStatusTimer) {
      clearInterval(meetingStatusTimer);
      meetingStatusTimer = null;
    }
    if (meetingHeartbeatTimer) {
      clearInterval(meetingHeartbeatTimer);
      meetingHeartbeatTimer = null;
    }
    pendingCalls.clear();
    state.dataConnections = {};
    state.editorConnections = {};
    stopEditorScreenShare();
    stopEditorSync();
    stopEditorFollow();
    state.editorFollowMuted = false;
    state.isEditorSharing = false;
    state.editorPeerId = "";
    clearEditorShareStage();
    if (state.peer) {
      try {
        // Close all calls and data connections. PeerJS 1.5.x keeps both in
        // _connections (Map<peerId, connection[]>), so closing them here also
        // notifies remote peers that the screen share / call ended.
        const conns = state.peer._connections;
        if (conns instanceof Map) {
          conns.forEach((list) => {
            (list || []).forEach((c) => {
              try { c.close(); } catch (_) {}
            });
          });
        }
      } catch (_) {}
      try { state.peer.destroy(); } catch (_) {}
      state.peer = null;
    }

    // Stop tracks
    if (state.localStream) {
      state.localStream.getTracks().forEach((t) => t.stop());
      state.localStream = null;
    }
    if (state.screenStream) {
      state.screenStream.getTracks().forEach((t) => t.stop());
      state.screenStream = null;
    }
    Object.values(state.screenCalls || {}).forEach((c) => {
      try { c.close(); } catch (_) {}
    });
    state.screenCalls = {};

    Object.values(state.participants).forEach((p) => {
      stopVolumeMeter(p);
      if (p && p.audioEl) {
        try { p.audioEl.srcObject = null; } catch (_) {}
        try { p.audioEl.remove(); } catch (_) {}
      }
    });
    state.isMicOn = true;
    state.isCamOn = true;
    state.isScreenSharing = false;
    state.isHost = false;
    state.callActive = false;
    state.isConnected = false;
    document.body.classList.remove("meeting-active");
    state.participants = {};
    state.chatOpen = false;
    state.participantsOpen = false;
    state.chatTargetPeerId = "";
    state.chatTargetName = "Everyone";
    state.participantSearch = "";
    if (els.chatMessages) els.chatMessages.replaceChildren();
    state.handRaised = false;
    state.spotlightId = null;
    state._prevPeers = 0;
    stopMeetingTimer();
    // Reset UI
    els.container.style.display = "none";
    els.container.classList.remove("self-main", "spotlight", "focus-mode", "screen-share-clean", "chat-open", "participants-open", "meeting-show-identity", "meeting-show-leave", "meeting-minimized");
    _focusMode = false;
    if (els.localTile) els.localTile.classList.remove("minimized");
    const minBtn = document.getElementById("meeting-local-minimize");
    const maxBtn = document.getElementById("meeting-local-maximize");
    if (minBtn) minBtn.style.display = "flex";
    if (maxBtn) maxBtn.style.display = "none";
    if (els.localTile) els.localTile.style.display = "";
    if (els.screenStage) els.screenStage.classList.remove("spotlight");
    // The self-view may live inside the grid (gallery mode) — move it back
    // before clearing, otherwise it would be destroyed with the grid.
    if (els.localTile && els.localTile.parentNode === els.remoteGrid) {
      els.videoArea.appendChild(els.localTile);
    }
    els.remoteGrid.innerHTML = "";
    els.remoteGrid.classList.remove("gallery", "many", "strip", "g10plus");
    for (let n = 1; n <= 9; n += 1) els.remoteGrid.classList.remove("g" + n);
    els.localVideo.srcObject = null;
    els.localInitials.style.display = "none";
    if (els.localHandBadge) els.localHandBadge.style.display = "none";
    if (els.localTileMic) els.localTileMic.style.display = "none";
    updateChatTargetUI();
    state.participantsOpen = false;
    if (els.participantsPanel) els.participantsPanel.style.display = "none";
    closeMeetingMenus();
    els.videoArea.querySelectorAll(".meeting-reaction-burst").forEach((b) => b.remove());
    els.videoArea.querySelectorAll(".meeting-reaction-stage").forEach((s) => s.remove());
    stopAudioMix();
    closeOthers();
    othersPageIdx = 0;
    clearScreenStage();
    updateControlUI();
    updateParticipantCount();
    // Reset activity bar button
    if (els.joinBtn) els.joinBtn.classList.remove("active");
    state.meetingMinimized = false;

  }

  // ─── Local video / initials ────────────────────────────────────────────
  function renderLocalVideo() {
    if (state.localStream && state.isCamOn) {
      els.localVideo.srcObject = state.localStream;
      els.localVideo.muted = true;
      els.localVideo.style.display = "block";
      els.localInitials.style.display = "none";
    } else {
      els.localVideo.srcObject = null;
      els.localVideo.style.display = "none";
      els.localInitials.style.display = "flex";
      updateLocalInitials();
    }
  }

  // ─── Remote video tiles + dynamic grid ────────────────────────────────
  const OTHERS_PAGE_SIZE = 16; // 4x4 per slide in the Others viewer
  let othersOpen = false;
  let othersPageIdx = 0;

  function makeRemoteTile(peerId, p) {
    const tile = document.createElement("div");
    tile.className = "meeting-remote-tile";
    tile.setAttribute("data-peer", peerId);

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.style.width = "100%";
    video.style.height = "100%";
    video.style.objectFit = "cover";
    video.style.background = "#111827";
    video.style.borderRadius = "7px";
    video.setAttribute("data-peer-video", peerId);

    // Double-click / double-tap a tile → make that user MY main stage.
    // (Single click switches the spotlight while a spotlight is active.)
    tile.addEventListener("click", () => {
      if (state.spotlightId && state.spotlightId !== peerId && !state.screenPeerId) {
        setSpotlight(peerId);
      }
    });
    tile.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      if (state.screenPeerId) return;
      if (state.spotlightId !== peerId) setSpotlight(peerId);
    });

    const initialsOverlay = document.createElement("div");
    initialsOverlay.className = "meeting-initials-overlay";
    initialsOverlay.setAttribute("data-peer-initials", peerId);
    initialsOverlay.style.display = "none";
    const initialsText = document.createElement("span");
    initialsText.className = "meeting-initials-text";
    initialsText.textContent = initials(p.name || peerId);
    initialsOverlay.appendChild(initialsText);

    const label = document.createElement("div");
    label.className = "meeting-user-label";
    const dot = document.createElement("span");
    dot.className = "meeting-status-dot meeting-status-connected";
    const nameSpan = document.createElement("span");
    nameSpan.className = "meeting-tile-name";
    nameSpan.textContent = p.name || peerId;
    label.appendChild(dot);
    label.appendChild(nameSpan);
    const micSpan = document.createElement("span");
    micSpan.className = "meeting-tile-mic";
    micSpan.style.display = "none";
    micSpan.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line><line class="meeting-slash" x1="4" y1="4" x2="20" y2="20"></line></svg>';
    label.appendChild(micSpan);

    const handBadge = document.createElement("div");
    handBadge.className = "meeting-hand-badge";
    handBadge.style.display = "none";
    handBadge.textContent = "✋";

    tile.appendChild(video);
    tile.appendChild(initialsOverlay);
    tile.appendChild(label);
    tile.appendChild(handBadge);

    // Attach stream / initials
    if (p.stream && p.stream.getVideoTracks().length > 0) {
      video.srcObject = p.stream;
      // Audio is played through the dedicated remote audio element so the
      // camera tile can safely be hidden during screen sharing.
      video.muted = true;
      video.style.display = "block";
      initialsOverlay.style.display = "none";
      const playPromise = video.play();
      if (playPromise && playPromise.catch) {
        playPromise.catch(() => {
          // A browser may defer autoplay until the next user gesture. The
          // element remains connected; the global audio unlock below retries.
        });
      }
    } else {
      video.srcObject = null;
      video.style.display = "none";
      initialsOverlay.style.display = "flex";
      initialsOverlay.querySelector(".meeting-initials-text").textContent = initials(p.name || peerId);
    }
    if (p.handUp) handBadge.style.display = "flex";
    return tile;
  }

  function makeOthersTile(count) {
    const tile = document.createElement("div");
    tile.className = "meeting-others-tile";
    tile.setAttribute("role", "button");
    tile.tabIndex = 0;
    tile.title = "Show all participants";
    const num = document.createElement("div");
    num.className = "meeting-others-count";
    num.textContent = "+" + count;
    const label = document.createElement("div");
    label.className = "meeting-others-label";
    label.textContent = "Others";
    tile.appendChild(num);
    tile.appendChild(label);
    tile.addEventListener("click", openOthers);
    tile.addEventListener("keydown", (e) => { if (e.key === "Enter") openOthers(); });
    return tile;
  }

  // Rebuild the main grid from current state:
  // - Gallery (no spotlight / no share): self-view joins the grid as the first
  //   uniform tile. Up to 4 total → everyone shown; more → 3 named + "Others".
  // - Spotlight: the pinned user fills the stage; everyone else becomes a
  //   right-side filmstrip (self included, unless self is the one spotlighted).
  // - Presentation (real screen share): screen fills the stage, cameras in
  //   a right-side filmstrip.
  function renderGrid() {
    if (!els.remoteGrid) return;
    const peers = Object.keys(state.participants);
    const total = peers.length + 1;
    const spotlight = !!state.spotlightId && !state.screenPeerId;
    const gallery = !state.spotlightId && !state.screenPeerId && peers.length > 0;
    const selfInGrid = gallery || (spotlight && state.spotlightId !== "self");

    // Self-view: uniform grid/filmstrip cell, or floating PiP (hidden while
    // self is the spotlighted stage — it would just duplicate the stage).
    if (selfInGrid && els.localTile.parentNode !== els.remoteGrid) {
      els.remoteGrid.insertBefore(els.localTile, els.remoteGrid.firstChild);
    } else if (!selfInGrid && els.localTile.parentNode === els.remoteGrid) {
      els.videoArea.appendChild(els.localTile);
    }
    if (els.localTile) {
      els.localTile.style.display = state.localViewHidden || (spotlight && state.spotlightId === "self") ? "none" : "";
      els.localTile.title = gallery
        ? "Double-click to spotlight your video"
        : "Drag to move · Double-click to spotlight";
    }

    if (gallery) {
      // A dragged/minimized self-view carries inline positioning. Clear it
      // before moving it into the grid or it distorts the next participant's
      // layout while the other tiles are being rebuilt. Keep the minimized
      // class: a fixed PiP intentionally leaves the gallery flow.
      resetLocalTilePosition();
    }
    els.remoteGrid.classList.toggle("gallery", gallery);
    els.remoteGrid.classList.toggle("strip", spotlight);
    const many = gallery && total > 9;
    els.remoteGrid.classList.toggle("many", many);
    for (let n = 1; n <= 9; n += 1) {
      els.remoteGrid.classList.toggle("g" + n, gallery && total === n);
    }
    els.remoteGrid.classList.toggle("g10plus", gallery && total >= 10);
    els.container.classList.toggle("presentation-no-remote", !!state.screenPeerId && peers.length === 0);

    // Rebuild remote tiles + others tile (filmstrip excludes the spotlighted
    // user — they own the stage).
    els.remoteGrid.querySelectorAll(".meeting-remote-tile, .meeting-others-tile").forEach((t) => t.remove());
    const strip = spotlight
      ? peers.filter((pid) => pid !== state.spotlightId)
      : state.screenPeerId
        ? peers.filter((pid) => pid !== state.screenPeerId)
        : peers;
    const shown = many ? strip.slice(0, 8) : strip;
    shown.forEach((pid) => {
      const p = state.participants[pid];
      if (!p) return;
      els.remoteGrid.appendChild(makeRemoteTile(pid, p));
    });
    if (many) els.remoteGrid.appendChild(makeOthersTile(strip.length - shown.length));
  }

  function renderRemoteVideo(peerId) {
    const p = state.participants[peerId];
    if (!p) return;
    updateParticipantCount(); // re-renders the grid with current peer state
  }

  // ─── "Others" paged viewer (4x4 per slide) ────────────────────────────
  function getHiddenRemotePeers() {
    return Object.keys(state.participants).slice(2);
  }

  function othersPageCount() {
    return Math.max(1, Math.ceil(getHiddenRemotePeers().length / OTHERS_PAGE_SIZE));
  }

  function renderOthersOverlay() {
    if (!els.othersGrid) return;
    const hidden = getHiddenRemotePeers();
    const pages = othersPageCount();
    if (othersPageIdx >= pages) othersPageIdx = pages - 1;
    els.othersGrid.innerHTML = "";
    const start = othersPageIdx * OTHERS_PAGE_SIZE;
    hidden.slice(start, start + OTHERS_PAGE_SIZE).forEach((pid) => {
      const p = state.participants[pid];
      if (!p) return;
      els.othersGrid.appendChild(makeRemoteTile(pid, p));
    });
    if (els.othersTitle) els.othersTitle.textContent = "Others (" + hidden.length + ")";
    if (els.othersPageEl) els.othersPageEl.textContent = (othersPageIdx + 1) + " / " + pages;
    if (els.othersPrev) els.othersPrev.disabled = pages <= 1;
    if (els.othersNext) els.othersNext.disabled = pages <= 1;
  }

  function openOthers() {
    othersOpen = true;
    othersPageIdx = 0;
    renderOthersOverlay();
    if (els.othersOverlay) els.othersOverlay.style.display = "flex";
    closeMeetingMenus();
  }

  function closeOthers() {
    othersOpen = false;
    if (els.othersOverlay) els.othersOverlay.style.display = "none";
  }

  function othersPage(dir) {
    const pages = othersPageCount();
    othersPageIdx = (othersPageIdx + dir + pages) % pages;
    renderOthersOverlay();
  }

  function removeParticipant(peerId) {
    const participant = state.participants[peerId];
    stopVolumeMeter(participant);
    if (participant && participant.audioEl) {
      try { participant.audioEl.srcObject = null; } catch (_) {}
      try { participant.audioEl.remove(); } catch (_) {}
    }
    delete state.participants[peerId];
    // Forcefully remove any lingering tile from the DOM
    const tile = document.querySelector(`.meeting-remote-tile[data-peer="${peerId}"]`);
    if (tile) {
      const video = tile.querySelector("video");
      if (video && video.srcObject) {
        video.srcObject.getTracks().forEach((t) => t.stop());
      }
      tile.remove();
    }
    if (othersOpen) closeOthers();
    // Clear the screen stage if the presenter left
    if (state.screenPeerId === peerId) {
      clearScreenStage();
    }
    if (state.editorPeerId === peerId) {
      state.editorPeerId = "";
      clearEditorShareStage();
    }
    // Full re-render so the grid reflows correctly after a participant leaves
    renderGrid();
    updateParticipantCount();
  }



  async function toggleMic() {
    // No mic track yet (join failed or device was missing): clicking the mic
    // button now is a fresh user gesture, so the browser asks for permission.
    if (!state.localStream || !state.localStream.getAudioTracks().length) {
      await requestMissingMedia(false, true);
      return;
    }

    const audioTracks = state.localStream.getAudioTracks();
    state.isMicOn = !state.isMicOn;
    audioTracks.forEach((t) => t.enabled = state.isMicOn);

    // Notify others via data channels
    broadcastChatMessage(null, {
      type: "mic-toggle",
      micOn: state.isMicOn,
    });

    updateControlUI();
    updateMicIndicators();
    renderParticipants();
    toast(state.isMicOn ? "Microphone unmuted" : "Microphone muted", state.isMicOn ? "success" : "error");
  }

  async function toggleCamera() {
    // No camera track yet (join failed or no camera at join time): clicking
    // the camera button is a fresh user gesture, so the browser asks for
    // permission (or explains the device is missing) instead of silently
    // doing nothing.
    if (!state.localStream || !state.localStream.getVideoTracks().length) {
      await requestMissingMedia(true, false);
      return;
    }

    const videoTracks = state.localStream.getVideoTracks();
    state.isCamOn = !state.isCamOn;
    videoTracks.forEach((t) => t.enabled = state.isCamOn);

    // Send peers the camera track (or null to black out) via sender.replaceTrack
    const camTrack = state.isCamOn ? state.localStream.getVideoTracks()[0] : null;
    replaceTrackForPeers("video", camTrack || null);

    // Notify peers so they can swap between video and initials avatar
    broadcastChatMessage(null, {
      type: "video-toggle",
      videoOn: state.isCamOn,
      name: state.userName,
    });

    renderLocalVideo();
    updateControlUI();
    updateMicIndicators();
    renderParticipants();
    toast(state.isCamOn ? "Camera turned on" : "Camera turned off", state.isCamOn ? "success" : "error");
  }

  async function toggleScreenShare() {
    if (state.isScreenSharing) {
      stopScreenShare();
      return;
    }
    if (state.isEditorSharing) stopEditorShare();
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: "always" },
        audio: true, // ask for system/tab audio (browser shows a checkbox)
      });

      // Detect if user clicked "Stop sharing" in the browser dialog
      const track = stream.getVideoTracks()[0];
      if (track) {
        track.addEventListener("ended", onScreenTrackEnded);
      }

      state.screenStream = stream;
      state.isScreenSharing = true;

      state.screenCalls = {};
      // Open a dedicated one-way presentation call for every current peer.
      Object.keys(state.participants).forEach(openScreenCall);

      // Notify others so they can switch to presentation mode
      broadcastChatMessage(null, {
        type: "screen-toggle",
        sharing: true,
        name: state.userName,
      });

      addSystemMessage(state.userName + " started screen sharing");
      showScreenInStage(state.peerId, stream, state.userName);
      updateControlUI();
      toast("Screen sharing started", "success");
    } catch (err) {
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        toast("Screen sharing permission denied.", "error");
      } else if (err.name === "NotFoundError") {
        toast("No screen to share.", "error");
      } else {
        toast("Screen share error: " + err.message, "error");
      }
      state.isScreenSharing = false;
      updateControlUI();
    }
  }

  function stopScreenShare() {
    if (state.screenStream) {
      state.screenStream.getTracks().forEach((t) => t.stop());
      state.screenStream = null;
    }
    // Close any dedicated screen calls (no-camera fallback)
    Object.values(state.screenCalls || {}).forEach((c) => {
      try { c.close(); } catch (_) {}
    });
    state.screenCalls = {};
    state.isScreenSharing = false;

    // Back to normal camera bitrate
    getActiveMediaCalls().forEach((c) => boostCallBitrates(c, 2500000));

    broadcastChatMessage(null, { type: "screen-toggle", sharing: false });
    addSystemMessage(state.userName + " stopped screen sharing");
    clearScreenStage();
    updateControlUI();
    toast("Screen sharing stopped", "success");
  }

  window.MeetingRoom.toggleMic = toggleMic;
  window.MeetingRoom.toggleCamera = toggleCamera;
  window.MeetingRoom.toggleScreenShare = toggleScreenShare;

  // ─── Presentation Mode (dedicated screen-share stage) ──────────────────
  function showScreenInStage(peerId, stream, name) {
    state.screenPeerId = peerId;
    clearSpotlight();
    resetLocalTilePosition();
    if (els.screenVideo) {
      els.screenVideo.srcObject = stream || null;
      // The presenter must not hear their own shared tab/system audio, but
      // viewers must receive it.  The old implementation muted this element
      // for everyone, making “share audio” appear broken.
      els.screenVideo.muted = peerId === state.peerId;
      const playPromise = els.screenVideo.play();
      if (playPromise.catch) {
        playPromise.catch((err) => {
          console.warn("[Meeting] Screen video play failed:", err.message);
        });
      }
    }
    if (els.screenLabel) {
      els.screenLabel.textContent =
        peerId === state.peerId
          ? "You're presenting"
          : (name || "Someone") + " is presenting";
    }
    if (els.screenStage) els.screenStage.style.display = "flex";
    document.body.classList.add("presentation-mode");
    els.container.classList.add("presentation-mode", "screen-share-clean");
    renderGrid();
  }

  function clearScreenStage() {
    state.screenPeerId = "";
    state.localViewHidden = false;
    if (els.localTile) els.localTile.classList.remove("minimized");
    const minBtn = document.getElementById("meeting-local-minimize");
    const maxBtn = document.getElementById("meeting-local-maximize");
    if (minBtn) minBtn.style.display = "flex";
    if (maxBtn) maxBtn.style.display = "none";
    if (els.screenVideo) els.screenVideo.srcObject = null;
    if (els.screenStage) els.screenStage.style.display = "none";
    document.body.classList.remove("presentation-mode");
    els.container.classList.remove("presentation-mode", "screen-share-clean");
    renderGrid();
  }

  // ─── Chat ──────────────────────────────────────────────────────────────
  function updateChatTargetUI() {
    const direct = !!state.chatTargetPeerId;
    if (els.chatRecipient) {
      const selected = direct ? state.chatTargetPeerId : "";
      els.chatRecipient.value = selected;
    }
    if (els.chatInput) els.chatInput.placeholder = direct
      ? "Message " + state.chatTargetName + "..."
      : "Type a message... (Enter to send)";
  }

  function updateChatRecipientOptions() {
    if (!els.chatRecipient) return;
    const selected = state.chatTargetPeerId && state.participants[state.chatTargetPeerId]
      ? state.chatTargetPeerId
      : "";
    if (!selected) {
      state.chatTargetPeerId = "";
      state.chatTargetName = "Everyone";
    }
    els.chatRecipient.innerHTML = "";
    const everyone = document.createElement("option");
    everyone.value = "";
    everyone.textContent = "Everyone";
    els.chatRecipient.appendChild(everyone);
    Object.keys(state.participants)
      .sort((a, b) => (state.participants[a].name || "Peer").localeCompare(state.participants[b].name || "Peer"))
      .forEach((peerId) => {
        const option = document.createElement("option");
        option.value = peerId;
        option.textContent = state.participants[peerId].name || "Peer";
        els.chatRecipient.appendChild(option);
      });
    els.chatRecipient.value = selected;
  }

  function clearChatTarget() {
    state.chatTargetPeerId = "";
    state.chatTargetName = "Everyone";
    updateChatTargetUI();
    updateChatRecipientOptions();
  }

  function openParticipantChat(peerId, name) {
    if (!peerId || !state.participants[peerId]) return;
    state.chatTargetPeerId = peerId;
    state.chatTargetName = name || state.participants[peerId].name || "Participant";
    if (state.participantsOpen) {
      state.participantsOpen = false;
      if (els.participantsPanel) els.participantsPanel.style.display = "none";
      els.container.classList.remove("participants-open");
    }
    if (!state.chatOpen) {
      state.chatOpen = true;
      if (els.chatDrawer) els.chatDrawer.style.display = "flex";
      els.container.classList.add("chat-open");
    }
    updateChatTargetUI();
    updateControlUI();
    if (els.chatInput) els.chatInput.focus();
    updateChatRecipientOptions();
  }

  function toggleChat() {
    state.chatOpen = !state.chatOpen;
    els.chatDrawer.style.display = state.chatOpen ? "flex" : "none";
    els.container.classList.toggle("chat-open", state.chatOpen);
    if (state.chatOpen && state.participantsOpen) {
      state.participantsOpen = false;
      if (els.participantsPanel) els.participantsPanel.style.display = "none";
      els.container.classList.remove("participants-open");
    }
    updateControlUI();
    updateChatRecipientOptions();
    // When chat opens, shrink the video area so the two panels sit side by
    // side instead of the drawer painting over the video grid.
    if (els.videoArea) {
      els.videoArea.style.flex = state.chatOpen ? "1 1 auto" : "";
      els.videoArea.style.minWidth = state.chatOpen ? "0" : "";
    }
    if (state.chatOpen) {
      els.chatInput.focus();
    }
  }

  window.MeetingRoom.toggleChat = toggleChat;

  function addChatMessage(from, message, isSystem, targetPeerId, targetName) {
    const box = els.chatMessages;
    if (!box) return;

    const div = document.createElement("div");
    div.className = "meeting-chat-msg " + (
      isSystem ? "system" :
      from === state.userName || from === state.userName.split(" ")[0] ? "from-me" : "from-other"
    );

    if (isSystem) {
      div.textContent = message;
    } else {
      const senderSpan = document.createElement("span");
      senderSpan.className = "msg-sender";
      senderSpan.textContent = from || "Unknown";
      div.appendChild(senderSpan);
      const metaSpan = document.createElement("span");
      metaSpan.className = "msg-meta";
      metaSpan.textContent = targetPeerId ? "Private · " + (targetName || "Participant") : "Everyone";
      div.appendChild(metaSpan);
      const textSpan = document.createElement("span");
      // Basic HTML escape for code snippets
      textSpan.textContent = message;
      div.appendChild(textSpan);
    }

    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  function addSystemMessage(msg) {
    addChatMessage(null, msg, true);
  }

  function recordMeetingEvent(eventType, payload) {
    if (!state.roomId || !state.peerId || !state.callActive) return;
    fetch("/api/meeting/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roomId: state.roomId,
        peerId: state.peerId,
        eventType: eventType,
        payload: payload || {},
      }),
      keepalive: eventType === "chat",
    }).catch(() => {});
  }

  function sendChatMessage() {
    const input = els.chatInput;
    if (!input) return;
    const msg = input.value.trim();
    if (!msg) return;

    const payload = { type: "chat", message: msg };
    if (state.chatTargetPeerId) {
      payload.targetPeerId = state.chatTargetPeerId;
      payload.targetName = state.chatTargetName;
      const target = state.participants[state.chatTargetPeerId];
      if (target && target.dataConnection && target.dataConnection.open) {
        try { target.dataConnection.send(Object.assign({}, payload, { from: state.userName })); } catch (_) {}
      }
    } else {
      broadcastChatMessage(state.userName, payload);
    }

    // Also add locally
    addChatMessage(state.userName, msg, false, state.chatTargetPeerId, state.chatTargetName);
    recordMeetingEvent("chat", {
      from: state.userName,
      message: msg,
      targetPeerId: state.chatTargetPeerId || null,
      targetName: state.chatTargetName || "Everyone",
    });
    input.value = "";
  }

  window.MeetingRoom.sendChatMessage = sendChatMessage;

  function broadcastChatMessage(from, payload) {
    if (!state.peer) return;
    const data = Object.assign({}, payload, { from: from || state.userName });
    broadcastMeetingData(data);
  }

  function broadcastMeetingData(payload) {
    if (!state.peer) return;
    const data = Object.assign({}, payload, { from: state.userName });
    const connections = Object.values(state.dataConnections);
    // Backward-compatible fallback for connections created before the map
    // was populated.
    Object.values(state.participants).forEach((participant) => {
      if (participant && participant.dataConnection && !connections.includes(participant.dataConnection)) {
        connections.push(participant.dataConnection);
      }
    });
    connections.forEach((connection) => {
      if (connection && connection.open) {
        try { connection.send(data); } catch (_) {}
      }
    });
  }

  // Chat enter key
  function onChatKeydown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  }

  // ─── Self-view: drag PiP + click to swap with the stage ───────────────
  function setupLocalTileInteractions() {
    if (!els.localTile || !els.videoArea) return;

    // Drag: pointer capture so the tile follows the cursor anywhere
    els.localTile.addEventListener("pointerdown", (e) => {
      if (state.spotlightId === "self") return; // stage is not draggable
      if (els.localTile.parentNode === els.remoteGrid) return; // grid cells don't drag
      if (e.target.closest(".meeting-spotlight-exit")) return;
      state.localTileMoved = false;
      const areaRect = els.videoArea.getBoundingClientRect();
      const tileRect = els.localTile.getBoundingClientRect();
      dragState = {
        startX: e.clientX,
        startY: e.clientY,
        origLeft: tileRect.left - areaRect.left,
        origTop: tileRect.top - areaRect.top,
      };
      els.localTile.style.left = dragState.origLeft + "px";
      els.localTile.style.top = dragState.origTop + "px";
      els.localTile.style.right = "auto";
      els.localTile.style.bottom = "auto";
      els.localTile.style.transform = "none";
      els.localTile.classList.add("dragging");
      try { els.localTile.setPointerCapture(e.pointerId); } catch (_) {}
    });

    els.localTile.addEventListener("pointermove", (e) => {
      if (!dragState || !els.localTile.hasPointerCapture(e.pointerId)) return;
      const dx = e.clientX - dragState.startX;
      const dy = e.clientY - dragState.startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) state.localTileMoved = true;
      const areaRect = els.videoArea.getBoundingClientRect();
      const w = els.localTile.offsetWidth;
      const h = els.localTile.offsetHeight;
      const nx = Math.max(4, Math.min(dragState.origLeft + dx, areaRect.width - w - 4));
      const ny = Math.max(4, Math.min(dragState.origTop + dy, areaRect.height - h - 4));
      els.localTile.style.left = nx + "px";
      els.localTile.style.top = ny + "px";
    });

    function endLocalDrag() {
      if (!dragState) return;
      dragState = null;
      els.localTile.classList.remove("dragging");
    }
    els.localTile.addEventListener("pointerup", endLocalDrag);
    els.localTile.addEventListener("pointercancel", endLocalDrag);

    // Double-click / double-tap on your own tile → make yourself the stage.
    els.localTile.addEventListener("dblclick", (e) => {
      if (e.target.closest(".meeting-spotlight-exit")) return;
      if (state.localTileMoved) {
        state.localTileMoved = false;
        return;
      }
      if (state.screenPeerId) return; // screen share owns the stage
      if (state.spotlightId !== "self") setSpotlight("self");
    });

    // Single click on the self tile switches the spotlight to me (when a
    // spotlight is active and the tile sits in the filmstrip).
    els.localTile.addEventListener("click", (e) => {
      if (els.localTile.classList.contains("minimized")) {
        if (e.target.closest(".meeting-tile-controls")) return;
        toggleLocalMinimize();
        return;
      }
      if (state.spotlightId && state.spotlightId !== "self" && !state.screenPeerId) {
        setSpotlight("self");
      }
    });
  }

  // ─── Spotlight: pin any user (incl. self) as MY main stage ────────────
  function setSpotlight(id) {
    if (!id || state.screenPeerId || state.spotlightId === id) return;
    state.layoutMode = "speaker";
    state.spotlightId = id;
    resetLocalTilePosition();
    els.container.classList.add("spotlight");

    const isSelf = id === "self";
    const p = isSelf ? null : state.participants[id];
    const stream = isSelf
      ? (state.localStream || null)
      : (p && p.stream ? p.stream : null);

    if (els.screenStage) {
      els.screenStage.classList.add("spotlight");
      els.screenStage.style.display = "flex";
    }
    if (els.screenVideo) {
      els.screenVideo.srcObject = stream || null;
      els.screenVideo.muted = true;
      const playPromise = els.screenVideo.play();
      if (playPromise.catch) {
        playPromise.catch((err) => {
          console.warn("[Meeting] Spotlight video play failed:", err.message);
        });
      }
    }
    if (els.screenLabel) {
      els.screenLabel.textContent = isSelf
        ? "Your video — Spotlight"
        : ((p && p.name) || "Participant") + " — Spotlight";
    }

    toast(isSelf ? "Spotlighted your video" : "Spotlighted " + ((p && p.name) || "participant"), "success");
    renderGrid();
  }

  function clearSpotlight() {
    if (!state.spotlightId) return;
    state.layoutMode = "gallery";
    state.spotlightId = null;
    els.container.classList.remove("spotlight");
    if (els.screenStage) {
      els.screenStage.classList.remove("spotlight");
      if (!state.screenPeerId) els.screenStage.style.display = "none";
    }
    if (els.screenVideo && !state.screenPeerId) els.screenVideo.srcObject = null;
    renderGrid();
  }

  function exitSpotlight(e) {
    if (e && e.stopPropagation) e.stopPropagation();
    clearSpotlight();
  }

  window.MeetingRoom.setSpotlight = setSpotlight;
  window.MeetingRoom.exitSpotlight = exitSpotlight;
  // Back-compat alias for old HTML references
  window.MeetingRoom.exitSelfMain = exitSpotlight;

  // Clear drag-position inline styles so the stage always fits the frame
  // (inline left/top from a dragged PiP would otherwise push it out of bounds).
  function resetLocalTilePosition() {
    if (!els.localTile) return;
    els.localTile.style.left = "";
    els.localTile.style.top = "";
    els.localTile.style.right = "";
    els.localTile.style.bottom = "";
    els.localTile.style.transform = "";
  }

  // ─── Minimize / restore self-view PiP ─────────────────────────────────
  function toggleLocalMinimize() {
    if (!els.localTile) return;
    const isMinimized = els.localTile.classList.toggle("minimized");
    // In presentation mode the minus control means “hide my self-view” so
    // the shared content can occupy the complete stage.  Restore is handled
    // by the same control and the grid is recalculated in both directions.
    state.localViewHidden = !!state.screenPeerId && isMinimized;
    const minBtn = document.getElementById("meeting-local-minimize");
    const maxBtn = document.getElementById("meeting-local-maximize");
    if (minBtn) minBtn.style.display = isMinimized ? "none" : "flex";
    if (maxBtn) maxBtn.style.display = isMinimized ? "flex" : "none";
    if (isMinimized) {
      toast("Self-view minimized — click the tile to restore", "success");
    }
    renderGrid();
  }
  window.MeetingRoom.toggleLocalMinimize = toggleLocalMinimize;

  // ─── Focus mode: hide all chrome, make screen share fill the area ─────
  let _focusMode = false;
  function toggleFocusMode() {
    _focusMode = !_focusMode;
    if (els.container) els.container.classList.toggle("focus-mode", _focusMode);
    const btn = document.getElementById("meeting-focus-btn");
    if (btn) btn.classList.toggle("active", _focusMode);
    toast(_focusMode ? "Focus mode — only shared screen is visible" : "Focus mode off", "success");
  }

  // Called when the user clicks the browser "Stop sharing" pill in the
  // getDisplayMedia picker. Without this, stopping from the browser UI leaves
  // us with a stale (blank) screen stage and a stuck sharing state.
  function onScreenTrackEnded() {
    if (!state.screenPeerId) return;
    stopScreenShare();
  }
  window.MeetingRoom.toggleFocusMode = toggleFocusMode;

  function toggleLayoutMode() {
    if (state.screenPeerId) {
      toast("Gallery and speaker layout are unavailable while someone is presenting", "error");
      return;
    }
    const peers = Object.keys(state.participants);
    if (!peers.length && !state.spotlightId) {
      toast("Speaker layout needs another participant", "error");
      return;
    }
    if (state.layoutMode === "gallery") {
      state.layoutMode = "speaker";
      setSpotlight(peers[0] || "self");
      toast("Speaker view", "success");
    } else {
      state.layoutMode = "gallery";
      clearSpotlight();
      toast("Gallery view", "success");
    }
    updateLayoutButton();
  }

  function updateLayoutButton() {
    const btn = document.getElementById("meeting-layout-btn");
    if (btn) btn.title = state.layoutMode === "gallery" ? "Switch to speaker view" : "Switch to gallery view";
  }
  window.MeetingRoom.toggleLayoutMode = toggleLayoutMode;

  function toggleMeetingMinimize() {
    state.meetingMinimized = !state.meetingMinimized;
    if (els.container) {
      els.container.classList.toggle("meeting-minimized", state.meetingMinimized);
      // Explicitly set the window geometry as well as the class. This keeps
      // the control reliable when the meeting container's initial inline
      // fullscreen styles have higher precedence in older cached builds.
      if (state.meetingMinimized) {
        els.container.style.inset = "auto 22px 22px auto";
        els.container.style.width = "min(440px, calc(100vw - 32px))";
        els.container.style.height = "260px";
        els.container.style.borderRadius = "12px";
      } else {
        els.container.style.inset = "0";
        els.container.style.width = "";
        els.container.style.height = "";
        els.container.style.borderRadius = "";
      }
      requestAnimationFrame(() => renderGrid());
    }
    const btn = document.getElementById("meeting-minimize-btn");
    if (btn) {
      btn.title = state.meetingMinimized ? "Restore meeting" : "Minimize meeting";
      btn.setAttribute("aria-label", btn.title);
      btn.setAttribute("aria-pressed", state.meetingMinimized ? "true" : "false");
    }
  }
  window.MeetingRoom.toggleMeetingMinimize = toggleMeetingMinimize;

  // ─── Raise hand ────────────────────────────────────────────────────────
  function toggleHand() {
    state.handRaised = !state.handRaised;
    updateControlUI();
    if (els.localHandBadge) {
      els.localHandBadge.style.display = state.handRaised ? "flex" : "none";
    }
    broadcastChatMessage(state.userName, {
      type: "hand",
      handUp: state.handRaised,
      name: state.userName,
    });
    addSystemMessage(state.userName + (state.handRaised ? " raised their hand" : " lowered their hand"));
    if (state.handRaised) toast("You raised your hand ✋", "success");
    renderParticipants();
  }

  function handlePeerHand(peerId, up, name) {
    const p = state.participants[peerId];
    if (!p) return;
    p.handUp = up;
    const tile = document.querySelector(`.meeting-remote-tile[data-peer="${peerId}"]`);
    const badge = tile && tile.querySelector(".meeting-hand-badge");
    if (badge) badge.style.display = up ? "flex" : "none";
    const who = name || p.name || "Someone";
    if (up) {
      addSystemMessage(who + " raised a hand");
      toast(who + " raised a hand ✋", "");
    } else {
      toast(who + " lowered their hand", "success");
    }
    renderParticipants();
  }

  // ─── Participants panel (Teams-style) ──────────────────────────────────
  function toggleParticipants() {
    state.participantsOpen = !state.participantsOpen;
    if (els.participantsPanel) {
      els.participantsPanel.style.display = state.participantsOpen ? "flex" : "none";
    }
    els.container.classList.toggle("participants-open", state.participantsOpen);
    if (state.participantsOpen && state.chatOpen) {
      state.chatOpen = false;
      if (els.chatDrawer) els.chatDrawer.style.display = "none";
      els.container.classList.remove("chat-open");
    }
    updateControlUI();
    if (state.participantsOpen) {
      if (els.inviteInput) {
        els.inviteInput.value = state.roomId || "";
      }
      if (els.participantSearch) els.participantSearch.value = state.participantSearch;
      renderParticipants();
    }
  }

  function renderParticipants() {
    if (!els.participantList) return;
    const peers = Object.keys(state.participants);
    const total = peers.length + 1;
    if (els.panelSectionTitle) els.panelSectionTitle.textContent = "In this meeting (" + total + ")";
    els.participantList.innerHTML = "";
    const query = (state.participantSearch || "").trim().toLowerCase();
    const selfVideoOn = state.isCamOn && !!(state.localStream && state.localStream.getVideoTracks().length);
    if (!query || state.userName.toLowerCase().includes(query)) {
      els.participantList.appendChild(makeParticipantRow(
        state.userName,
        state.isHost ? "Organizer" : "Participant",
        state.isMicOn,
        selfVideoOn,
        state.handRaised,
        true,
        null,
      ));
    }
    peers.forEach((pid) => {
      const p = state.participants[pid];
      const audioTrack = p.stream && p.stream.getAudioTracks()[0];
      const micOn = p.micOn !== undefined ? p.micOn : (audioTrack ? audioTrack.enabled !== false : true);
      const name = p.name || "Peer";
      if (query && !name.toLowerCase().includes(query)) return;
      const videoTrack = p.stream && p.stream.getVideoTracks()[0];
      const videoOn = p.videoOn !== undefined ? p.videoOn : !!(videoTrack && videoTrack.enabled !== false);
      els.participantList.appendChild(makeParticipantRow(name, "Guest", micOn, videoOn, !!p.handUp, false, pid));
    });
    updateChatRecipientOptions();
  }

  function makeParticipantRow(name, role, micOn, videoOn, handUp, isSelf, peerId) {
    const row = document.createElement("div");
    row.className = "meeting-participant-row";

    const avatar = document.createElement("div");
    avatar.className = "meeting-participant-avatar";
    avatar.textContent = initials(name);

    const info = document.createElement("div");
    info.className = "meeting-participant-info";
    const nm = document.createElement("div");
    nm.className = "meeting-participant-name";
    nm.textContent = name + (isSelf ? " (You)" : "");
    const roleEl = document.createElement("div");
    roleEl.className = "meeting-participant-role";
    roleEl.textContent = role;
    info.appendChild(nm);
    info.appendChild(roleEl);

    const status = document.createElement("div");
    status.className = "meeting-participant-status";
    if (handUp) {
      const hand = document.createElement("span");
      hand.className = "meeting-participant-hand";
      hand.textContent = "✋";
      status.appendChild(hand);
    }
    status.appendChild(makeParticipantMediaIcon("audio", micOn));
    status.appendChild(makeParticipantMediaIcon("video", videoOn));
    if (!isSelf && peerId) {
      const chatBtn = document.createElement("button");
      chatBtn.className = "meeting-participant-chat";
      chatBtn.title = "Chat with " + name;
      chatBtn.setAttribute("aria-label", "Chat with " + name);
      chatBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11.5a7.5 7.5 0 0 1-8 7.5 8.4 8.4 0 0 1-4-.9L4 20l1.2-3.1A7.2 7.2 0 0 1 4 12a7.5 7.5 0 0 1 8-7.5 7.5 7.5 0 0 1 8 7z"></path></svg>';
      chatBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        openParticipantChat(peerId, name);
      });
      status.appendChild(chatBtn);
    }
    // Only the persisted host gets a remove control. The API also verifies the
    // same role so hiding this button is not the security boundary.
    if (state.isHost && !isSelf && peerId) {
      const kickBtn = document.createElement("button");
      kickBtn.className = "meeting-participant-kick";
      kickBtn.title = "Remove from meeting";
      kickBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
      kickBtn.addEventListener("click", () => kickParticipant(peerId, name));
      status.appendChild(kickBtn);
    }

    row.appendChild(avatar);
    row.appendChild(info);
    row.appendChild(status);
    return row;
  }

  function makeMicOffIcon(className) {
    const span = document.createElement("span");
    span.className = className;
    span.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line><line class="meeting-slash" x1="4" y1="4" x2="20" y2="20"></line></svg>';
    return span;
  }

  function updateMicIndicators() {
    // Self tile label
    if (els.localTileMic) els.localTileMic.style.display = state.isMicOn ? "none" : "inline-flex";
    // Remote tile labels
    Object.keys(state.participants).forEach((pid) => {
      const p = state.participants[pid];
      const audioTrack = p.stream && p.stream.getAudioTracks()[0];
      const micOn = p.micOn !== undefined ? p.micOn : (audioTrack ? audioTrack.enabled !== false : true);
      const tile = document.querySelector(`.meeting-remote-tile[data-peer="${pid}"]`);
      if (!tile) return;
      let mic = tile.querySelector(".meeting-tile-mic");
      if (!mic) {
        mic = document.createElement("span");
        mic.className = "meeting-tile-mic";
        mic.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line><line class="meeting-slash" x1="4" y1="4" x2="20" y2="20"></line></svg>';
        const label = tile.querySelector(".meeting-user-label");
        if (label) label.appendChild(mic);
      }
      if (mic) mic.style.display = micOn ? "none" : "inline-flex";
    });
  }

  // ─── Emoji reactions ───────────────────────────────────────────────────
  function sendReaction(emoji) {
    closeMeetingMenus();
    showReactionBurst(emoji, null, state.userName);
    broadcastChatMessage(state.userName, { type: "reaction", emoji: emoji, name: state.userName });
    recordMeetingEvent("reaction", { from: state.userName, emoji: emoji });
  }

  function makeParticipantMediaIcon(kind, enabled) {
    const span = document.createElement("span");
    span.className = "meeting-participant-media-status " + (enabled ? "is-on" : "is-off");
    const label = kind === "audio" ? (enabled ? "Microphone on" : "Microphone off") : (enabled ? "Camera on" : "Camera off");
    span.title = label;
    span.setAttribute("aria-label", label);
    span.innerHTML = kind === "audio"
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8"></path>' + (enabled ? "" : '<path class="meeting-slash" d="M4 4l16 16"></path>') + '</svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 10l4.5-2.5v9L15 14"></path><rect x="3" y="6" width="12" height="12" rx="2"></rect>' + (enabled ? "" : '<path class="meeting-slash" d="M4 4l16 16"></path>') + '</svg>';
    return span;
  }

  // ─── More actions / Leave menus (Teams-style) ──────────────────────────
  function toggleMoreMenu() {
    if (!els.moreMenu) return;
    const open = els.moreMenu.classList.toggle("open");
    if (els.moreBtn) els.moreBtn.classList.toggle("active", open);
    if (els.leaveMenu) els.leaveMenu.classList.remove("open");
  }

  function toggleLeaveMenu(e) {
    if (e && e.stopPropagation) e.stopPropagation();
    if (!els.leaveMenu) return;
    const open = els.leaveMenu.classList.toggle("open");
    if (els.moreMenu) els.moreMenu.classList.remove("open");
    if (els.moreBtn) els.moreBtn.classList.remove("active");
  }

  function closeMeetingMenus() {
    if (els.moreMenu) els.moreMenu.classList.remove("open");
    if (els.moreBtn) els.moreBtn.classList.remove("active");
    if (els.leaveMenu) els.leaveMenu.classList.remove("open");
  }

  function showReactionBurst(emoji, peerId, name) {
    // All reactions pop up in one floating stage at the center-bottom of the
    // video area (Teams-style), labeled with who sent them.
    const host = els.videoArea;
    if (!host) return;
    let stage = host.querySelector(".meeting-reaction-stage");
    if (!stage) {
      stage = document.createElement("div");
      stage.className = "meeting-reaction-stage";
      host.appendChild(stage);
    }
    const span = document.createElement("span");
    span.className = "meeting-reaction-burst";
    const em = document.createElement("span");
    em.className = "meeting-reaction-emoji";
    em.textContent = emoji;
    const nm = document.createElement("span");
    nm.className = "meeting-reaction-name";
    nm.textContent = name || (peerId ? "Someone" : "You");
    span.appendChild(em);
    span.appendChild(nm);
    span.style.marginLeft = (Math.random() * 24 - 12) + "px";
    stage.appendChild(span);
    // Never let the stage overflow with stale emojis
    while (stage.children.length > 8) stage.firstElementChild.remove();
    setTimeout(() => span.remove(), 2400);
  }

  // ─── Speaking indicator (volume meter per remote peer) ─────────────────
  function attachVolumeMeter(peerId, stream) {
    const p = state.participants[peerId];
    if (!p || p.audioMeter) return;
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const levels = new Uint8Array(analyser.frequencyBinCount);
      const timer = setInterval(() => {
        analyser.getByteFrequencyData(levels);
        let sum = 0;
        for (let i = 0; i < levels.length; i++) sum += levels[i];
        const level = sum / levels.length / 255;
        const tile = document.querySelector(`.meeting-remote-tile[data-peer="${peerId}"]`);
        if (tile) tile.classList.toggle("talking", level > 0.05 && track.enabled);
      }, 200);
      p.audioMeter = { ctx: ctx, timer: timer };
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
    } catch (_) {}
  }

  function stopVolumeMeter(p) {
    if (p && p.audioMeter) {
      clearInterval(p.audioMeter.timer);
      try { p.audioMeter.ctx.close(); } catch (_) {}
      p.audioMeter = null;
    }
  }

  // ─── Meeting timer ─────────────────────────────────────────────────────
  let meetingStartTime = 0;
  let meetingTimer = null;

  function startMeetingTimer() {
    meetingStartTime = Date.now();
    if (meetingTimer) clearInterval(meetingTimer);
    meetingTimer = setInterval(updateMeetingTimer, 1000);
    updateMeetingTimer();
  }

  function stopMeetingTimer() {
    if (meetingTimer) clearInterval(meetingTimer);
    meetingTimer = null;
    if (els.timerEl) els.timerEl.textContent = "00:00";
  }

  function updateMeetingTimer() {
    if (!els.timerEl) return;
    const total = Math.max(0, Math.floor((Date.now() - meetingStartTime) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, "0");
    els.timerEl.textContent = (h ? pad(h) + ":" : "") + pad(m) + ":" + pad(s);
  }

  // ─── Fullscreen ────────────────────────────────────────────────────────
  // Uses the Fullscreen API (document-level) so the OS taskbar is hidden and
  // the whole app fills the display. The grid is %-based, so it reflows
  // automatically when the viewport changes.
  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {
        toast("Fullscreen is not supported here", "error");
      });
    }
  }

  document.addEventListener("fullscreenchange", () => {
    const active = !!document.fullscreenElement;
    if (els.fullscreenBtn) els.fullscreenBtn.classList.toggle("active", active);
    document.body.classList.toggle("meeting-fullscreen", active);
  });

  // ─── Host: remove participant ─────────────────────────────────────────
  async function kickParticipant(peerId, name) {
    if (!peerId) return;
    if (!state.isHost) {
      toast("Only the meeting host can remove participants", "error");
      return;
    }
    let response;
    try {
      response = await fetch("/api/meeting/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId: state.roomId, peerId: state.peerId, targetPeerId: peerId }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.status !== "ok") {
        toast(result.error || "Unable to remove participant", "error");
        return;
      }
    } catch (_) {
      toast("Unable to remove participant", "error");
      return;
    }
    // Notify the removed browser after the server has committed the removal.
    const p = state.participants[peerId];
    if (p && p.dataConnection && p.dataConnection.open) {
      try {
        p.dataConnection.send({ type: "force-leave" });
      } catch (_) {}
    }
    // Clean up locally
    removeParticipant(peerId);
    addSystemMessage((name || "Participant") + " was removed from the meeting");
    toast((name || "Participant") + " removed", "success");
  }
  window.MeetingRoom.kickParticipant = kickParticipant;

  // ─── End meeting ───────────────────────────────────────────────────────
  function showExitScreen(title, message) {
    if (!els.exitScreen) return;
    if (els.exitTitle) els.exitTitle.textContent = title;
    if (els.exitMessage) els.exitMessage.textContent = message;
    els.exitScreen.style.display = "flex";
  }

  function dismissExitScreen() {
    if (els.exitScreen) els.exitScreen.style.display = "none";
    if (els.modal) els.modal.classList.remove("active");
    if (els.container) {
      els.container.classList.remove("meeting-minimized", "chat-open", "presentation-mode", "screen-share-clean", "focus-mode");
      els.container.style.inset = "0";
      els.container.style.width = "";
      els.container.style.height = "";
      els.container.style.borderRadius = "";
      els.container.style.display = "none";
    }
    state.meetingMinimized = false;
    // Return to the actual CodeLeaf welcome view instead of leaving the user
    // behind an empty meeting layer after the overlay is dismissed.
    if (typeof window.showView === "function") window.showView("intro");
    const welcomeButton = document.getElementById("act-welcome");
    if (welcomeButton) welcomeButton.classList.add("active");
    window.scrollTo(0, 0);
  }

  function completeMeetingExit(title, message) {
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
    document.body.classList.remove("meeting-fullscreen");
    disconnectPeer();
    if (els.modal) els.modal.classList.remove("active");
    if (els.chatDrawer) els.chatDrawer.style.display = "none";
    state.chatOpen = false;
    hideStatus();
    showExitScreen(title, message);
  }

  function handleMeetingEnded(endedBy) {
    if (!state.callActive) return;
    completeMeetingExit(
      "Meeting ended by the host",
      "The host ended this meeting for everyone. Thanks for joining CodeLeaf Meeting."
    );
    toast("Meeting ended by " + (endedBy || "the host"), "success");
  }

  async function endMeeting(endForEveryone) {
    if (!state.callActive && !state.peer) return;
    closeMeetingMenus();

    if (endForEveryone) {
      if (!state.isHost) {
        toast("Only the meeting host can end the meeting for everyone", "error");
        return;
      }
      try {
        const response = await fetch("/api/meeting/end", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roomId: state.roomId, peerId: state.peerId }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.status !== "ok") {
          toast(data.error || "Unable to end the meeting", "error");
          return;
        }
        // Notify connected clients only after the server has committed the
        // closed state. Clients that miss this message still discover the
        // same state through the status poll.
        broadcastChatMessage(null, { type: "meeting-ended", endedBy: state.userName });
        completeMeetingExit(
          "Meeting ended by the host",
      "Thanks for joining CodeLeaf Meeting. The meeting has ended for everyone."
        );
      } catch (_) {
        toast("Unable to end the meeting. Please try again.", "error");
      }
      return;
    }

    notifyMeetingLeave();
    completeMeetingExit(
      "Thanks for joining CodeLeaf Meeting",
      "You have left the meeting. We hope to see you again soon."
    );
    toast("You left the meeting", "success");
  }

  window.MeetingRoom.dismissExitScreen = dismissExitScreen;
  if (els.exitReturnBtn) els.exitReturnBtn.addEventListener("click", dismissExitScreen);

  window.MeetingRoom.endMeeting = endMeeting;

  // ─── Keyboard shortcuts ────────────────────────────────────────────────
  function onGlobalKeydown(e) {
    // Browser/application shortcuts must keep their native meaning. In
    // particular Ctrl/Cmd+C copies selected text; it must never open chat.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Don't trigger if typing in an input
    if (
      e.target &&
      (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable)
    ) {
      // Allow Enter in chat input to send (handled separately)
      if (e.target === els.chatInput) return;
      return;
    }

    if (!state.callActive) {
      if (e.key === "m" || e.key === "M") {
        toggleMeeting();
        e.preventDefault();
      }
      return;
    }

    switch (e.key.toLowerCase()) {
      case "m":
        toggleMic();
        e.preventDefault();
        break;
      case "v":
        toggleCamera();
        e.preventDefault();
        break;
      case "s":
        toggleScreenShare();
        e.preventDefault();
        break;
      case "e":
        toggleEditorShare();
        e.preventDefault();
        break;
      case "c":
        toggleChat();
        e.preventDefault();
        break;
      case "h":
        toggleHand();
        e.preventDefault();
        break;
      case "p":
        toggleParticipants();
        e.preventDefault();
        break;
      case "f":
        toggleFullscreen();
        e.preventDefault();
        break;
      case "escape":
        if (state.chatOpen) {
          toggleChat();
          e.preventDefault();
        } else if (state.participantsOpen) {
          toggleParticipants();
          e.preventDefault();
        } else if ((els.moreMenu && els.moreMenu.classList.contains("open")) ||
                   (els.leaveMenu && els.leaveMenu.classList.contains("open"))) {
          closeMeetingMenus();
          e.preventDefault();
        }
        break;
    }
  }

  // ─── Init ──────────────────────────────────────────────────────────────
  let identityRevealTimer = null;
  let leaveRevealTimer = null;

  function revealMeetingChrome(event) {
    if (!els.container || !state.callActive) return;
    els.container.classList.add("meeting-show-identity");
    clearTimeout(identityRevealTimer);
    identityRevealTimer = setTimeout(() => {
      if (els.container) els.container.classList.remove("meeting-show-identity");
    }, 1800);

    const rect = els.container.getBoundingClientRect();
    const nearBottom = event.clientY >= rect.bottom - 132;
    const nearRight = event.clientX >= rect.right - 340;
    if (nearBottom && nearRight) {
      els.container.classList.add("meeting-show-leave");
      clearTimeout(leaveRevealTimer);
      leaveRevealTimer = setTimeout(() => {
        if (els.container) els.container.classList.remove("meeting-show-leave");
      }, 1800);
    } else if (!event.target.closest(".meeting-leave-wrap")) {
      els.container.classList.remove("meeting-show-leave");
    }
  }

  function init() {
    els.chatInput && els.chatInput.addEventListener("keydown", onChatKeydown);
    document.addEventListener("keydown", onGlobalKeydown);
    els.chatRecipient && els.chatRecipient.addEventListener("change", (event) => {
      const peerId = event.target.value || "";
      if (!peerId) {
        clearChatTarget();
        return;
      }
      const participant = state.participants[peerId];
      if (participant) {
        state.chatTargetPeerId = peerId;
        state.chatTargetName = participant.name || "Participant";
        updateChatTargetUI();
      }
    });
    els.participantSearch && els.participantSearch.addEventListener("input", (event) => {
      state.participantSearch = event.target.value || "";
      renderParticipants();
    });
    els.container && els.container.addEventListener("mousemove", revealMeetingChrome);

    // Draggable self-view + click-to-swap
    setupLocalTileInteractions();

    // Close the More / Leave menus when clicking anywhere outside them
    document.addEventListener("click", (e) => {
      if (els.moreMenu && els.moreMenu.classList.contains("open") && !e.target.closest(".meeting-more-wrap")) {
        closeMeetingMenus();
      }
      if (els.leaveMenu && els.leaveMenu.classList.contains("open") && !e.target.closest(".meeting-leave-wrap")) {
        closeMeetingMenus();
      }
    });

    // Enter key in join form
    els.roomIdInput && els.roomIdInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") joinMeeting();
    });
    els.userNameInput && els.userNameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        els.roomIdInput.focus();
      }
    });

    // Enter key in create form
    els.createNameInput && els.createNameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (els.createTitleInput) els.createTitleInput.focus();
      }
    });
    els.createTitleInput && els.createTitleInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        createMeeting();
      }
    });
    els.createRoomInput && els.createRoomInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") createMeeting();
    });

    // Invite URLs arrive at the SPA's welcome view. Open the Join Meeting
    // flow automatically and preserve the room ID from the URL.
    openInviteJoin();
  }

  // Auto-init when DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  return {
    toggleMeeting,
    closeMeeting,
    showChoiceScreen,
    showCreateScreen,
    showJoinScreen,
    createMeeting,
    joinMeeting,
    generateRoomId,
    copyRoomId,
    openOthers,
    closeOthers,
    othersPage,
    toggleMic,
    toggleCamera,
    toggleScreenShare,
    toggleEditorShare,
    toggleChat,
    sendChatMessage,
    endMeeting,
    toggleHand,
    sendReaction,
    toggleFullscreen,
    exitSpotlight,
    toggleParticipants,
    toggleMoreMenu,
    toggleLeaveMenu,
    copyRoomLink,
    clearChatTarget,
    openParticipantChat,
  };
})();
