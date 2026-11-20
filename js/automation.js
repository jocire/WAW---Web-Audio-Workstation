// WAW automation: per-track lanes for volume, pan, sends and any insert-FX
// parameter, with Read / Touch / Latch / Write modes.
//
// Data (stored on the track, so it is saved, undone and shared like the rest):
//   track.automation = { mode: "off"|"read"|"touch"|"latch"|"write", show: bool,
//                        lanes: [{ id, param, points: [{ t, v }] }] }
//   param ids: "volume" | "pan" | "send.A".."send.D" | "fx.<fxId>.<paramId>"
// Times are song seconds (re-mapped with the tempo map like everything else).
//
// Playback reads lanes at control rate (every scheduler tick, ~25 ms) and sets
// the channel strip's AudioParams / FX parameters directly, so the project's
// static mix values are never overwritten by reading. The WAV export schedules
// exact ramps for volume/pan/sends and steps FX parameters while rendering.
//
// Writing: while playing, a touched control (fader, knob, slider) records its
// value into its lane:  Touch = while held, Latch = from the touch until stop,
// Write = every lane of the track from play start until stop (then the track
// drops to Touch so the next pass does not overwrite everything again).
(function () {
  "use strict";
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const uid = () => "al_" + Math.random().toString(36).slice(2, 9);
  const MODES = ["off", "read", "touch", "latch", "write"];
  const LANE_H = 46;

  // ---------------------------------------------------------------------------
  // data helpers
  // ---------------------------------------------------------------------------
  function auto(track) {
    if (!track.automation || typeof track.automation !== "object") track.automation = { mode: "read", show: false, lanes: [] };
    const a = track.automation;
    if (!MODES.includes(a.mode)) a.mode = "read";
    if (!Array.isArray(a.lanes)) a.lanes = [];
    a.lanes.forEach(l => { if (!l.id) l.id = uid(); if (!Array.isArray(l.points)) l.points = []; });
    return a;
  }

  const fmtDb = g => g <= 0.00001 ? "-∞ dB" : (20 * Math.log10(g)).toFixed(1) + " dB";
  function paramsFor(track) {
    const out = [
      { id: "volume", label: "Volume", min: 0, max: 2, get: t => t.volume ?? 1, fmt: fmtDb, curve: "fader" },
      { id: "pan", label: "Pan", min: -1, max: 1, get: t => t.pan ?? 0, fmt: v => Math.abs(v) < 0.01 ? "C" : (v < 0 ? "L" : "R") + Math.round(Math.abs(v) * 100) },
      ...(window.WAWMixer?.SEND_KEYS || ["A", "B", "C", "D"]).map(k => ({
        id: "send." + k, label: `Send ${k}`, min: 0, max: 1, get: t => t.sends?.[k] ?? 0, fmt: v => Math.round(v * 100) + "%"
      }))
    ];
    (track.inserts || []).forEach(fx => {
      const def = window.WAWFX?.FX_TYPES[fx.type];
      (def?.params || []).forEach(p => {
        if (p.type === "select" || p.type === "toggle" || !Number.isFinite(p.min)) return;
        out.push({
          id: `fx.${fx.id}.${p.id}`, label: `${def.name} · ${p.label}`, min: p.min, max: p.max, log: !!p.log && p.min > 0,
          get: () => fx.params?.[p.id] ?? p.default, fmt: v => window.WAWFX.formatParam(p, v), fx, spec: p
        });
      });
    });
    return out;
  }
  function paramById(track, id) { return paramsFor(track).find(p => p.id === id); }

  // normalised 0..1 <-> value (fader-like curve for volume, log for frequencies)
  function toNorm(p, v) {
    if (p.curve === "fader") return v <= 0 ? 0 : clamp(Math.pow(v / p.max, 1 / 2.2), 0, 1);
    if (p.log) return clamp(Math.log(v / p.min) / Math.log(p.max / p.min), 0, 1);
    return clamp((v - p.min) / (p.max - p.min), 0, 1);
  }
  function fromNorm(p, n) {
    n = clamp(n, 0, 1);
    if (p.curve === "fader") return p.max * Math.pow(n, 2.2);
    if (p.log) return p.min * Math.pow(p.max / p.min, n);
    return p.min + n * (p.max - p.min);
  }

  function valueAt(points, t) {
    if (!points.length) return null;
    if (t <= points[0].t) return points[0].v;
    const last = points[points.length - 1];
    if (t >= last.t) return last.v;
    let lo = 0, hi = points.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (points[m].t <= t) lo = m; else hi = m; }
    const a = points[lo], b = points[hi];
    return b.t - a.t < 1e-9 ? b.v : a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t);
  }

  /** remove points that a straight line through their neighbours already describes */
  function simplify(points, p) {
    if (points.length < 3) return points;
    const tol = (p.max - p.min) * 0.002;
    const out = [points[0]];
    for (let i = 1; i < points.length - 1; i++) {
      const a = out[out.length - 1], b = points[i], c = points[i + 1];
      const v = c.t - a.t < 1e-9 ? a.v : a.v + (c.v - a.v) * (b.t - a.t) / (c.t - a.t);
      if (Math.abs(v - b.v) > tol) out.push(b);
    }
    out.push(points[points.length - 1]);
    return out;
  }

  // ---------------------------------------------------------------------------
  // engine: apply values to the realtime channel strip
  // ---------------------------------------------------------------------------
  const lastApplied = new Map(); // trackId|param -> value
  function channelOf(track, graph) {
    const g = graph || window.WAWMixer?.getRealtimeGraph?.();
    return g?.channels?.get(track.id) || null;
  }
  function applyValue(track, p, v, ctxTime, graph = null) {
    const ch = channelOf(track, graph);
    if (!ch) return;
    const key = track.id + "|" + p.id;
    // the mixer re-syncs strips to the static values on any edit, so re-apply
    // regularly; FX parameter sets can be expensive, so skip unchanged values briefly
    const prev = lastApplied.get(key);
    const nowMs = performance.now();
    if (!graph && prev && Math.abs(prev.v - v) < 1e-5 && nowMs - prev.at < (p.fx ? 300 : 60)) return;
    if (!graph) lastApplied.set(key, { v, at: nowMs });
    const set = (param) => { try { param.setTargetAtTime(v, ctxTime, 0.012); } catch (e) { param.value = v; } };
    if (p.id === "volume") set(ch.fader.gain);
    else if (p.id === "pan") set(ch.panner.pan);
    else if (p.id.startsWith("send.")) { const s = ch.sends[p.id.slice(5)]; if (s) set(s.gain.gain); }
    else if (p.fx) {
      const it = ch.inserts.items.find(x => x.fx.id === p.fx.id);
      if (it?.inst) it.inst.set({ ...window.WAWFX.defaultParams(p.fx.type), ...p.fx.params, [p.spec.id]: v });
    }
  }

  // ---------------------------------------------------------------------------
  // touch detection (generic: any UI that edits the track's mix values)
  // ---------------------------------------------------------------------------
  let pointerDown = false;
  const touched = new Map();   // trackId|param -> { at, latched }
  const prevLive = new Map();  // trackId|param -> last seen control value
  window.addEventListener("pointerdown", () => { pointerDown = true; }, true);
  window.addEventListener("pointerup", () => { pointerDown = false; releaseTouches(); }, true);
  window.addEventListener("pointercancel", () => { pointerDown = false; releaseTouches(); }, true);
  function releaseTouches() {
    touched.forEach((v, k) => { if (!v.latched) touched.delete(k); else v.held = false; });
  }

  // ---------------------------------------------------------------------------
  // realtime: called by the scheduler with the current song position
  // ---------------------------------------------------------------------------
  let pass = null; // { historyTaken, cursors: Map(key -> lastT), wrote: Set(trackId), startPos }

  function tick(songPos, ctxTime) {
    if (songPos == null) return;
    if (!pass) pass = { historyTaken: false, cursors: new Map(), wrote: new Set(), startPos: songPos, last: songPos };
    const wrapped = songPos < pass.last - 0.05; // loop jumped back
    pass.last = songPos;
    const now = performance.now();
    tracks.forEach(track => {
      const a = track.automation;
      if (!a || a.mode === "off") return;
      const writingTrack = a.mode === "touch" || a.mode === "latch" || a.mode === "write";
      if (!a.lanes.length && !writingTrack) return;
      const params = paramsFor(track);
      params.forEach(p => {
        const key = track.id + "|" + p.id;
        const lane = a.lanes.find(l => l.param === p.id);
        const live = p.get(track);
        // detect a touch: the control value changed while playing
        if (writingTrack) {
          const prev = prevLive.get(key);
          if (prev !== undefined && Math.abs(prev - live) > 1e-6) {
            const tch = touched.get(key) || { latched: a.mode === "latch" };
            tch.at = now; tch.held = pointerDown;
            touched.set(key, tch);
          }
          // wheel / keyboard edits have no pointer: treat as a short touch
          const tch = touched.get(key);
          if (tch && !tch.held && !tch.latched && now - tch.at > 400) touched.delete(key);
        }
        prevLive.set(key, live);
        const writing = writingTrack && (touched.has(key) || (a.mode === "write" && (lane || p.id === "volume")));
        if (writing) {
          writePoint(track, a, lane, p, songPos, live, wrapped);
          return;
        }
        pass.cursors.delete(key);
        if (lane?.points.length) applyValue(track, p, valueAt(lane.points, songPos), ctxTime);
      });
    });
  }

  function writePoint(track, a, lane, p, t, v, wrapped) {
    const key = track.id + "|" + p.id;
    if (!pass.historyTaken) { pushHistory(); pass.historyTaken = true; }
    if (!lane) { lane = { id: uid(), param: p.id, points: [] }; a.lanes.push(lane); a.show = true; }
    let from = pass.cursors.get(key);
    const punchIn = from == null || wrapped || t < from;
    if (punchIn) from = t;
    // overwrite what was there after the previous written point, up to now
    lane.points = lane.points.filter(pt => (punchIn ? pt.t < from - 1e-6 : pt.t <= from + 1e-6) || pt.t > t + 1e-6);
    // anchor the old curve just before a new write starts (smooth punch-in)
    if (punchIn) {
      const before = valueAt(lane.points, from - 0.001);
      if (before != null) lane.points.push({ t: Math.max(0, from - 0.001), v: before });
    }
    lane.points.push({ t, v });
    lane.points.sort((x, y) => x.t - y.t);
    pass.cursors.set(key, t);
    pass.wrote.add(track.id);
  }

  function onStop() {
    if (!pass) return;
    const wrote = pass.wrote;
    // close each written segment by anchoring the old curve after it
    tracks.forEach(track => {
      const a = track.automation;
      if (!a || !wrote.has(track.id)) return;
      a.lanes.forEach(l => { const p = paramById(track, l.param); if (p) l.points = simplify(l.points, p); });
      if (a.mode === "write") a.mode = "touch";
    });
    pass = null;
    touched.clear();
    prevLive.clear();
    lastApplied.clear();
    // back to the static mix values
    window.WAWMixer?.syncEngine?.();
    if (wrote.size) {
      if (typeof renderSequencer === "function") renderSequencer();
      window.WAWCollab?.notifyChange?.();
      statusEl.textContent = "Automation written.";
    }
  }

  // ---------------------------------------------------------------------------
  // offline (WAV export)
  // ---------------------------------------------------------------------------
  function applyOffline(ctx, graph, duration) {
    const fxSteps = []; // { t, fn }
    tracks.forEach(track => {
      const a = track.automation;
      if (!a || a.mode === "off") return;
      const ch = graph.channels.get(track.id);
      if (!ch) return;
      a.lanes.forEach(lane => {
        if (!lane.points.length) return;
        const p = paramById(track, lane.param);
        if (!p) return;
        let param = null;
        if (p.id === "volume") param = ch.fader.gain;
        else if (p.id === "pan") param = ch.panner.pan;
        else if (p.id.startsWith("send.")) param = ch.sends[p.id.slice(5)]?.gain.gain;
        if (param) {
          param.cancelScheduledValues(0);
          param.setValueAtTime(lane.points[0].v, 0);
          lane.points.forEach(pt => param.linearRampToValueAtTime(pt.v, Math.max(0, pt.t)));
          return;
        }
        if (p.fx) {
          const it = ch.inserts.items.find(x => x.fx.id === p.fx.id);
          if (!it?.inst) return;
          const end = Math.min(duration, lane.points[lane.points.length - 1].t + 0.05);
          let last = null;
          for (let t = 0; t <= end; t += 1 / 40) {
            const v = valueAt(lane.points, t);
            if (last != null && Math.abs(v - last) < (p.max - p.min) * 0.001) continue;
            last = v;
            fxSteps.push({ t, fn: () => it.inst.set({ ...window.WAWFX.defaultParams(p.fx.type), ...p.fx.params, [p.spec.id]: v }) });
          }
        }
      });
    });
    if (!fxSteps.length || typeof ctx.suspend !== "function") { fxSteps.filter(s => s.t === 0).forEach(s => s.fn()); return; }
    // group by render quantum time; OfflineAudioContext.suspend needs distinct times
    const byTime = new Map();
    fxSteps.forEach(s => {
      const q = Math.round(s.t * ctx.sampleRate / 128) * 128 / ctx.sampleRate;
      if (!byTime.has(q)) byTime.set(q, []);
      byTime.get(q).push(s.fn);
    });
    byTime.forEach((fns, t) => {
      if (t <= 0) { fns.forEach(f => f()); return; }
      ctx.suspend(t).then(() => { fns.forEach(f => f()); ctx.resume(); }).catch(() => {});
    });
  }

  // ---------------------------------------------------------------------------
  // time edits (tempo map + arranger)
  // ---------------------------------------------------------------------------
  function remapTrack(track, map) {
    (track.automation?.lanes || []).forEach(l => l.points.forEach(pt => { pt.t = Math.max(0, map(pt.t)); }));
  }
  function shiftTrack(track, at, delta, cutStart, cutEnd) {
    (track.automation?.lanes || []).forEach(l => {
      if (cutStart != null) l.points = l.points.filter(pt => !(pt.t >= cutStart && pt.t < cutEnd));
      l.points.forEach(pt => { if (pt.t >= at - 1e-6) pt.t += delta; });
    });
  }
  function copyRange(track, start, end, offset) {
    (track.automation?.lanes || []).forEach(l => {
      const seg = l.points.filter(pt => pt.t >= start && pt.t < end).map(pt => ({ t: pt.t + offset, v: pt.v }));
      l.points = l.points.filter(pt => !(pt.t >= start + offset && pt.t < end + offset)).concat(seg).sort((a, b) => a.t - b.t);
    });
  }

  // ---------------------------------------------------------------------------
  // lanes UI (rows under each track in the sequencer)
  // ---------------------------------------------------------------------------
  function appendLanes(grid, track, ti, { pxPerSec, laneWidthPx }) {
    const a = track.automation;
    if (!a?.show) return;
    const lanes = a.lanes.length ? a.lanes : [];
    const params = paramsFor(track);
    const rows = lanes.length ? lanes : [null];
    rows.forEach((lane, li) => {
      const row = document.createElement("div");
      row.className = "seq-track-row seq-extra-row auto-row";
      row.dataset.trackIndex = ti;
      const p = lane ? paramById(track, lane.param) : null;
      const used = new Set(lanes.map(l => l.param));
      const options = params.map(x => `<option value="${escapeHtml(x.id)}" ${x.id === lane?.param ? "selected" : ""} ${used.has(x.id) && x.id !== lane?.param ? "disabled" : ""}>${escapeHtml(x.label)}</option>`).join("");
      row.innerHTML = `
        <div class="seq-row-label auto-label" style="border-left:4px solid ${track.color || "#888"}">
          <div class="auto-top">
            ${li === 0 ? `<select class="auto-mode" title="Automation mode for ${escapeHtml(track.name)}">${MODES.map(m => `<option value="${m}" ${m === a.mode ? "selected" : ""}>${m[0].toUpperCase() + m.slice(1)}</option>`).join("")}</select>` : ""}
            <button type="button" class="auto-add" title="Add a lane">+</button>
            ${lane ? `<button type="button" class="auto-del" title="Delete this lane">×</button>` : ""}
          </div>
          <select class="auto-param">${lane ? "" : `<option value="">Choose parameter…</option>`}${options}</select>
        </div>
        <div class="seq-row-lane auto-lane"></div>`;
      const laneEl = row.querySelector(".auto-lane");
      laneEl.style.width = laneWidthPx + "px";
      row.querySelector(".auto-mode")?.addEventListener("change", (e) => { pushHistory(); a.mode = e.target.value; lastApplied.clear(); window.WAWMixer?.syncEngine?.(); window.WAWCollab?.notifyChange?.(); });
      row.querySelector(".auto-add").addEventListener("click", (e) => {
        e.stopPropagation();
        const free = params.find(x => !used.has(x.id));
        if (!free) return;
        pushHistory(); a.lanes.push({ id: uid(), param: free.id, points: [] }); renderSequencer();
      });
      row.querySelector(".auto-del")?.addEventListener("click", (e) => {
        e.stopPropagation();
        pushHistory(); a.lanes = a.lanes.filter(l => l !== lane); lastApplied.clear(); window.WAWMixer?.syncEngine?.(); renderSequencer(); window.WAWCollab?.notifyChange?.();
      });
      row.querySelector(".auto-param").addEventListener("change", (e) => {
        const id = e.target.value;
        if (!id) return;
        pushHistory();
        if (lane) { lane.param = id; lane.points = []; } else a.lanes.push({ id: uid(), param: id, points: [] });
        lastApplied.clear(); window.WAWMixer?.syncEngine?.();
        renderSequencer(); window.WAWCollab?.notifyChange?.();
      });
      row.querySelectorAll("select, button").forEach(el => el.addEventListener("pointerdown", ev => ev.stopPropagation()));
      if (lane && p) drawLane(laneEl, track, lane, p, pxPerSec, laneWidthPx);
      grid.appendChild(row);
    });
  }

  const SVGNS = "http://www.w3.org/2000/svg";
  function drawLane(laneEl, track, lane, p, pxPerSec, widthPx) {
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", "auto-svg");
    svg.setAttribute("width", widthPx); svg.setAttribute("height", LANE_H);
    const H = LANE_H - 8;
    const y = v => 4 + (1 - toNorm(p, v)) * H;
    const valFromY = py => fromNorm(p, 1 - (py - 4) / H);
    const color = track.color || "#60a5fa";
    const render = () => {
      svg.innerHTML = "";
      const pts = lane.points;
      const live = p.get(track);
      // static value line when the lane is empty
      if (!pts.length) {
        const l = document.createElementNS(SVGNS, "line");
        l.setAttribute("x1", 0); l.setAttribute("x2", widthPx); l.setAttribute("y1", y(live)); l.setAttribute("y2", y(live));
        l.setAttribute("class", "auto-static"); svg.appendChild(l);
      } else {
        const d = [`M0,${y(pts[0].v)}`].concat(pts.map(pt => `L${pt.t * pxPerSec},${y(pt.v)}`), [`L${widthPx},${y(pts[pts.length - 1].v)}`]).join(" ");
        const fill = document.createElementNS(SVGNS, "path");
        fill.setAttribute("d", d + ` L${widthPx},${LANE_H} L0,${LANE_H} Z`); fill.setAttribute("class", "auto-fill"); fill.style.fill = color;
        svg.appendChild(fill);
        const path = document.createElementNS(SVGNS, "path");
        path.setAttribute("d", d); path.setAttribute("class", "auto-line"); path.style.stroke = color;
        svg.appendChild(path);
        if (pts.length < 400) pts.forEach((pt, i) => {
          const c = document.createElementNS(SVGNS, "circle");
          c.setAttribute("cx", pt.t * pxPerSec); c.setAttribute("cy", y(pt.v)); c.setAttribute("r", 3.5);
          c.setAttribute("class", "auto-pt"); c.dataset.i = i;
          const tip = document.createElementNS(SVGNS, "title"); tip.textContent = `${p.label}: ${p.fmt ? p.fmt(pt.v) : pt.v.toFixed(2)} (drag; double-click = delete)`;
          c.appendChild(tip);
          svg.appendChild(c);
        });
      }
      const name = document.createElementNS(SVGNS, "text");
      name.setAttribute("x", 4 + (sequencerGrid?.scrollLeft || 0)); name.setAttribute("y", 11); name.setAttribute("class", "auto-name");
      name.textContent = `${p.label}${pts.length ? "" : " — click to add points"}`;
      svg.appendChild(name);
    };
    render();

    const localXY = (e) => { const r = svg.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    svg.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.stopPropagation(); e.preventDefault();
      const { x, y: py } = localXY(e);
      beginHistoryGesture();
      let idx = e.target.classList?.contains("auto-pt") ? Number(e.target.dataset.i) : -1;
      if (idx < 0) {
        // new point (snapped in time with Shift held off; free with Alt)
        let t = Math.max(0, x / pxPerSec);
        if (!e.altKey && typeof snapSec === "function") t = snapSec(t);
        const v = clamp(valFromY(py), p.min, p.max);
        lane.points.push({ t, v });
        lane.points.sort((a2, b2) => a2.t - b2.t);
        idx = lane.points.findIndex(pt => pt.t === t && pt.v === v);
        render();
      }
      const pt = lane.points[idx];
      const moved = { any: idx >= 0 && !e.target.classList?.contains("auto-pt") };
      try { svg.setPointerCapture(e.pointerId); } catch (_) {}
      const move = (ev) => {
        const q = localXY(ev);
        let t = Math.max(0, q.x / pxPerSec);
        if (!ev.altKey && typeof snapSec === "function") t = snapSec(t);
        // keep the order: a point cannot pass its neighbours
        const i = lane.points.indexOf(pt);
        const lo = i > 0 ? lane.points[i - 1].t : 0, hi = i < lane.points.length - 1 ? lane.points[i + 1].t : Infinity;
        pt.t = clamp(t, lo, hi);
        pt.v = clamp(valFromY(q.y), p.min, p.max);
        moved.any = true;
        render();
      };
      const up = () => {
        svg.removeEventListener("pointermove", move); svg.removeEventListener("pointerup", up); svg.removeEventListener("pointercancel", up);
        if (moved.any) { commitHistoryGesture(); lastApplied.clear(); window.WAWCollab?.notifyChange?.(); } else cancelHistoryGesture();
      };
      svg.addEventListener("pointermove", move); svg.addEventListener("pointerup", up); svg.addEventListener("pointercancel", up);
    });
    svg.addEventListener("dblclick", (e) => {
      if (!e.target.classList?.contains("auto-pt")) return;
      e.stopPropagation();
      pushHistory();
      lane.points.splice(Number(e.target.dataset.i), 1);
      lastApplied.clear();
      render();
      window.WAWCollab?.notifyChange?.();
    });
    svg.addEventListener("contextmenu", (e) => {
      e.preventDefault(); e.stopPropagation();
      window.WAWWorkspace?.popupMenu(e.clientX, e.clientY, [
        { label: "Clear lane", action: () => { pushHistory(); lane.points = []; lastApplied.clear(); window.WAWMixer?.syncEngine?.(); render(); window.WAWCollab?.notifyChange?.(); } },
        { label: "Set whole lane to current value", action: () => { pushHistory(); lane.points = [{ t: 0, v: p.get(track) }]; lastApplied.clear(); render(); window.WAWCollab?.notifyChange?.(); } },
        { label: "Thin out points", action: () => { pushHistory(); lane.points = simplify(lane.points, p); render(); } },
      ]);
    });
    laneEl.appendChild(svg);
  }

  function toggleShow(track) {
    const a = auto(track);
    a.show = !a.show;
    if (a.show && !a.lanes.length) a.lanes.push({ id: uid(), param: "volume", points: [] });
    renderSequencer();
  }

  window.WAWAutomation = {
    MODES, normalize: auto, paramsFor, valueAt, tick, onStop, applyOffline,
    remapTrack, shiftTrack, copyRange, appendLanes, toggleShow,
    remapGlobal: () => {}, serializeGlobal: () => undefined, restoreGlobal: () => {}
  };
})();
