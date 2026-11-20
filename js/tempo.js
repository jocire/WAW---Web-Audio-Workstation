// WAW tempo map: tempo changes, time signatures, markers and arranger sections.
//
// Song positions are stored in SECONDS everywhere (notes, clips, loops,
// automation). The tempo map converts seconds <-> musical time:
//   beat = quarter note, counted from the song start (beat 0 = bar 1).
//   tempos: [{ beat, bpm }]   constant tempo from each point to the next
//   sigs:   [{ bar, num, den }] time signature from bar `bar` (1-based)
//   markers:[{ id, sec, end?, name, color }]  a marker starts an arranger
//            section; it ends at `end` (resizable) or at the next marker
// When the map is edited, every stored time is re-mapped so content keeps its
// bar/beat position (remapTimes in app.js), exactly like a BPM change.
(function () {
  "use strict";
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const uid = () => "mk_" + Math.random().toString(36).slice(2, 9);
  const MARKER_COLORS = ["#f97316", "#22c55e", "#3b82f6", "#eab308", "#a855f7", "#06b6d4", "#ef4444", "#14b8a6"];

  function defaultState(bpm = 120) {
    return { tempos: [{ beat: 0, bpm }], sigs: [{ bar: 1, num: 4, den: 4 }], markers: [] };
  }
  let state = defaultState();

  function normalize(s, fallbackBpm = 120) {
    const out = defaultState(fallbackBpm);
    if (!s || typeof s !== "object") return out;
    const tempos = (Array.isArray(s.tempos) ? s.tempos : [])
      .map(t => ({ beat: Math.max(0, Number(t.beat) || 0), bpm: clamp(Number(t.bpm) || fallbackBpm, 20, 400) }))
      .sort((a, b) => a.beat - b.beat);
    if (!tempos.length || tempos[0].beat > 0) tempos.unshift({ beat: 0, bpm: tempos[0]?.bpm || fallbackBpm });
    // drop duplicates at the same beat (last wins)
    out.tempos = tempos.filter((t, i) => i === tempos.length - 1 || tempos[i + 1].beat - t.beat > 1e-6);
    const sigs = (Array.isArray(s.sigs) ? s.sigs : [])
      .map(g => ({ bar: Math.max(1, Math.round(Number(g.bar) || 1)), num: clamp(Math.round(Number(g.num) || 4), 1, 32), den: [1, 2, 4, 8, 16, 32].includes(Number(g.den)) ? Number(g.den) : 4 }))
      .sort((a, b) => a.bar - b.bar);
    if (!sigs.length || sigs[0].bar > 1) sigs.unshift({ bar: 1, num: 4, den: 4 });
    out.sigs = sigs.filter((g, i) => i === sigs.length - 1 || sigs[i + 1].bar !== g.bar);
    out.markers = (Array.isArray(s.markers) ? s.markers : [])
      .map((m, i) => {
        const sec = Math.max(0, Number(m.sec) || 0);
        const out = { id: String(m.id || uid()), sec, name: String(m.name || `Section ${i + 1}`).slice(0, 40), color: /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : MARKER_COLORS[i % MARKER_COLORS.length] };
        if (Number.isFinite(Number(m.end)) && Number(m.end) > sec) out.end = Number(m.end);
        return out;
      })
      .sort((a, b) => a.sec - b.sec);
    return out;
  }

  // ---------------------------------------------------------------------------
  // seconds <-> beats
  // ---------------------------------------------------------------------------
  function segmentsOf(s = state) {
    // [{ beat, sec, bpm }] with cumulative seconds at each tempo point
    const out = [];
    let sec = 0;
    s.tempos.forEach((t, i) => {
      if (i > 0) { const p = s.tempos[i - 1]; sec += (t.beat - p.beat) * 60 / p.bpm; }
      out.push({ beat: t.beat, sec, bpm: t.bpm });
    });
    return out;
  }
  let segCache = null, segCacheFor = null;
  function segs(s = state) {
    if (s !== state) return segmentsOf(s);
    if (segCacheFor !== state || !segCache) { segCache = segmentsOf(state); segCacheFor = state; }
    return segCache;
  }
  function invalidate() { segCache = null; segCacheFor = null; barCache = null; }

  function secToBeat(sec, s = state) {
    const sg = segs(s);
    let k = sg.length - 1;
    while (k > 0 && sg[k].sec > sec) k--;
    return sg[k].beat + (sec - sg[k].sec) * sg[k].bpm / 60;
  }
  function beatToSec(beat, s = state) {
    const sg = segs(s);
    let k = sg.length - 1;
    while (k > 0 && sg[k].beat > beat) k--;
    return sg[k].sec + (beat - sg[k].beat) * 60 / sg[k].bpm;
  }
  function bpmAt(sec, s = state) {
    const sg = segs(s);
    let k = sg.length - 1;
    while (k > 0 && sg[k].sec > sec + 1e-9) k--;
    return sg[k].bpm;
  }

  // ---------------------------------------------------------------------------
  // bars
  // ---------------------------------------------------------------------------
  const barLen = g => g.num * 4 / g.den; // in quarter-note beats
  let barCache = null;
  function sigBeats() {
    // [{ bar, num, den, beat }] beat at which each signature starts
    if (barCache) return barCache;
    const out = [];
    let beat = 0;
    state.sigs.forEach((g, i) => {
      if (i > 0) { const p = state.sigs[i - 1]; beat += (g.bar - p.bar) * barLen(p); }
      out.push({ ...g, beat });
    });
    barCache = out;
    return out;
  }
  function sigAtBeat(beat) {
    const sb = sigBeats();
    let k = sb.length - 1;
    while (k > 0 && sb[k].beat > beat + 1e-9) k--;
    return sb[k];
  }
  function sigAtBar(bar) {
    const sb = sigBeats();
    let k = sb.length - 1;
    while (k > 0 && sb[k].bar > bar) k--;
    return sb[k];
  }
  function barStartBeat(bar) {
    const g = sigAtBar(bar);
    return g.beat + (bar - g.bar) * barLen(g);
  }
  /** { bar (1-based), beat (1-based, in denominator units), tick (0..959), sig } */
  function position(sec) {
    const b = secToBeat(Math.max(0, sec));
    const g = sigAtBeat(b);
    const into = b - g.beat;
    const len = barLen(g);
    const barIdx = Math.floor(into / len + 1e-9);
    const inBar = into - barIdx * len;
    const unit = 4 / g.den; // beats per denominator unit
    const beatNo = Math.floor(inBar / unit + 1e-9);
    const tick = Math.floor(((inBar - beatNo * unit) / unit) * 960);
    return { bar: g.bar + barIdx, beat: beatNo + 1, tick: clamp(tick, 0, 959), sig: g, barBeat: g.beat + barIdx * len };
  }
  function barToSec(bar) { return beatToSec(barStartBeat(bar)); }

  /** grid lines between two song times: [{ sec, kind: "bar"|"beat"|"sub", bar }] */
  function gridLines(startSec, endSec, pxPerSec, minPx = 6) {
    const out = [];
    const b0 = secToBeat(Math.max(0, startSec));
    const b1 = secToBeat(Math.max(0, endSec));
    let { bar } = position(Math.max(0, startSec));
    let guard = 0;
    while (guard++ < 5000) {
      const bb = barStartBeat(bar);
      if (bb > b1) break;
      const g = sigAtBar(bar);
      const len = barLen(g), unit = 4 / g.den;
      const barSec = beatToSec(bb);
      const nextSec = beatToSec(bb + len);
      const barPx = (nextSec - barSec) * pxPerSec;
      const beatsInBar = g.num;
      const beatPx = barPx / beatsInBar;
      // thin out bars when zoomed far out
      const barStep = barPx >= minPx * 2 ? 1 : Math.pow(2, Math.ceil(Math.log2((minPx * 2) / Math.max(0.01, barPx))));
      if ((bar - 1) % barStep === 0 && bb >= b0 - len) out.push({ sec: barSec, kind: "bar", bar, labelEvery: barStep });
      if (beatPx >= minPx) {
        for (let i = 1; i < beatsInBar; i++) out.push({ sec: beatToSec(bb + i * unit), kind: "beat", bar });
        if (beatPx >= minPx * 4) {
          for (let i = 0; i < beatsInBar; i++) for (let j = 1; j < 4; j++) out.push({ sec: beatToSec(bb + (i + j / 4) * unit), kind: "sub", bar });
        }
      }
      bar++;
    }
    return out.filter(l => l.sec >= startSec - 1e-6 && l.sec <= endSec + 1e-6);
  }

  /**
   * Snap a song time to a grid given in whole notes (1 = whole note,
   * 0.25 = quarter). Snapping is relative to the bar start, so odd meters work.
   */
  function snapSec(sec, wholeFraction, swing = 0, isStart = true) {
    const gridBeats = Math.max(1 / 64, wholeFraction * 4);
    const p = position(Math.max(0, sec));
    const b = secToBeat(Math.max(0, sec));
    const rel = b - p.barBeat;
    let idx = Math.round(rel / gridBeats);
    let q = p.barBeat + idx * gridBeats;
    if (swing > 0 && isStart && idx % 2 === 1) q += swing * 0.5 * gridBeats;
    return Math.max(0, beatToSec(q));
  }

  /** maps an old song time to the time with the same bar/beat in the new map */
  function remapper(oldState, newState) {
    const o = normalize(oldState), n = normalize(newState);
    return (sec) => beatToSec(secToBeat(sec, o), n);
  }

  // ---------------------------------------------------------------------------
  // edits (all go through commit so content follows the map)
  // ---------------------------------------------------------------------------
  function serialize() { return structuredClone(state); }
  function setState(s, fallbackBpm) { state = normalize(s, fallbackBpm); invalidate(); }

  /** apply a new map; content times are re-mapped by app.js (remapAllTimes) */
  function commit(newState, { history = true } = {}) {
    const old = serialize();
    const next = normalize(newState, state.tempos[0].bpm);
    if (JSON.stringify(old) === JSON.stringify(next)) return;
    if (history) pushHistory();
    const map = remapper(old, next);
    state = next; invalidate();
    // markers are stored in seconds too: keep their bar position
    state.markers.forEach(m => { m.sec = map(m.sec); if (m.end != null) m.end = map(m.end); });
    if (typeof remapAllTimes === "function") remapAllTimes(map, old, next);
    syncBpmField();
    window.WAWCollab?.notifyChange?.();
  }

  function syncBpmField() {
    if (typeof bpmInput !== "undefined" && bpmInput && document.activeElement !== bpmInput) bpmInput.value = state.tempos[0].bpm;
    if (typeof timelineBpm !== "undefined") timelineBpm = state.tempos[0].bpm;
  }

  function setTempoAt(sec, bpm) {
    const s = serialize();
    const beat = snapBeatToBar(secToBeat(sec));
    const existing = s.tempos.find(t => Math.abs(t.beat - beat) < 1e-6);
    if (existing) existing.bpm = bpm; else s.tempos.push({ beat, bpm });
    commit(s);
  }
  function removeTempo(beat) {
    const s = serialize();
    if (beat <= 0) return;
    s.tempos = s.tempos.filter(t => Math.abs(t.beat - beat) > 1e-6);
    commit(s);
  }
  /** the BPM field edits the tempo in effect at `sec` (the first tempo when there is only one) */
  function setBpmFromField(bpm, sec = 0) {
    const s = serialize();
    const sg = segs();
    let k = sg.length - 1;
    while (k > 0 && sg[k].sec > sec + 1e-9) k--;
    s.tempos[k].bpm = bpm;
    commit(s);
  }
  function setSigAt(bar, num, den) {
    const s = serialize();
    const ex = s.sigs.find(g => g.bar === bar);
    if (ex) { ex.num = num; ex.den = den; } else s.sigs.push({ bar, num, den });
    commit(s);
  }
  function removeSig(bar) {
    if (bar <= 1) return;
    const s = serialize();
    s.sigs = s.sigs.filter(g => g.bar !== bar);
    commit(s);
  }
  function snapBeatToBar(beat) {
    const p = position(beatToSec(beat));
    const len = barLen(p.sig);
    return Math.abs(beat - p.barBeat) < len / 2 ? p.barBeat : p.barBeat + len;
  }

  function addMarker(sec, name) {
    pushHistory();
    const p = position(sec);
    const start = barToSec(p.bar);
    // a new section is 1 bar long (or up to the next marker); stretch it with its right edge
    const next = state.markers.filter(m => m.sec > start + 1e-6).sort((a, b) => a.sec - b.sec)[0];
    const end = Math.min(barToSec(p.bar + 1), next ? next.sec : Infinity);
    state.markers.push({ id: uid(), sec: start, end, name: name || `Section ${state.markers.length + 1}`, color: MARKER_COLORS[state.markers.length % MARKER_COLORS.length] });
    state.markers.sort((a, b) => a.sec - b.sec);
    changed();
  }
  function removeMarker(id) { pushHistory(); state.markers = state.markers.filter(m => m.id !== id); changed(); }
  function renameMarker(id, name) { const m = state.markers.find(x => x.id === id); if (!m) return; pushHistory(); m.name = name.slice(0, 40); changed(); }
  function changed() { renderSequencer(); window.WAWCollab?.notifyChange?.(); }

  /** arranger section = marker .. next marker (or the end of the content) */
  function sections() {
    const end = Math.max(typeof getBaseDuration === "function" ? getBaseDuration() : 0, ...state.markers.map(m => m.sec + 1));
    return state.markers.map((m, i) => {
      const nextStart = state.markers[i + 1]?.sec;
      const auto = nextStart ?? contentEnd(end);
      const e = m.end != null ? Math.min(m.end, nextStart ?? Infinity) : auto;
      return { ...m, start: m.sec, end: Math.max(m.sec + 0.01, e) };
    });
  }
  function contentEnd(fallback) {
    let e = 0;
    tracks.forEach(t => (t.clips || []).forEach(c => { e = Math.max(e, c.endSec); }));
    if (e <= 0) return fallback;
    const p = position(e);
    return p.barBeat === secToBeat(e) ? e : barToSec(p.bar + 1);
  }

  // ---------------------------------------------------------------------------
  // Global lane UI (top row of the sequencer)
  // ---------------------------------------------------------------------------
  function buildGlobalRow(grid, { pxPerSec, laneWidthPx }) {
    const row = document.createElement("div");
    row.className = "seq-track-row seq-extra-row seq-global-row";
    row.innerHTML = `
      <div class="seq-row-label seq-global-label">
        <div class="seq-label-top"><span class="seq-label-name">Tempo · Meter · Markers</span></div>
        <div class="seq-label-btns gl-btns">
          <button type="button" data-g="tempo" title="Add a tempo change at the playhead" aria-label="Add tempo change">${window.WAWIcons?.tempo || "♩"}</button>
          <button type="button" data-g="sig" title="Add a time signature change at the playhead" aria-label="Add meter change">${window.WAWIcons?.meter || "4/4"}</button>
          <button type="button" data-g="marker" title="Add an arranger marker at the playhead" aria-label="Add marker">${window.WAWIcons?.marker || "⚑"}</button>
        </div>
      </div>
      <div class="seq-row-lane seq-global-lane"></div>`;
    const lane = row.querySelector(".seq-global-lane");
    lane.style.width = laneWidthPx + "px";
    const x = sec => sec * pxPerSec;
    const head = () => lastPlayheadSec || 0;

    row.querySelector(".seq-global-label").addEventListener("click", (e) => {
      const g = e.target.closest("[data-g]")?.dataset.g;
      if (!g) return;
      e.stopPropagation();
      if (g === "tempo") askTempo(head());
      else if (g === "sig") askSig(position(head()).bar);
      else if (g === "marker") addMarker(head());
    });

    // arranger sections
    sections().forEach(sec => {
      const el = document.createElement("div");
      el.className = "arr-section";
      el.style.left = x(sec.start) + "px";
      el.style.width = Math.max(4, x(sec.end) - x(sec.start)) + "px";
      el.style.setProperty("--c", sec.color);
      el.title = `${sec.name}: drag = move, drag right edge = resize, click = loop, double-click = rename, right-click = arranger menu`;
      el.innerHTML = `<span>${escapeHtml(sec.name)}</span><div class="arr-resize" title="Drag to change the section length"></div>`;
      el.addEventListener("click", (e) => { e.stopPropagation(); if (el.dataset.dragged) { delete el.dataset.dragged; return; } loopSection(sec); });
      el.addEventListener("dblclick", (e) => { e.stopPropagation(); const v = prompt("Section name:", sec.name); if (v && v.trim()) renameMarker(sec.id, v.trim()); });
      el.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); sectionMenu(sec, e.clientX, e.clientY); });
      dragMarker(el, sec, pxPerSec);
      lane.appendChild(el);
    });

    // tempo + signature flags
    const sg = segs();
    sg.forEach((t, i) => {
      const f = document.createElement("div");
      f.className = "gl-flag tempo";
      f.style.left = x(t.sec) + "px";
      f.textContent = `♩=${+t.bpm.toFixed(2)}`;
      f.title = i === 0 ? "Song tempo (click to change)" : "Tempo change: click = edit, right-click = remove";
      f.addEventListener("click", (e) => { e.stopPropagation(); askTempo(t.sec, t.bpm); });
      f.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); if (i > 0 && confirm(`Remove tempo change ${t.bpm} BPM?`)) removeTempo(t.beat); });
      lane.appendChild(f);
    });
    sigBeats().forEach((g, i) => {
      const f = document.createElement("div");
      f.className = "gl-flag sig";
      f.style.left = x(beatToSec(g.beat)) + "px";
      f.textContent = `${g.num}/${g.den}`;
      f.title = i === 0 ? "Time signature (click to change)" : `Meter change at bar ${g.bar}: click = edit, right-click = remove`;
      f.addEventListener("click", (e) => { e.stopPropagation(); askSig(g.bar, g); });
      f.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); if (i > 0 && confirm(`Remove ${g.num}/${g.den} at bar ${g.bar}?`)) removeSig(g.bar); });
      lane.appendChild(f);
    });

    lane.addEventListener("dblclick", (e) => {
      if (e.target !== lane) return;
      const r = lane.getBoundingClientRect();
      addMarker(Math.max(0, (e.clientX - r.left) / pxPerSec));
    });
    grid.appendChild(row);
  }

  function askTempo(sec, current) {
    const p = position(sec);
    const v = prompt(`Tempo (BPM) from bar ${p.bar}:`, String(current ?? bpmAt(sec)));
    const bpm = parseFloat(v);
    if (!Number.isFinite(bpm) || bpm < 20 || bpm > 400) return;
    if (isRecording) { toast("Stop recording before changing the tempo"); return; }
    setTempoAt(barToSec(p.bar), bpm);
  }
  function askSig(bar, current) {
    const v = prompt(`Time signature from bar ${bar} (e.g. 3/4, 6/8, 7/8):`, current ? `${current.num}/${current.den}` : "3/4");
    const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(v || "");
    if (!m) return;
    const num = parseInt(m[1], 10), den = parseInt(m[2], 10);
    if (!(num >= 1 && num <= 32) || ![1, 2, 4, 8, 16, 32].includes(den)) { toast("Use n/d with d = 1, 2, 4, 8, 16 or 32"); return; }
    setSigAt(bar, num, den);
  }

  /** move a section (drag its body) or resize it (drag its right edge); snapped to bars */
  function dragMarker(el, sec, pxPerSec) {
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const m = state.markers.find(x => x.id === sec.id);
      if (!m) return;
      const resizing = !!e.target.closest(".arr-resize");
      const x0 = e.clientX;
      const s0 = m.sec, e0 = sec.end, len0 = sec.end - sec.start;
      const startBar = position(s0).bar;
      const lenBars = Math.max(1, position(e0 - 1e-6).bar + 1 - startBar);
      let moved = false;
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      const move = (ev) => {
        const dx = ev.clientX - x0;
        if (!moved && Math.abs(dx) < 4) return;
        if (!moved) { moved = true; beginHistoryGesture(); el.classList.add("dragging"); }
        if (resizing) {
          const endBar = Math.max(startBar + 1, position(e0 + dx / pxPerSec + 0.5 * (barToSec(startBar + 1) - barToSec(startBar))).bar);
          m.end = barToSec(endBar);
          el.style.width = Math.max(4, (m.end - m.sec) * pxPerSec) + "px";
        } else {
          const bar = Math.max(1, position(Math.max(0, s0 + dx / pxPerSec) + 0.5 * (barToSec(startBar + 1) - barToSec(startBar))).bar);
          m.sec = barToSec(bar);
          m.end = barToSec(bar + lenBars);
          el.style.left = m.sec * pxPerSec + "px";
          el.style.width = Math.max(4, (m.end - m.sec) * pxPerSec) + "px";
        }
      };
      const up = () => {
        el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up);
        el.classList.remove("dragging");
        if (!moved) return; // a click: loops the section
        el.dataset.dragged = "1";
        if (m.sec === s0 && Math.abs((m.end ?? e0) - e0) < 1e-6) { cancelHistoryGesture(); return; }
        state.markers.sort((a2, b2) => a2.sec - b2.sec);
        void len0;
        commitHistoryGesture(); changed();
      };
      el.addEventListener("pointermove", move); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
    });
  }

  function loopSection(sec) {
    loopStartSec = sec.start; loopEndSec = sec.end; loopEnabled = true;
    loopBtn?.classList.toggle("active", true);
    lastPlayheadSec = sec.start; playheadWasManuallySet = true;
    drawAllLoopBars(lastPlayheadSec);
    if (typeof drawSequencerRuler === "function") drawSequencerRuler(lastPlayheadSec);
    restartPlaybackFromCurrentPosition();
    statusEl.textContent = `Looping "${sec.name}".`;
  }

  function sectionMenu(sec, x, y) {
    const items = [
      { label: `Loop "${sec.name}"`, action: () => loopSection(sec) },
      { label: "Duplicate section (insert after)", action: () => insertSection(sec, true) },
      { label: "Insert empty bars here…", action: () => { const n = parseInt(prompt("Bars to insert:", "4"), 10); if (n > 0) insertBars(sec.start, n); } },
      { label: "Delete section (remove time)", action: () => { if (confirm(`Delete "${sec.name}" and close the gap?`)) deleteTime(sec.start, sec.end, sec.id); } },
      { label: "Rename…", action: () => { const v = prompt("Section name:", sec.name); if (v && v.trim()) renameMarker(sec.id, v.trim()); } },
      { label: "Remove marker", action: () => removeMarker(sec.id) },
    ];
    window.WAWWorkspace?.popupMenu ? window.WAWWorkspace.popupMenu(x, y, items) : items[0].action();
  }

  // ---- arranger edits: they move every kind of time-stamped content ----
  function shiftAfter(at, delta, { cutStart = null, cutEnd = null } = {}) {
    const shift = s => (s >= at - 1e-6 ? s + delta : s);
    tracks.forEach(t => {
      if (cutStart != null) t.clips = (t.clips || []).filter(c => !(c.startSec >= cutStart - 1e-6 && c.endSec <= cutEnd + 1e-6));
      (t.clips || []).forEach(c => { if (c.startSec >= at - 1e-6) { c.startSec += delta; c.endSec += delta; } });
      (t.notes || []).forEach(n => { if (n.startSec >= at - 1e-6) { n.startSec += delta; n.endSec += delta; } });
      if (cutStart != null) t.notes = (t.notes || []).filter(n => !(n.startSec >= cutStart - 1e-6 && n.startSec < cutEnd - 1e-6));
      window.WAWAutomation?.shiftTrack?.(t, at, delta, cutStart, cutEnd);
    });
    state.markers.forEach(m => { m.sec = shift(m.sec); if (m.end != null) m.end = shift(m.end); });
    if (loopEndSec > loopStartSec) { loopStartSec = shift(loopStartSec); loopEndSec = shift(loopEndSec); }
  }

  function insertBars(at, bars) {
    pushHistory();
    const p = position(at);
    const start = barToSec(p.bar);
    const delta = barToSec(p.bar + bars) - start;
    shiftAfter(start, delta);
    afterArrange(`Inserted ${bars} bar(s).`);
  }

  function insertSection(sec, copyContent) {
    pushHistory();
    const len = sec.end - sec.start;
    shiftAfter(sec.end, len);
    if (copyContent) {
      tracks.forEach(t => {
        const copies = (t.clips || []).filter(c => c.startSec >= sec.start - 1e-6 && c.startSec < sec.end - 1e-6).map(c => {
          const cp = structuredClone(c);
          cp.id = "clip_" + Math.random().toString(36).slice(2, 9);
          cp.startSec += len; cp.endSec += len;
          return cp;
        });
        t.clips.push(...copies);
        copies.forEach(c => { if (!c.audio && typeof syncTrackNotesFromClip === "function") syncTrackNotesFromClip(t, c); });
        window.WAWAutomation?.copyRange?.(t, sec.start, sec.end, len);
      });
      const i = state.markers.findIndex(m => m.id === sec.id);
      state.markers.splice(i + 1, 0, { id: uid(), sec: sec.end, end: sec.end + len, name: sec.name + " (copy)", color: sec.color });
      state.markers.sort((a, b) => a.sec - b.sec);
    }
    afterArrange(`Duplicated "${sec.name}".`);
  }

  function deleteTime(start, end, markerId) {
    pushHistory();
    if (markerId) state.markers = state.markers.filter(m => m.id !== markerId);
    shiftAfter(end, -(end - start), { cutStart: start, cutEnd: end });
    afterArrange("Section deleted.");
  }

  function afterArrange(msg) {
    if (typeof setActiveTrack === "function") setActiveTrack(activeTrackIndex, { silent: true });
    renderSequencer(); renderSidebarTracks?.();
    restartPlaybackFromCurrentPosition();
    statusEl.textContent = msg;
    window.WAWCollab?.notifyChange?.();
  }

  window.WAWTempo = {
    get state() { return state; }, serialize, setState, normalize, commit, remapper,
    secToBeat, beatToSec, bpmAt, position, barToSec, barStartBeat, sigAtBeat, gridLines, snapSec,
    setTempoAt, removeTempo, setBpmFromField, setSigAt, removeSig, addMarker, removeMarker, renameMarker,
    sections, insertBars, insertSection, deleteTime, buildGlobalRow, syncBpmField,
    isSimple: () => state.tempos.length === 1 && state.sigs.length === 1 && state.sigs[0].num === 4 && state.sigs[0].den === 4
  };
})();
