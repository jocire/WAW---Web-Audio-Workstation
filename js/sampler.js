// WAW Sampler — MPC-style 16-pad sampler instrument.
// Pads respond to MIDI notes 36..51 (pad 1 = note 36) and the computer keys
// Z X C V / A S D F / Q W E R / 1 2 3 4 (bottom row = pads 1-4).
(function () {
  "use strict";
  const S = () => window.WAWSamples;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const PAD_COUNT = 16;
  const BASE_NOTE = 36;

  function defaultPad(i) {
    return {
      sampleId: null, name: `Pad ${i + 1}`,
      start: 0, end: 1,               // fraction of the sample
      gain: 0, tune: 0, fine: 0, pan: 0,
      attack: 0.001, release: 0.05,
      mode: "oneshot",                // oneshot | gate | loop
      reverse: false,
      choke: 0,                       // 0 = none, 1..4 = choke group
      velSens: 0.7,
      cutoff: 20000, resonance: 0.7
    };
  }

  function normalizeTrack(track) {
    // Normalize IN PLACE: this runs on every note and sidebar render, and the pad
    // editor holds references to the pad objects (replacing them lost knob edits).
    if (!track.samplerPatch || typeof track.samplerPatch !== "object") track.samplerPatch = {};
    const sp = track.samplerPatch;
    if (!Array.isArray(sp.pads)) sp.pads = [];
    for (let i = 0; i < PAD_COUNT; i++) {
      const p = sp.pads[i];
      if (!p || typeof p !== "object") { sp.pads[i] = defaultPad(i); continue; }
      const def = defaultPad(i);
      for (const k in def) if (p[k] === undefined) p[k] = def[k];
    }
    sp.pads.length = PAD_COUNT;
    sp.kitName = sp.kitName || "Empty Kit";
    sp.selected = clamp(Number(sp.selected) || 0, 0, PAD_COUNT - 1);
    return track;
  }

  function padIndexForNote(note) {
    const i = Math.round(note) - BASE_NOTE;
    return i >= 0 && i < PAD_COUNT ? i : -1;
  }

  // reversed copies, cached per AudioBuffer
  const reversed = new WeakMap();
  function getReversed(buf) {
    let r = reversed.get(buf);
    if (!r) {
      r = new AudioBuffer({ numberOfChannels: buf.numberOfChannels, length: buf.length, sampleRate: buf.sampleRate });
      for (let c = 0; c < buf.numberOfChannels; c++) { const d = new Float32Array(buf.getChannelData(c)); d.reverse(); r.copyToChannel(d, c); }
      reversed.set(buf, r);
    }
    return r;
  }

  // per-context, per-track active voices (for choke groups + live note-off)
  const voiceState = new WeakMap();
  function voicesFor(ctx, trackId) {
    let m = voiceState.get(ctx);
    if (!m) { m = new Map(); voiceState.set(ctx, m); }
    if (!m.has(trackId)) m.set(trackId, []);
    return m.get(trackId);
  }

  /**
   * Schedule a pad hit. t1 == null -> held (live) note, released with previewOff.
   * Returns the created source nodes.
   */
  function scheduleNote(ctx, destination, track, midiNote, velocity, t0, t1 = null) {
    if (!track) return [];
    normalizeTrack(track);
    const padIdx = padIndexForNote(midiNote);
    if (padIdx < 0) return [];
    const pad = track.samplerPatch.pads[padIdx];
    const raw = S().get(pad.sampleId);
    if (!raw) { if (pad.sampleId) S().load(pad.sampleId); return []; }
    const buf = pad.reverse ? getReversed(raw) : raw;
    const dur = buf.duration;
    let a = clamp(pad.start, 0, 1) * dur, b = clamp(pad.end, 0, 1) * dur;
    if (b <= a) b = Math.min(dur, a + 0.01);
    if (pad.reverse) { const na = dur - b, nb = dur - a; a = na; b = nb; }
    const regionLen = b - a;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    const rate = Math.pow(2, (pad.tune + pad.fine / 100) / 12);
    src.playbackRate.value = rate;
    if (pad.mode === "loop") { src.loop = true; src.loopStart = a; src.loopEnd = b; }

    const filt = ctx.createBiquadFilter();
    filt.type = "lowpass";
    filt.frequency.value = Math.min(pad.cutoff, ctx.sampleRate / 2 - 100);
    filt.Q.value = pad.resonance;
    const env = ctx.createGain();
    const vel = clamp(velocity / 127, 0, 1);
    const level = Math.pow(10, pad.gain / 20) * ((1 - pad.velSens) + pad.velSens * vel);
    const atk = Math.max(0.0005, pad.attack);
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(level, t0 + atk);
    let node = env;
    if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = clamp(pad.pan, -1, 1); env.connect(p); node = p; }
    src.connect(filt); filt.connect(env); node.connect(destination);

    // choke: stop other voices of the same group on this track
    const voices = voicesFor(ctx, track.id);
    if (pad.choke > 0) {
      voices.filter(v => v.choke === pad.choke && v.t0 < t0).forEach(v => {
        try { v.env.gain.cancelScheduledValues(t0); v.env.gain.setTargetAtTime(0, t0, 0.008); v.src.stop(t0 + 0.06); } catch (e) {}
      });
    }

    const rel = Math.max(0.005, pad.release);
    const naturalEnd = t0 + regionLen / rate;
    let stopAt = null;
    if (pad.mode === "oneshot") stopAt = naturalEnd;
    else if (t1 != null) stopAt = pad.mode === "loop" ? t1 : Math.min(t1, naturalEnd);
    if (stopAt != null) {
      env.gain.setValueAtTime(level, Math.max(t0 + atk, stopAt - 0.0001));
      env.gain.linearRampToValueAtTime(0, stopAt + rel);
      src.start(t0, a, pad.mode === "loop" ? undefined : regionLen);
      src.stop(stopAt + rel + 0.02);
    } else {
      src.start(t0, a, pad.mode === "loop" ? undefined : regionLen);
    }

    const voice = { src, env, choke: pad.choke, t0, note: midiNote, held: stopAt == null, release: rel };
    voices.push(voice);
    src.addEventListener("ended", () => { const i = voices.indexOf(voice); if (i >= 0) voices.splice(i, 1); }, { once: true });
    flashPad(track, padIdx);
    return [src];
  }

  function previewOn(track, note, velocity) {
    const ctx = ensureAudioContext();
    const pad = track?.samplerPatch?.pads?.[padIndexForNote(note)];
    // one-shot pads play out; gate/loop pads are held until the key is released
    scheduleNote(ctx, window.WAWMixer.getTrackInput(track), track, note, velocity, ctx.currentTime, pad?.mode === "oneshot" ? undefined : null);
  }

  function previewOff(track, note) {
    const ctx = ensureAudioContext();
    const voices = voicesFor(ctx, track.id);
    voices.filter(v => v.held && v.note === note).forEach(v => {
      const t = ctx.currentTime;
      try { v.env.gain.cancelScheduledValues(t); v.env.gain.setValueAtTime(v.env.gain.value, t); v.env.gain.linearRampToValueAtTime(0, t + v.release); v.src.stop(t + v.release + 0.02); } catch (e) {}
      v.held = false;
    });
  }

  async function preloadForTracks(list) {
    const ids = new Set();
    (list || []).forEach(t => (t.samplerPatch?.pads || []).forEach(p => p.sampleId && ids.add(p.sampleId)));
    await Promise.all([...ids].map(id => S().load(id)));
  }

  function sampleIdsInUse(list) {
    const ids = new Set();
    (list || []).forEach(t => {
      (t.samplerPatch?.pads || []).forEach(p => p.sampleId && ids.add(p.sampleId));
      (t.clips || []).forEach(c => {
        if (c.audio?.sampleId) ids.add(c.audio.sampleId);
        (c.takes || []).forEach(x => x.sampleId && ids.add(x.sampleId)); // comp takes
      });
    });
    return ids;
  }

  // ---------------------------------------------------------------------------
  // Render the Drum Synth into a starter kit (so the sampler is playable at once)
  // ---------------------------------------------------------------------------
  async function renderDrumKit(track) {
    const voices = DRUM_808_VOICES;
    const kit = createDefault808Patch();
    const rate = 44100;
    for (let i = 0; i < PAD_COUNT; i++) {
      const v = voices[i];
      const len = v.id === "cymbal" || v.id === "openHat" ? 1.8 : 1.0;
      const off = new OfflineAudioContext(2, Math.ceil(rate * len), rate);
      window.WAWDrums.trigger(off, off.destination, v.id, 112, kit, 0);
      const buf = await off.startRendering();
      const id = await S().put(trimSilence(buf), `Synth ${v.label}`);
      track.samplerPatch.pads[i] = { ...defaultPad(i), sampleId: id, name: v.label, choke: v.id === "closedHat" || v.id === "openHat" ? 1 : 0 };
    }
    track.samplerPatch.kitName = "Drum Synth Kit";
  }

  function trimSilence(buf, threshold = 0.0005) {
    let last = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = d.length - 1; i > last; i--) if (Math.abs(d[i]) > threshold) { last = i; break; }
    }
    const len = Math.min(buf.length, last + Math.floor(buf.sampleRate * 0.02));
    const out = new AudioBuffer({ numberOfChannels: buf.numberOfChannels, length: Math.max(1, len), sampleRate: buf.sampleRate });
    for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).subarray(0, len), c);
    return out;
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------
  let modal = null;
  let currentTrack = null;
  const flashTimers = new Map();

  function flashPad(track, idx) {
    if (!track || typeof document === "undefined") return;
    requestAnimationFrame(() => {
      document.querySelectorAll(`.smp-pad[data-track="${track.id}"][data-pad="${idx}"]`).forEach(el => {
        el.classList.add("hit");
        clearTimeout(flashTimers.get(el));
        flashTimers.set(el, setTimeout(() => el.classList.remove("hit"), 110));
      });
    });
  }

  function padGridHtml(track, small = false) {
    // MPC layout: pads 13-16 on top, 1-4 at the bottom
    const order = [12, 13, 14, 15, 8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3];
    return `<div class="smp-grid${small ? " small" : ""}">${order.map(i => {
      const p = track.samplerPatch.pads[i];
      const sel = track.samplerPatch.selected === i ? " selected" : "";
      const empty = p.sampleId ? "" : " empty";
      const PM = window.WAWPadMap;
      const key = PM ? PM.keyLabel(i) : PAD_KEY_LABELS[i];
      const midi = PM ? PM.midiLabel(i, "sampler") : String(BASE_NOTE + i);
      const learning = PM?.learn.mode && PM.learn.pad === i ? " learning" : "";
      return `<button type="button" class="smp-pad${sel}${empty}${learning}" data-track="${escapeHtml(track.id)}" data-pad="${i}" title="Pad ${i + 1} · MIDI ${midi}${PM?.isLearned(i) ? " (learned)" : ""} · key ${key}">
        <span class="smp-num">${i + 1}</span><span class="smp-key">${escapeHtml(key)}</span><span class="smp-midi">${escapeHtml(midi)}</span><span class="smp-name">${escapeHtml(p.sampleId ? p.name : "—")}</span></button>`;
    }).join("")}</div>`;
  }

  function attachPadEvents(root, track, { select = true } = {}) {
    root.querySelectorAll(".smp-pad").forEach(el => {
      const idx = Number(el.dataset.pad);
      el.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        window.WAWPadMap?.setLearnPad(idx); // in learn mode: choose the pad to map
        const note = BASE_NOTE + idx;
        midiNoteOn(note, 110);
        const up = () => { midiNoteOff(note); window.removeEventListener("pointerup", up); };
        window.addEventListener("pointerup", up);
        if (select && track.samplerPatch.selected !== idx) {
          track.samplerPatch.selected = idx;
          root.querySelectorAll(".smp-pad").forEach(p => p.classList.toggle("selected", Number(p.dataset.pad) === idx));
          if (modal?.classList.contains("visible")) renderEditor();
        }
      });
      el.addEventListener("click", e => e.stopPropagation());
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault(); e.stopPropagation();
        if (!track.samplerPatch.pads[idx].sampleId) return;
        if (!confirm(`Clear pad ${idx + 1}?`)) return;
        pushHistory();
        track.samplerPatch.pads[idx] = defaultPad(idx);
        refreshAll(track);
      });
      // drag & drop audio files onto a pad
      el.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); el.classList.add("drop"); } });
      el.addEventListener("dragleave", () => el.classList.remove("drop"));
      el.addEventListener("drop", async (e) => {
        e.preventDefault(); el.classList.remove("drop");
        const files = [...e.dataTransfer.files].filter(f => f.type.startsWith("audio/") || /\.(wav|mp3|ogg|flac|m4a|aif+)$/i.test(f.name));
        if (!files.length) return;
        pushHistory();
        // multiple files fill consecutive pads
        for (let k = 0; k < files.length && idx + k < PAD_COUNT; k++) await loadFileIntoPad(track, idx + k, files[k], false);
        refreshAll(track);
        window.WAWCollab?.notifyChange?.();
      });
    });
  }

  async function loadFileIntoPad(track, idx, file, withHistory = true) {
    try {
      if (withHistory) pushHistory();
      const id = await S().importFile(file);
      track.samplerPatch.pads[idx] = { ...defaultPad(idx), ...track.samplerPatch.pads[idx], sampleId: id, name: S().name(id), start: 0, end: 1, reverse: false };
      statusEl.textContent = `Loaded "${S().name(id)}" into pad ${idx + 1}.`;
    } catch (err) {
      console.error(err);
      statusEl.textContent = "Could not decode that audio file: " + err.message;
    }
  }

  function refreshAll(track) {
    if (track === getActiveTrack()) renderSidebarTracks();
    if (modal?.classList.contains("visible") && currentTrack === track) renderModal();
  }

  function sidebarPanelHtml(track) {
    normalizeTrack(track);
    return `<button type="button" class="edit-synth-btn smp-open">Edit Sampler</button>${padGridHtml(track, true)}`;
  }

  function attachSidebarPanel(root, track) {
    root.querySelector(".smp-open")?.addEventListener("click", (e) => { e.stopPropagation(); open(track); });
    attachPadEvents(root, track, { select: true });
  }

  function ensureModal() {
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = "samplerModal";
    modal.className = "modal-backdrop sampler-modal";
    modal.innerHTML = `<div class="modal-dialog sampler-dialog">
      <div class="modal-header"><span id="smpTitle">Sampler</span><button type="button" id="smpClose">×</button></div>
      <div class="smp-body"><div class="smp-left" id="smpLeft"></div><div class="smp-right" id="smpRight"></div></div>
    </div>`;
    document.body.appendChild(modal);
    modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
    modal.querySelector("#smpClose").addEventListener("click", close);
    return modal;
  }

  function open(track = getActiveTrack()) {
    if (!track) return;
    normalizeTrack(track);
    currentTrack = track;
    ensureModal();
    preloadForTracks([track]).then(() => renderModal());
    renderModal();
    modal.classList.add("visible");
  }
  function close() { modal?.classList.remove("visible"); stopRecording(); }

  /** undo/redo and collaborators replace track objects: re-bind the open editor */
  function refreshIfStale() {
    if (!modal?.classList.contains("visible") || !currentTrack) return;
    const fresh = tracks.find(x => x.id === currentTrack.id);
    if (!fresh || fresh.instrument !== "sampler") { close(); return; }
    if (fresh !== currentTrack) { normalizeTrack(fresh); currentTrack = fresh; renderModal(); }
  }

  function renderModal() {
    const t = currentTrack;
    if (!t || !modal) return;
    modal.querySelector("#smpTitle").textContent = `Sampler · ${t.name} · ${t.samplerPatch.kitName}`;
    const left = modal.querySelector("#smpLeft");
    left.innerHTML = `${padGridHtml(t)}
      <div class="smp-kit-actions">
        <button type="button" data-act="kit">Load Drum-Synth Kit</button>
        <button type="button" data-act="multi">Load Files…</button>
        <button type="button" data-act="clearkit">Clear Kit</button>
      </div>
      ${window.WAWPadMap ? window.WAWPadMap.toolbarHtml() : ""}
      <p class="smp-hint">Click/hold pads, play the keys shown on them, or use your MIDI controller (notes 36–51 by default; MIDI Learn maps any controller). Drop audio files on pads. Right-click a pad to clear it.</p>`;
    attachPadEvents(left, t);
    window.WAWPadMap?.attachToolbar(left, () => t.samplerPatch.selected || 0);
    left.querySelector('[data-act="kit"]').addEventListener("click", async () => {
      pushHistory();
      statusEl.textContent = "Rendering drum synth kit…";
      await renderDrumKit(t);
      statusEl.textContent = "Drum synth kit loaded into the sampler.";
      refreshAll(t);
      window.WAWCollab?.notifyChange?.();
    });
    left.querySelector('[data-act="multi"]').addEventListener("click", () => pickFiles(true, async files => {
      pushHistory();
      for (let k = 0; k < files.length && k < PAD_COUNT; k++) await loadFileIntoPad(t, k, files[k], false);
      refreshAll(t); window.WAWCollab?.notifyChange?.();
    }));
    left.querySelector('[data-act="clearkit"]').addEventListener("click", () => {
      if (!confirm("Clear all 16 pads?")) return;
      pushHistory();
      t.samplerPatch.pads = Array.from({ length: PAD_COUNT }, (_, i) => defaultPad(i));
      t.samplerPatch.kitName = "Empty Kit";
      refreshAll(t); window.WAWCollab?.notifyChange?.();
    });
    renderEditor();
  }

  function pickFiles(multiple, cb) {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = "audio/*"; inp.multiple = multiple;
    inp.addEventListener("change", () => { if (inp.files?.length) cb([...inp.files]); });
    inp.click();
  }

  // ----- pad editor -----
  let recCtl = null;
  function stopRecording() { if (recCtl) { recCtl.cancel?.(); recCtl = null; } }

  function renderEditor() {
    const t = currentTrack;
    const right = modal.querySelector("#smpRight");
    const idx = t.samplerPatch.selected;
    const pad = t.samplerPatch.pads[idx];
    right.innerHTML = `
      <div class="smp-ed-head">
        <strong>Pad ${idx + 1}</strong>
        <input type="text" class="smp-pad-name" value="${escapeHtml(pad.name)}" spellcheck="false" aria-label="Pad name">
        <span class="smp-dur"></span>
      </div>
      <div class="smp-wave-wrap"><canvas class="smp-wave"></canvas><div class="smp-region"></div><div class="smp-mark start" title="Drag: sample start"></div><div class="smp-mark end" title="Drag: sample end"></div></div>
      <div class="smp-tools">
        <button type="button" data-act="load">Load File</button>
        <button type="button" data-act="rec" class="${recCtl ? "on" : ""}">${recCtl ? "■ Stop Rec" : "● Record"}</button>
        <button type="button" data-act="play">▶ Audition</button>
        <button type="button" data-act="normalize">Normalize</button>
        <button type="button" data-act="crop">Crop to Region</button>
        <button type="button" data-act="fadeIn">Fade In</button>
        <button type="button" data-act="fadeOut">Fade Out</button>
        <button type="button" data-act="chopEq">Chop ×16 (equal)</button>
        <button type="button" data-act="chopTr">Chop (transients)</button>
        <button type="button" data-act="clear">Clear Pad</button>
      </div>
      <div class="smp-params"></div>`;
    right.querySelector(".smp-pad-name").addEventListener("change", (e) => {
      pushHistory(); pad.name = e.target.value.trim() || `Pad ${idx + 1}`; refreshAll(t); window.WAWCollab?.notifyChange?.();
    });
    drawEditorWave(right, pad);
    attachMarkers(right, pad);

    const act = (name, fn) => right.querySelector(`[data-act="${name}"]`).addEventListener("click", fn);
    act("load", () => pickFiles(false, async files => { await loadFileIntoPad(t, idx, files[0]); refreshAll(t); window.WAWCollab?.notifyChange?.(); }));
    act("rec", async () => {
      if (recCtl) {
        const ctl = recCtl; recCtl = null;
        const buf = await ctl.stop();
        if (buf) {
          pushHistory();
          const id = await S().put(trimSilence(buf, 0.0002), `Rec ${new Date().toLocaleTimeString()}`);
          t.samplerPatch.pads[idx] = { ...pad, sampleId: id, name: S().name(id), start: 0, end: 1, reverse: false };
          window.WAWCollab?.notifyChange?.();
        }
        refreshAll(t);
      } else {
        try {
          recCtl = await window.WAWAudio.startCapture();
          statusEl.textContent = "Recording into pad… press Stop Rec when done.";
          renderEditor();
        } catch (err) { statusEl.textContent = "Recording failed: " + err.message; recCtl = null; }
      }
    });
    act("play", () => { const n = BASE_NOTE + idx; midiNoteOn(n, 110); setTimeout(() => midiNoteOff(n), 600); });
    const destructive = (op) => async () => {
      if (!pad.sampleId) return;
      const buf = S().get(pad.sampleId) || await S().load(pad.sampleId);
      if (!buf) { statusEl.textContent = "That pad's audio is not available."; return; }
      pushHistory();
      const opts = { start: pad.start * buf.duration, end: pad.end * buf.duration };
      const id = await S().edit(pad.sampleId, op, opts);
      if (id) {
        pad.sampleId = id;
        if (op === "crop") { pad.start = 0; pad.end = 1; }
      }
      refreshAll(t); window.WAWCollab?.notifyChange?.();
    };
    act("normalize", destructive("normalize"));
    act("crop", destructive("crop"));
    act("fadeIn", destructive("fadeIn"));
    act("fadeOut", destructive("fadeOut"));
    act("chopEq", () => chop(t, idx, "equal"));
    act("chopTr", () => chop(t, idx, "transients"));
    act("clear", () => { pushHistory(); t.samplerPatch.pads[idx] = defaultPad(idx); refreshAll(t); window.WAWCollab?.notifyChange?.(); });

    renderParams(right.querySelector(".smp-params"), pad, t);
  }

  function chop(t, idx, mode) {
    const pad = t.samplerPatch.pads[idx];
    const buf = S().get(pad.sampleId);
    if (!buf) return;
    pushHistory();
    let cuts;
    const a = pad.start, b = pad.end;
    if (mode === "transients") {
      const times = S().detectTransients(pad.sampleId, PAD_COUNT).map(x => x / buf.duration).filter(x => x >= a && x < b);
      cuts = times.length ? times : [a];
    } else {
      cuts = Array.from({ length: PAD_COUNT }, (_, i) => a + ((b - a) * i) / PAD_COUNT);
    }
    cuts.forEach((c, i) => {
      const end = i + 1 < cuts.length ? cuts[i + 1] : b;
      t.samplerPatch.pads[i] = { ...defaultPad(i), sampleId: pad.sampleId, name: `${pad.name} ${i + 1}`, start: c, end, choke: 0 };
    });
    t.samplerPatch.selected = 0;
    statusEl.textContent = `Chopped into ${cuts.length} pad(s).`;
    refreshAll(t);
    window.WAWCollab?.notifyChange?.();
  }

  function drawEditorWave(right, pad) {
    const canvas = right.querySelector(".smp-wave");
    const durEl = right.querySelector(".smp-dur");
    const buf = S().get(pad.sampleId);
    if (!buf) {
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      durEl.textContent = pad.sampleId ? "loading…" : "empty — load, drop or record audio";
      if (pad.sampleId) S().load(pad.sampleId).then(() => drawEditorWave(right, pad));
    } else {
      S().drawWaveform(canvas, pad.sampleId, { color: "rgba(250,204,21,0.85)", bg: "#07080d" });
      durEl.textContent = `${(buf.duration * (pad.end - pad.start)).toFixed(2)} s of ${buf.duration.toFixed(2)} s · ${buf.sampleRate} Hz`;
    }
    positionMarkers(right, pad);
  }

  function positionMarkers(right, pad) {
    const s = right.querySelector(".smp-mark.start"), e = right.querySelector(".smp-mark.end"), r = right.querySelector(".smp-region");
    s.style.left = (pad.start * 100) + "%";
    e.style.left = (pad.end * 100) + "%";
    r.style.left = (pad.start * 100) + "%";
    r.style.width = ((pad.end - pad.start) * 100) + "%";
  }

  function attachMarkers(right, pad) {
    const wrap = right.querySelector(".smp-wave-wrap");
    ["start", "end"].forEach(which => {
      const m = right.querySelector(`.smp-mark.${which}`);
      m.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        try { m.setPointerCapture(e.pointerId); } catch (_) {}
        beginHistoryGesture();
        const before = pad.start + ":" + pad.end;
        const move = (ev) => {
          const r = wrap.getBoundingClientRect();
          const x = clamp((ev.clientX - r.left) / r.width, 0, 1);
          if (which === "start") pad.start = Math.min(x, pad.end - 0.002);
          else pad.end = Math.max(x, pad.start + 0.002);
          positionMarkers(right, pad);
          const buf = S().get(pad.sampleId);
          if (buf) right.querySelector(".smp-dur").textContent = `${(buf.duration * (pad.end - pad.start)).toFixed(2)} s of ${buf.duration.toFixed(2)} s`;
        };
        const up = () => {
          m.removeEventListener("pointermove", move); m.removeEventListener("pointerup", up); m.removeEventListener("pointercancel", up);
          if (pad.start + ":" + pad.end === before) { cancelHistoryGesture(); return; }
          commitHistoryGesture(); window.WAWCollab?.notifyChange?.();
        };
        m.addEventListener("pointermove", move); m.addEventListener("pointerup", up); m.addEventListener("pointercancel", up);
      });
    });
  }

  function renderParams(root, pad, t) {
    root.innerHTML = "";
    const K = (key, label, min, max, step, fmt, opts = {}) => {
      root.appendChild(window.WAWMixer.createKnob({
        label, min, max, step, log: !!opts.log, size: "lg", color: opts.color || "wk-yellow",
        value: pad[key], default: defaultPad(0)[key], format: fmt,
        onChange: v => { pad[key] = v; }
      }));
    };
    K("gain", "Level", -36, 12, 0.1, v => (v > 0 ? "+" : "") + v.toFixed(1) + " dB");
    K("tune", "Tune", -24, 24, 1, v => (v > 0 ? "+" : "") + v + " st");
    K("fine", "Fine", -100, 100, 1, v => (v > 0 ? "+" : "") + v + " ct");
    K("pan", "Pan", -1, 1, 0.01, v => Math.abs(v) < 0.005 ? "C" : (v < 0 ? "L" : "R") + Math.round(Math.abs(v) * 100), { color: "wk-blue" });
    K("attack", "Attack", 0.001, 2, 0.001, v => (v * 1000).toFixed(0) + " ms", { log: true, color: "wk-green" });
    K("release", "Release", 0.005, 4, 0.001, v => (v * 1000).toFixed(0) + " ms", { log: true, color: "wk-green" });
    K("cutoff", "Cutoff", 80, 20000, 1, v => v >= 1000 ? (v / 1000).toFixed(1) + " kHz" : Math.round(v) + " Hz", { log: true, color: "wk-red" });
    K("resonance", "Reso", 0.1, 15, 0.1, v => v.toFixed(1), { color: "wk-red" });
    K("velSens", "Vel Sens", 0, 1, 0.01, v => Math.round(v * 100) + "%", { color: "wk-black" });
    const sel = (key, label, options) => {
      const wrap = document.createElement("label");
      wrap.className = "smp-sel";
      wrap.innerHTML = `<span>${label}</span><select>${options.map(([v, n]) => `<option value="${v}" ${String(pad[key]) === String(v) ? "selected" : ""}>${n}</option>`).join("")}</select>`;
      wrap.querySelector("select").addEventListener("change", (e) => {
        pushHistory();
        const raw = e.target.value;
        pad[key] = key === "choke" ? Number(raw) : raw === "true" ? true : raw === "false" ? false : raw;
        window.WAWCollab?.notifyChange?.();
      });
      root.appendChild(wrap);
    };
    sel("mode", "Mode", [["oneshot", "One-shot"], ["gate", "Gate (note length)"], ["loop", "Loop while held"]]);
    sel("choke", "Choke", [[0, "None"], [1, "Group 1"], [2, "Group 2"], [3, "Group 3"], [4, "Group 4"]]);
    sel("reverse", "Direction", [["false", "Forward"], ["true", "Reverse"]]);
  }

  // re-label pads when the controller mapping or learn state changes
  window.WAWPadMap?.onChange(() => {
    if (modal?.classList.contains("visible") && currentTrack) {
      const left = modal.querySelector("#smpLeft");
      const grid = left?.querySelector(".smp-grid");
      if (grid) {
        grid.outerHTML = padGridHtml(currentTrack);
        attachPadEvents(left, currentTrack);
        const bar = left.querySelector(".padmap-bar");
        if (bar) { bar.outerHTML = window.WAWPadMap.toolbarHtml(); window.WAWPadMap.attachToolbar(left, () => currentTrack.samplerPatch.selected || 0); }
      }
    }
    if (typeof drum808Modal !== "undefined" && drum808Modal?.classList.contains("visible") && typeof render808ModalPads === "function") render808ModalPads();
    if (typeof renderSidebarTracks === "function") renderSidebarTracks();
  });

  window.WAWSampler = {
    PAD_COUNT, BASE_NOTE, defaultPad, normalizeTrack, scheduleNote, previewOn, previewOff,
    preloadForTracks, sampleIdsInUse, renderDrumKit, open, close, refreshIfStale, sidebarPanelHtml, attachSidebarPanel, padIndexForNote
  };
})();
