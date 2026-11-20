// WAW step sequencers:
//  * synth: a monophonic analog-style step sequencer (note, on/off, accent,
//    slide per step; length, rate, swing, gate) with step input from any keyboard
//  * drum machine: a 16-instrument step grid (off / on / accent per step)
//    with starter beats
// Patterns live on the track (track.synthSeq / track.drumSeq), so they are
// saved, undoable and shared with collaborators. Both preview at the song
// tempo and can be copied to a regular MIDI clip at the playhead.
(function () {
  "use strict";
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const MAX = 32;
  const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const noteName = n => NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
  const RATES = [[0.5, "1/8"], [1 / 3, "1/8T"], [0.25, "1/16"], [1 / 6, "1/16T"], [0.125, "1/32"]];

  // ---------------------------------------------------------------------------
  // data
  // ---------------------------------------------------------------------------
  function synthSeq(track) {
    if (!track.synthSeq || typeof track.synthSeq !== "object") {
      // a classic bass line to start from
      const line = [36, 36, 48, 36, 39, 36, 43, 41, 36, 36, 48, 36, 46, 43, 39, 41];
      track.synthSeq = { length: 16, stepBeats: 0.25, swing: 0, gate: 0.55, steps: Array.from({ length: MAX }, (_, i) => ({ on: i < 16 && ![3, 11].includes(i), note: line[i % 16], accent: [0, 8, 12].includes(i), slide: [6, 14].includes(i) })) };
    }
    const s = track.synthSeq;
    s.length = clamp(Math.round(s.length || 16), 1, MAX);
    if (!Array.isArray(s.steps)) s.steps = [];
    for (let i = 0; i < MAX; i++) s.steps[i] = { on: false, note: 48, accent: false, slide: false, ...(s.steps[i] || {}) };
    if (!(s.stepBeats > 0)) s.stepBeats = 0.25;
    s.swing = clamp(Number(s.swing) || 0, 0, 0.75);
    s.gate = clamp(Number(s.gate) || 0.55, 0.05, 1);
    return s;
  }
  function drumSeq(track) {
    if (!track.drumSeq || typeof track.drumSeq !== "object") track.drumSeq = { length: 16, stepBeats: 0.25, swing: 0, grid: {} };
    const s = track.drumSeq;
    s.length = clamp(Math.round(s.length || 16), 1, MAX);
    if (!(s.stepBeats > 0)) s.stepBeats = 0.25;
    s.swing = clamp(Number(s.swing) || 0, 0, 0.75);
    s.grid = s.grid && typeof s.grid === "object" ? s.grid : {};
    DRUM_808_VOICES.forEach(v => { const row = Array.isArray(s.grid[v.id]) ? s.grid[v.id] : []; s.grid[v.id] = Array.from({ length: MAX }, (_, i) => clamp(Number(row[i]) || 0, 0, 2)); });
    return s;
  }

  // starter beats: x = hit, X = accent, . = rest (16 steps)
  const BEATS = {
    "Four on the Floor": { kick: "X...x...X...x...", clap: "....x.......x...", closedHat: "..x...x...x...x.", },
    "House": { kick: "X...x...X...x...", clap: "....X.......X...", closedHat: "x.x.x.x.x.x.x.x.", openHat: "..x...x...x...x.", maracas: "xxxxxxxxxxxxxxxx" },
    "Techno": { kick: "X...X...X...X...", rimshot: "..x..x....x..x..", closedHat: "xxxxxxxxxxxxxxxx", openHat: "..x...x...x...x.", clap: "....x.......x..." },
    "Electro": { kick: "X.....x...x.....", snare: "....X.......X...", closedHat: "x.x.x.x.x.x.x.x.", cowbell: "..x.......x....x", clap: "....x.......x..." },
    "Boom Bap": { kick: "X......x.xX.....", snare: "....X.......X...", closedHat: "x.x.x.x.x.x.x.x.", openHat: "..............x." },
    "Trap": { kick: "X......x..x.....", snare: "........X.......", closedHat: "x.xxx.x.xxxxx.xx", openHat: "...........x....", clap: "........X......." },
    "Breakbeat": { kick: "X.x.......x.....", snare: "....X..x.x..X...", closedHat: "x.x.x.x.x.x.x.x.", openHat: "......x........x" },
    "Disco": { kick: "X...x...X...x...", snare: "....x.......x...", openHat: "..x...x...x...x.", closedHat: "x...x...x...x...", clap: "....x.......x..." },
    "Reggaeton": { kick: "X...x...X...x...", snare: "...x..x....x..x.", closedHat: "x.x.x.x.x.x.x.x." },
    "Funk": { kick: "X..x..x...x..x..", snare: "....X..x.x..X..x", closedHat: "xxxxxxxxxxxxxxxx", openHat: "......x........." },
    "Hip Hop": { kick: "X.......xx......", snare: "....X.......X...", closedHat: "x.x.x.x.x.x.x.x." },
    "Latin": { kick: "X..x....X..x....", claves: "x..x..x...x.x...", highConga: "..x...x...x.x.x.", lowConga: "x.....x.x.......", maracas: "xxxxxxxxxxxxxxxx" },
    "Dembow Perc": { kick: "X...x...X...x...", rimshot: "...x..x....x..x.", highConga: "..x.....x.x.....", maracas: "x.x.x.x.x.x.x.x." },
    "Half Time": { kick: "X.........x.....", snare: "........X.......", closedHat: "x.x.x.x.x.x.x.x.", cymbal: "X..............." },
  };

  // ---------------------------------------------------------------------------
  // preview player (sample-accurate lookahead, song tempo)
  // ---------------------------------------------------------------------------
  const player = { timer: null, raf: null, kind: null, track: null, nextTime: 0, step: 0, queue: [], voices: new Set(), onStep: null };

  function bpmNow() { return window.WAWTempo ? window.WAWTempo.bpmAt(lastPlayheadSec || 0) : (parseFloat(bpmInput?.value) || 120); }
  function stepDur(seq) { return (60 / bpmNow()) * seq.stepBeats; }
  function swingOffset(seq, i, dur) { return i % 2 === 1 ? seq.swing * dur : 0; }

  function play(kind, track, onStep) {
    stop();
    const ctx = ensureAudioContext();
    ctx.resume?.();
    Object.assign(player, { kind, track, step: 0, queue: [], onStep, nextTime: ctx.currentTime + 0.06 });
    player.timer = setInterval(tick, 25);
    tick();
    const frame = () => {
      const now = ctx.currentTime;
      let cur = null;
      while (player.queue.length && player.queue[0][0] <= now) cur = player.queue.shift()[1];
      if (cur != null) player.onStep?.(cur);
      player.raf = requestAnimationFrame(frame);
    };
    player.raf = requestAnimationFrame(frame);
  }
  function stop() {
    clearInterval(player.timer); cancelAnimationFrame(player.raf);
    player.timer = null;
    const ctx = typeof audioCtx !== "undefined" ? audioCtx : null;
    player.voices.forEach(v => { try { if (v.stop && ctx) v.stop(ctx.currentTime); else v.forEach?.(s => s.stop()); } catch (e) {} });
    player.voices.clear();
    player.onStep?.(-1);
    player.kind = null;
  }
  const isPlaying = (kind, track) => player.kind === kind && player.track === track && !!player.timer;

  function tick() {
    const ctx = ensureAudioContext();
    const t = player.track;
    if (!t || !tracks.includes(t)) { stop(); return; }
    const seq = player.kind === "synth" ? synthSeq(t) : drumSeq(t);
    const dest = window.WAWMixer.getTrackInput(t);
    while (player.nextTime < ctx.currentTime + 0.12) {
      const dur = stepDur(seq);
      const i = player.step % seq.length;
      const when = player.nextTime + swingOffset(seq, i, dur);
      if (player.kind === "synth") scheduleSynthStep(ctx, dest, t, seq, i, when, dur);
      else scheduleDrumStep(ctx, dest, t, seq, i, when);
      player.queue.push([when, i]);
      player.step = (i + 1) % seq.length;
      player.nextTime += dur;
    }
  }

  function scheduleSynthStep(ctx, dest, t, seq, i, when, dur) {
    const s = seq.steps[i];
    if (!s.on) return;
    const prev = seq.steps[(i - 1 + seq.length) % seq.length];
    const next = seq.steps[(i + 1) % seq.length];
    // slide: hold into the next note, which glides from this pitch
    const len = s.slide && next.on ? dur * 1.05 : dur * seq.gate;
    const patch = { ...window.WAWSynth.fullPatch(t.synthPatch) };
    const opts = {};
    if (prev.on && prev.slide) { opts.glideFrom = prev.note; if (!(patch.glide > 0.005)) patch.glide = Math.min(0.08, dur * 0.5); }
    const voice = window.WAWSynth.buildSynthVoice(ctx, dest, s.note, s.accent ? 127 : 92, patch, when, when + len, opts);
    player.voices.add(voice);
    setTimeout(() => player.voices.delete(voice), (when - ctx.currentTime + len + 2) * 1000);
  }
  function scheduleDrumStep(ctx, dest, t, seq, i, when) {
    DRUM_808_VOICES.forEach(v => {
      const val = seq.grid[v.id][i];
      if (!val) return;
      const src = triggerSynthetic808(ctx, dest, v.note, val === 2 ? 127 : 96, t.drum808Patch, Math.max(0, when - ctx.currentTime));
      if (src) { player.voices.add(src); setTimeout(() => player.voices.delete(src), (when - ctx.currentTime + 3) * 1000); }
    });
  }

  // ---------------------------------------------------------------------------
  // copy to a MIDI clip at the playhead (first free spot on the track)
  // ---------------------------------------------------------------------------
  function copyToClip(kind, track, repeats = 1) {
    const T = window.WAWTempo;
    const seq = kind === "synth" ? synthSeq(track) : drumSeq(track);
    const totalBeats = seq.length * seq.stepBeats * repeats;
    let startSec = T.barToSec(T.position(lastPlayheadSec || 0).bar);
    const lenSec = T.beatToSec(T.secToBeat(startSec) + totalBeats) - startSec;
    startSec = getNextAvailableClipStart(track, startSec, lenSec);
    const startBeat = T.secToBeat(startSec);
    const endSec = T.beatToSec(startBeat + totalBeats);
    const local = (beat) => T.beatToSec(startBeat + beat) - startSec;
    const notesOut = [];
    const mk = (b0, b1, note, vel) => {
      const deg = getScaleDegreeInfo(note, tonicSemitone, scalePattern);
      notesOut.push(new NoteEvent(local(b0), local(b1), note, vel, deg.degree, deg.octave));
    };
    for (let r = 0; r < repeats; r++) {
      for (let i = 0; i < seq.length; i++) {
        const b = (r * seq.length + i) * seq.stepBeats + (i % 2 === 1 ? seq.swing * seq.stepBeats : 0);
        if (kind === "synth") {
          const s = seq.steps[i];
          if (!s.on) continue;
          const next = seq.steps[(i + 1) % seq.length];
          const len = s.slide && next.on ? seq.stepBeats * 1.05 : seq.stepBeats * seq.gate;
          mk(b, Math.min(totalBeats, b + len), s.note, s.accent ? 127 : 92);
        } else {
          DRUM_808_VOICES.forEach(v => { const val = seq.grid[v.id][i]; if (val) mk(b, b + seq.stepBeats * 0.5, v.note, val === 2 ? 127 : 96); });
        }
      }
    }
    if (!notesOut.length) { statusEl.textContent = "The pattern is empty: nothing to copy."; return null; }
    pushHistory();
    const clip = new Clip({ startSec, endSec, notesSnapshot: notesOut });
    clip.name = kind === "synth" ? "Seq Pattern" : "Drum Pattern";
    track.clips = track.clips || [];
    track.clips.push(clip);
    syncTrackNotesFromClip(track, clip);
    const ti = tracks.indexOf(track);
    if (ti >= 0) setSelectedClip(ti, clip.id);
    renderSequencer();
    window.WAWCollab?.notifyChange?.();
    const p = T.position(startSec);
    statusEl.textContent = `Copied the pattern${repeats > 1 ? ` ×${repeats}` : ""} to a MIDI clip at bar ${p.bar} on "${track.name}".`;
    return clip;
  }

  // ---------------------------------------------------------------------------
  // shared UI bits
  // ---------------------------------------------------------------------------
  const changed = () => window.WAWCollab?.notifyChange?.();
  function toolbar(kind, track, seq, extra = "") {
    return `<div class="sq-bar">
      <button type="button" class="sq-play" data-sq="play">${isPlaying(kind, track) ? "■ Stop" : "▶ Play"}</button>
      <label>Steps <input type="number" min="1" max="${MAX}" value="${seq.length}" data-sq="length"></label>
      <label>Rate <select data-sq="rate">${RATES.map(([v, n]) => `<option value="${v}" ${Math.abs(v - seq.stepBeats) < 1e-6 ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      <label>Swing <input type="range" min="0" max="0.6" step="0.01" value="${seq.swing}" data-sq="swing"><span class="sq-val">${Math.round(seq.swing * 100)}%</span></label>
      ${extra}
      <span class="sq-spacer"></span>
      <button type="button" data-sq="clear">Clear</button>
      <span class="sq-copy"><button type="button" class="sq-copy-btn" data-sq="copy" title="Write the pattern as a MIDI clip on this track at the playhead">→ MIDI clip</button><select data-sq="repeats" aria-label="Repeat the pattern"><option value="1">×1</option><option value="2">×2</option><option value="4">×4</option><option value="8">×8</option></select></span>
    </div>`;
  }
  function bindToolbar(root, kind, track, seq, rerender) {
    const q = s => root.querySelector(`[data-sq="${s}"]`);
    q("play").addEventListener("click", () => {
      if (isPlaying(kind, track)) stop(); else play(kind, track, i => highlight(root, i));
      q("play").textContent = isPlaying(kind, track) ? "■ Stop" : "▶ Play";
    });
    q("length").addEventListener("change", (e) => { pushHistory(); seq.length = clamp(parseInt(e.target.value, 10) || 16, 1, MAX); changed(); rerender(); });
    q("rate").addEventListener("change", (e) => { pushHistory(); seq.stepBeats = Number(e.target.value); changed(); });
    const sw = q("swing");
    sw.addEventListener("pointerdown", () => beginHistoryGesture());
    sw.addEventListener("input", () => { seq.swing = Number(sw.value); sw.nextElementSibling.textContent = Math.round(seq.swing * 100) + "%"; });
    sw.addEventListener("change", () => { commitHistoryGesture(); changed(); });
    q("clear").addEventListener("click", () => {
      pushHistory();
      if (kind === "synth") seq.steps.forEach(s => { s.on = false; s.accent = false; s.slide = false; });
      else Object.values(seq.grid).forEach(row => row.fill(0));
      changed(); rerender();
    });
    q("copy").addEventListener("click", () => copyToClip(kind, track, Number(q("repeats").value) || 1));
  }
  function highlight(root, i) {
    root.querySelectorAll(".sq-col.now, .sq-cell.now").forEach(el => el.classList.remove("now"));
    if (i < 0) return;
    root.querySelectorAll(`[data-col="${i}"]`).forEach(el => el.classList.add("now"));
  }

  // ---------------------------------------------------------------------------
  // synth sequencer UI
  // ---------------------------------------------------------------------------
  const stepInput = { on: false, sel: 0, root: null, track: null, rerender: null };

  function renderSynth(root, track) {
    const seq = synthSeq(track);
    stepInput.root = root; stepInput.track = track;
    const rerender = () => renderSynth(root, track);
    stepInput.rerender = rerender;
    root.innerHTML = toolbar("synth", track, seq, `
      <label>Gate <input type="range" min="0.05" max="1" step="0.01" value="${seq.gate}" data-sq="gate"><span class="sq-val">${Math.round(seq.gate * 100)}%</span></label>
      <span class="sq-grp"><button type="button" data-tr="-12" title="Octave down">−Oct</button><button type="button" data-tr="-1" title="Transpose down">−1</button><button type="button" data-tr="1" title="Transpose up">+1</button><button type="button" data-tr="12" title="Octave up">+Oct</button></span>
      <button type="button" data-sq="rand" title="Random pattern in the current key">Random</button>
      <button type="button" data-sq="rec" class="${stepInput.on ? "on" : ""}" title="Step input: play notes (keyboard, MIDI or the keys below) to write them into the selected step">● Step input</button>`) +
      `<div class="sq-steps" style="--n:${seq.length}">${seq.steps.slice(0, seq.length).map((s, i) => `
        <div class="sq-col${i % 4 === 0 ? " beat" : ""}${stepInput.on && stepInput.sel === i ? " sel" : ""}" data-col="${i}">
          <span class="sq-idx">${i + 1}</span>
          <button type="button" class="sq-led${s.on ? " on" : ""}" data-i="${i}" data-k="on" aria-label="Step ${i + 1} ${s.on ? "on" : "off"}"></button>
          <button type="button" class="sq-note" data-i="${i}" data-k="note" title="Drag or wheel to change the note; click to select for step input">${noteName(s.note)}</button>
          <button type="button" class="sq-tog${s.accent ? " on" : ""}" data-i="${i}" data-k="accent" title="Accent">A</button>
          <button type="button" class="sq-tog${s.slide ? " on" : ""}" data-i="${i}" data-k="slide" title="Slide into the next step">S</button>
        </div>`).join("")}</div>`;
    bindToolbar(root, "synth", track, seq, rerender);
    const g = root.querySelector('[data-sq="gate"]');
    g.addEventListener("pointerdown", () => beginHistoryGesture());
    g.addEventListener("input", () => { seq.gate = Number(g.value); g.nextElementSibling.textContent = Math.round(seq.gate * 100) + "%"; });
    g.addEventListener("change", () => { commitHistoryGesture(); changed(); });
    root.querySelectorAll("[data-tr]").forEach(b => b.addEventListener("click", () => {
      pushHistory(); const d = Number(b.dataset.tr);
      seq.steps.forEach(s => { s.note = clamp(s.note + d, 12, 108); }); changed(); rerender();
    }));
    root.querySelector('[data-sq="rand"]').addEventListener("click", () => {
      pushHistory();
      const root0 = 36 + (typeof tonicSemitone === "number" ? tonicSemitone : 0);
      const scale = Array.isArray(scalePattern) && scalePattern.length ? scalePattern : [0, 2, 3, 5, 7, 8, 10];
      seq.steps.forEach((s, i) => {
        const deg = Math.floor(Math.random() * scale.length), oct = Math.random() < 0.25 ? 12 : 0;
        Object.assign(s, { on: i % 4 === 0 || Math.random() < 0.6, note: root0 + scale[deg] + oct, accent: Math.random() < 0.2, slide: Math.random() < 0.15 });
      });
      changed(); rerender();
    });
    root.querySelector('[data-sq="rec"]').addEventListener("click", () => { stepInput.on = !stepInput.on; rerender(); });
    // step controls
    root.querySelectorAll(".sq-steps [data-k]").forEach(el => {
      const i = Number(el.dataset.i), k = el.dataset.k;
      if (k === "note") {
        el.addEventListener("wheel", (e) => { e.preventDefault(); beginWheel(); seq.steps[i].note = clamp(seq.steps[i].note + (e.deltaY < 0 ? 1 : -1), 12, 108); el.textContent = noteName(seq.steps[i].note); auditionStep(track, seq.steps[i].note); }, { passive: false });
        el.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          stepInput.sel = i;
          root.querySelectorAll(".sq-col").forEach(c => c.classList.toggle("sel", stepInput.on && Number(c.dataset.col) === i));
          const y0 = e.clientY, n0 = seq.steps[i].note; let moved = false;
          try { el.setPointerCapture(e.pointerId); } catch (_) {}
          const move = (ev) => {
            const n = clamp(n0 + Math.round((y0 - ev.clientY) / 6), 12, 108);
            if (n === seq.steps[i].note) return;
            if (!moved) { moved = true; beginHistoryGesture(); }
            seq.steps[i].note = n; el.textContent = noteName(n);
          };
          const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); if (moved) { commitHistoryGesture(); changed(); } auditionStep(track, seq.steps[i].note); };
          el.addEventListener("pointermove", move); el.addEventListener("pointerup", up);
        });
        return;
      }
      el.addEventListener("click", () => {
        pushHistory();
        seq.steps[i][k] = !seq.steps[i][k];
        el.classList.toggle("on", seq.steps[i][k]);
        changed();
      });
    });
  }
  let wheelT = null;
  function beginWheel() { if (!wheelT) beginHistoryGesture(); clearTimeout(wheelT); wheelT = setTimeout(() => { wheelT = null; commitHistoryGesture(); changed(); }, 500); }
  function auditionStep(track, note) {
    if (isPlaying("synth", track)) return;
    previewNoteOn(note, 100, track);
    setTimeout(() => previewNoteOff(note, track.id), 220);
  }

  /** a played note (panel keys, computer keyboard, MIDI) in step-input mode */
  function noteIn(note) {
    if (!stepInput.on || !stepInput.root?.isConnected || !stepInput.track) return false;
    const seq = synthSeq(stepInput.track);
    pushHistory();
    Object.assign(seq.steps[stepInput.sel], { on: true, note });
    stepInput.sel = (stepInput.sel + 1) % seq.length;
    changed();
    stepInput.rerender?.();
    return true;
  }

  // ---------------------------------------------------------------------------
  // drum grid UI
  // ---------------------------------------------------------------------------
  function renderDrums(root, track) {
    const seq = drumSeq(track);
    const rerender = () => renderDrums(root, track);
    root.innerHTML = toolbar("drum", track, seq, `<label>Beat <select data-sq="beat"><option value="">Load a starter beat…</option>${Object.keys(BEATS).map(b => `<option>${b}</option>`).join("")}</select></label>`) +
      `<div class="sq-grid" style="--n:${seq.length}">${DRUM_808_VOICES.map(v => `
        <div class="sq-row"><button type="button" class="sq-name" data-hit="${v.note}" title="Play ${escapeHtml(v.label)}">${escapeHtml(v.label)}</button>
        ${seq.grid[v.id].slice(0, seq.length).map((val, i) => `<button type="button" class="sq-cell${i % 4 === 0 ? " beat" : ""}${val ? " v" + val : ""}" data-v="${v.id}" data-col="${i}" aria-label="${escapeHtml(v.label)} step ${i + 1}"></button>`).join("")}</div>`).join("")}</div>
      <p class="sq-hint">Click a step: on → accent → off. Drag to paint. Right-click clears.</p>`;
    bindToolbar(root, "drum", track, seq, rerender);
    root.querySelector('[data-sq="beat"]').addEventListener("change", (e) => {
      const b = BEATS[e.target.value];
      if (!b) return;
      pushHistory();
      Object.values(seq.grid).forEach(row => row.fill(0));
      Object.entries(b).forEach(([id, pat]) => { [...pat].forEach((c, i) => { if (seq.grid[id] && i < MAX) seq.grid[id][i] = c === "X" ? 2 : c === "x" ? 1 : 0; }); });
      seq.length = 16;
      changed(); rerender();
    });
    root.querySelectorAll("[data-hit]").forEach(b => b.addEventListener("pointerdown", () => play808Hit(Number(b.dataset.hit), 105, track)));
    // click to cycle, drag to paint the same value, right-click to clear
    const grid = root.querySelector(".sq-grid");
    let paint = null;
    const apply = (cell) => {
      const row = seq.grid[cell.dataset.v], i = Number(cell.dataset.col);
      row[i] = paint;
      cell.classList.remove("v1", "v2"); if (paint) cell.classList.add("v" + paint);
    };
    grid.addEventListener("pointerdown", (e) => {
      const cell = e.target.closest(".sq-cell");
      if (!cell || e.button !== 0) return;
      e.preventDefault();
      const cur = seq.grid[cell.dataset.v][Number(cell.dataset.col)];
      paint = (cur + 1) % 3;
      beginHistoryGesture();
      apply(cell);
      try { grid.setPointerCapture(e.pointerId); } catch (_) {}
    });
    grid.addEventListener("pointermove", (e) => {
      if (paint == null) return;
      const cell = document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".sq-cell");
      if (cell && grid.contains(cell) && seq.grid[cell.dataset.v][Number(cell.dataset.col)] !== paint) apply(cell);
    });
    const end = () => { if (paint == null) return; paint = null; commitHistoryGesture(); changed(); };
    grid.addEventListener("pointerup", end); grid.addEventListener("pointercancel", end);
    grid.addEventListener("contextmenu", (e) => {
      const cell = e.target.closest(".sq-cell");
      if (!cell) return;
      e.preventDefault(); pushHistory();
      seq.grid[cell.dataset.v][Number(cell.dataset.col)] = 0; cell.classList.remove("v1", "v2"); changed();
    });
  }

  window.WAWStepSeq = { synthSeq, drumSeq, renderSynth, renderDrums, play, stop, isPlaying, copyToClip, noteIn, BEATS, noteName };
})();
