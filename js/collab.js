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
        <label class="cp-check" title="When someone presses Record, start recording your own armed tracks at the same song position (and stop with them). Arm the tracks you play on."><input type="checkbox" class="cp-rectog" ${state.recordTogether ? "checked" : ""}> Record together (band mode)</label>
        <p class="cp-note">Arming, monitoring and audio inputs are yours only: everyone arms and records their own tracks. Each take lines up with the song as you heard it.</p>
        <button type="button" class="cp-leave">Leave session</button>`;
      box.querySelector(".cp-copy").addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(link); toast("Session link copied"); }
        catch (e) { box.querySelector(".cp-link").select(); }
      });
      box.querySelector(".cp-follow").addEventListener("change", (e) => { state.followTransport = e.target.checked; });
      box.querySelector(".cp-rectog").addEventListener("change", (e) => { state.recordTogether = e.target.checked; });
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
    units.clear(); clock = 0;
    state.room = lib.joinRoom({ appId: APP_ID, password: roomId }, roomId);
    state.peers.clear();
    // creator owns version 1; a joiner starts at 0 so the room's state wins
    if (isNew) { state.version = Math.max(1, state.version + 1); state.versionBy = state.selfId; state.adoptedRoom = true; }
    else {
      state.version = 0; state.versionBy = ""; state.adoptedRoom = false;
      // nobody sent a project (empty room, or everyone else left): own the session
      clearTimeout(state.adoptTimer);
      state.adoptTimer = setTimeout(() => {
        if (!state.room || state.adoptedRoom) return;
        state.adoptedRoom = true;
        state.version = 1; state.versionBy = state.selfId;
        if (state.peers.size) sendProject();
      }, 10000);
    }
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
      if (state.adoptedRoom) sendProject(peerId);
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
      // "Record together": start / stop our own recording with the others
      if (state.recordTogether && typeof data?.recording === "boolean") {
        if (data.recording && !isRecording && tracks.some(t => t.armed)) {
          state.remoteRecording = true;
          state.remoteTransport = true;
          stopPlayback();
          lastPlayheadSec = clamp(Number(data.pos) || 0, 0, 36000);
          playheadWasManuallySet = true;
          startRecording();
          statusEl.textContent = `Recording together with ${state.peers.get(data.from)?.name || "the session"}…`;
          return;
        }
        if (!data.recording && isRecording && state.remoteRecording) {
          state.remoteRecording = false;
          state.remoteTransport = false;
          stopRecording();
          return;
        }
      }
      if (!state.followTransport || isRecording) return;
      // remember the remote state so our transport watcher does not echo it back
      // (the echo restarted playback on the sender)
      state.remoteTransport = !!data?.playing;
      if (data?.playing) {
        if (isPlaying) return;
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
    clearTimeout(state.adoptTimer);
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
  // ---------------------------------------------------------------------------
  // Project sync (protocol 2): the project is split into UNITS, each a
  // last-writer-wins register with its own Lamport version, so concurrent
  // edits on different parts merge instead of overwriting each other:
  //   t:<id>:meta     name, colour, type, instrument, mute/solo, alive
  //   t:<id>:mix      volume, pan, mono, strip, inserts, sends, automation
  //   t:<id>:inst     synth / drum synth / sampler patch
  //   t:<id>:content  clips + notes
  //   g:order g:mixer g:tempo g:loop g:key
  // Per-user settings never leave the computer: armed, monitor, input, midiIn.
  // Remote units are applied IN PLACE (track objects keep their identity), and
  // the content of a track that is being recorded locally is kept until the
  // take is finished, so recording and someone else's mixing do not collide.
  // ---------------------------------------------------------------------------
  const LOCAL_FIELDS = new Set(["armed", "monitor", "input", "midiIn"]);
  const UNIT_FIELDS = {
    mix: ["volume", "pan", "mono", "strip", "inserts", "sends", "sendPre", "automation"],
    inst: ["synthPatch", "drum808Patch", "samplerPatch"],
    content: ["clips", "notes"],
  };
  const NON_META = new Set([...LOCAL_FIELDS, ...Object.values(UNIT_FIELDS).flat()]);
  const units = new Map(); // key -> { v, by, h }
  let clock = 0;

  function hashStr(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(36) + ":" + s.length; }
  const plain = (v) => JSON.parse(JSON.stringify(v ?? null));

  /** current local state split into units: Map(key -> value) */
  function localUnits() {
    if (currentView === "editor" && typeof saveEditorNotesToActiveClip === "function") { try { saveEditorNotesToActiveClip(); } catch (e) {} }
    const out = new Map();
    tracks.forEach(t => {
      const meta = { alive: true };
      Object.keys(t).forEach(k => { if (!NON_META.has(k) && typeof t[k] !== "function") meta[k] = t[k]; });
      out.set(`t:${t.id}:meta`, plain(meta));
      Object.entries(UNIT_FIELDS).forEach(([u, fields]) => {
        const v = {}; fields.forEach(f => { if (t[f] !== undefined) v[f] = t[f]; });
        out.set(`t:${t.id}:${u}`, plain(v));
      });
    });
    // deleted tracks keep a tombstone so the deletion wins over older edits
    units.forEach((rec, key) => {
      const m = /^t:(.+):meta$/.exec(key);
      if (m && !tracks.some(t => t.id === m[1])) out.set(key, rec.dead ? rec.value : { alive: false, id: m[1] });
    });
    out.set("g:order", tracks.map(t => t.id));
    out.set("g:mixer", window.WAWMixer?.serialize() ?? null);
    out.set("g:tempo", { map: window.WAWTempo?.serialize() ?? null, timelineBpm });
    out.set("g:loop", { loopStartSec, loopEndSec, loopEnabled });
    out.set("g:key", { tonicName, scaleId: scaleSelect ? scaleSelect.value : "major" });
    return out;
  }

  /** bump the version of every unit whose content changed locally */
  function stampLocal() {
    const cur = localUnits();
    let changed = false;
    cur.forEach((value, key) => {
      const h = hashStr(JSON.stringify(value));
      const rec = units.get(key);
      if (rec && rec.h === h) return;
      clock += 1;
      units.set(key, { v: clock, by: state.selfId, h, value, dead: value?.alive === false });
      changed = true;
    });
    return { cur, changed };
  }

  function packet() {
    const out = {};
    units.forEach((rec, key) => { out[key] = { v: rec.v, by: rec.by, value: rec.value }; });
    return { proto: 2, clock, units: out, lead: state.selfId };
  }

  let changeTimer = null;
  function notifyChange() {
    // a joiner must not broadcast before it has received the room's project,
    // otherwise its local project can win and overwrite everybody's work
    if (!state.room || state.applyingRemote || !state.adoptedRoom) return;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      const { changed } = stampLocal();
      if (!changed) return;
      state.actions.project.send(packet());
    }, 350);
  }

  function sendProject(target) {
    stampLocal();
    state.actions.project.send(packet(), target ? { target } : undefined);
  }

  const wins = (r, l) => !l || r.v > l.v || (r.v === l.v && String(r.by) > String(l.by));

  async function receiveProject(data, peerId) {
    if (!data || typeof data !== "object" || data.proto !== 2 || !data.units || typeof data.units !== "object") return;
    clock = Math.max(clock, Number(data.clock) || 0);
    if (!state.adoptedRoom) {
      // first state from the room: keep a backup of whatever was open locally,
      // then take the room's project as a whole
      state.adoptedRoom = true;
      clearTimeout(state.adoptTimer);
      const hasContent = tracks.some(t => (t.clips || []).length || (t.notes || []).length);
      if (hasContent) {
        try { saveProjectToLibrary(`Backup before ${state.roomId}`, { newProject: true, silent: true }); } catch (e) {}
        setActiveProject(null);
      }
      units.clear();
      tracks.splice(0, tracks.length);
    }
    const incoming = [];
    Object.entries(data.units).forEach(([key, rec]) => {
      if (!rec || typeof rec !== "object" || !Number.isFinite(rec.v)) return;
      if (wins(rec, units.get(key))) incoming.push([key, rec]);
    });
    if (incoming.length) mergeUnits(incoming);
    // fetch any audio we don't have yet
    const missing = [...window.WAWSampler.sampleIdsInUse(tracks)].filter(id => !window.WAWSamples.has(id));
    if (missing.length) {
      const stillMissing = [];
      for (const id of missing) { if (!(await window.WAWSamples.load(id))) stillMissing.push(id); }
      if (stillMissing.length) state.actions.smpReq.send({ ids: stillMissing }, { target: peerId });
      else renderSequencer();
    }
  }

  const toNotes = (arr) => (Array.isArray(arr) ? arr : []).map(o => new NoteEvent(o.startSec, o.endSec, o.midiNote, o.velocity, o.scaleDegree, o.octave));

  /** is this track being recorded into right now (its clips must not be replaced)? */
  function recordingLocally(t) {
    if (!isRecording) return false;
    if (t.armed) return true;
    return tracks.indexOf(t) === clipRecordTrackIndex;
  }

  function mergeUnits(incoming) {
    state.applyingRemote = true;
    try {
      if (currentView === "editor") { try { saveEditorNotesToActiveClip(); } catch (e) {} }
      const keepTrackId = tracks[activeTrackIndex]?.id;
      let order = null, structural = false;
      const byId = new Map(tracks.map(t => [t.id, t]));
      const getTrack = (id) => {
        let t = byId.get(id);
        if (!t) { t = normalizeTrack({ id, name: "Track", clips: [], notes: [] }, tracks.length); tracks.push(t); byId.set(id, t); structural = true; }
        return t;
      };
      const removed = new Set();
      const applied = new Set();
      incoming.forEach(([key, rec]) => {
        const value = rec.value;
        const m = /^t:(.+):(meta|mix|inst|content)$/.exec(key);
        if (m) {
          const [, id, unit] = m;
          if (unit === "meta" && value?.alive === false) {
            removed.add(id);
            units.set(key, { v: rec.v, by: rec.by, h: hashStr(JSON.stringify(value)), value, dead: true });
            return;
          }
          if (removed.has(id)) return;
          const t = getTrack(id);
          if (unit === "content" && recordingLocally(t)) return; // keep the take; ours will win when it is done
          if (unit === "meta") {
            Object.keys(t).forEach(k => { if (!NON_META.has(k) && k !== "id" && !(k in value)) delete t[k]; });
            Object.entries(value || {}).forEach(([k, v]) => { if (k !== "alive" && k !== "id" && !LOCAL_FIELDS.has(k)) t[k] = v; });
            structural = true;
          } else {
            UNIT_FIELDS[unit].forEach(f => { if (value && f in value) t[f] = structuredClone(value[f]); else if (unit !== "content") delete t[f]; });
            if (unit === "content") {
              t.notes = toNotes(t.notes);
              t.clips = (t.clips || []).map(c => ({ ...c, notesSnapshot: toNotes(c.notesSnapshot) }));
            }
            if (unit === "mix") window.WAWMixer?.normalizeTrackMix(t);
            if (unit === "inst" && t.instrument === "sampler") window.WAWSampler?.normalizeTrack(t);
          }
        } else if (key === "g:order") { order = Array.isArray(value) ? value.map(String) : null; }
        else if (key === "g:mixer" && value && window.WAWMixer) window.WAWMixer.state = value;
        else if (key === "g:tempo" && value) {
          if (value.map && window.WAWTempo) window.WAWTempo.setState(value.map, value.timelineBpm);
          if (Number.isFinite(value.timelineBpm)) { timelineBpm = value.timelineBpm; if (bpmInput) bpmInput.value = value.timelineBpm; }
        } else if (key === "g:loop" && value) {
          loopStartSec = Number(value.loopStartSec) || 0; loopEndSec = Number(value.loopEndSec) || 0;
          loopEnabled = !!value.loopEnabled; loopBtn?.classList.toggle("active", loopEnabled);
        } else if (key === "g:key" && value) {
          tonicName = value.tonicName || tonicName;
          if (scaleSelect && value.scaleId) scaleSelect.value = value.scaleId;
        }
        units.set(key, { v: rec.v, by: rec.by, h: hashStr(JSON.stringify(value)), value });
        applied.add(key);
      });
      // remove deleted tracks; order = the winning order, then any other live tracks
      if (removed.size) { for (let i = tracks.length - 1; i >= 0; i--) if (removed.has(tracks[i].id)) tracks.splice(i, 1); structural = true; }
      if (order) {
        const pos = new Map(order.map((id, i) => [id, i]));
        tracks.sort((a, b) => (pos.has(a.id) ? pos.get(a.id) : 1e9) - (pos.has(b.id) ? pos.get(b.id) : 1e9));
        structural = true;
      }
      const idx = tracks.findIndex(t => t.id === keepTrackId);
      activeTrackIndex = idx >= 0 ? idx : Math.max(0, Math.min(activeTrackIndex, tracks.length - 1));
      ensureTracks();
      notes = tracks[activeTrackIndex]?.notes || notes;
      if (activeClipId && !tracks[activeTrackIndex]?.clips?.some(c => c.id === activeClipId)) activeClipId = null;
      void structural;
      window.WAWMixer?.syncEngine?.();
      window.WAWAudio?.syncInputs?.();
      renderSidebarTracks(); renderSequencer(); window.renderMixer();
      window.WAWSampler?.refreshIfStale?.(); window.WAWAudio?.refreshEditor?.();
      window.WAWSynthPanel?.refresh?.(); window.WAWDrumPanel?.refresh?.();
      if (currentView === "editor") { drawPianoRoll(lastPlayheadSec); drawVelocityLane(); }
      drawAllLoopBars?.(lastPlayheadSec);
      // record how the merged units look locally (normalisation may add
      // defaults) WITHOUT bumping versions, and only for the merged units:
      // our own pending changes (e.g. a take that just finished) must still be
      // detected and sent by notifyChange
      const cur = localUnits();
      applied.forEach((key) => {
        const r = units.get(key);
        if (r && cur.has(key)) { r.value = cur.get(key); r.h = hashStr(JSON.stringify(r.value)); }
      });
    } catch (e) {
      console.error("remote project merge failed", e);
    } finally {
      state.applyingRemote = false;
    }
  }

  // broadcast transport + presence changes
  let hooked = false;
  function hookTransport() {
    if (hooked) return;
    hooked = true;
    let wasPlaying = false, wasRecording = false;
    setInterval(() => {
      if (!state.room) return;
      if (isRecording !== wasRecording) {
        wasRecording = isRecording;
        // a recording we started because someone else did is not broadcast again
        if (!state.remoteRecording || !isRecording) {
          if (!(state.remoteRecordingEnded && !isRecording)) {
            state.actions.transport.send({ playing: isPlaying, recording: isRecording, pos: (isRecording ? recordingBaseSec : lastPlayheadSec) || 0, from: state.selfId });
          }
        }
        state.remoteRecordingEnded = false;
        wasPlaying = isPlaying;
        return;
      }
      if (isPlaying !== wasPlaying) {
        wasPlaying = isPlaying;
        const echo = state.remoteTransport === isPlaying;
        state.remoteTransport = null;
        if (!echo && !isRecording) state.actions.transport.send({ playing: isPlaying, pos: lastPlayheadSec || 0, from: state.selfId });
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
