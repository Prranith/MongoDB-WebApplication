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
    isMicOn: true,
    isCamOn: true,
    isScreenSharing: false,
    isConnected: false,
    participants: {},        // peerId -> { name, stream, dataConnection }
    callActive: false,
    chatOpen: false,
  };

  // ─── DOM refs ──────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const els = {
    joinBtn:      $("btn-join-meeting"),
    modal:        $("meeting-modal"),
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
    ctrlBar:      document.querySelector(".meeting-control-bar"),
  };

  // ─── Helpers ───────────────────────────────────────────────────────────
  function initials(name) {
    if (!name) return "?";
    const parts = name.trim().split(/[\s_-]+/).filter(Boolean);
    if (parts.length === 0) return "?";
    if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  }

  function showStatus(msg, type) {
    if (!els.statusMsg) return;
    els.statusMsg.textContent = msg;
    els.statusMsg.className = "meeting-status-msg " + (type || "");
    els.statusMsg.style.display = "block";
  }

  function hideStatus() {
    if (!els.statusMsg) return;
    els.statusMsg.style.display = "none";
  }

  function toast(msg, type) {
    const container = document.getElementById("toast-container");
    if (!container) return;
    const el = document.createElement("div");
    el.className = "toast" + (type ? " " + type : "");
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => {
      el.style.transition = "opacity 0.3s, transform 0.3s";
      el.style.opacity = "0";
      el.style.transform = "translateY(8px) scale(0.96)";
      setTimeout(() => el.remove(), 350);
    }, 3500);
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
  }

  function setControlButton(btn, on, label) {
    if (!btn) return;
    btn.classList.toggle("active", !!on);
    btn.classList.toggle("muted", !on && btn !== els.micBtn && btn !== els.camBtn);
    const lbl = btn.querySelector(".meeting-ctrl-label");
    if (lbl && label) lbl.textContent = label;
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

  // ─── Modal / UI ────────────────────────────────────────────────────────
  function toggleMeeting() {
    if (state.callActive) {
      endMeeting();
      return;
    }
    els.modal.style.display = els.modal.style.display === "flex" ? "none" : "flex";
    if (els.modal.style.display === "flex") {
      els.userNameInput.value = state.userName || "Developer";
      const existing = localStorage.getItem("meeting_last_room");
      if (existing) els.roomIdInput.value = existing;
      els.userNameInput.focus();
      els.userNameInput.select();
    }
  }

  function closeMeeting() {
    els.modal.style.display = "none";
    hideStatus();
  }

  window.MeetingRoom = {
    toggleMeeting,
    closeMeeting,
  };

  function generateRoomId() {
    const id = "MTG-" + Math.random().toString(36).substring(2, 8).toUpperCase();
    els.roomIdInput.value = id;
    els.roomIdInput.focus();
    els.roomIdInput.select();
  }

  window.MeetingRoom.generateRoomId = generateRoomId;

  // ─── Join flow ─────────────────────────────────────────────────────────
  async function joinMeeting() {
    const name = els.userNameInput.value.trim() || "Developer";
    let roomId = els.roomIdInput.value.trim().toUpperCase();

    if (!name) {
      showStatus("Please enter your name.", "error");
      els.userNameInput.focus();
      return;
    }

    state.userName = name;

    // Create room if empty
    if (!roomId) {
      showStatus("Creating room...", "success");
      try {
        const res = await fetch("/api/meeting/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hostName: name }),
        });
        const data = await res.json();
        if (data.status !== "ok") {
          showStatus("Failed to create room: " + (data.error || "unknown"), "error");
          return;
        }
        roomId = data.roomId;
        els.roomIdInput.value = roomId;
        localStorage.setItem("meeting_last_room", roomId);
      } catch (err) {
        showStatus("Network error creating room.", "error");
        return;
      }
    }

    // Validate room exists / join
    try {
      const joinRes = await fetch("/api/meeting/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId, participantName: name, peerId: "" }),
      });
      const joinData = await joinRes.json();
      if (joinData.status !== "ok") {
        showStatus("Cannot join room: " + (joinData.error || "unknown"), "error");
        return;
      }
    } catch (err) {
      showStatus("Network error joining room.", "error");
      return;
    }

    hideStatus();
    await startCall(roomId, name);
  }

  window.MeetingRoom.joinMeeting = joinMeeting;

  // ─── PeerJS / WebRTC ───────────────────────────────────────────────────
  async function startCall(roomId, name) {
    state.roomId = roomId;
    state.peerId = "peer-" + Math.random().toString(36).substring(2, 10);

    // Close any previous call
    disconnectPeer();

    // Get local media
    try {
      state.localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        toast("Camera/microphone access was blocked. Check browser permissions.", "error");
        showStatus("Media permission denied. Please allow camera & microphone.", "error");
      } else if (err.name === "NotFoundError") {
        toast("No camera or microphone found on this device.", "error");
        showStatus("No media devices found.", "error");
      } else {
        toast("Could not access media: " + err.message, "error");
        showStatus("Media error: " + err.message, "error");
      }
      // Still allow call without media — show initials avatar
      state.isCamOn = false;
      state.isMicOn = false;
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
      return;
    }

    // Attach local stream to peer so remote peers can call us
    if (state.peer && state.localStream) {
      state.peer._stream = state.localStream;
    }

    state.peer.on("open", (peerId) => {
      state.peerId = peerId;
      state.isConnected = true;
      state.callActive = true;

      // Open the meeting UI
      els.modal.style.display = "none";
      els.container.style.display = "flex";
      els.roomLabel.textContent = "Room: " + state.roomId;
      updateLocalInitials();
      updateParticipantCount();
      updateControlUI();

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

    state.peer.on("error", (err) => {
      console.warn("[Meeting] PeerJS error:", err.type, err.message);
      if (err.type === "peer-unavailable") {
        toast("Peer unavailable. Share the Room ID and try again.", "error");
      }
    });

    // Heartbeat: re-join on reconnect
    setInterval(() => {
      if (state.callActive && state.roomId) {
        fetch("/api/meeting/join", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roomId: state.roomId, participantName: state.userName, peerId: state.peerId }),
        }).catch(() => {});
      }
    }, 15000);
  }

  function connectToPeer(targetPeerId) {
    if (!state.peer || !targetPeerId) return;
    if (state.participants[targetPeerId] && state.participants[targetPeerId].call) return;

    const stream = state.localStream || new MediaStream();
    const call = state.peer.call(targetPeerId, stream);
    if (call) {
      call.on("stream", (remoteStream) => {
        handleRemoteStream(targetPeerId, remoteStream, call);
      });
      call.on("close", () => {
        removeParticipant(targetPeerId);
      });
      call.on("error", (err) => {
        console.warn("[Meeting] Call error with peer", targetPeerId, err);
      });
    }

    const conn = state.peer.connect(targetPeerId);
    if (conn) {
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

    call.on("stream", (remoteStream) => {
      handleRemoteStream(call.peer, remoteStream, call);
    });

    call.on("close", () => {
      removeParticipant(call.peer);
    });

    call.on("error", (err) => {
      console.warn("[Meeting] Call error from", call.peer, err);
    });
  }

  function handleRemoteStream(peerId, stream, call) {
    // Detect if this is a screen share (larger, or from getDisplayMedia)
    const isScreen = stream.getVideoTracks().length > 0 &&
      stream.getVideoTracks()[0].getSettings && (
        stream.getVideoTracks()[0].getSettings().width > 1280 ||
        stream.getVideoTracks()[0].label && stream.getVideoTracks()[0].label.includes("screenshare")
      );

    state.participants[peerId] = state.participants[peerId] || {};
    state.participants[peerId].stream = stream;
    state.participants[peerId].call = call;
    state.participants[peerId].isScreen = isScreen;
    state.participants[peerId].name = state.participants[peerId].name || "Peer";

    renderRemoteVideo(peerId);

    // If this peer is sharing screen, switch to presentation mode
    if (isScreen && !state.isScreenSharing) {
      enterPresentationMode(peerId);
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

      conn.on("data", (data) => {
        if (data && data.type === "chat") {
          addChatMessage(data.from || peerId, data.message, data.system || false);
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

  function disconnectPeer() {
    if (state.peer) {
      try {
        // Close all calls
        if (state.peer._calls) {
          Object.values(state.peer._calls).forEach((c) => {
            try { c.close(); } catch (_) {}
          });
        }
        // Close all data connections
        if (state.peer._connections) {
          Object.values(state.peer._connections).forEach((c) => {
            try { c.close(); } catch (_) {}
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

    state.isMicOn = true;
    state.isCamOn = true;
    state.isScreenSharing = false;
    state.callActive = false;
    state.isConnected = false;
    state.participants = {};

    // Reset UI
    els.container.style.display = "none";
    els.remoteGrid.innerHTML = "";
    els.localVideo.srcObject = null;
    els.localInitials.style.display = "none";
    leavePresentationMode();
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

  // ─── Remote video tiles ────────────────────────────────────────────────
  function renderRemoteVideo(peerId) {
    const p = state.participants[peerId];
    if (!p) return;

    let tile = document.querySelector(`.meeting-remote-tile[data-peer="${peerId}"]`);
    if (!tile) {
      // Create tile
      tile = document.createElement("div");
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
      nameSpan.textContent = p.name || peerId;
      label.appendChild(dot);
      label.appendChild(nameSpan);

      tile.appendChild(video);
      tile.appendChild(initialsOverlay);
      tile.appendChild(label);
      els.remoteGrid.appendChild(tile);
    }

    // Attach stream
    const video = tile.querySelector(`[data-peer-video="${peerId}"]`);
    const initialsOverlay = tile.querySelector(`[data-peer-initials="${peerId}"]`);

    if (p.stream && p.stream.getVideoTracks().length > 0) {
      video.srcObject = p.stream;
      video.style.display = "block";
      if (initialsOverlay) initialsOverlay.style.display = "none";
    } else {
      video.srcObject = null;
      video.style.display = "none";
      if (initialsOverlay) {
        initialsOverlay.style.display = "flex";
        initialsOverlay.querySelector(".meeting-initials-text").textContent = initials(p.name || peerId);
      }
    }

    // Update label
    const nameSpan = tile.querySelector(".meeting-user-label span:last-child");
    if (nameSpan) nameSpan.textContent = p.name || peerId;

    updateParticipantCount();
  }

  function removeParticipant(peerId) {
    delete state.participants[peerId];
    const tile = document.querySelector(`.meeting-remote-tile[data-peer="${peerId}"]`);
    if (tile) {
      // Stop tracks before removing
      const video = tile.querySelector("video");
      if (video && video.srcObject) {
        video.srcObject.getTracks().forEach((t) => t.stop());
      }
      tile.remove();
    }
    updateParticipantCount();

    // Exit presentation mode if the screen sharer left
    if (state.isScreenSharing) {
      const stillSharing = Object.values(state.participants).some(
        (p) => p.isScreen && p.stream && p.stream.getVideoTracks().length > 0
      );
      if (!stillSharing) {
        exitPresentationMode();
      }
    }
  }

  // ─── Controls ──────────────────────────────────────────────────────────
  function updateControlUI() {
    setControlButton(els.micBtn, state.isMicOn, "Mic");
    setControlButton(els.camBtn, state.isCamOn, "Cam");
    setControlButton(els.shareBtn, state.isScreenSharing, "Share");
    setControlButton(els.chatBtn, state.chatOpen, "Chat");

    els.micBtn.classList.toggle("muted", !state.isMicOn);
    els.camBtn.classList.toggle("muted", !state.isCamOn);
    // Update activity bar button state
    const actBtn = els.joinBtn;
    if (actBtn) {
      actBtn.classList.toggle("active", state.callActive);
    }
  }

  function toggleMic() {
    if (!state.localStream) return;
    const audioTracks = state.localStream.getAudioTracks();
    if (!audioTracks.length) return;

    state.isMicOn = !state.isMicOn;
    audioTracks.forEach((t) => t.enabled = state.isMicOn);

    // Notify others via data channels
    broadcastChatMessage(null, {
      type: "mic-toggle",
      micOn: state.isMicOn,
    });

    updateControlUI();
    toast(state.isMicOn ? "Microphone unmuted" : "Microphone muted", state.isMicOn ? "success" : "error");
  }

  function toggleCamera() {
    if (!state.localStream) return;
    const videoTracks = state.localStream.getVideoTracks();
    if (!videoTracks.length) return;

    state.isCamOn = !state.isCamOn;
    videoTracks.forEach((t) => t.enabled = state.isCamOn);

    // Replace track for peers if local stream is being sent
    if (state.peer && state.peer._calls) {
      Object.values(state.peer._calls).forEach((call) => {
        try {
          if (state.isCamOn) {
            const track = state.localStream.getVideoTracks()[0];
            if (track && call.remoteStream) {
              call.remoteStream.getVideoTracks().forEach((old) => {
                call.remoteStream.removeTrack(old);
              });
              call.remoteStream.addTrack(track);
            }
          }
        } catch (_) {}
      });
    }

    renderLocalVideo();
    updateControlUI();
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
        audio: false,
      });

      // Detect if user clicked "Stop sharing" in the browser dialog
      const track = stream.getVideoTracks()[0];
      track.addEventListener("ended", () => {
        stopScreenShare();
        toast("Screen share stopped by user", "success");
      });

      state.screenStream = stream;
      state.isScreenSharing = true;

      // Replace local video track with screen track
      // We keep the local camera stream but swap the video track sent to peers
      if (state.peer && state.localStream) {
        const localVideoTrack = state.localStream.getVideoTracks()[0];
        if (localVideoTrack) {
          // Disable camera track (optional — some prefer to show screen instead)
          // Here we keep both by replacing on the call level
        }
      }

      // Send screen stream to all connected peers
      if (state.peer && state.peer._calls) {
        Object.values(state.peer._calls).forEach((call) => {
          try {
            const screenTrack = stream.getVideoTracks()[0];
            if (screenTrack) {
              call.remoteStream = call.remoteStream || new MediaStream();
              // Replace video track
              call.remoteStream.getVideoTracks().forEach((old) => {
                call.remoteStream.removeTrack(old);
              });
              call.remoteStream.addTrack(screenTrack);
              // Update the remote stream reference in participant state
              const peerId = call.peer;
              if (state.participants[peerId]) {
                state.participants[peerId].stream = call.remoteStream;
                state.participants[peerId].isScreen = true;
                renderRemoteVideo(peerId);
              }
            }
          } catch (_) {}
        });
      }

      // Also, for ourselves we show the screen share in the local tile? No — we show our camera still.
      // But we notify others
      broadcastChatMessage(null, {
        type: "screen-toggle",
        sharing: true,
        name: state.userName,
      });

      addSystemMessage(state.userName + " started screen sharing");
      enterPresentationMode(state.peerId);
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
    state.isScreenSharing = false;

    // Restore camera track to peers
    if (state.peer && state.localStream && state.localStream.getVideoTracks().length > 0) {
      const cameraTrack = state.localStream.getVideoTracks()[0];
      if (state.peer._calls) {
        Object.values(state.peer._calls).forEach((call) => {
          try {
            call.remoteStream = call.remoteStream || new MediaStream();
            call.remoteStream.getVideoTracks().forEach((old) => {
              call.remoteStream.removeTrack(old);
            });
            call.remoteStream.addTrack(cameraTrack);
            const peerId = call.peer;
            if (state.participants[peerId]) {
              state.participants[peerId].stream = call.remoteStream;
              state.participants[peerId].isScreen = false;
              renderRemoteVideo(peerId);
            }
          } catch (_) {}
        });
      }
    }

    broadcastChatMessage(null, { type: "screen-toggle", sharing: false });
    addSystemMessage(state.userName + " stopped screen sharing");
    exitPresentationMode();
    updateControlUI();
    toast("Screen sharing stopped", "success");
  }

  window.MeetingRoom.toggleMic = toggleMic;
  window.MeetingRoom.toggleCamera = toggleCamera;
  window.MeetingRoom.toggleScreenShare = toggleScreenShare;

  // ─── Presentation Mode ─────────────────────────────────────────────────
  function enterPresentationMode(sharingPeerId) {
    document.body.classList.add("presentation-mode");
    els.container.classList.add("presentation-mode");
    // Also adjust for the local tile — hide it, show screen share big
  }

  function exitPresentationMode() {
    document.body.classList.remove("presentation-mode");
    els.container.classList.remove("presentation-mode");
  }

  function leavePresentationMode() {
    exitPresentationMode();
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
    els.modal.style.display = "none";
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
      case "escape":
        if (state.chatOpen) {
          toggleChat();
          e.preventDefault();
        }
        break;
    }
  }

  // ─── Init ──────────────────────────────────────────────────────────────
  function init() {
    els.chatInput && els.chatInput.addEventListener("keydown", onChatKeydown);
    document.addEventListener("keydown", onGlobalKeydown);

    // Close modal on backdrop click
    els.modal && els.modal.addEventListener("click", (e) => {
      if (e.target === els.modal) closeMeeting();
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
    joinMeeting,
    generateRoomId,
    toggleMic,
    toggleCamera,
    toggleScreenShare,
    toggleChat,
    sendChatMessage,
    endMeeting,
  };
})();
