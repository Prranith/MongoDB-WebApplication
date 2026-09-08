/**
 * meeting.js
 * PeerJS WebRTC real-time video call, screen sharing, and chat for Codexa Labs IDE.
 * Integrated as an IDE collaboration dock with dark-mode glassmorphism styling.
 */

window.Meeting = (function() {
  'use strict';

  // ── State ────────────────────────────────────────────────────
  const state = {
    peer: null,
    localStream: null,
    screenStream: null,
    remoteStreams: new Map(), // peerId -> { video, stream }
    isMuted: false,
    isCameraOff: false,
    isSharing: false,
    isChatOpen: false,
    roomId: null,
    userName: '',
    localPeerId: null,
    dataChannels: new Map(), // peerId -> DataChannel
    audioContext: null,
    analyserNode: null,
    animationFrame: null,
  };

  // ── DOM References ───────────────────────────────────────────
  const dom = {
    modal: document.getElementById('meeting-modal'),
    joinScreen: document.getElementById('meeting-join-screen'),
    activeScreen: document.getElementById('meeting-active-screen'),
    localVideo: document.getElementById('local-video'),
    localTile: document.getElementById('video-local'),
    localAvatar: document.getElementById('local-avatar'),
    remoteGrid: document.getElementById('meeting-remote-grid'),
    chatDrawer: document.getElementById('meeting-chat-drawer'),
    chatMessages: document.getElementById('meeting-chat-messages'),
    chatInput: document.getElementById('meeting-chat-input'),
    userNameInput: document.getElementById('meeting-user-name'),
    roomIdInput: document.getElementById('meeting-room-id'),
    roomDisplay: document.getElementById('meeting-room-display'),
    participantCount: document.getElementById('meeting-participant-count'),
  };

  // ── Utility ──────────────────────────────────────────────────
  function getInitials(name) {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  }

  function showToast(message, type = 'info') {
    const existing = document.querySelector('.meeting-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `meeting-toast ${type}`;
    toast.innerHTML = `
      <span class="meeting-status-dot ${type === 'error' ? 'disconnected' : type === 'success' ? 'connected' : 'connecting'}"></span>
      ${message}
    `;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  function generateRoomId() {
    return 'DEV-' + Math.random().toString(36).substring(2, 6).toUpperCase();
  }

  // ── Audio Visualizer ─────────────────────────────────────────
  function initAudioVisualizer(stream) {
    if (!stream || !stream.getAudioTracks().length) return;

    try {
      state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = state.audioContext.createMediaStreamSource(stream);
      state.analyserNode = state.audioContext.createAnalyser();
      state.analyserNode.fftSize = 256;
      source.connect(state.analyserNode);
    } catch (e) {
      console.warn('Audio visualizer init failed:', e);
    }
  }

  function startAudioVisualizer() {
    if (!state.analyserNode) return;

    const tiles = document.querySelectorAll('.video-tile[data-peer-id] .audio-level');
    const dataArray = new Uint8Array(state.analyserNode.frequencyBinCount);

    function update() {
      state.analyserNode.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
      const percent = Math.min(100, (avg / 255) * 100);

      tiles.forEach(el => {
        el.style.width = percent + '%';
        el.classList.add('active');
      });

      state.animationFrame = requestAnimationFrame(update);
    }

    if (state.animationFrame) cancelAnimationFrame(state.animationFrame);
    state.animationFrame = requestAnimationFrame(update);
  }

  function stopAudioVisualizer() {
    if (state.animationFrame) {
      cancelAnimationFrame(state.animationFrame);
      state.animationFrame = null;
    }
    document.querySelectorAll('.audio-level').forEach(el => el.classList.remove('active'));
  }

  // ── Video Tile Management ────────────────────────────────────
  function createVideoTile(peerId, stream, name, isLocal = false) {
    // Remove existing tile for this peer
    const existing = document.querySelector(`.video-tile[data-peer-id="${peerId}"]`);
    if (existing) existing.remove();

    const tile = document.createElement('div');
    tile.className = `video-tile${isLocal ? ' video-local' : ''}`;
    tile.dataset.peerId = peerId;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    if (isLocal) video.muted = true;

    const overlay = document.createElement('div');
    overlay.className = 'video-overlay';

    const avatar = document.createElement('div');
    avatar.className = 'video-avatar';
    avatar.textContent = getInitials(name);

    const nameEl = document.createElement('div');
    nameEl.className = 'video-name';
    nameEl.textContent = name;

    // Audio level indicator
    const audioLevel = document.createElement('div');
    audioLevel.className = 'audio-level';
    overlay.appendChild(audioLevel);

    overlay.appendChild(avatar);
    overlay.appendChild(nameEl);

    // Screen share badge
    const shareBadge = document.createElement('div');
    shareBadge.className = 'screen-share-badge';
    shareBadge.style.display = 'none';
    shareBadge.innerHTML = '🖥️ Sharing';
    overlay.appendChild(shareBadge);

    tile.appendChild(video);
    tile.appendChild(overlay);

    // Attach audio level for local user
    if (isLocal && state.analyserNode) {
      tile.querySelector('.audio-level').style.display = 'block';
    }

    return { tile, video, shareBadge };
  }

  function updateVideoTile(peerId, stream, name) {
    let entry = state.remoteStreams.get(peerId);
    const existingVideo = document.querySelector(`.video-tile[data-peer-id="${peerId}"] video`);

    if (!entry) {
      // New participant
      const { tile, video } = createVideoTile(peerId, stream, name);
      document.getElementById('meeting-remote-grid').appendChild(tile);

      video.srcObject = stream;
      entry = { video, tile, shareBadge: tile.querySelector('.screen-share-badge') };
      state.remoteStreams.set(peerId, entry);

      // Update audio level for remote
      try {
        const audioTrack = stream.getAudioTracks()[0];
        if (audioTrack) {
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          const src = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          src.connect(analyser);
          // Store for visualization
          entry.analyser = analyser;
        }
      } catch (e) {
        console.warn('Remote audio analyser init failed:', e);
      }

      updateParticipantCount();
      addSystemMessage(`${name} joined the meeting`);
    } else {
      // Update existing
      if (entry.video) {
        entry.video.srcObject = stream;
      }
      if (entry.tile) {
        entry.tile.querySelector('.video-name').textContent = name;
        entry.tile.querySelector('.video-avatar').textContent = getInitials(name);
      }
    }
  }

  function removeVideoTile(peerId, name) {
    const entry = state.remoteStreams.get(peerId);
    if (entry && entry.tile) {
      entry.tile.remove();
    }
    state.remoteStreams.delete(peerId);
    updateParticipantCount();
    if (name) addSystemMessage(`${name} left the meeting`);
  }

  function updateParticipantCount() {
    const count = state.remoteStreams.size + 1; // +1 for local
    dom.participantCount.textContent = count === 1
      ? '1 participant (just you)'
      : `${count} participants`;
  }

  // ── Media Controls ───────────────────────────────────────────
  async function requestMedia() {
    try {
      const constraints = {
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: 'user',
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 48000,
        },
      };

      state.localStream = await navigator.mediaDevices.getUserMedia(constraints);
      initAudioVisualizer(state.localStream);

      // Set up local video tile
      const { tile, video, shareBadge } = createVideoTile('local', state.localStream, state.userName, true);
      dom.localTile.replaceWith(tile);
      Object.assign(dom, { localTile: tile, localVideo: video });

      video.srcObject = state.localStream;
      dom.localAvatar.style.display = 'none';
      dom.localVideo.style.display = 'block';

      startAudioVisualizer();
      showToast('Camera and microphone connected', 'success');
      return true;
    } catch (err) {
      console.error('Media request failed:', err);
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        showToast('Camera/microphone permission denied. Please allow access in browser settings.', 'error');
        // Show avatar fallback
        dom.localAvatar.style.display = 'flex';
        dom.localVideo.style.display = 'none';
      } else if (err.name === 'NotFoundError') {
        showToast('No camera or microphone found on this device.', 'error');
        dom.localAvatar.style.display = 'flex';
        dom.localVideo.style.display = 'none';
      } else {
        showToast('Failed to access camera/microphone: ' + err.message, 'error');
      }
      return false;
    }
  }

  async function requestScreenShare() {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });

      state.screenStream = stream;

      // Replace local video track with screen track
      const localVideoTrack = state.localStream.getVideoTracks()[0];
      if (localVideoTrack) {
        const screenTrack = stream.getVideoTracks()[0];
        if (screenTrack) {
          localVideoTrack.replaceWith(screenTrack);
        }
      }

      state.isSharing = true;

      // Update UI
      document.getElementById('meeting-video-container').classList.add('presenting');
      document.querySelector('.meeting-ctrl-btn[id="btn-screen"], .meeting-ctrl-btn[id="btn-screen-bar"]')
        ?.classList.add('active');

      // Show screen share badge
      const localTile = dom.localTile || document.querySelector('.video-local');
      if (localTile) {
        const badge = localTile.querySelector('.screen-share-badge') || createScreenShareBadge();
        if (!localTile.querySelector('.screen-share-badge')) {
          localTile.querySelector('.video-overlay').appendChild(badge);
        }
        badge.style.display = 'flex';
      }

      // Handle when user stops sharing via browser UI
      stream.getVideoTracks()[0].addEventListener('ended', () => {
        stopScreenShare();
      });

      showToast('Screen sharing started', 'success');
      broadcastSystemMessage('started screen sharing');

      return true;
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        showToast('Screen sharing permission denied.', 'error');
      } else if (err.name === 'NotFoundError') {
        showToast('No screen to share found.', 'error');
      } else {
        showToast('Failed to share screen: ' + err.message, 'error');
      }
      return false;
    }
  }

  function createScreenShareBadge() {
    const badge = document.createElement('div');
    badge.className = 'screen-share-badge';
    badge.style.display = 'none';
    badge.innerHTML = '🖥️ Sharing';
    return badge;
  }

  function stopScreenShare() {
    if (state.screenStream) {
      state.screenStream.getTracks().forEach(track => track.stop());
      state.screenStream = null;
    }

    state.isSharing = false;
    document.getElementById('meeting-video-container')?.classList.remove('presenting');

    // Restore camera track
    if (state.localStream && !state.isCameraOff) {
      try {
        const stream = navigator.mediaDevices.getUserMedia({
          video: { width: 1280, height: 720, facingMode: 'user' },
        });
        stream.then(s => {
          const newTrack = s.getVideoTracks()[0];
          if (newTrack) {
            const localVideoTrack = state.localStream.getVideoTracks()[0];
            if (localVideoTrack) {
              localVideoTrack.replaceWith(newTrack);
            }
            state.localStream = s;
          }
        });
      } catch (e) {
        console.warn('Could not restore camera after screen share:', e);
      }
    }

    // Remove screen share badge
    document.querySelectorAll('.screen-share-badge').forEach(b => b.style.display = 'none');
    document.querySelector('.meeting-ctrl-btn[id="btn-screen"], .meeting-ctrl-btn[id="btn-screen-bar"]')
      ?.classList.remove('active');

    showToast('Screen sharing stopped', 'info');
    broadcastSystemMessage('stopped screen sharing');
  }

  // ── Toggle Functions ─────────────────────────────────────────
  function toggleMic() {
    if (!state.localStream) return;

    const audioTrack = state.localStream.getAudioTracks()[0];
    if (!audioTrack) return;

    audioTrack.enabled = !audioTrack.enabled;
    state.isMuted = !audioTrack.enabled;

    const btn = document.querySelector('.meeting-ctrl-btn[id="btn-mic"]') ||
                document.querySelector('[onclick="Meeting.toggleMic()"]');
    if (btn) btn.classList.toggle('off', state.isMuted);

    showToast(state.isMuted ? 'Microphone muted' : 'Microphone unmuted', 'info');
    if (state.isMuted) {
      broadcastSystemMessage('muted microphone');
    } else {
      broadcastSystemMessage('unmuted microphone');
    }
  }

  function toggleCam() {
    if (!state.localStream) return;

    const videoTrack = state.localStream.getVideoTracks()[0];
    if (!videoTrack) return;

    videoTrack.enabled = !videoTrack.enabled;
    state.isCameraOff = !videoTrack.enabled;

    const btn = document.querySelector('.meeting-ctrl-btn[id="btn-cam"]') ||
                document.querySelector('[onclick="Meeting.toggleCam()"]');
    if (btn) btn.classList.toggle('off', state.isCameraOff);

    // Show/hide avatar
    if (state.isCameraOff) {
      dom.localAvatar.style.display = 'flex';
      dom.localVideo.style.display = 'none';
    } else {
      dom.localAvatar.style.display = 'none';
      dom.localVideo.style.display = 'block';
    }

    showToast(state.isCameraOff ? 'Camera turned off' : 'Camera turned on', 'info');
    if (state.isCameraOff) {
      broadcastSystemMessage('turned off camera');
    } else {
      broadcastSystemMessage('turned on camera');
    }
  }

  function toggleScreenShare() {
    if (state.isSharing) {
      stopScreenShare();
    } else {
      requestScreenShare();
    }
  }

  function toggleChat() {
    state.isChatOpen = !state.isChatOpen;
    dom.chatDrawer.classList.toggle('open', state.isChatOpen);
  }

  // ── Chat ─────────────────────────────────────────────────────
  function addChatMessage(sender, text, isSystem = false) {
    const msg = document.createElement('div');
    msg.className = `meeting-chat-msg ${isSystem ? 'system' : 'message'}`;

    if (isSystem) {
      msg.textContent = text;
    } else {
      msg.innerHTML = `
        <div class="msg-sender">${escapeHtml(sender)}</div>
        <div class="msg-text">${escapeHtml(text)}</div>
      `;
    }

    dom.chatMessages.appendChild(msg);
    dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
  }

  function addSystemMessage(text) {
    addChatMessage('System', text, true);
  }

  function broadcastSystemMessage(text) {
    const fullMsg = `${state.userName}: ${text}`;
    addSystemMessage(fullMsg);
    // Broadcast to peers via data channels
    state.dataChannels.forEach((dc, peerId) => {
      if (dc && dc.readyState === 'open') {
        dc.send(JSON.stringify({
          type: 'system',
          text: `${state.userName}: ${text}`,
          sender: 'system',
        }));
      }
    });
  }

  function sendChat() {
    const text = dom.chatInput.value.trim();
    if (!text) return;

    addChatMessage(state.userName, text);
    dom.chatInput.value = '';

    // Broadcast to peers
    state.dataChannels.forEach((dc, peerId) => {
      if (dc && dc.readyState === 'open') {
        dc.send(JSON.stringify({
          type: 'message',
          sender: state.userName,
          text: text,
        }));
      }
    });
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ── PeerJS Connection Management ─────────────────────────────
  function initPeer() {
    return new Promise((resolve, reject) => {
      try {
        state.peer = new Peer();

        state.peer.on('open', (peerId) => {
          state.localPeerId = peerId;
          console.log('PeerJS ID:', peerId);
          resolve(peerId);
        });

        state.peer.on('call', (call) => {
          // Incoming call - answer with local stream
          call.answer(state.localStream);

          call.on('stream', (remoteStream) => {
            const peerId = call.peer;
            // Try to get caller's name from connection metadata
            const name = `Peer ${peerId.substring(0, 4)}`;
            updateVideoTile(peerId, remoteStream, name);
          });

          call.on('close', () => {
            removeVideoTile(call.peer);
          });

          // Set up data channel for chat
          call.on('datachannel', (dataChannel) => {
            setupDataChannel(call.peer, dataChannel);
          });
        });

        state.peer.on('connection', (conn) => {
          conn.on('open', () => {
            // Set up data channel
            const dc = conn.createDataChannel('chat');
            setupDataChannel(conn.peer, dc);

            // Answer with media
            const call = state.peer.call(conn.peer, state.localStream);
            call.on('stream', (stream) => {
              updateVideoTile(conn.peer, stream, conn.peer);
            });
          });
        });

        state.peer.on('error', (err) => {
          console.error('PeerJS error:', err);
          showToast('Connection error: ' + err.message, 'error');
          reject(err);
        });

      } catch (err) {
        reject(err);
      }
    });
  }

  function setupDataChannel(peerId, dc) {
    state.dataChannels.set(peerId, dc);

    dc.onopen = () => {
      console.log(`Data channel open with ${peerId}`);
    };

    dc.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'message') {
          addChatMessage(data.sender || 'Unknown', data.text || '');
        } else if (data.type === 'system') {
          addSystemMessage(data.text || '');
        }
      } catch (e) {
        console.warn('Failed to parse data channel message:', e);
      }
    };

    dc.onclose = () => {
      state.dataChannels.delete(peerId);
      console.log(`Data channel closed with ${peerId}`);
    };
  }

  function connectToPeer(peerId) {
    if (!state.localStream) {
      showToast('No local media stream available', 'error');
      return;
    }

    try {
      const conn = state.peer.connect(peerId, {
        reliable: true,
      });

      conn.on('open', () => {
        // Create data channel for chat
        const dc = conn.createDataChannel('chat');
        setupDataChannel(peerId, dc);

        // Call with media
        const call = state.peer.call(peerId, state.localStream);

        call.on('stream', (stream) => {
          updateVideoTile(peerId, stream, peerId);
        });

        call.on('close', () => {
          removeVideoTile(peerId);
        });

        showToast(`Connected to peer ${peerId.substring(0, 6)}...`, 'success');
      });

      conn.on('error', (err) => {
        console.error('Connection error:', err);
        showToast('Failed to connect to peer: ' + err.message, 'error');
      });

    } catch (err) {
      showToast('Connection failed: ' + err.message, 'error');
    }
  }

  // ── Room Management (API) ────────────────────────────────────
  async function createRoom(roomId, userName) {
    try {
      const response = await fetch('/api/meeting/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          room_id: roomId,
          host_peer_id: state.localPeerId,
        }),
      });

      const data = await response.json();
      if (data.success) {
        state.roomId = data.room.room_id;
        state.userName = userName;
        dom.roomDisplay.textContent = state.roomId;
        dom.roomIdInput.value = state.roomId;
        dom.userNameInput.value = userName;
        return true;
      } else {
        showToast('Failed to create room: ' + (data.error || 'Unknown error'), 'error');
        return false;
      }
    } catch (err) {
      showToast('Network error creating room: ' + err.message, 'error');
      return false;
    }
  }

  async function joinRoom(roomId) {
    try {
      const response = await fetch('/api/meeting/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room_id: roomId }),
      });

      const data = await response.json();
      if (data.success) {
        state.roomId = roomId;
        state.userName = dom.userNameInput.value.trim() || 'Anonymous';
        return true;
      } else {
        showToast('Cannot join room: ' + (data.error || 'Room not found'), 'error');
        return false;
      }
    } catch (err) {
      showToast('Network error joining room: ' + err.message, 'error');
      return false;
    }
  }

  async function leaveRoom() {
    if (!state.roomId) return;

    try {
      await fetch('/api/meeting/leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room_id: state.roomId }),
      });
    } catch (err) {
      console.warn('Leave room API call failed:', err);
    }
  }

  // ── Main Meeting Flow ────────────────────────────────────────
  async function joinMeetingFlow() {
    const name = dom.userNameInput.value.trim();
    let roomId = dom.roomIdInput.value.trim().toUpperCase();

    if (!name) {
      showToast('Please enter your name', 'error');
      dom.userNameInput.focus();
      return;
    }

    if (!roomId) {
      roomId = generateRoomId();
      dom.roomIdInput.value = roomId;
    }

    // Request media first
    const mediaOk = await requestMedia();
    if (!mediaOk && !state.localStream) {
      // If no media at all, allow joining without video (audio-only or no media)
      // But still proceed
    }

    // Initialize PeerJS
    try {
      state.localPeerId = await initPeer();
    } catch (err) {
      showToast('Failed to initialize peer connection: ' + err.message, 'error');
      return;
    }

    // Create or join room via API
    const isNewRoom = roomId.startsWith('DEV-') && roomId.length === 11;
    let roomCreated = false;

    if (isNewRoom) {
      roomCreated = await createRoom(roomId, name);
    } else {
      const joined = await joinRoom(roomId);
      if (!joined) return;
      state.userName = name;
    }

    if (!roomCreated && isNewRoom) return;

    state.userName = name;

    // Switch UI
    dom.joinScreen.classList.remove('active');
    dom.activeScreen.classList.add('active');

    // Update local tile name
    if (dom.localTile) {
      dom.localTile.querySelector('.video-name').textContent = state.userName;
      dom.localTile.querySelector('.video-avatar').textContent = getInitials(state.userName);
    }
    dom.localAvatar.textContent = getInitials(state.userName);

    showToast(`Connected to room ${roomId}`, 'success');

    // Listen for peers connecting (simple broadcast mechanism would need a signaling server)
    // For now, users need to share the room ID and peer ID to connect
    addSystemMessage(`You joined ${roomId}`);

    // Store peer ID for sharing
    sessionStorage.setItem('meeting_peer_id', state.localPeerId);
    sessionStorage.setItem('meeting_room_id', state.roomId);
    sessionStorage.setItem('meeting_user_name', state.userName);

    updateParticipantCount();
  }

  function generateAndJoin() {
    const name = dom.userNameInput.value.trim() || 'Anonymous';
    const roomId = generateRoomId();
    dom.roomIdInput.value = roomId;
    dom.userNameInput.value = name;
    joinMeetingFlow();
  }

  // ── Close / Leave Meeting ────────────────────────────────────
  async function closeMeeting() {
    await endMeeting();
  }

  async function endMeeting() {
    // Cleanup
    if (state.localStream) {
      state.localStream.getTracks().forEach(track => track.stop());
      state.localStream = null;
    }

    if (state.screenStream) {
      state.screenStream.getTracks().forEach(track => track.stop());
      state.screenStream = null;
    }

    if (state.peer) {
      // Close all data channels
      state.dataChannels.forEach((dc, peerId) => {
        if (dc) dc.close();
      });
      state.dataChannels.clear();

      // Disconnect from peers
      state.peer.disconnect();
      state.peer.destroy();
      state.peer = null;
    }

    stopAudioVisualizer();

    // Reset UI
    dom.joinScreen.classList.add('active');
    dom.activeScreen.classList.remove('active');
    dom.chatDrawer.classList.remove('open');
    state.isChatOpen = false;

    // Clear room state
    if (state.roomId) {
      await leaveRoom();
    }
    state.roomId = null;
    state.userName = '';
    state.localPeerId = null;
    state.isMuted = false;
    state.isCameraOff = false;
    state.isSharing = false;
    state.remoteStreams.clear();

    // Clear session storage
    sessionStorage.removeItem('meeting_peer_id');
    sessionStorage.removeItem('meeting_room_id');
    sessionStorage.removeItem('meeting_user_name');

    // Reset local video display
    dom.localAvatar.style.display = 'flex';
    dom.localVideo.style.display = 'none';
    dom.localVideo.srcObject = null;

    showToast('Meeting ended', 'info');
  }

  // ── Public API ───────────────────────────────────────────────
  return {
    joinRoom: joinMeetingFlow,
    generateAndJoin,
    closeMeeting,
    endMeeting,
    toggleMic,
    toggleCam,
    toggleScreenShare,
    toggleChat,
    sendChat,

    // For external initialization (e.g., from exam portal)
    init: async function(roomId, userName) {
      dom.userNameInput.value = userName || '';
      dom.roomIdInput.value = roomId || '';
      dom.modal.classList.add('active');
      dom.userNameInput.focus();
    },

    open: function() {
      dom.modal.classList.add('active');
      dom.userNameInput?.focus();
    },

    // Quick access for console debugging
    getState: () => ({ ...state }),
  };

})();

// ── Handle Browser Close / Tab Unload ─────────────────────────
window.addEventListener('beforeunload', (e) => {
  if (window.Meeting && window.Meeting.getState().roomId) {
    // Fire and forget - best effort cleanup
    fetch('/api/meeting/leave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room_id: window.Meeting.getState().roomId,
      }),
    }).catch(() => {});
  }
});

// ── Keyboard Shortcuts ────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  // Only when meeting modal is active
  if (!document.getElementById('meeting-modal')?.classList.contains('active')) return;

  // Ctrl+K or Cmd+K to toggle chat
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    window.Meeting.toggleChat();
  }

  // Escape to close chat or leave meeting
  if (e.key === 'Escape') {
    if (window.Meeting.getState().isChatOpen) {
      window.Meeting.toggleChat();
    }
  }
});

// ── Expose for Exam Portal integration ────────────────────────
console.log('Meeting module loaded. Use window.Meeting to control.');
