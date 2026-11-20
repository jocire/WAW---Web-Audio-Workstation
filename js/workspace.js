// WAW workspace: track management, editing shortcuts, transport display,
// drag & drop import, chord voicing and MIDI input settings.
(function () {
  "use strict";
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const changed = () => window.WAWCollab?.notifyChange?.();

  function refreshAll() {
    renderSidebarTracks();
    renderSequencer();
    renderMixer();
  }

  // ---------------------------------------------------------------------------
  // Tracks
  // ---------------------------------------------------------------------------
  const TRACK_KINDS = [
    { id: "synth", label: "Synth", icon: "〰", make: () => createTrack(null, { instrument: "synth" }) },
    { id: "808", label: "Drum Synth", icon: "◉", make: () => createTrack(null, { instrument: "808" }) },
    { id: "sampler", label: "Sampler (16 pads)", icon: "▦", make: () => createTrack(null, { instrument: "sampler" }) },
    { id: "audio", label: "Audio Track", icon: "∿", make: () => createTrack(null, { type: "audio" }) },
  ];

  function addTrackOfKind(kindId) {
    const kind = TRACK_KINDS.find(k => k.id === kindId) || TRACK_KINDS[0];
    pushHistory();
    const t = kind.make();
    const sameKind = tracks.filter(x => (kindId === "audio" ? x.type === "audio" : x.instrument === kindId && x.type !== "audio")).length;
    t.name = `${kindId === "audio" ? "Audio" : kindId === "808" ? "Drums" : kindId === "sampler" ? "Sampler" : "Synth"} ${sameKind + 1}`;
    tracks.push(t);
    setActiveTrack(tracks.length - 1, { silent: true });
    refreshAll();
    toast(`Added ${t.name}`);
    changed();
    return t;
  }

  function popupMenu(x, y, items) {
    document.querySelectorAll(".waw-popup").forEach(m => m.remove());
    const m = document.createElement("div");
    m.className = "waw-popup";
    items.forEach(it => {
      if (it === "-") { m.appendChild(document.createElement("hr")); return; }
      const b = document.createElement("button");
      b.type = "button";
      b.innerHTML = `${it.icon ? `<span class="pm-ico">${it.icon}</span>` : ""}${escapeHtml(it.label)}${it.hint ? `<span class="pm-hint">${escapeHtml(it.hint)}</span>` : ""}`;
      if (it.disabled) b.disabled = true;
      b.addEventListener("click", (e) => { e.stopPropagation(); m.remove(); it.action(); });
      m.appendChild(b);
    });
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = clamp(x, 4, window.innerWidth - r.width - 4) + "px";
    m.style.top = clamp(y, 4, window.innerHeight - r.height - 4) + "px";
    setTimeout(() => document.addEventListener("pointerdown", function close(ev) {
      if (!m.contains(ev.target)) { m.remove(); document.removeEventListener("pointerdown", close, true); }
    }, true), 0);
    return m;
  }

  function deleteTrack(ti) {
    const t = tracks[ti];
    if (!t) return;
    if (tracks.length === 1) { toast("A project needs at least one track"); return; }
    if ((t.clips || []).length && !confirm(`Delete track "${t.name}" and its ${t.clips.length} clip(s)?`)) return;
    pushHistory();
    tracks.splice(ti, 1);
    activeTrackIndex = clamp(activeTrackIndex >= ti ? activeTrackIndex - 1 : activeTrackIndex, 0, tracks.length - 1);
    setSelectedClip(null, null);
    activeClipId = null;
    ensureTracks();
    window.WAWMixer.syncEngine();
    window.WAWAudio?.syncMonitoring?.();
    refreshAll();
    restartPlaybackFromCurrentPosition();
    changed();
  }

  function duplicateTrack(ti) {
    const t = tracks[ti];
    if (!t) return;
    pushHistory();
    const copy = structuredClone({ ...t });
    copy.id = "trk_" + Math.random().toString(36).slice(2, 9);
    copy.name = t.name + " Copy";
    copy.clips = (copy.clips || []).map(c => ({ ...c, id: "clip_" + Math.random().toString(36).slice(2, 9) }));
    (copy.inserts || []).forEach(fx => {
      const oldId = fx.id;
      fx.id = "fx_" + Math.random().toString(36).slice(2, 9);
      // automation lanes of the copied FX must point at the new instance
      (copy.automation?.lanes || []).forEach(l => { if (l.param.startsWith(`fx.${oldId}.`)) l.param = l.param.replace(`fx.${oldId}.`, `fx.${fx.id}.`); });
    });
    copy.solo = false; copy.armed = false; copy.monitor = false;
    tracks.splice(ti + 1, 0, normalizeTrack(copy, ti + 1));
    setActiveTrack(ti + 1, { silent: true });
    refreshAll();
    changed();
  }

  function moveTrack(ti, dir) {
    const to = ti + dir;
    if (to < 0 || to >= tracks.length) return;
    pushHistory();
    const [t] = tracks.splice(ti, 1);
    tracks.splice(to, 0, t);
    activeTrackIndex = to;
    setSelectedClip(null, null);
    ensureTracks();
    refreshAll();
    changed();
  }

  function setTrackColor(ti) {
    const t = tracks[ti];
    const inp = document.createElement("input");
    inp.type = "color";
    inp.value = t.color || "#3b82f6";
    inp.style.position = "fixed"; inp.style.left = "-100px";
    document.body.appendChild(inp);
    inp.addEventListener("change", () => { pushHistory(); t.color = inp.value; refreshAll(); changed(); inp.remove(); });
    inp.addEventListener("blur", () => setTimeout(() => inp.remove(), 300));
    inp.click();
  }

  function showTrackMenu(ti, x, y) {
    const t = tracks[ti];
    if (!t) return;
    popupMenu(x, y, [
      { label: "Rename…", action: () => { const v = prompt("Track name:", t.name); if (v && v.trim()) { pushHistory(); t.name = v.trim(); refreshAll(); changed(); } } },
      { label: "Color…", action: () => setTrackColor(ti) },
      { label: "Insert FX chain…", action: () => openTrackFxChain(t) },
      ...(t.type === "audio" ? [{ label: "Import audio…", action: () => importAudioDialog(ti) }] : [
        { label: "Instrument: Synth", disabled: t.instrument === "synth", action: () => updateTrackInstrument(t.id, "synth") },
        { label: "Instrument: Drum Synth", disabled: t.instrument === "808", action: () => updateTrackInstrument(t.id, "808") },
        { label: "Instrument: Sampler", disabled: t.instrument === "sampler", action: () => updateTrackInstrument(t.id, "sampler") },
      ]),
      "-",
      { label: "Duplicate track", action: () => duplicateTrack(ti) },
      { label: "Move up", disabled: ti === 0, action: () => moveTrack(ti, -1) },
      { label: "Move down", disabled: ti === tracks.length - 1, action: () => moveTrack(ti, 1) },
      "-",
      { label: "Delete track", action: () => deleteTrack(ti) },
    ]);
  }

  async function trackButton(t, kind) {
    if (kind === "arm") { toggleArm(t); return; }
    if (kind === "auto") { window.WAWAutomation?.toggleShow(t); return; }
    if (kind === "monitor") {
      await window.WAWAudio.setMonitor(t, !t.monitor);
      refreshAll();
      return;
    }
    pushHistory();
    if (kind === "mute") t.mute = !t.mute;
    if (kind === "solo") t.solo = !t.solo;
    window.WAWMixer.syncEngine();
    refreshAll();
    changed();
  }

  function toggleArm(t) {
    t.armed = !t.armed;
    if (t.armed && t.type === "audio") window.WAWAudio.openInput().catch(e => { statusEl.textContent = "Input unavailable: " + e.message; });
    refreshAll();
  }

  function importAudioDialog(ti) {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = "audio/*"; inp.multiple = true;
    inp.addEventListener("change", () => {
      if (inp.files?.length) window.WAWAudio.importFilesToTrack([...inp.files], ti, lastPlayheadSec || 0);
    });
    inp.click();
  }

  // ---------------------------------------------------------------------------
  // FX chain popup for any track
  // ---------------------------------------------------------------------------
  let chainModal = null;
  function openTrackFxChain(t) {
    if (!chainModal) {
      chainModal = document.createElement("div");
      chainModal.className = "modal-backdrop";
      chainModal.id = "fxChainModal";
      chainModal.innerHTML = `<div class="modal-dialog fx-chain-dialog"><div class="modal-header"><span class="fcm-title"></span><button type="button" class="fcm-close">×</button></div><div class="fcm-body"></div></div>`;
      document.body.appendChild(chainModal);
      chainModal.addEventListener("click", e => { if (e.target === chainModal) chainModal.classList.remove("visible"); });
      chainModal.querySelector(".fcm-close").addEventListener("click", () => chainModal.classList.remove("visible"));
    }
    const render = () => {
      chainModal.querySelector(".fcm-title").textContent = `${t.name} — Insert FX chain`;
      const body = chainModal.querySelector(".fcm-body");
      body.innerHTML = `<p class="smp-hint">Signal flows top to bottom (after the channel EQ/dynamics). Drag inserts to reorder. ⏻ bypasses.</p>`;
      body.appendChild(window.WAWMixer.renderInsertSection(t, t.inserts, () => { window.WAWMixer.updateTrackEngine(t); }, `${t.name} — Inserts`));
    };
    render();
    // re-render after adds/removes (renderMixer is called by the insert section)
    const obs = new MutationObserver(() => {});
    void obs;
    chainModal._render = render;
    chainModal.classList.add("visible");
  }
  // keep the chain popup in sync when the mixer re-renders
  const origRenderMixer = window.renderMixer;
  window.renderMixer = function () {
    origRenderMixer();
    if (chainModal?.classList.contains("visible")) chainModal._render?.();
    renderSidebarTracksSoon();
  };
  let sidebarTimer = null;
  function renderSidebarTracksSoon() {
    clearTimeout(sidebarTimer);
    sidebarTimer = setTimeout(() => { if (!document.activeElement?.closest?.(".track-row")) renderSidebarTracks(); }, 50);
  }

  // ---------------------------------------------------------------------------
  // Clip editing
  // ---------------------------------------------------------------------------
  function splitClipAt(ti, clipId, atSec) {
    const t = tracks[ti];
    const clip = t?.clips?.find(c => c.id === clipId);
    if (!clip || atSec == null) return false;
    const at = snapSec(atSec);
    if (at <= clip.startSec + 0.01 || at >= clip.endSec - 0.01) { toast("Place the playhead inside the clip to split it"); return false; }
    pushHistory();
    const right = new Clip({ startSec: at, endSec: clip.endSec, notesSnapshot: [] });
    right.name = (clip.name || "Clip") + " (2)";
    if (clip.audio) {
      const k = window.WAWWarp ? window.WAWWarp.factor(clip) : 1;
      right.audio = { ...clip.audio, offset: clip.audio.offset + (at - clip.startSec) / k, fadeIn: 0.003 };
      window.WAWComp?.splitTakes(clip, right, at - clip.startSec);
      clip.audio.fadeOut = Math.min(clip.audio.fadeOut || 0.003, 0.003);
    } else {
      const local = getClipLocalNotes(clip);
      const cut = at - clip.startSec;
      clip.notesSnapshot = local.filter(n => n.startSec < cut).map(n => ({ ...n, endSec: Math.min(n.endSec, cut) }));
      // notes crossing the cut stay (shortened) in the left clip; copying them into
      // the right clip as well re-triggered them at the split point
      right.notesSnapshot = local.filter(n => n.startSec >= cut).map(n => ({ ...n, startSec: n.startSec - cut, endSec: n.endSec - cut }));
    }
    clip.endSec = at;
    t.clips.push(right);
    if (!clip.audio) { syncTrackNotesFromClip(t, clip); syncTrackNotesFromClip(t, right); }
    setSelectedClip(ti, right.id);
    renderSequencer();
    restartPlaybackFromCurrentPosition();
    changed();
    return true;
  }

  function toggleClipMute(ti, clipId) {
    const clip = tracks[ti]?.clips?.find(c => c.id === clipId);
    if (!clip) return;
    pushHistory();
    clip.muted = !clip.muted;
    renderSequencer();
    restartPlaybackFromCurrentPosition();
    changed();
  }

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts (DAW-style)
  // ---------------------------------------------------------------------------
  window.addEventListener("keydown", (e) => {
    if (isTypingTarget(e.target)) return;
    if (document.querySelector(".modal-backdrop.visible")) return;
    const mod = navigator.platform.toUpperCase().includes("MAC") ? e.metaKey : e.ctrlKey;
    const sel = getSelectedClipRef();

    if (e.code === "Home") { e.preventDefault(); goToStart(); return; }
    if (e.code === "End") { e.preventDefault(); setPlayhead(getBaseDuration()); return; }

    if (currentView === "sequencer" && mod && !e.shiftKey) {
      if (e.code === "KeyC" && sel) { e.preventDefault(); copyClip(sel.trackIndex, sel.clip.id); return; }
      if (e.code === "KeyX" && sel) { e.preventDefault(); cutClip(sel.trackIndex, sel.clip.id); return; }
      if (e.code === "KeyV") { e.preventDefault(); pasteClip(activeTrackIndex, lastPlayheadSec ?? 0); return; }
      if (e.code === "KeyD" && sel) { e.preventDefault(); duplicateClip(sel.trackIndex, sel.clip.id); return; }
      if (e.code === "KeyE" && sel) { e.preventDefault(); splitClipAt(sel.trackIndex, sel.clip.id, lastPlayheadSec); return; }
    }

    if (currentView === "editor") {
      if (mod && e.code === "KeyA") { e.preventDefault(); selectedNotes = new Set(notes.map((_, i) => i)); drawPianoRoll(lastPlayheadSec); drawVelocityLane(); return; }
      if (mod && e.code === "KeyC") { e.preventDefault(); copySelectedNotes(); return; }
      if (mod && e.code === "KeyX") { e.preventDefault(); copySelectedNotes(); deleteSelectedNotes(); return; }
      if (mod && e.code === "KeyV") { e.preventDefault(); pasteClipboard(lastPlayheadSec); return; }
      if (mod && e.code === "KeyD") { e.preventDefault(); duplicateSelectedNotes(); return; }
      if (mod && e.code === "KeyQ") { e.preventDefault(); quantizeNotes(selectedNotes.size > 0); return; }
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key) && selectedNotes.size) {
        e.preventDefault();
        nudgeSelectedNotes(e.key, e.shiftKey);
      }
    }
  });

  function nudgeSelectedNotes(key, big) {
    pushHistory();
    const bpm = parseFloat(bpmInput.value) || 120;
    const grid = getGridSeconds(60 / bpm);
    selectedNotes.forEach(i => {
      const n = notes[i];
      if (!n) return;
      if (key === "ArrowUp" || key === "ArrowDown") {
        // chromatic transpose (Shift = octave); the scale lock still applies when dragging
        const d = (key === "ArrowUp" ? 1 : -1) * (big ? 12 : 1);
        n.midiNote = clamp(n.midiNote + d, GLOBAL_MIN_NOTE, GLOBAL_MAX_NOTE);
        const deg = getScaleDegreeInfo(n.midiNote, tonicSemitone, scalePattern);
        n.scaleDegree = deg.degree; n.octave = deg.octave;
      } else {
        const d = (key === "ArrowRight" ? 1 : -1) * grid * (big ? 4 : 1);
        const len = n.endSec - n.startSec;
        n.startSec = Math.max(0, n.startSec + d);
        n.endSec = n.startSec + len;
      }
    });
    drawPianoRoll(lastPlayheadSec);
    drawVelocityLane();
    changed();
  }

  // ---------------------------------------------------------------------------
  // Transport: time display, return-to-start, tap tempo, master meter
  // ---------------------------------------------------------------------------
  function goToStart() {
    const was = isPlaying;
    if (was) stopPlayback();
    setPlayhead(loopEnabled && loopEndSec > loopStartSec && (lastPlayheadSec ?? 0) > loopStartSec + 0.01 ? loopStartSec : 0);
    if (was) playNotes(getAllNotesMixdown());
  }

  function formatPosition(sec) {
    const { bar, beat, tick } = window.WAWTempo.position(sec || 0);
    const m = Math.floor((sec || 0) / 60);
    const s = ((sec || 0) % 60);
    return { bbt: `${String(bar).padStart(3, " ")}.${beat}.${String(tick).padStart(3, "0")}`, time: `${m}:${s.toFixed(3).padStart(6, "0")}` };
  }

  let tapTimes = [];
  function tapTempo() {
    const now = performance.now();
    tapTimes = tapTimes.filter(t => now - t < 2500);
    tapTimes.push(now);
    if (tapTimes.length >= 3) {
      const iv = [];
      for (let i = 1; i < tapTimes.length; i++) iv.push(tapTimes[i] - tapTimes[i - 1]);
      const bpm = Math.round(60000 / (iv.reduce((a, b) => a + b, 0) / iv.length));
      bpmInput.value = clamp(bpm, 30, 240);
      bpmInput.dispatchEvent(new Event("change"));
    }
  }

  function buildTransport() {
    const right = document.querySelector(".header-right");
    if (!right || document.getElementById("timeDisplay")) return;
    const home = document.createElement("button");
    home.type = "button"; home.id = "homeBtn"; home.textContent = "⏮"; home.title = "Return to start / loop start (Home)";
    home.addEventListener("click", goToStart);
    right.insertBefore(home, document.getElementById("playBtn"));
    const disp = document.createElement("div");
    disp.id = "timeDisplay";
    disp.className = "time-display";
    disp.title = "Bars.Beats.Ticks / minutes:seconds";
    disp.innerHTML = `<span class="td-bbt">  1.1.000</span><span class="td-time">0:00.000</span>`;
    right.insertBefore(disp, home);
    const meter = window.WAWMixer.createMeterEl(false);
    meter.id = "masterMeterHeader";
    meter.classList.add("header-meter");
    meter.title = "Master output";
    right.insertBefore(meter, disp);
    const bpmLabel = document.querySelector(".bpm-label");
    if (bpmLabel && !document.getElementById("tapBtn")) {
      const tap = document.createElement("button");
      tap.type = "button"; tap.id = "tapBtn"; tap.textContent = "Tap"; tap.title = "Tap tempo";
      tap.addEventListener("click", tapTempo);
      bpmLabel.after(tap);
    }
    // the old "+ Track" button opens a menu with all track kinds
    const add = document.getElementById("addTrackBtn");
    if (add) {
      const clone = add.cloneNode(true); // drop the old single-kind listener
      add.replaceWith(clone);
      clone.textContent = "+ Track ▾";
      clone.addEventListener("click", (e) => {
        const r = clone.getBoundingClientRect();
        popupMenu(r.left, r.bottom + 4, TRACK_KINDS.map(k => ({ label: k.label, icon: k.icon, action: () => addTrackOfKind(k.id) })));
        e.stopPropagation();
      });
    }
    window.WAWMixer.startMeters();
    let last = "";
    const tick = () => {
      const f = formatPosition(lastPlayheadSec || 0);
      const txt = f.bbt + f.time;
      if (txt !== last) {
        last = txt;
        disp.querySelector(".td-bbt").textContent = f.bbt;
        disp.querySelector(".td-time").textContent = f.time;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------------------
  // Drag & drop audio files onto the arrangement
  // ---------------------------------------------------------------------------
  function attachDrop() {
    const grid = document.getElementById("sequencerGrid");
    if (!grid) return;
    grid.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      grid.classList.add("drop-target");
    });
    grid.addEventListener("dragleave", (e) => { if (e.target === grid) grid.classList.remove("drop-target"); });
    grid.addEventListener("drop", (e) => {
      grid.classList.remove("drop-target");
      const files = [...(e.dataTransfer?.files || [])].filter(f => f.type.startsWith("audio/") || /\.(wav|mp3|ogg|flac|m4a|aif+)$/i.test(f.name));
      if (!files.length) return;
      e.preventDefault();
      const row = e.target.closest(".seq-track-row");
      const ti = row ? Number(row.dataset.trackIndex) : -1;
      const lane = row?.querySelector(".seq-row-lane");
      const x = lane ? e.clientX - lane.getBoundingClientRect().left : 0;
      const sec = snapSec(Math.max(0, x / getSeqPxPerSec()));
      window.WAWAudio.importFilesToTrack(files, ti, sec);
    });
  }

  // ---------------------------------------------------------------------------
  // Chord voicing (inversion + per-tone octave) for chord-preset drawing
  // ---------------------------------------------------------------------------
  const voicing = { inversion: 0, octaves: [0, 0, 0] };
  const INV_NAMES = ["Root", "1st", "2nd"];
  function applyVoicing(chordNotes) {
    if (!chordNotes || chordNotes.length < 2) return;
    // chordNotes are [root, 3rd, 5th, ...] in that order
    chordNotes.forEach((n, i) => { n.midiNote += 12 * (voicing.octaves[i] || 0); });
    for (let k = 0; k < voicing.inversion && k < chordNotes.length; k++) chordNotes[k].midiNote += 12;
    chordNotes.forEach(n => {
      n.midiNote = clamp(n.midiNote, GLOBAL_MIN_NOTE, GLOBAL_MAX_NOTE);
      const deg = getScaleDegreeInfo(n.midiNote, tonicSemitone, scalePattern);
      n.scaleDegree = deg.degree; n.octave = deg.octave;
    });
  }
  function attachVoicingControls() {
    const inv = document.getElementById("invBtn");
    const render = () => {
      if (inv) inv.textContent = `Inv: ${INV_NAMES[voicing.inversion]}`;
      document.querySelectorAll(".octave-controls button").forEach(b => {
        const tone = Number(b.dataset.tone), dir = Number(b.dataset.dir);
        b.classList.toggle("active", Math.sign(voicing.octaves[tone]) === dir);
      });
    };
    inv?.addEventListener("click", () => { voicing.inversion = (voicing.inversion + 1) % 3; render(); });
    document.querySelectorAll(".octave-controls button").forEach(b => b.addEventListener("click", () => {
      const tone = Number(b.dataset.tone), dir = Number(b.dataset.dir);
      voicing.octaves[tone] = clamp((voicing.octaves[tone] || 0) + dir, -2, 2);
      render();
      toast(`Tone ${["R", "3", "5"][tone]} octave ${voicing.octaves[tone] > 0 ? "+" : ""}${voicing.octaves[tone]}`);
    }));
    render();
  }

  // ---------------------------------------------------------------------------
  // MIDI input device / channel filter (Settings)
  // ---------------------------------------------------------------------------
  const midiPrefs = { input: "all", channel: "all" };
  try { Object.assign(midiPrefs, JSON.parse(localStorage.getItem("waw.midiPrefs") || "{}")); } catch (e) {}
  function acceptMidi(event) {
    if (midiPrefs.input !== "all" && event.target?.id !== midiPrefs.input) return false;
    if (midiPrefs.channel !== "all") {
      const ch = (event.data[0] & 0x0f) + 1;
      if (String(ch) !== String(midiPrefs.channel)) return false;
    }
    return true;
  }
  function buildMidiSettings() {
    const body = document.querySelector("#appSettingsModal .modal-body");
    if (!body || document.getElementById("midiInputSelect")) return;
    const sec = document.createElement("div");
    sec.className = "settings-section";
    sec.innerHTML = `<div class="settings-section-title">MIDI Input</div>
      <label>Device <select id="midiInputSelect"><option value="all">All inputs</option></select></label>
      <label>Channel <select id="midiChannelSelect"><option value="all">Omni (all)</option>${Array.from({ length: 16 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join("")}</select></label>`;
    body.appendChild(sec);
    const devSel = sec.querySelector("#midiInputSelect");
    const chSel = sec.querySelector("#midiChannelSelect");
    const fill = () => {
      const inputs = midiAccess ? [...midiAccess.inputs.values()] : [];
      devSel.innerHTML = `<option value="all">All inputs</option>` + inputs.map(i => `<option value="${escapeHtml(i.id)}">${escapeHtml(i.name || i.id)}</option>`).join("");
      devSel.value = midiPrefs.input;
      if (devSel.value !== midiPrefs.input) devSel.value = "all";
    };
    const save = () => { try { localStorage.setItem("waw.midiPrefs", JSON.stringify(midiPrefs)); } catch (e) {} };
    devSel.addEventListener("change", () => { midiPrefs.input = devSel.value; save(); });
    chSel.value = midiPrefs.channel;
    chSel.addEventListener("change", () => { midiPrefs.channel = chSel.value; save(); });
    document.getElementById("appSettingsBtn")?.addEventListener("click", fill);
    setTimeout(fill, 1500);
  }

  document.addEventListener("DOMContentLoaded", () => {
    buildTransport();
    attachDrop();
    attachVoicingControls();
    buildMidiSettings();
  });

  window.WAWWorkspace = {
    TRACK_KINDS, addTrackOfKind, deleteTrack, duplicateTrack, moveTrack, showTrackMenu, trackButton, toggleArm,
    importAudioDialog, openTrackFxChain, splitClipAt, toggleClipMute, applyVoicing, acceptMidi, formatPosition, goToStart, popupMenu
  };
})();
