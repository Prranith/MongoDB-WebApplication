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
    peerId: "",
    peer: null,
    userName: "Developer",
    localStream: null,       // camera+audio
    screenStream: null,      // screen share
    screenCalls: {},         // peerId -> dedicated screen-share MediaConnection (no-camera fallback)
    isMicOn: true,
    isCamOn: true,
    isScreenSharing: false,
    screenPeerId: "",          // peerId whose stream is in the screen stage
    isConnected: false,
    participants: {},        // peerId -> { name, stream, dataConnection }
    callActive: false,
    chatOpen: false,
    participantsOpen: false,
    handRaised: false,
    spotlightId: null,     // "self" | peerId | null — user pinned as MY main stage
    localTileMoved: false, // true if the last PiP gesture was a drag
    joining: false,        // true while a join/create call is starting
    _prevPeers: 0,
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
    participantCount: $("meeting-participant-count"),
    micBtn:       $("meeting-mic-btn"),
    camBtn:       $("meeting-cam-btn"),
    shareBtn:     $("meeting-share-btn"),
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
    timerEl:      $("meeting-timer"),
    localHandBadge: $("local-hand-badge"),
    localTileMic: $("local-tile-mic"),
    screenStage: $("meeting-screen-stage"),
    screenVideo: $("meeting-screen-video"),
    screenLabel: $("meeting-screen-label"),
    fullscreenBtn: $("meeting-fullscreen-btn"),
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

  function copyRoomId() {
    if (!state.roomId) return;
    navigator.clipboard.writeText(state.roomId).then(() => {
      toast("Room ID copied to clipboard: " + state.roomId, "success");
    }).catch(() => {
      toast("Room ID: " + state.roomId, "success");
    });
  }

  // ─── Controls ──────────────────────────────────────────────────────────
  function updateControlUI() {
    // Mic / camera off → strike-through slash over the icon (Teams style)
    if (els.micBtn) els.micBtn.classList.toggle("off", !state.isMicOn);
    if (els.camBtn) els.camBtn.classList.toggle("off", !state.isCamOn);
    if (els.shareBtn) els.shareBtn.classList.toggle("active", state.isScreenSharing);
    if (els.chatBtn) els.chatBtn.classList.toggle("active", state.chatOpen);
    if (els.participantsBtn) els.participantsBtn.classList.toggle("active", state.participantsOpen);
    if (els.handBtn) els.handBtn.classList.toggle("hand-up", state.handRaised);
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
  window.addEventListener("beforeunload", (e) => {
    if (state.callActive && state.roomId) {
      fetch("/api/meeting/leave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId: state.roomId, peerId: state.peerId }),
      }).catch(() => {});
    }
    disconnectPeer();
  });

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
    // Always present a room ID so the host can share it immediately
    if (!els.createRoomInput.value.trim()) {
      els.createRoomInput.value = generateRoomIdText();
    }
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
    const urlParams = new URLSearchParams(window.location.search);
    const urlRoom = urlParams.get("room");
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
    copyRoomId,
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
    state.userName = name;

    showStatus("Creating room...", "success");
    setJoining(true);
    try {
      const res = await fetch("/api/meeting/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostName: name }),
      });
      const data = await res.json();
      if (data.status !== "ok") {
        showStatus("Failed to create room: " + (data.error || "unknown"), "error");
        setJoining(false);
        return;
      }
      const roomId = data.roomId;
      els.createRoomInput.value = roomId;
      localStorage.setItem("meeting_last_room", roomId);
      hideStatus();
      await startCall(roomId, name);
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
    localStorage.setItem("meeting_last_room", roomId);
    hideStatus();
    setJoining(true);
    await startCall(roomId, name);
  }

  window.MeetingRoom.joinMeeting = joinMeeting;

  // ─── PeerJS / WebRTC ───────────────────────────────────────────────────

  // Capture settings tuned for maximum clarity: ask for 1080p@30 (the browser
  // falls back to whatever the camera actually supports) and enable the full
  // audio processing suite so speech stays crisp.
  const VIDEO_CONSTRAINTS = {
    width: { ideal: 3840, max: 3840 },
    height: { ideal: 2160, max: 2160 },
    frameRate: { ideal: 60, max: 60 },
    facingMode: "user",
  };
  const AUDIO_CONSTRAINTS = {
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
            maxBitrate: s.track.kind === "video" ? (videoBitrate || 10000000) : 128000,
            maxFramerate: s.track.kind === "video" ? 60 : undefined,
          })
        );
        s.setParameters(params).catch(() => {});
      });
    } catch (_) {}
  }

  async function startCall(roomId, name) {
    state.roomId = roomId;
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
      setJoining(false);

      // Open the meeting UI
      if (els.modal) els.modal.classList.remove("active");
      els.container.style.display = "flex";
      els.roomLabel.textContent = "Room: " + state.roomId;
      updateLocalInitials();
      updateParticipantCount();
      updateControlUI();
      startMeetingTimer();

      // Join room on backend with real peer ID
      fetch("/api/meeting/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId: state.roomId, participantName: state.userName, peerId: state.peerId }),
      })
      .then((r) => r.json())
      .then((data) => {
        if (data && data.hostPeerId && data.hostPeerId !== state.peerId) {
          connectToPeer(data.hostPeerId);
        }
        // Start peer discovery polling to find all other participants in the room
        startPeerDiscovery(state.roomId);
      })
      .catch(() => {});

      toast("Connected to " + state.roomId, "success");
      addSystemMessage("You joined " + state.roomId);
    });

    state.peer.on("call", (call) => {
      handleIncomingCall(call);
    });

    // Data connections for chat / signaling
    state.peer.on("connection", (conn) => {
      handleDataConnection(conn);
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
    setInterval(() => {
      if (state.callActive && state.roomId && state.peer && !state.peer.destroyed) {
        fetch("/api/meeting/join", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roomId: state.roomId, participantName: state.userName, peerId: state.peerId }),
        }).catch(() => {});
      }
    }, 15000);
  }

  // ─── Peer Discovery ────────────────────────────────────────────────────
  let peerDiscoveryTimer = null;
  let dragState = null; // active PiP drag session
  const pendingCalls = new Set(); // track peer IDs we're currently connecting to
  let _pendingHostConnect = false; // true while we expect an outgoing call to complete

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

    // While screen sharing, new peers get the screen stream right away.
    const stream = state.isScreenSharing && state.screenStream
      ? state.screenStream
      : (state.localStream || new MediaStream());
    const call = state.peer.call(targetPeerId, stream);
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
        console.warn("[Meeting] Call error with peer", targetPeerId, err);
        // If the call fails, clean up the participant entry so the UI
        // doesn't show a stale tile and the global handler doesn't
        // re-surface a peer-unavailable toast.
        if (state.participants[targetPeerId]) {
          delete state.participants[targetPeerId];
        }
      });
    }

    const conn = state.peer.connect(targetPeerId);
    if (conn) {
      conn.on("error", (err) => {
        _pendingHostConnect = false;
        console.warn("[Meeting] Data connection error to", targetPeerId, err);
      });
      handleDataConnection(conn);
    }
  }

  function handleIncomingCall(call) {
    // Answer with local stream if available
    if (state.localStream) {
      call.answer(state.localStream);
    } else {
      // Create a dummy stream with no tracks so the call can be established
      const dest = new MediaStream();
      call.answer(dest);
    }
    boostCallBitrates(call);

    call.on("stream", (remoteStream) => {
      handleRemoteStream(call.peer, remoteStream, call);
    });

    call.on("close", () => {
      // A dedicated screen-share call may close while the peer's camera call
      // is still alive — only drop the participant when no media call remains.
      const otherCall = getActiveMediaCalls().some((c) => c !== call && c.peer === call.peer);
      if (!otherCall) {
        removeParticipant(call.peer);
      } else {
        const p = state.participants[call.peer];
        if (p) p.stream = null; // screen ended; tile falls back to initials
        if (state.screenPeerId === call.peer) clearScreenStage();
        updateParticipantCount();
      }
    });

    call.on("error", (err) => {
      console.warn("[Meeting] Call error from", call.peer, err);
    });
  }

  function handleRemoteStream(peerId, stream, call) {
    // Detect screen shares reliably: Chrome exposes displaySurface on
    // getDisplayMedia captures; fall back to resolution/label heuristics.
    const vTrack = stream.getVideoTracks()[0];
    const settings = vTrack && vTrack.getSettings ? (vTrack.getSettings() || {}) : {};
    const isScreen = !!vTrack && (
      settings.displaySurface === "monitor" ||
      settings.displaySurface === "window" ||
      settings.displaySurface === "browser" ||
      (settings.width || 0) > 1280 ||
      !!(vTrack.label && vTrack.label.toLowerCase().includes("screen"))
    );

    state.participants[peerId] = state.participants[peerId] || {};
    state.participants[peerId].stream = stream;
    state.participants[peerId].call = call;
    state.participants[peerId].isScreen = isScreen;
    state.participants[peerId].name = state.participants[peerId].name || "Peer";

    boostCallBitrates(call);
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
      if (!state.participants[peerId]) {
        state.participants[peerId] = { name: "Peer" };
      }
      state.participants[peerId].dataConnection = conn;

      // Introduce ourselves so the remote side shows our real name
      try {
        conn.send({ type: "hello", name: state.userName });
      } catch (_) {}

      conn.on("data", (data) => {
        if (!data || typeof data !== "object") return;
        if (data.type === "hello" && data.name) {
          if (!state.participants[peerId]) {
            state.participants[peerId] = {};
          }
          state.participants[peerId].name = data.name;
          renderRemoteVideo(peerId);
        } else if (data.type === "chat") {
          addChatMessage(data.from || peerId, data.message, data.system || false);
        } else if (data.type === "screen-toggle") {
          // The peer swapped its camera/screen track; reflect it in the UI
          const p = state.participants[peerId];
          if (p) {
            p.isScreen = !!data.sharing;
            if (data.sharing && p.stream) {
              showScreenInStage(peerId, p.stream, data.name || p.name);
            } else if (!data.sharing) {
              renderRemoteVideo(peerId);
              if (!Object.values(state.participants).some((x) => x.isScreen)) {
                clearScreenStage();
              }
            }
          }
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
        }
      });

      conn.on("close", () => {
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
    pendingCalls.clear();
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

    Object.values(state.participants).forEach((p) => stopVolumeMeter(p));
    state.isMicOn = true;
    state.isCamOn = true;
    state.isScreenSharing = false;
    state.callActive = false;
    state.isConnected = false;
    state.participants = {};
    state.handRaised = false;
    state.spotlightId = null;
    state._prevPeers = 0;
    stopMeetingTimer();
    // Reset UI
    els.container.style.display = "none";
    els.container.classList.remove("self-main", "spotlight", "focus-mode");
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
    els.remoteGrid.classList.remove("gallery", "many", "g3", "strip");
    els.localVideo.srcObject = null;
    els.localInitials.style.display = "none";
    if (els.localHandBadge) els.localHandBadge.style.display = "none";
    if (els.localTileMic) els.localTileMic.style.display = "none";
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
      video.style.display = "block";
      initialsOverlay.style.display = "none";
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
      els.localTile.style.display = spotlight && state.spotlightId === "self" ? "none" : "";
      els.localTile.title = gallery
        ? "Double-click to spotlight your video"
        : "Drag to move · Double-click to spotlight";
    }

    els.remoteGrid.classList.toggle("gallery", gallery);
    els.remoteGrid.classList.toggle("strip", spotlight);
    const many = gallery && total > 4;
    els.remoteGrid.classList.toggle("many", many);
    els.remoteGrid.classList.toggle("g3", gallery && total === 3);

    // Rebuild remote tiles + others tile (filmstrip excludes the spotlighted
    // user — they own the stage).
    els.remoteGrid.querySelectorAll(".meeting-remote-tile, .meeting-others-tile").forEach((t) => t.remove());
    const strip = spotlight
      ? peers.filter((pid) => pid !== state.spotlightId)
      : state.screenPeerId
        ? peers.filter((pid) => pid !== state.screenPeerId)
        : peers;
    const shown = many ? strip.slice(0, 2) : strip;
    shown.forEach((pid) => {
      const p = state.participants[pid];
      if (!p) return;
      els.remoteGrid.appendChild(makeRemoteTile(pid, p));
    });
    if (many) els.remoteGrid.appendChild(makeOthersTile(total - 3));
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
    stopVolumeMeter(state.participants[peerId]);
    delete state.participants[peerId];
    const tile = document.querySelector(`.meeting-remote-tile[data-peer="${peerId}"]`);
    if (tile) {
      // Stop tracks before removing
      const video = tile.querySelector("video");
      if (video && video.srcObject) {
        video.srcObject.getTracks().forEach((t) => t.stop());
      }
    }
    if (othersOpen) closeOthers();
    updateParticipantCount();

    // Clear the screen stage if the presenter left
    if (state.screenPeerId === peerId) {
      clearScreenStage();
    }
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
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: "always" },
        audio: true, // ask for system/tab audio (browser shows a checkbox)
      });

      // Detect if user clicked "Stop sharing" in the browser dialog
      const track = stream.getVideoTracks()[0];
      track.addEventListener("ended", () => {
        stopScreenShare();
        toast("Screen share stopped by user", "success");
      });

      state.screenStream = stream;
      state.isScreenSharing = true;

      // Send the screen track to all connected peers via sender.replaceTrack.
      // Peers whose call has no video sender (e.g. they joined with no camera)
      // get a dedicated screen call instead so sharing always reaches them.
      const missingPeers = replaceTrackForPeers("video", stream.getVideoTracks()[0] || null);
      state.screenCalls = {};
      missingPeers.forEach((pid) => {
        if (pid === state.peerId || state.screenCalls[pid]) return;
        try {
          const sc = state.peer.call(pid, stream);
          if (sc) {
            state.screenCalls[pid] = sc;
            boostCallBitrates(sc, 4000000);
          }
        } catch (_) {}
      });

      // High bitrate for the screen track on every established call
      getActiveMediaCalls().forEach((c) => boostCallBitrates(c, 4000000));

      // Mix shared system audio with the mic for remote peers
      startAudioMix(stream);

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

    // Restore the camera track to peers
    const cameraTrack = state.localStream && state.localStream.getVideoTracks()[0];
    replaceTrackForPeers("video", cameraTrack || null);

    // Restore the plain microphone to peers
    stopAudioMix();

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
      els.screenVideo.play().catch(() => {});
    }
    if (els.screenLabel) {
      els.screenLabel.textContent =
        peerId === state.peerId
          ? "You're presenting"
          : (name || "Someone") + " is presenting";
    }
    if (els.screenStage) els.screenStage.style.display = "flex";
    document.body.classList.add("presentation-mode");
    els.container.classList.add("presentation-mode");
    renderGrid();
  }

  function clearScreenStage() {
    state.screenPeerId = "";
    if (els.screenVideo) els.screenVideo.srcObject = null;
    if (els.screenStage) els.screenStage.style.display = "none";
    document.body.classList.remove("presentation-mode");
    els.container.classList.remove("presentation-mode");
    renderGrid();
  }

  // ─── Chat ──────────────────────────────────────────────────────────────
  function toggleChat() {
    state.chatOpen = !state.chatOpen;
    els.chatDrawer.style.display = state.chatOpen ? "flex" : "none";
    updateControlUI();
    if (state.chatOpen) {
      els.chatInput.focus();
    }
  }

  window.MeetingRoom.toggleChat = toggleChat;

  function addChatMessage(from, message, isSystem) {
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

  function sendChatMessage() {
    const input = els.chatInput;
    if (!input) return;
    const msg = input.value.trim();
    if (!msg) return;

    // Send to all peers via data connections
    broadcastChatMessage(state.userName, { type: "chat", message: msg });

    // Also add locally
    addChatMessage(state.userName, msg, false);
    input.value = "";
  }

  window.MeetingRoom.sendChatMessage = sendChatMessage;

  function broadcastChatMessage(from, payload) {
    if (!state.peer) return;
    const data = Object.assign({}, payload, { from: from || state.userName });
    Object.values(state.participants).forEach((p) => {
      if (p.dataConnection && p.dataConnection.open) {
        try {
          p.dataConnection.send(data);
        } catch (_) {}
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
    els.localTile.addEventListener("click", () => {
      if (state.spotlightId && state.spotlightId !== "self" && !state.screenPeerId) {
        setSpotlight("self");
      }
    });
  }

  // ─── Spotlight: pin any user (incl. self) as MY main stage ────────────
  function setSpotlight(id) {
    if (!id || state.screenPeerId || state.spotlightId === id) return;
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
      els.screenVideo.play().catch(() => {});
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
    const minBtn = document.getElementById("meeting-local-minimize");
    const maxBtn = document.getElementById("meeting-local-maximize");
    if (minBtn) minBtn.style.display = isMinimized ? "none" : "flex";
    if (maxBtn) maxBtn.style.display = isMinimized ? "flex" : "none";
    if (isMinimized) {
      toast("Self-view minimized — click the tile to restore", "success");
    }
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
  window.MeetingRoom.toggleFocusMode = toggleFocusMode;

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
    updateControlUI();
    if (state.participantsOpen) {
      if (els.inviteInput) {
        els.inviteInput.value = state.roomId || "";
      }
      renderParticipants();
    }
  }

  function renderParticipants() {
    if (!els.participantList) return;
    const peers = Object.keys(state.participants);
    const total = peers.length + 1;
    if (els.panelSectionTitle) els.panelSectionTitle.textContent = "In this meeting (" + total + ")";
    els.participantList.innerHTML = "";
    els.participantList.appendChild(makeParticipantRow(state.userName, "Organizer", state.isMicOn, state.handRaised, true));
    peers.forEach((pid) => {
      const p = state.participants[pid];
      const audioTrack = p.stream && p.stream.getAudioTracks()[0];
      const micOn = p.micOn !== undefined ? p.micOn : (audioTrack ? audioTrack.enabled !== false : true);
      els.participantList.appendChild(makeParticipantRow(p.name || "Peer", "Guest", micOn, !!p.handUp, false));
    });
  }

  function makeParticipantRow(name, role, micOn, handUp, isSelf) {
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
    if (!micOn) {
      status.appendChild(makeMicOffIcon("meeting-participant-mic"));
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
  });

  // ─── End meeting ───────────────────────────────────────────────────────
  function endMeeting() {
    if (state.roomId) {
      fetch("/api/meeting/leave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId: state.roomId, peerId: state.peerId }),
      }).catch(() => {});
    }

    addSystemMessage("You left the meeting");
    disconnectPeer();
    if (els.modal) els.modal.classList.remove("active");
    els.container.style.display = "none";
    els.chatDrawer.style.display = "none";
    state.chatOpen = false;
    hideStatus();
    toast("Meeting ended", "success");
  }

  window.MeetingRoom.endMeeting = endMeeting;

  // ─── Keyboard shortcuts ────────────────────────────────────────────────
  function onGlobalKeydown(e) {
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
  function init() {
    els.chatInput && els.chatInput.addEventListener("keydown", onChatKeydown);
    document.addEventListener("keydown", onGlobalKeydown);

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
        els.createRoomInput && els.createRoomInput.focus();
      }
    });
    els.createRoomInput && els.createRoomInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") createMeeting();
    });
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
  };
})();
