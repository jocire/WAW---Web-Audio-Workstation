// WAW real-time collaboration (serverless WebRTC via Trystero + public Nostr relays).
//
// * Rooms are addressed by the URL hash:  https://…/#room=<code>
//   The room code doubles as the signalling password, so relays only see
//   encrypted handshakes. Treat the link like a shared secret.
// * Project sync: every edit broadcasts the full project snapshot with a
//   Lamport version; the highest version wins (ties broken by peer id).
//   Simple and robust for small rooms; see roadmap.md for the CRDT plan.
// * Audio samples are fetched on demand from the peer that referenced them.
// * Chat (text) + optional camera/microphone video call.
//
// The Trystero library is only downloaded when a session is started/joined.
(function () {
  "use strict";
  const TRYSTERO_URL = "https://cdn.jsdelivr.net/npm/trystero@0.25.4/dist/nostr.mjs/+esm";
  const APP_ID = "waw-web-audio-workstation-v1";
  const COLORS = ["#f97316", "#22c55e", "#3b82f6", "#eab308", "#a855f7", "#06b6d4", "#ef4444", "#14b8a6"];
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const state = {
    lib: null, room: null, roomId: null, selfId: null,
    name: localStorage.getItem("waw.collab.name") || "",
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    peers: new Map(),           // peerId -> { name, color, view, track, joinedAt }
    version: 0, versionBy: "",  // Lamport version of the local project
    applyingRemote: false,
    lastSentSig: "",
    actions: {},
    localStream: null, camOn: false, micOn: false,
    peerStreams: new Map(),
    followTransport: false,
    adoptedRoom: false,
    unread: 0
  };

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------
  function buildPanel() {
    if (document.getElementById("collabPanel")) return;
    const panel = document.createElement("aside");
    panel.id = "collabPanel";
    panel.className = "collab-panel";
    panel.innerHTML = `
      <div class="cp-head"><strong>Session</strong><button type="button" class="cp-close" title="Hide panel">×</button></div>
      <div class="cp-section cp-session"></div>
      <div class="cp-section cp-people-wrap"><div class="cp-title">People</div><div class="cp-people"></div></div>
      <div class="cp-section cp-video-wrap">
        <div class="cp-title">Video</div>
        <div class="cp-av-btns"><button type="button" class="cp-cam">📷 Camera</button><button type="button" class="cp-mic">🎙 Mic</button></div>
        <div class="cp-videos"></div>
      </div>
      <div class="cp-section cp-chat-wrap">
        <div class="cp-title">Chat</div>
        <div class="cp-chat" aria-live="polite"></div>
        <form class="cp-chat-form"><input type="text" class="cp-chat-input" placeholder="Message…" maxlength="1000" autocomplete="off"><button type="submit">Send</button></form>
      </div>`;
    document.body.appendChild(panel);
    panel.querySelector(".cp-close").addEventListener("click", () => togglePanel(false));
    panel.querySelector(".cp-chat-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const inp = panel.querySelector(".cp-chat-input");
      const text = inp.value.trim();
      if (!text) return;
      inp.value = "";
      sendChat(text);
    });
    panel.querySelector(".cp-cam").addEventListener("click", () => toggleMedia("cam"));
    panel.querySelector(".cp-mic").addEventListener("click", () => toggleMedia("mic"));

    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "collabToggleBtn";
    btn.className = "collab-toggle";
    btn.title = "Collaboration: share a session link, chat and video";
    btn.innerHTML = `👥 <span class="ct-label">Collab</span><span class="ct-badge" hidden></span>`;
    btn.addEventListener("click", () => togglePanel());
    document.querySelector(".header-right")?.appendChild(btn);
    renderSession();
    renderPeople();
  }

  function togglePanel(force) {
    const panel = document.getElementById("collabPanel");
    const open = force ?? !panel.classList.contains("open");
    panel.classList.toggle("open", open);
    document.body.classList.toggle("collab-open", open);
    if (open) { state.unread = 0; updateBadge(); }
    window.dispatchEvent(new Event("resize"));
  }

  function updateBadge() {
    const b = document.querySelector("#collabToggleBtn .ct-badge");
    if (!b) return;
    const n = state.room ? state.peers.size : 0;
    const label = document.querySelector("#collabToggleBtn .ct-label");
    if (label) label.textContent = state.room ? `Live · ${n + 1}` : "Collab";
    b.hidden = !state.unread;
    b.textContent = state.unread > 9 ? "9+" : String(state.unread);
    document.getElementById("collabToggleBtn")?.classList.toggle("live", !!state.room);
  }

  function renderSession() {
    const box = document.querySelector("#collabPanel .cp-session");
    if (!box) return;
    if (!state.room) {
      box.innerHTML = `
        <label class="stack">Your name<input type="text" class="cp-name" value="${escapeHtml(state.name)}" maxlength="40" placeholder="e.g. Alex"></label>
        <button type="button" class="cp-start primary">Start new session</button>
        <div class="cp-or">or join with a code / link</div>
        <div class="cp-join-row"><input type="text" class="cp-code" placeholder="room code or link"><button type="button" class="cp-join">Join</button></div>
        <p class="cp-note">Peer-to-peer via WebRTC; public Nostr relays only help peers find each other (handshakes are encrypted with the room code). Anyone with the link can join and edit — share it only with people you trust. Joining replaces your current project with the session's (a backup is saved to Projects).</p>`;
      box.querySelector(".cp-name").addEventListener("change", (e) => setName(e.target.value));
      box.querySelector(".cp-start").addEventListener("click", () => { setName(box.querySelector(".cp-name").value); start(randomRoomId(), true); });
      box.querySelector(".cp-join").addEventListener("click", () => {
        setName(box.querySelector(".cp-name").value);
        const code = parseRoom(box.querySelector(".cp-code").value);
        if (!code) { toast("Enter a room code or link"); return; }
        start(code, false);
      });
    } else {
      const link = shareLink();
      box.innerHTML = `
        <div class="cp-live"><span class="cp-dot"></span>Live in room <code>${escapeHtml(state.roomId)}</code></div>
        <div class="cp-join-row"><input type="text" readonly class="cp-link" value="${escapeHtml(link)}"><button type="button" class="cp-copy">Copy link</button></div>
        <label class="cp-check"><input type="checkbox" class="cp-follow" ${state.followTransport ? "checked" : ""}> Follow others' play/stop</label>
        <button type="button" class="cp-leave">Leave session</button>`;
      box.querySelector(".cp-copy").addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(link); toast("Session link copied"); }
        catch (e) { box.querySelector(".cp-link").select(); }
      });
      box.querySelector(".cp-follow").addEventListener("change", (e) => { state.followTransport = e.target.checked; });
      box.querySelector(".cp-leave").addEventListener("click", leave);
    }
  }

  function renderPeople() {
    const box = document.querySelector("#collabPanel .cp-people");
    if (!box) return;
    const me = `<div class="cp-person"><span class="cp-swatch" style="background:${state.color}"></span>${escapeHtml(state.name || "You")} <em>(you)</em></div>`;
    if (!state.room) { box.innerHTML = `<div class="cp-empty">Not in a session.</div>`; return; }
    const others = [...state.peers.entries()].map(([id, p]) => {
      const where = p.view ? ` · ${escapeHtml(p.view)}${p.track ? " / " + escapeHtml(p.track) : ""}` : "";
      return `<div class="cp-person"><span class="cp-swatch" style="background:${escapeHtml(p.color || "#888")}"></span>${escapeHtml(p.name || "Guest " + id.slice(0, 4))}<span class="cp-where">${where}</span></div>`;
    }).join("");
    box.innerHTML = me + (others || `<div class="cp-empty">Waiting for others to join… share the link.</div>`);
    updateBadge();
    paintTrackPresence();
  }

  // colored dots in sequencer track labels showing where collaborators are
  function paintTrackPresence() {
    document.querySelectorAll(".seq-presence").forEach(el => el.remove());
    if (!state.room) return;
    state.peers.forEach(p => {
      if (!p.trackId) return;
      const idx = tracks.findIndex(t => t.id === p.trackId);
      const label = document.querySelector(`.seq-track-row[data-track-index="${idx}"] .seq-label-top`);
      if (!label) return;
      const dot = document.createElement("span");
      dot.className = "seq-presence";
      dot.style.background = p.color || "#888";
      dot.title = `${p.name || "Guest"} is here`;
      label.appendChild(dot);
    });
  }

  function addChatLine({ name, color, text, at, system }) {
    const box = document.querySelector("#collabPanel .cp-chat");
    if (!box) return;
    const line = document.createElement("div");
    line.className = "cp-msg" + (system ? " system" : "");
    const time = new Date(at || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    line.innerHTML = system
      ? `<span class="cp-msg-text">${escapeHtml(text)}</span>`
      : `<span class="cp-msg-name" style="color:${escapeHtml(color || "#ccc")}">${escapeHtml(name || "Guest")}</span><span class="cp-msg-time">${time}</span><div class="cp-msg-text">${escapeHtml(text)}</div>`;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
    if (!document.getElementById("collabPanel")?.classList.contains("open") && !system) { state.unread++; updateBadge(); }
  }

  // ---------------------------------------------------------------------------
  // Room lifecycle
  // ---------------------------------------------------------------------------
  function randomRoomId() {
    const a = new Uint8Array(9);
    crypto.getRandomValues(a);
    return [...a].map(b => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("").replace(/(.{3})(?!$)/g, "$1-");
  }
  function parseRoom(v) {
    v = (v || "").trim();
    const m = v.match(/room=([a-z0-9-]+)/i);
    return (m ? m[1] : v).toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 64) || null;
  }
  function shareLink() {
    return `${location.origin}${location.pathname}#room=${state.roomId}`;
  }
  function setName(v) {
    state.name = (v || "").trim().slice(0, 40) || state.name || "Guest";
    try { localStorage.setItem("waw.collab.name", state.name); } catch (e) {}
    if (state.room) sendPresence();
  }

  async function loadLib() {
    if (state.lib) return state.lib;
    state.lib = await import(TRYSTERO_URL);
    return state.lib;
  }

  async function start(roomId, isNew) {
    if (state.room) await leave();
    if (!state.name) setName(prompt("Your name for this session:", "") || "Guest");
    let lib;
    try {
      statusEl.textContent = "Connecting to collaboration network…";
      lib = await loadLib();
    } catch (err) {
      statusEl.textContent = "Could not load the collaboration library (offline or blocked): " + err.message;
      return;
    }
    state.roomId = roomId;
    state.selfId = lib.selfId;
    state.room = lib.joinRoom({ appId: APP_ID, password: roomId }, roomId);
    state.peers.clear();
    // creator owns version 1; a joiner starts at 0 so the room's state wins
    if (isNew) { state.version = Math.max(1, state.version + 1); state.versionBy = state.selfId; state.adoptedRoom = true; }
    else { state.version = 0; state.versionBy = ""; state.adoptedRoom = false; }
    history.replaceState(null, "", `#room=${roomId}`);

    const A = (name) => state.room.makeAction(name);
    state.actions = {
      hello: A("hello"), presence: A("presence"), chat: A("chat"),
      project: A("project"), smpReq: A("smpreq"), smp: A("smp"), transport: A("transport")
    };

    state.room.onPeerJoin = (peerId) => {
      state.peers.set(peerId, { name: "", color: "#888", joinedAt: Date.now() });
      renderPeople();
      sendPresence(peerId);
      // send our project to the newcomer; they adopt the highest version
      if (state.version > 0) sendProject(peerId);
      if (state.localStream) state.room.addStream(state.localStream, { target: peerId });
    };
    state.room.onPeerLeave = (peerId) => {
      const p = state.peers.get(peerId);
      state.peers.delete(peerId);
      removePeerVideo(peerId);
      renderPeople();
      addChatLine({ system: true, text: `${p?.name || "A participant"} left.` });
    };
    state.room.onPeerStream = (stream, peerId) => addPeerVideo(peerId, stream);

    state.actions.presence.onMessage = (data, { peerId }) => {
      const prev = state.peers.get(peerId) || {};
      const isNewName = !prev.name && data?.name;
      state.peers.set(peerId, { ...prev, ...sanitizePresence(data) });
      renderPeople();
      if (isNewName) addChatLine({ system: true, text: `${data.name} joined.` });
    };
    state.actions.chat.onMessage = (data, { peerId }) => {
      const p = state.peers.get(peerId) || {};
      if (typeof data?.text !== "string") return;
      addChatLine({ name: p.name || "Guest", color: p.color, text: data.text.slice(0, 1000), at: Date.now() });
    };
    state.actions.project.onMessage = (data, { peerId }) => receiveProject(data, peerId);
    state.actions.smpReq.onMessage = async (data, { peerId }) => {
      for (const id of (Array.isArray(data?.ids) ? data.ids : []).slice(0, 64)) {
        const raw = await window.WAWSamples.getRaw(String(id));
        if (raw) state.actions.smp.send(raw.wav, { target: peerId, metadata: { id: String(id), name: raw.name } });
      }
    };
    state.actions.smp.onMessage = async (data, { metadata }) => {
      if (!metadata?.id || !(data instanceof ArrayBuffer || ArrayBuffer.isView(data))) return;
      try {
        const ab = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        await window.WAWSamples.putRaw(String(metadata.id), ab, String(metadata.name || "Sample"));
        renderSequencer(); renderSidebarTracks();
      } catch (e) { console.warn("sample receive failed", e); }
    };
    state.actions.transport.onMessage = (data) => {
      if (!state.followTransport) return;
      if (data?.playing) {
        lastPlayheadSec = clamp(Number(data.pos) || 0, 0, 36000);
        playheadWasManuallySet = true;
        playNotes(getAllNotesMixdown());
      } else if (isPlaying) stopPlayback();
    };

    renderSession(); renderPeople(); togglePanel(true);
    addChatLine({ system: true, text: isNew ? "Session started. Share the link to invite collaborators." : "Joined session. Syncing project…" });
    statusEl.textContent = `Collaboration room "${roomId}" is live.`;
    hookTransport();
  }

  async function leave() {
    if (!state.room) return;
    try { await state.room.leave(); } catch (e) {}
    state.room = null;
    state.peers.clear();
    state.peerStreams.forEach((_, id) => removePeerVideo(id));
    stopLocalMedia();
    history.replaceState(null, "", location.pathname + location.search);
    renderSession(); renderPeople();
    addChatLine({ system: true, text: "You left the session." });
    updateBadge();
  }

  function sanitizePresence(d) {
    return {
      name: String(d?.name || "").slice(0, 40),
      color: /^#[0-9a-f]{6}$/i.test(d?.color) ? d.color : "#888",
      view: String(d?.view || "").slice(0, 20),
      track: String(d?.track || "").slice(0, 60),
      trackId: String(d?.trackId || "").slice(0, 40)
    };
  }

  function sendPresence(target) {
    if (!state.room) return;
    const t = tracks[activeTrackIndex];
    state.actions.presence.send({ name: state.name, color: state.color, view: currentView, track: t?.name || "", trackId: t?.id || "" }, target ? { target } : undefined);
  }

  function sendChat(text) {
    if (!state.room) { toast("Start or join a session to chat"); return; }
    addChatLine({ name: state.name || "You", color: state.color, text, at: Date.now() });
    state.actions.chat.send({ text });
  }

  // ---------------------------------------------------------------------------
  // Project sync
  // ---------------------------------------------------------------------------
  function projectPayload() {
    const p = getProjectPayload();
    delete p.savedAt; delete p.id; delete p.name;
    return p;
  }

  let changeTimer = null;
  function notifyChange() {
    if (!state.room || state.applyingRemote) return;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      const payload = projectPayload();
      const sig = JSON.stringify(payload);
      if (sig === state.lastSentSig) return;
      state.lastSentSig = sig;
      state.version += 1;
      state.versionBy = state.selfId;
      state.actions.project.send({ v: state.version, by: state.selfId, payload });
    }, 350);
  }

  function sendProject(target) {
    const payload = projectPayload();
    state.lastSentSig = JSON.stringify(payload);
    state.actions.project.send({ v: state.version, by: state.versionBy || state.selfId, payload }, target ? { target } : undefined);
  }

  function newer(v, by) {
    if (v > state.version) return true;
    if (v === state.version && String(by) > String(state.versionBy)) return true;
    return false;
  }

  async function receiveProject(data, peerId) {
    if (!data || typeof data !== "object" || !data.payload?.project) return;
    const v = Number(data.v) || 0;
    if (!newer(v, data.by)) return;
    if (!state.adoptedRoom) {
      // first state from the room: keep a backup of whatever was open locally
      state.adoptedRoom = true;
      const hasContent = tracks.some(t => (t.clips || []).length || (t.notes || []).length);
      if (hasContent) {
        try { saveProjectToLibrary(`Backup before ${state.roomId}`, { newProject: true, silent: true }); } catch (e) {}
        setActiveProject(null);
      }
    }
    state.version = v;
    state.versionBy = String(data.by || peerId);
    applyRemote(data.payload);
    // fetch any audio we don't have yet
    const missing = [...window.WAWSampler.sampleIdsInUse(tracks)].filter(id => !window.WAWSamples.has(id));
    if (missing.length) {
      const stillMissing = [];
      for (const id of missing) { if (!(await window.WAWSamples.load(id))) stillMissing.push(id); }
      if (stillMissing.length) state.actions.smpReq.send({ ids: stillMissing }, { target: peerId });
      else renderSequencer();
    }
  }

  function applyRemote(payload) {
    state.applyingRemote = true;
    try {
      const keepTrackId = tracks[activeTrackIndex]?.id;
      const keepClip = activeClipId;
      const keepView = currentView;
      if (currentView === "editor") saveEditorNotesToActiveClip();
      historyLocked = true;
      restoreSnapshot(payload.project);
      historyLocked = false;
      const idx = tracks.findIndex(t => t.id === keepTrackId);
      activeTrackIndex = idx >= 0 ? idx : Math.min(activeTrackIndex, tracks.length - 1);
      ensureTracks();
      if (keepClip && tracks[activeTrackIndex]?.clips?.some(c => c.id === keepClip)) {
        activeClipId = keepClip;
        const clip = getActiveClip();
        if (clip && keepView === "editor") syncTrackNotesFromClip(tracks[activeTrackIndex], clip);
      }
      if (payload.bpm && bpmInput) { bpmInput.value = payload.bpm; timelineBpm = payload.bpm; }
      if (typeof payload.loopEnabled === "boolean") { loopEnabled = payload.loopEnabled; loopBtn?.classList.toggle("active", loopEnabled); }
      state.lastSentSig = JSON.stringify(projectPayload());
      renderSidebarTracks(); renderSequencer(); window.renderMixer();
      if (currentView === "editor") { drawPianoRoll(lastPlayheadSec); drawVelocityLane(); }
    } catch (e) {
      console.error("remote project apply failed", e);
    } finally {
      historyLocked = false;
      state.applyingRemote = false;
    }
  }

  // broadcast transport + presence changes
  let hooked = false;
  function hookTransport() {
    if (hooked) return;
    hooked = true;
    let wasPlaying = false;
    setInterval(() => {
      if (!state.room) return;
      if (isPlaying !== wasPlaying) {
        wasPlaying = isPlaying;
        state.actions.transport.send({ playing: isPlaying, pos: lastPlayheadSec || 0 });
      }
    }, 150);
    let lastPresence = "";
    setInterval(() => {
      if (!state.room) return;
      const key = currentView + "|" + (tracks[activeTrackIndex]?.id || "") + "|" + state.name;
      if (key !== lastPresence) { lastPresence = key; sendPresence(); }
    }, 500);
  }

  // ---------------------------------------------------------------------------
  // Video / voice
  // ---------------------------------------------------------------------------
  async function toggleMedia(kind) {
    if (!state.room) { toast("Start or join a session first"); return; }
    if (kind === "cam") state.camOn = !state.camOn; else state.micOn = !state.micOn;
    stopLocalMedia(true);
    if (!state.camOn && !state.micOn) { renderMediaButtons(); return; }
    try {
      state.localStream = await navigator.mediaDevices.getUserMedia({
        video: state.camOn ? { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 20 } } : false,
        audio: state.micOn ? { echoCancellation: true, noiseSuppression: true } : false
      });
      state.room.addStream(state.localStream);
      addPeerVideo("self", state.localStream, true);
    } catch (err) {
      toast("Camera/mic unavailable: " + err.message);
      state.camOn = false; state.micOn = false;
    }
    renderMediaButtons();
  }

  function stopLocalMedia(keepFlags = false) {
    if (state.localStream) {
      try { state.room?.removeStream(state.localStream); } catch (e) {}
      state.localStream.getTracks().forEach(t => t.stop());
      state.localStream = null;
    }
    removePeerVideo("self");
    if (!keepFlags) { state.camOn = false; state.micOn = false; renderMediaButtons(); }
  }

  function renderMediaButtons() {
    document.querySelector("#collabPanel .cp-cam")?.classList.toggle("on", state.camOn);
    document.querySelector("#collabPanel .cp-mic")?.classList.toggle("on", state.micOn);
  }

  function addPeerVideo(peerId, stream, isSelf = false) {
    const box = document.querySelector("#collabPanel .cp-videos");
    if (!box) return;
    removePeerVideo(peerId);
    const tile = document.createElement("div");
    tile.className = "cp-video";
    tile.dataset.peer = peerId;
    const v = document.createElement("video");
    v.autoplay = true; v.playsInline = true; v.muted = isSelf;
    v.srcObject = stream;
    const label = document.createElement("span");
    label.textContent = isSelf ? "You" : (state.peers.get(peerId)?.name || "Guest");
    if (!stream.getVideoTracks().length) tile.classList.add("audio-only");
    tile.append(v, label);
    box.appendChild(tile);
    state.peerStreams.set(peerId, stream);
    stream.addEventListener?.("removetrack", () => { if (!stream.getTracks().length) removePeerVideo(peerId); });
  }

  function removePeerVideo(peerId) {
    document.querySelectorAll(`#collabPanel .cp-video[data-peer="${CSS.escape(peerId)}"]`).forEach(el => el.remove());
    state.peerStreams.delete(peerId);
  }

  // ---------------------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", () => {
    buildPanel();
    const fromHash = parseRoom((location.hash.match(/room=([^&]+)/) || [])[1] || "");
    if (fromHash) {
      // auto-join links, but only after the user confirms (joining replaces the project)
      setTimeout(() => {
        togglePanel(true);
        const box = document.querySelector("#collabPanel .cp-session");
        const code = box?.querySelector(".cp-code");
        if (code) code.value = fromHash;
        addChatLine({ system: true, text: `Invitation to room "${fromHash}". Enter your name and press Join.` });
      }, 300);
    }
  });

  window.WAWCollab = { notifyChange, start, leave, get state() { return state; }, togglePanel, paintPresence: paintTrackPresence };
})();
