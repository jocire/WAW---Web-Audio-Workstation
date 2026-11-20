// WAW comping: cycle recordings keep every pass as a take; take lanes under
// the track let you pick the best parts.
//
// clip.takes      = [{ sampleId, offset, name }]  offset = source position at clip-local 0
// clip.activeTake = index used where no comp segment says otherwise
// clip.comp       = [{ start, end, take }] clip-local song seconds, or null
// clip.showTakes  = take lanes visible
// clip.audio.sampleId/offset always mirror the active take, so code that does
// not know about takes still plays something sensible.
(function () {
  "use strict";
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const S = () => window.WAWSamples;
  const k = clip => window.WAWWarp ? window.WAWWarp.factor(clip) : 1;

  function hasTakes(c) { return Array.isArray(c?.takes) && c.takes.length > 1; }

  function mirrorActive(c) {
    const t = c.takes?.[c.activeTake ?? 0];
    if (t) { c.audio.sampleId = t.sampleId; c.audio.offset = t.offset; }
  }

  /** playback segments of a clip: [{ src:{sampleId,offset}, start, end, fadeIn, fadeOut }] (clip-local) */
  function segments(c) {
    const len = c.endSec - c.startSec;
    const takes = hasTakes(c) ? c.takes : null;
    const raw = takes && c.comp?.length ? c.comp.filter(s => s.end > s.start && s.start < len) : [{ start: 0, end: len, take: takes ? (c.activeTake ?? 0) : -1 }];
    const X = 0.004; // crossfade at comp boundaries
    return raw.map((s, i) => {
      const first = i === 0, last = i === raw.length - 1;
      const src = takes ? (takes[s.take] || takes[0]) : c.audio;
      return {
        src, take: s.take,
        start: clamp(s.start - (first ? 0 : X), 0, len), end: clamp(s.end + (last ? 0 : X), 0, len),
        fadeIn: first ? (c.audio.fadeIn || 0) : X, fadeOut: last ? (c.audio.fadeOut || 0) : X
      };
    });
  }

  function setRange(segs, a, b, take) {
    const out = [];
    segs.forEach(s => {
      if (s.end <= a || s.start >= b) { out.push(s); return; }
      if (s.start < a) out.push({ start: s.start, end: a, take: s.take });
      if (s.end > b) out.push({ start: b, end: s.end, take: s.take });
    });
    out.push({ start: a, end: b, take });
    out.sort((x, y) => x.start - y.start);
    // merge neighbours that use the same take
    return out.reduce((acc, s) => {
      const p = acc[acc.length - 1];
      if (p && p.take === s.take && Math.abs(p.end - s.start) < 1e-6) p.end = s.end; else acc.push({ ...s });
      return acc;
    }, []);
  }

  /** keep takes + comp aligned when a clip's left edge is trimmed (dSrc in source s) */
  function onTrim(c, dSrc) {
    if (!c.takes) return;
    c.takes.forEach(t => { t.offset += dSrc; });
    if (c.comp) {
      const dSong = dSrc * k(c);
      c.comp = c.comp.map(s => ({ ...s, start: Math.max(0, s.start - dSong), end: s.end - dSong })).filter(s => s.end > 0.001);
    }
    mirrorActive(c);
  }

  /** split support: returns the right-hand clip's takes/comp for a cut at local time `cut` */
  function splitTakes(c, right, cut) {
    if (!c.takes) return;
    const dSrc = cut / k(c);
    right.takes = c.takes.map(t => ({ ...t, offset: t.offset + dSrc }));
    right.activeTake = c.activeTake;
    right.showTakes = c.showTakes;
    if (c.comp) {
      right.comp = c.comp.filter(s => s.end > cut).map(s => ({ ...s, start: Math.max(0, s.start - cut), end: s.end - cut }));
      c.comp = c.comp.filter(s => s.start < cut).map(s => ({ ...s, end: Math.min(cut, s.end) }));
    }
    mirrorActive(right);
  }

  // ---------------------------------------------------------------------------
  // take lanes UI
  // ---------------------------------------------------------------------------
  function appendLanes(grid, track, ti, { pxPerSec, laneWidthPx }) {
    if (track.type !== "audio") return;
    const clips = (track.clips || []).filter(c => hasTakes(c) && c.showTakes);
    if (!clips.length) return;
    const rows = Math.max(...clips.map(c => c.takes.length));
    for (let r = 0; r < rows; r++) {
      const row = document.createElement("div");
      row.className = "seq-track-row seq-extra-row take-row";
      row.dataset.trackIndex = ti;
      row.innerHTML = `<div class="seq-row-label take-label" style="border-left:4px solid ${track.color || "#888"}"><span>Take ${r + 1}</span><small>drag = comp · click = whole take</small></div><div class="seq-row-lane take-lane"></div>`;
      const lane = row.querySelector(".take-lane");
      lane.style.width = laneWidthPx + "px";
      clips.forEach(c => {
        const take = c.takes[r];
        if (!take) return;
        const len = c.endSec - c.startSec;
        const el = document.createElement("div");
        el.className = "take-clip";
        el.style.left = c.startSec * pxPerSec + "px";
        el.style.width = Math.max(6, len * pxPerSec) + "px";
        const segs = segments(c);
        const used = segs.filter(s => s.take === r || (!c.comp?.length && (c.activeTake ?? 0) === r));
        el.innerHTML = `<canvas></canvas>${used.map(s => `<div class="take-used" style="left:${(s.start / len) * 100}%;width:${((s.end - s.start) / len) * 100}%"></div>`).join("")}<span class="take-name">${escapeHtml(take.name || `Take ${r + 1}`)}</span><div class="take-sel"></div>`;
        lane.appendChild(el);
        const canvas = el.querySelector("canvas");
        const draw = () => S().drawWaveform(canvas, take.sampleId, { start: take.offset, end: take.offset + len / k(c), color: "rgba(255,255,255,0.55)" });
        requestAnimationFrame(() => { if (S().has(take.sampleId)) draw(); else S().load(take.sampleId).then(b => b && canvas.isConnected && draw()); });
        attachSwipe(el, c, r, len, pxPerSec);
      });
      grid.appendChild(row);
    }
  }

  function attachSwipe(el, c, takeIdx, len, pxPerSec) {
    const sel = el.querySelector(".take-sel");
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const r = el.getBoundingClientRect();
      const x0 = e.clientX - r.left;
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      let x1 = x0;
      const move = (ev) => {
        x1 = clamp(ev.clientX - r.left, 0, r.width);
        sel.style.display = "block";
        sel.style.left = Math.min(x0, x1) + "px";
        sel.style.width = Math.abs(x1 - x0) + "px";
      };
      const up = () => {
        el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up);
        sel.style.display = "none";
        pushHistory();
        if (Math.abs(x1 - x0) < 4) {
          // click: the whole clip uses this take
          c.comp = null; c.activeTake = takeIdx;
          mirrorActive(c);
        } else {
          let a = Math.min(x0, x1) / pxPerSec, b = Math.max(x0, x1) / pxPerSec;
          // snap the comp boundaries to the grid (in song time)
          if (typeof snapSec === "function") { a = snapSec(c.startSec + a) - c.startSec; b = snapSec(c.startSec + b) - c.startSec; }
          a = clamp(a, 0, len); b = clamp(b, 0, len);
          if (b - a < 0.01) { b = Math.min(len, a + Math.max(0.01, Math.abs(x1 - x0) / pxPerSec)); }
          const base = c.comp?.length ? c.comp : [{ start: 0, end: len, take: c.activeTake ?? 0 }];
          c.comp = setRange(base, a, b, takeIdx);
          if (c.comp.length === 1) { c.activeTake = c.comp[0].take; c.comp = null; mirrorActive(c); }
        }
        renderSequencer();
        restartPlaybackFromCurrentPosition();
        window.WAWCollab?.notifyChange?.();
      };
      el.addEventListener("pointermove", move); el.addEventListener("pointerup", up);
    });
  }

  function toggleTakes(trackIndex, clipId) {
    const c = tracks[trackIndex]?.clips?.find(x => x.id === clipId);
    if (!hasTakes(c)) { toast("This clip has only one take (record in cycle mode to get several)"); return; }
    c.showTakes = !c.showTakes;
    renderSequencer();
  }

  /** render the comp into a single new sample and drop the takes */
  async function flatten(trackIndex, clipId) {
    const t = tracks[trackIndex];
    const c = t?.clips?.find(x => x.id === clipId);
    if (!hasTakes(c)) { toast("Nothing to flatten"); return; }
    const len = c.endSec - c.startSec;
    const ids = [...new Set(c.takes.map(x => x.sampleId))];
    await Promise.all(ids.map(id => S().load(id)));
    await window.WAWWarp?.prepareAll?.();
    const rate = S().get(ids[0])?.sampleRate || 48000;
    const off = new OfflineAudioContext(2, Math.max(1, Math.ceil(len * rate)), rate);
    const evs = window.WAWAudio.collectAudioEvents(c.startSec, c.endSec, { clip: c, ignoreClipGain: true });
    evs.forEach(ev => window.WAWAudio.scheduleAudioEvent(off, off.destination, { ...ev, gain: 0 }, ev.start - c.startSec, 0));
    const buf = await off.startRendering();
    pushHistory();
    const id = await S().put(buf, `${c.name || "Comp"} (comp)`);
    c.audio = { ...c.audio, sampleId: id, offset: 0, fadeIn: 0, fadeOut: 0 }; // fades are in the render
    // the render is at song speed: keep it following the tempo from here
    if (c.audio.warp?.on) c.audio.warp = { on: true, srcBpm: window.WAWTempo.bpmAt(c.startSec) };
    delete c.takes; delete c.comp; delete c.activeTake; delete c.showTakes;
    renderSequencer();
    statusEl.textContent = "Comp flattened into one clip.";
    window.WAWCollab?.notifyChange?.();
  }

  window.WAWComp = { hasTakes, segments, setRange, onTrim, splitTakes, appendLanes, toggleTakes, flatten, mirrorActive };
})();
