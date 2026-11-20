// WAW mixing engine + SSL-style console UI.
//
// Signal flow per channel (realtime AND offline/WAV export use the same graph):
//   input -> trim/phase -> [EQ: HPF, LPF, LF, LMF, HMF, HF] <-> [DYN: gate, comp, make-up]
//         -> insert FX chain -> mono -> pan -> fader -> mute -> meter -> master
//                                  `-> pre-fader sends      `-> post-fader sends -> aux buses A-D
//   aux bus: input -> insert chain -> pan -> fader -> mute -> master
//   master:  input -> insert chain -> fader -> mono -> meter -> destination
//
// Depends on globals from app.js (tracks, activeTrackIndex, setActiveTrack, ...) and js/fx.js.
(function () {
  "use strict";
  const FX = window.WAWFX;
  const dbToGain = db => Math.pow(10, db / 20);
  const gainToDb = g => (g <= 0.000001 ? -Infinity : 20 * Math.log10(g));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const SEND_KEYS = ["A", "B", "C", "D"];

  // ---------------------------------------------------------------------------
  // Data model defaults
  // ---------------------------------------------------------------------------
  function defaultStrip() {
    return {
      trim: 0, phase: false,
      hpfOn: false, hpf: 80, lpfOn: false, lpf: 12000,
      eqOn: true,
      hfGain: 0, hfFreq: 10000, hfBell: false,
      hmfGain: 0, hmfFreq: 3000, hmfQ: 1,
      lmfGain: 0, lmfFreq: 600, lmfQ: 1,
      lfGain: 0, lfFreq: 100, lfBell: false,
      dynOn: false, compThresh: -18, compRatio: 4, compAttack: 10, compRelease: 150, compMakeup: 0,
      gateOn: false, gateThresh: -50, gateRange: -40,
      dynPreEq: false
    };
  }

  function defaultBuses() {
    return [
      { id: "busA", key: "A", name: "Reverb", volume: 1, pan: 0, mute: false, inserts: [FX.newFx("reverb", { mix: 1, size: 2.4 })] },
      { id: "busB", key: "B", name: "Delay", volume: 1, pan: 0, mute: false, inserts: [FX.newFx("delay", { mix: 1 })] },
      { id: "busC", key: "C", name: "Plate", volume: 1, pan: 0, mute: false, inserts: [FX.newFx("reverb", { mix: 1, size: 1.1, damping: 0.2, preDelay: 0 })] },
      { id: "busD", key: "D", name: "Chorus", volume: 1, pan: 0, mute: false, inserts: [FX.newFx("chorus", { mix: 1, depth: 0.7 })] },
    ];
  }

  let mixerState = {
    buses: defaultBuses(),
    master: { volume: 1, mono: false, inserts: [] }
  };

  function normalizeMixerState(state) {
    const s = state && typeof state === "object" ? state : {};
    const defaults = defaultBuses();
    const buses = SEND_KEYS.map((key, i) => {
      const b = (s.buses || []).find(x => x.key === key) || defaults[i];
      return {
        ...defaults[i], ...b,
        inserts: Array.isArray(b.inserts) ? b.inserts : defaults[i].inserts
      };
    });
    return {
      buses,
      master: { volume: 1, mono: false, inserts: [], ...(s.master || {}), inserts: Array.isArray(s.master?.inserts) ? s.master.inserts : [] }
    };
  }

  function normalizeTrackMix(track) {
    track.strip = { ...defaultStrip(), ...(track.strip || {}) };
    track.inserts = Array.isArray(track.inserts) ? track.inserts : [];
    const sends = track.sends && typeof track.sends === "object" ? track.sends : {};
    // migrate legacy mixer knobs (sendA/sendB, eqHigh/eqMid/eqLow in -1..1)
    if (sends.A == null && typeof track.sendA === "number") sends.A = track.sendA;
    if (sends.B == null && typeof track.sendB === "number") sends.B = track.sendB;
    if (typeof track.eqHigh === "number" && track.eqHigh !== 0 && !track.strip.hfGain) track.strip.hfGain = track.eqHigh * 12;
    if (typeof track.eqMid === "number" && track.eqMid !== 0 && !track.strip.hmfGain) track.strip.hmfGain = track.eqMid * 12;
    if (typeof track.eqLow === "number" && track.eqLow !== 0 && !track.strip.lfGain) track.strip.lfGain = track.eqLow * 12;
    delete track.sendA; delete track.sendB; delete track.eqHigh; delete track.eqMid; delete track.eqLow;
    if (track.stereo === false) track.mono = true;
    delete track.stereo;
    track.sends = {};
    SEND_KEYS.forEach(k => { track.sends[k] = Number.isFinite(sends[k]) ? sends[k] : 0; });
    track.sendPre = { ...(track.sendPre || {}) };
    if (!Number.isFinite(track.volume)) track.volume = 1;
    return track;
  }

  // ---------------------------------------------------------------------------
  // Insert chain (shared by channels, buses and master)
  // ---------------------------------------------------------------------------
  class InsertChain {
    constructor(ctx) {
      this.ctx = ctx;
      this.input = ctx.createGain();
      this.output = ctx.createGain();
      this.items = []; // { fx (data), inst }
      this.input.connect(this.output);
      this.signature = "";
    }

    sync(fxList = []) {
      const sig = fxList.map(f => f.id + ":" + f.type + ":" + (f.bypass ? 1 : 0)).join("|");
      if (sig !== this.signature) {
        this.rebuild(fxList);
        this.signature = sig;
      } else {
        // params only
        fxList.forEach((f, i) => {
          const it = this.items[i];
          if (it?.inst && !f.bypass) it.inst.set({ ...FX.defaultParams(f.type), ...f.params });
        });
      }
    }

    rebuild(fxList) {
      try { this.input.disconnect(); } catch (e) {}
      this.items.forEach(it => { try { it.inst?.output.disconnect(); } catch (e) {} try { it.inst?.dispose(); } catch (e) {} });
      this.items = [];
      let node = this.input;
      fxList.forEach(f => {
        if (f.bypass) { this.items.push({ fx: f, inst: null }); return; }
        const inst = FX.createInstance(this.ctx, f);
        if (!inst) { this.items.push({ fx: f, inst: null }); return; }
        node.connect(inst.input);
        node = inst.output;
        this.items.push({ fx: f, inst });
      });
      node.connect(this.output);
    }

    reduction() {
      let r = 0;
      this.items.forEach(it => { const v = it.inst?.meter?.(); if (Number.isFinite(v)) r = Math.min(r, v); });
      return r;
    }

    dispose() {
      this.items.forEach(it => { try { it.inst?.dispose(); } catch (e) {} });
      try { this.input.disconnect(); this.output.disconnect(); } catch (e) {}
    }
  }

  // ---------------------------------------------------------------------------
  // Meter tap (stereo peak/RMS)
  // ---------------------------------------------------------------------------
  function createMeter(ctx, source, realtime) {
    if (!realtime) return null;
    const split = ctx.createChannelSplitter(2);
    const aL = ctx.createAnalyser(), aR = ctx.createAnalyser();
    aL.fftSize = 1024; aR.fftSize = 1024;
    source.connect(split); split.connect(aL, 0); split.connect(aR, 1);
    const buf = new Float32Array(1024);
    const read = (a) => {
      a.getFloatTimeDomainData(buf);
      let peak = 0, sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = buf[i]; const av = v < 0 ? -v : v; if (av > peak) peak = av; sum += v * v; }
      return { peak, rms: Math.sqrt(sum / buf.length) };
    };
    return { read: () => [read(aL), read(aR)], nodes: [split, aL, aR] };
  }

  // ---------------------------------------------------------------------------
  // Channel strip
  // ---------------------------------------------------------------------------
  class ChannelStrip {
    constructor(graph, track) {
      const ctx = graph.ctx;
      this.graph = graph;
      this.ctx = ctx;
      this.trackId = track.id;
      this.input = ctx.createGain();
      this.trim = ctx.createGain();
      // EQ section
      this.hpf = ctx.createBiquadFilter(); this.hpf.type = "highpass"; this.hpf.Q.value = 0.707;
      this.lpf = ctx.createBiquadFilter(); this.lpf.type = "lowpass"; this.lpf.Q.value = 0.707;
      this.lf = ctx.createBiquadFilter();
      this.lmf = ctx.createBiquadFilter(); this.lmf.type = "peaking";
      this.hmf = ctx.createBiquadFilter(); this.hmf.type = "peaking";
      this.hf = ctx.createBiquadFilter();
      this.eqIn = ctx.createGain(); this.eqOut = ctx.createGain();
      this.eqIn.connect(this.hpf); this.hpf.connect(this.lpf); this.lpf.connect(this.lf);
      this.lf.connect(this.lmf); this.lmf.connect(this.hmf); this.hmf.connect(this.hf); this.hf.connect(this.eqOut);
      // Dynamics section
      this.dynIn = ctx.createGain(); this.dynOut = ctx.createGain();
      this.gate = FX.makeWorklet(ctx, "waw-gate", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      this.comp = ctx.createDynamicsCompressor();
      this.makeup = ctx.createGain();
      this.dynBypass = ctx.createGain();
      this.dynWet = ctx.createGain();
      if (this.gate) { this.dynIn.connect(this.gate); this.gate.connect(this.comp); }
      else this.dynIn.connect(this.comp);
      this.comp.connect(this.makeup); this.makeup.connect(this.dynWet); this.dynWet.connect(this.dynOut);
      this.dynIn.connect(this.dynBypass); this.dynBypass.connect(this.dynOut);
      // inserts + output section
      this.inserts = new InsertChain(ctx);
      this.mono = ctx.createGain(); this.mono.channelCountMode = "explicit"; this.mono.channelCount = 2;
      this.panner = ctx.createStereoPanner();
      this.fader = ctx.createGain();
      this.muteGain = ctx.createGain();
      this.out = ctx.createGain();
      this.input.connect(this.trim);
      this.inserts.output.connect(this.mono);
      this.mono.connect(this.panner); this.panner.connect(this.fader); this.fader.connect(this.muteGain); this.muteGain.connect(this.out);
      this.out.connect(graph.master.input);
      this.sends = {};
      SEND_KEYS.forEach(k => {
        const g = ctx.createGain(); g.gain.value = 0;
        g.connect(graph.buses[k].input);
        this.sends[k] = { gain: g, pre: null };
      });
      this.meter = createMeter(ctx, this.out, graph.realtime);
      this.order = null;
      this.update(track);
    }

    wireOrder(dynPreEq) {
      if (this.order === dynPreEq) return;
      this.order = dynPreEq;
      [this.trim, this.eqOut, this.dynOut].forEach(n => { try { n.disconnect(); } catch (e) {} });
      if (dynPreEq) { this.trim.connect(this.dynIn); this.dynOut.connect(this.eqIn); this.eqOut.connect(this.inserts.input); }
      else { this.trim.connect(this.eqIn); this.eqOut.connect(this.dynIn); this.dynOut.connect(this.inserts.input); }
    }

    update(track, audible = true) {
      const ctx = this.ctx;
      const s = track.strip || defaultStrip();
      const set = (param, v, t = 0.015) => { try { param.setTargetAtTime(v, ctx.currentTime, t); } catch (e) { param.value = v; } };
      const nyq = ctx.sampleRate / 2 - 100;
      this.wireOrder(!!s.dynPreEq);
      set(this.trim.gain, dbToGain(s.trim) * (s.phase ? -1 : 1), 0.005);
      set(this.hpf.frequency, s.hpfOn ? s.hpf : 10);
      set(this.lpf.frequency, s.lpfOn ? Math.min(s.lpf, nyq) : nyq);
      const eq = s.eqOn ? 1 : 0;
      this.lf.type = s.lfBell ? "peaking" : "lowshelf";
      this.hf.type = s.hfBell ? "peaking" : "highshelf";
      set(this.lf.frequency, s.lfFreq); set(this.lf.gain, s.lfGain * eq);
      set(this.lmf.frequency, s.lmfFreq); set(this.lmf.gain, s.lmfGain * eq); set(this.lmf.Q, s.lmfQ);
      set(this.hmf.frequency, s.hmfFreq); set(this.hmf.gain, s.hmfGain * eq); set(this.hmf.Q, s.hmfQ);
      set(this.hf.frequency, Math.min(s.hfFreq, nyq)); set(this.hf.gain, s.hfGain * eq);
      // dynamics
      const dynOn = !!(s.dynOn || s.gateOn);
      set(this.dynWet.gain, dynOn ? 1 : 0, 0.005);
      set(this.dynBypass.gain, dynOn ? 0 : 1, 0.005);
      set(this.comp.threshold, s.dynOn ? s.compThresh : 0);
      set(this.comp.ratio, s.dynOn ? s.compRatio : 1);
      set(this.comp.attack, clamp(s.compAttack / 1000, 0.0001, 1));
      set(this.comp.release, clamp(s.compRelease / 1000, 0.01, 1));
      set(this.makeup.gain, s.dynOn ? dbToGain(s.compMakeup) : 1);
      if (this.gate) {
        const P = n => this.gate.parameters.get(n);
        set(P("threshold"), s.gateOn ? s.gateThresh : -90);
        set(P("range"), s.gateOn ? s.gateRange : 0);
      }
      // inserts
      this.inserts.sync(track.inserts || []);
      // output
      this.mono.channelCount = track.mono ? 1 : 2;
      set(this.panner.pan, clamp(track.pan ?? 0, -1, 1));
      set(this.fader.gain, track.volume ?? 1);
      set(this.muteGain.gain, audible ? 1 : 0, 0.008);
      SEND_KEYS.forEach(k => {
        const send = this.sends[k];
        const pre = !!track.sendPre?.[k];
        if (send.pre !== pre) {
          send.pre = pre;
          try { this.mono.disconnect(send.gain); } catch (e) {}
          try { this.out.disconnect(send.gain); } catch (e) {}
          // pre-fader taps before pan/fader/mute; post-fader after
          (pre ? this.mono : this.out).connect(send.gain);
        }
        set(send.gain.gain, track.sends?.[k] ?? 0);
      });
    }

    reduction() {
      const own = this.order !== null ? (this.comp.reduction || 0) : 0;
      return Math.min(own, this.inserts.reduction());
    }

    dispose() {
      try { this.out.disconnect(); } catch (e) {}
      SEND_KEYS.forEach(k => { try { this.sends[k].gain.disconnect(); } catch (e) {} });
      this.inserts.dispose();
      try { this.input.disconnect(); } catch (e) {}
    }
  }

  // ---------------------------------------------------------------------------
  // Bus + master
  // ---------------------------------------------------------------------------
  class BusStrip {
    constructor(graph, bus) {
      const ctx = graph.ctx;
      this.ctx = ctx;
      this.input = ctx.createGain();
      this.inserts = new InsertChain(ctx);
      this.panner = ctx.createStereoPanner();
      this.fader = ctx.createGain();
      this.muteGain = ctx.createGain();
      this.input.connect(this.inserts.input);
      this.inserts.output.connect(this.panner);
      this.panner.connect(this.fader); this.fader.connect(this.muteGain);
      this.muteGain.connect(graph.master.input);
      this.meter = createMeter(ctx, this.muteGain, graph.realtime);
      this.update(bus);
    }
    update(bus) {
      const t = this.ctx.currentTime;
      this.inserts.sync(bus.inserts || []);
      this.panner.pan.setTargetAtTime(clamp(bus.pan ?? 0, -1, 1), t, 0.015);
      this.fader.gain.setTargetAtTime(bus.volume ?? 1, t, 0.015);
      this.muteGain.gain.setTargetAtTime(bus.mute ? 0 : 1, t, 0.008);
    }
    reduction() { return this.inserts.reduction(); }
  }

  class MasterStrip {
    constructor(graph) {
      const ctx = graph.ctx;
      this.ctx = ctx;
      this.input = ctx.createGain();
      this.inserts = new InsertChain(ctx);
      this.fader = ctx.createGain();
      this.mono = ctx.createGain(); this.mono.channelCountMode = "explicit"; this.mono.channelCount = 2;
      this.out = ctx.createGain();
      this.input.connect(this.inserts.input);
      this.inserts.output.connect(this.fader);
      this.fader.connect(this.mono); this.mono.connect(this.out);
      this.out.connect(graph.destination);
      this.meter = createMeter(ctx, this.out, graph.realtime);
    }
    update(master) {
      this.inserts.sync(master.inserts || []);
      this.fader.gain.setTargetAtTime(master.volume ?? 1, this.ctx.currentTime, 0.015);
      this.mono.channelCount = master.mono ? 1 : 2;
    }
    reduction() { return this.inserts.reduction(); }
  }

  class MixGraph {
    constructor(ctx, { realtime = true, destination = null } = {}) {
      this.ctx = ctx;
      this.realtime = realtime;
      this.destination = destination || ctx.destination;
      this.master = new MasterStrip(this);
      this.buses = {};
      mixerState.buses.forEach(b => { this.buses[b.key] = new BusStrip(this, b); });
      this.channels = new Map();
      this.master.update(mixerState.master);
    }

    channelFor(track) {
      if (!track) return null;
      let ch = this.channels.get(track.id);
      if (!ch) {
        normalizeTrackMix(track);
        ch = new ChannelStrip(this, track);
        this.channels.set(track.id, ch);
        ch.update(track, isAudible(track));
      }
      return ch;
    }

    inputFor(trackId) {
      const track = tracks.find(t => t.id === trackId);
      return track ? this.channelFor(track).input : this.master.input;
    }

    syncAll() {
      const list = tracks;
      const ids = new Set(list.map(t => t.id));
      this.channels.forEach((ch, id) => { if (!ids.has(id)) { ch.dispose(); this.channels.delete(id); } });
      list.forEach(t => this.channelFor(t).update(t, isAudible(t)));
      mixerState.buses.forEach(b => this.buses[b.key]?.update(b));
      this.master.update(mixerState.master);
    }

    updateTrack(track) {
      this.channelFor(track)?.update(track, isAudible(track));
    }

    dispose() {
      this.channels.forEach(ch => ch.dispose());
      this.channels.clear();
      try { this.master.out.disconnect(); } catch (e) {}
    }
  }

  function isAudible(track) {
    if (!track || track.mute) return false;
    const anySolo = tracks.some(t => t.solo);
    return !anySolo || !!track.solo;
  }

  // ---------------------------------------------------------------------------
  // Realtime engine (lazy; bound to the app's AudioContext)
  // ---------------------------------------------------------------------------
  let rtGraph = null;
  let rtCtx = null;

  function getRealtimeGraph() {
    const ctx = typeof ensureAudioContext === "function" ? ensureAudioContext() : null;
    if (!ctx) return null;
    if (!rtGraph || rtCtx !== ctx) {
      rtCtx = ctx;
      rtGraph = new MixGraph(ctx, { realtime: true });
      // worklets load async; rebuild once they're available so gates/bitcrushers work
      if (!ctx.__wawWorklets) {
        FX.ensureWorklets(ctx).then(ok => {
          if (ok && rtCtx === ctx) { replaceRealtimeGraph(ctx); renderMixerIfVisible(); }
        });
      }
      rtGraph.syncAll();
    }
    return rtGraph;
  }

  function replaceRealtimeGraph(ctx) {
    const old = rtGraph;
    rtGraph = new MixGraph(ctx, { realtime: true });
    rtGraph.syncAll();
    old?.dispose();
  }

  function getTrackInput(trackOrId) {
    const g = getRealtimeGraph();
    if (!g) return null;
    const id = typeof trackOrId === "string" ? trackOrId : trackOrId?.id;
    return g.inputFor(id);
  }

  function syncEngine() { if (rtGraph) rtGraph.syncAll(); }
  function updateTrackEngine(track) { if (rtGraph) { rtGraph.updateTrack(track); } }

  async function createOfflineGraph(ctx) {
    await FX.ensureWorklets(ctx);
    const g = new MixGraph(ctx, { realtime: false });
    g.syncAll();
    return g;
  }

  // ---------------------------------------------------------------------------
  // UI widgets: knob + fader
  // ---------------------------------------------------------------------------
  function toNorm(v, min, max, log) {
    if (log) return Math.log(v / min) / Math.log(max / min);
    return (v - min) / (max - min);
  }
  function fromNorm(n, min, max, log) {
    n = clamp(n, 0, 1);
    if (log) return min * Math.pow(max / min, n);
    return min + n * (max - min);
  }
  function roundStep(v, step) { return step ? Math.round(v / step) * step : v; }

  let activeKnobGesture = false;
  function createKnob(opts) {
    const { label, min, max, step = 0.01, log = false, color = "", size = "", format = v => v.toFixed(2), onChange, title = "" } = opts;
    let value = opts.value;
    const def = opts.default ?? value;
    const wrap = document.createElement("div");
    wrap.className = "wk-wrap" + (size ? " wk-" + size : "");
    wrap.innerHTML = `<div class="wk ${color}" tabindex="0" role="slider" aria-label="${escapeHtml(label)}"><span class="wk-ind"></span></div><span class="wk-label">${escapeHtml(label)}</span>`;
    const knob = wrap.querySelector(".wk");
    const render = () => {
      const n = toNorm(value, min, max, log);
      knob.style.setProperty("--rot", (-135 + n * 270) + "deg");
      knob.title = `${title || label}: ${format(value)}  (drag, wheel, double-click = reset)`;
      knob.setAttribute("aria-valuetext", format(value));
    };
    const setValue = (v, fire = true) => {
      v = clamp(roundStep(v, step), min, max);
      if (v === value) return;
      value = v; render();
      if (fire) onChange?.(v);
      showValueTip(knob, `${label} ${format(v)}`);
    };
    knob.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      try { knob.setPointerCapture(e.pointerId); } catch (_) {}
      const startY = e.clientY;
      const startN = toNorm(value, min, max, log);
      beginHistoryGesture?.();
      activeKnobGesture = true;
      let changed = false;
      const move = (ev) => {
        const sens = ev.shiftKey ? 0.0015 : 0.006;
        const before = value;
        setValue(fromNorm(startN + (startY - ev.clientY) * sens, min, max, log));
        if (value !== before) changed = true;
      };
      const up = () => {
        knob.removeEventListener("pointermove", move);
        knob.removeEventListener("pointerup", up);
        knob.removeEventListener("pointercancel", up);
        activeKnobGesture = false;
        if (changed) { commitHistoryGesture?.(); onCommit(); } else cancelHistoryGesture?.();
        hideValueTip();
      };
      knob.addEventListener("pointermove", move);
      knob.addEventListener("pointerup", up);
      knob.addEventListener("pointercancel", up);
    });
    knob.addEventListener("dblclick", (e) => { e.stopPropagation(); pushHistory(); setValue(def); onCommit(); });
    knob.addEventListener("wheel", (e) => {
      e.preventDefault(); e.stopPropagation();
      const n = toNorm(value, min, max, log) + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.005 : 0.025);
      setValue(fromNorm(n, min, max, log));
      scheduleWheelCommit();
    }, { passive: false });
    knob.addEventListener("keydown", (e) => {
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
      e.preventDefault(); e.stopPropagation();
      const dir = e.key === "ArrowUp" || e.key === "ArrowRight" ? 1 : -1;
      setValue(fromNorm(toNorm(value, min, max, log) + dir * 0.02, min, max, log));
    });
    render();
    wrap.setValue = (v) => { value = v; render(); };
    return wrap;
  }

  // wheel edits: coalesce into one undo step + one collab broadcast
  let wheelTimer = null;
  function scheduleWheelCommit() {
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => onCommit(), 400);
  }
  function onCommit() {
    window.WAWCollab?.notifyChange?.();
  }

  let tipEl = null;
  function showValueTip(anchor, text) {
    if (!tipEl) { tipEl = document.createElement("div"); tipEl.className = "wk-tip"; document.body.appendChild(tipEl); }
    const r = anchor.getBoundingClientRect();
    tipEl.textContent = text;
    tipEl.style.left = (r.left + r.width / 2) + "px";
    tipEl.style.top = (r.top - 6) + "px";
    tipEl.classList.add("show");
    clearTimeout(tipEl._t);
    tipEl._t = setTimeout(hideValueTip, 900);
  }
  function hideValueTip() { tipEl?.classList.remove("show"); }

  // Fader law: position (0..1) <-> dB, SSL-ish (0 dB at 75 %, +12 dB top)
  const FADER_POINTS = [[0, -Infinity], [0.04, -70], [0.12, -50], [0.25, -30], [0.4, -18], [0.55, -10], [0.65, -5], [0.75, 0], [0.87, 6], [1, 12]];
  function faderPosToDb(p) {
    p = clamp(p, 0, 1);
    for (let i = 1; i < FADER_POINTS.length; i++) {
      const [p1, d1] = FADER_POINTS[i];
      const [p0, d0] = FADER_POINTS[i - 1];
      if (p <= p1) {
        if (!Number.isFinite(d0)) return p <= 0.005 ? -Infinity : -70 - (1 - (p - p0) / (p1 - p0)) * 30;
        return d0 + ((p - p0) / (p1 - p0)) * (d1 - d0);
      }
    }
    return 12;
  }
  function faderDbToPos(db) {
    if (!Number.isFinite(db) || db <= -100) return 0;
    for (let i = 1; i < FADER_POINTS.length; i++) {
      const [p1, d1] = FADER_POINTS[i];
      const [p0, d0] = FADER_POINTS[i - 1];
      if (db <= d1) {
        if (!Number.isFinite(d0)) return clamp(p0 + (1 - (-70 - db) / 30) * (p1 - p0), 0, p1);
        return p0 + ((db - d0) / (d1 - d0)) * (p1 - p0);
      }
    }
    return 1;
  }
  function fmtDb(db) {
    if (!Number.isFinite(db)) return "-∞";
    return (db > 0 ? "+" : "") + db.toFixed(1);
  }

  function createFader(opts) {
    const { value, onChange, label = "Fader" } = opts; // value = linear gain
    let gain = value;
    const el = document.createElement("div");
    el.className = "wf";
    el.innerHTML = `
      <div class="wf-scale">${["+12", "+6", "0", "-5", "-10", "-18", "-30", "-50", "-∞"].map(t => `<span>${t}</span>`).join("")}</div>
      <div class="wf-track" tabindex="0" role="slider" aria-label="${escapeHtml(label)}"><div class="wf-cap"></div></div>`;
    const track = el.querySelector(".wf-track");
    const cap = el.querySelector(".wf-cap");
    const render = () => {
      const pos = faderDbToPos(gainToDb(gain));
      cap.style.bottom = `calc(${pos * 100}% - ${pos * 22}px)`;
      track.title = `${label}: ${fmtDb(gainToDb(gain))} dB (double-click = 0 dB)`;
    };
    const setPos = (pos) => {
      const db = faderPosToDb(pos);
      gain = Number.isFinite(db) ? dbToGain(db) : 0;
      render();
      onChange?.(gain);
    };
    const posFromEvent = (e) => {
      const r = track.getBoundingClientRect();
      return 1 - (e.clientY - r.top - 11) / Math.max(1, r.height - 22);
    };
    track.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      try { track.setPointerCapture(e.pointerId); } catch (_) {}
      beginHistoryGesture?.();
      const onCap = e.target === cap;
      const startY = e.clientY;
      const startPos = faderDbToPos(gainToDb(gain));
      if (!onCap) setPos(posFromEvent(e));
      const move = (ev) => {
        if (onCap) {
          const r = track.getBoundingClientRect();
          const sens = ev.shiftKey ? 0.25 : 1;
          setPos(startPos + ((startY - ev.clientY) / Math.max(1, r.height - 22)) * sens);
        } else setPos(posFromEvent(ev));
        showValueTip(cap, `${fmtDb(gainToDb(gain))} dB`);
      };
      const up = () => {
        track.removeEventListener("pointermove", move);
        track.removeEventListener("pointerup", up);
        track.removeEventListener("pointercancel", up);
        commitHistoryGesture?.();
        onCommit();
        hideValueTip();
      };
      track.addEventListener("pointermove", move);
      track.addEventListener("pointerup", up);
      track.addEventListener("pointercancel", up);
    });
    track.addEventListener("dblclick", () => { pushHistory(); gain = 1; render(); onChange?.(1); onCommit(); });
    track.addEventListener("wheel", (e) => {
      e.preventDefault();
      const pos = faderDbToPos(gainToDb(gain)) + (e.deltaY < 0 ? 0.01 : -0.01) * (e.shiftKey ? 0.3 : 1);
      setPos(pos);
      scheduleWheelCommit();
    }, { passive: false });
    track.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      setPos(faderDbToPos(gainToDb(gain)) + (e.key === "ArrowUp" ? 0.01 : -0.01));
    });
    render();
    el.setValue = (g) => { gain = g; render(); };
    return el;
  }

  function createMeterEl(withGr = false) {
    const el = document.createElement("div");
    el.className = "wm";
    el.innerHTML = `
      <div class="wm-clip" title="Clip — click to reset"></div>
      <div class="wm-bars"><div class="wm-bar"><i></i><b></b></div><div class="wm-bar"><i></i><b></b></div>${withGr ? `<div class="wm-gr" title="Gain reduction"><i></i></div>` : ""}</div>`;
    el.querySelector(".wm-clip").addEventListener("click", (e) => { e.stopPropagation(); e.currentTarget.classList.remove("on"); });
    el._peaks = [{ hold: 0, holdT: 0, level: 0 }, { hold: 0, holdT: 0, level: 0 }];
    return el;
  }

  // dBFS -> 0..1 meter height (range -60..+6)
  const meterNorm = db => clamp((db + 60) / 66, 0, 1);

  function paintMeter(el, readings, gr = 0) {
    if (!el || !readings) return;
    const now = performance.now();
    const bars = el.querySelectorAll(".wm-bar");
    readings.forEach((r, i) => {
      const st = el._peaks[i];
      const db = gainToDb(r.peak);
      const target = meterNorm(db);
      // fast attack, ~20 dB/s fall
      st.level = target > st.level ? target : Math.max(target, st.level - 0.012);
      if (target >= st.hold || now - st.holdT > 1500) { st.hold = target; st.holdT = now; }
      const bar = bars[i];
      if (!bar) return;
      bar.querySelector("i").style.transform = `scaleY(${st.level})`;
      bar.querySelector("b").style.bottom = (st.hold * 100) + "%";
      if (r.peak >= 0.999) el.querySelector(".wm-clip").classList.add("on");
    });
    const grEl = el.querySelector(".wm-gr i");
    if (grEl) grEl.style.transform = `scaleY(${clamp(-gr / 24, 0, 1)})`;
  }

  // ---------------------------------------------------------------------------
  // Console rendering
  // ---------------------------------------------------------------------------
  const strip = {}; // DOM refs per channel id for metering
  let meterRaf = null;

  const fmtHz = v => v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + "k" : Math.round(v) + "";
  const fmtDbK = v => (v > 0 ? "+" : "") + v.toFixed(1) + " dB";

  function btn(label, active, cls, title, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "wbtn " + (cls || "") + (active ? " on" : "");
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener("click", (e) => { e.stopPropagation(); onClick?.(b); });
    return b;
  }

  function section(title, cls = "") {
    const s = document.createElement("div");
    s.className = "ws-sec " + cls;
    if (title) s.innerHTML = `<div class="ws-sec-title">${escapeHtml(title)}</div>`;
    return s;
  }

  function row(...children) {
    const r = document.createElement("div");
    r.className = "ws-row";
    children.forEach(c => c && r.appendChild(c));
    return r;
  }

  function commitTrack(track) {
    updateTrackEngine(track);
  }

  function stripKnob(track, key, label, min, max, opts = {}) {
    return createKnob({
      label, min, max, step: opts.step ?? 0.1, log: !!opts.log, color: opts.color || "",
      value: track.strip[key], default: defaultStrip()[key], format: opts.format || (v => v.toFixed(1)),
      onChange: v => { track.strip[key] = v; commitTrack(track); }
    });
  }

  function stripToggle(track, key, label, cls, title, after) {
    return btn(label, !!track.strip[key], cls, title, (b) => {
      pushHistory();
      track.strip[key] = !track.strip[key];
      b.classList.toggle("on", track.strip[key]);
      commitTrack(track);
      after?.();
      onCommit();
    });
  }

  function renderInsertSection(owner, fxList, onChanged, titleText) {
    const sec = section("Inserts", "ws-inserts");
    const list = document.createElement("div");
    list.className = "ws-insert-list";
    fxList.forEach((fx, idx) => {
      const def = FX.FX_TYPES[fx.type];
      const item = document.createElement("div");
      item.className = "ws-insert" + (fx.bypass ? " bypassed" : "");
      item.innerHTML = `<button type="button" class="ws-ins-pwr" title="Bypass">⏻</button><button type="button" class="ws-ins-name" title="Edit ${escapeHtml(def?.name || fx.type)}">${escapeHtml(def?.name || fx.type)}</button><button type="button" class="ws-ins-x" title="Remove">×</button>`;
      item.querySelector(".ws-ins-pwr").addEventListener("click", (e) => { e.stopPropagation(); pushHistory(); fx.bypass = !fx.bypass; onChanged(); window.renderMixer(); onCommit(); });
      item.querySelector(".ws-ins-name").addEventListener("click", (e) => { e.stopPropagation(); openFxEditor(owner, fxList, idx, onChanged, titleText); });
      item.querySelector(".ws-ins-x").addEventListener("click", (e) => { e.stopPropagation(); pushHistory(); fxList.splice(idx, 1); onChanged(); window.renderMixer(); onCommit(); });
      // drag to reorder
      item.draggable = true;
      item.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/waw-insert", String(idx)); });
      item.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("text/waw-insert")) e.preventDefault(); });
      item.addEventListener("drop", (e) => {
        const from = parseInt(e.dataTransfer.getData("text/waw-insert"), 10);
        if (!Number.isFinite(from) || from === idx) return;
        e.preventDefault();
        pushHistory();
        const [moved] = fxList.splice(from, 1);
        fxList.splice(idx, 0, moved);
        onChanged(); window.renderMixer(); onCommit();
      });
      list.appendChild(item);
    });
    sec.appendChild(list);
    const add = document.createElement("select");
    add.className = "ws-ins-add";
    add.title = "Add an insert effect";
    const groups = {};
    Object.entries(FX.FX_TYPES).forEach(([id, d]) => { (groups[d.category] = groups[d.category] || []).push([id, d.name]); });
    add.innerHTML = `<option value="">+ Insert</option>` + Object.entries(groups).map(([g, items]) =>
      `<optgroup label="${escapeHtml(g)}">${items.map(([id, n]) => `<option value="${id}">${escapeHtml(n)}</option>`).join("")}</optgroup>`).join("");
    add.addEventListener("change", () => {
      if (!add.value) return;
      pushHistory();
      fxList.push(FX.newFx(add.value));
      onChanged();
      const idx = fxList.length - 1;
      window.renderMixer();
      openFxEditor(owner, fxList, idx, onChanged, titleText);
      onCommit();
    });
    add.addEventListener("click", e => e.stopPropagation());
    sec.appendChild(add);
    return sec;
  }

  function renderChannelStrip(track, index) {
    normalizeTrackMix(track);
    const s = track.strip;
    const el = document.createElement("div");
    el.className = "ws" + (index === activeTrackIndex ? " active" : "") + (track.type === "audio" ? " ws-audio" : "");
    el.dataset.trackIndex = index;
    el.style.setProperty("--trk", track.color || getTrackColor(index));

    const instLabel = track.type === "audio" ? "AUDIO" : (track.instrument === "808" ? "DRUM SYN" : track.instrument === "sampler" ? "SAMPLER" : "SYNTH");
    const head = document.createElement("div");
    head.className = "ws-head";
    head.innerHTML = `<div class="ws-num">${String(index + 1).padStart(2, "0")}</div><div class="ws-type">${instLabel}</div>`;
    el.appendChild(head);

    // INPUT
    const inp = section("Input");
    inp.appendChild(row(
      stripKnob(track, "trim", "Trim", -24, 24, { format: fmtDbK, color: "wk-red" }),
      stripToggle(track, "phase", "Ø", "", "Phase invert")
    ));
    inp.appendChild(row(
      stripKnob(track, "hpf", "HPF", 20, 600, { log: true, step: 1, format: v => fmtHz(v) + " Hz" }),
      stripToggle(track, "hpfOn", "IN", "", "High-pass filter in")
    ));
    inp.appendChild(row(
      stripKnob(track, "lpf", "LPF", 2000, 20000, { log: true, step: 10, format: v => fmtHz(v) + " Hz" }),
      stripToggle(track, "lpfOn", "IN", "", "Low-pass filter in")
    ));
    el.appendChild(inp);

    // DYNAMICS
    const dyn = section("Dynamics");
    dyn.appendChild(row(
      stripKnob(track, "compThresh", "Thr", -50, 0, { format: fmtDbK, color: "wk-black" }),
      stripKnob(track, "compRatio", "Ratio", 1, 20, { format: v => v.toFixed(1) + ":1", color: "wk-black" })
    ));
    dyn.appendChild(row(
      stripKnob(track, "compAttack", "Atk", 0.1, 100, { log: true, format: v => v.toFixed(1) + " ms", color: "wk-black" }),
      stripKnob(track, "compRelease", "Rel", 20, 1500, { log: true, step: 1, format: v => Math.round(v) + " ms", color: "wk-black" })
    ));
    dyn.appendChild(row(
      stripKnob(track, "compMakeup", "Gain", 0, 24, { format: fmtDbK, color: "wk-black" }),
      stripToggle(track, "dynOn", "COMP", "", "Compressor in")
    ));
    dyn.appendChild(row(
      stripKnob(track, "gateThresh", "Gate", -80, 0, { format: fmtDbK, color: "wk-green" }),
      stripKnob(track, "gateRange", "Range", -80, 0, { format: fmtDbK, color: "wk-green" }),
    ));
    dyn.appendChild(row(
      stripToggle(track, "gateOn", "GATE", "", "Gate / expander in"),
      stripToggle(track, "dynPreEq", "DYN>EQ", "small", "Order: dynamics before EQ (off = EQ before dynamics)")
    ));
    el.appendChild(dyn);

    // EQ
    const eq = section("EQ");
    eq.appendChild(row(
      stripKnob(track, "hfGain", "HF", -18, 18, { format: fmtDbK, color: "wk-red" }),
      stripKnob(track, "hfFreq", "kHz", 1500, 18000, { log: true, step: 10, format: v => fmtHz(v) + " Hz", color: "wk-red" })
    ));
    eq.appendChild(row(stripToggle(track, "hfBell", "BELL", "small", "HF band: bell instead of shelf")));
    eq.appendChild(row(
      stripKnob(track, "hmfGain", "HMF", -18, 18, { format: fmtDbK, color: "wk-green" }),
      stripKnob(track, "hmfFreq", "kHz", 600, 7000, { log: true, step: 10, format: v => fmtHz(v) + " Hz", color: "wk-green" })
    ));
    eq.appendChild(row(stripKnob(track, "hmfQ", "Q", 0.3, 6, { log: true, step: 0.05, format: v => v.toFixed(2), color: "wk-green", size: "sm" })));
    eq.appendChild(row(
      stripKnob(track, "lmfGain", "LMF", -18, 18, { format: fmtDbK, color: "wk-blue" }),
      stripKnob(track, "lmfFreq", "Hz", 100, 2000, { log: true, step: 1, format: v => fmtHz(v) + " Hz", color: "wk-blue" })
    ));
    eq.appendChild(row(stripKnob(track, "lmfQ", "Q", 0.3, 6, { log: true, step: 0.05, format: v => v.toFixed(2), color: "wk-blue", size: "sm" })));
    eq.appendChild(row(
      stripKnob(track, "lfGain", "LF", -18, 18, { format: fmtDbK, color: "wk-black" }),
      stripKnob(track, "lfFreq", "Hz", 30, 450, { log: true, step: 1, format: v => fmtHz(v) + " Hz", color: "wk-black" })
    ));
    eq.appendChild(row(
      stripToggle(track, "lfBell", "BELL", "small", "LF band: bell instead of shelf"),
      stripToggle(track, "eqOn", "EQ IN", "", "EQ in/out")
    ));
    el.appendChild(eq);

    // INSERTS
    el.appendChild(renderInsertSection(track, track.inserts, () => commitTrack(track), `${track.name} — Inserts`));

    // SENDS
    const sends = section("Aux Sends");
    SEND_KEYS.forEach(k => {
      const bus = mixerState.buses.find(b => b.key === k);
      const knob = createKnob({
        label: `${k} ${bus?.name || ""}`.trim(), min: 0, max: 1, step: 0.01, value: track.sends[k] ?? 0, default: 0,
        color: "wk-yellow", size: "sm", format: v => fmtDb(gainToDb(v)) + " dB",
        onChange: v => { track.sends[k] = v; commitTrack(track); }
      });
      const pre = btn("PRE", !!track.sendPre[k], "small", "Pre-fader send", (b) => {
        pushHistory();
        track.sendPre[k] = !track.sendPre[k]; b.classList.toggle("on", track.sendPre[k]); commitTrack(track); onCommit();
      });
      sends.appendChild(row(knob, pre));
    });
    el.appendChild(sends);

    // PAN + buttons
    const out = section("", "ws-out");
    out.appendChild(row(createKnob({
      label: "Pan", min: -1, max: 1, step: 0.01, value: track.pan ?? 0, default: 0, color: "wk-blue",
      format: v => Math.abs(v) < 0.005 ? "C" : (v < 0 ? "L" : "R") + Math.round(Math.abs(v) * 100),
      onChange: v => { track.pan = v; commitTrack(track); }
    })));
    const btns = document.createElement("div");
    btns.className = "ws-btns";
    btns.appendChild(btn("MONO", !!track.mono, "", "Mono (sum L+R)", (b) => { pushHistory(); track.mono = !track.mono; b.classList.toggle("on", track.mono); commitTrack(track); renderSidebarTracks(); onCommit(); }));
    btns.appendChild(btn("SOLO", !!track.solo, "solo", "Solo (solo-in-place)", () => { pushHistory(); track.solo = !track.solo; syncEngine(); window.renderMixer(); renderSidebarTracks(); renderSequencer(); onCommit(); }));
    btns.appendChild(btn("CUT", !!track.mute, "mute", "Mute", () => { pushHistory(); track.mute = !track.mute; syncEngine(); window.renderMixer(); renderSidebarTracks(); renderSequencer(); onCommit(); }));
    if (track.type === "audio" || track.instrument) {
      btns.appendChild(btn("REC", !!track.armed, "rec", "Record arm", () => { window.WAWWorkspace?.toggleArm?.(track); }));
    }
    out.appendChild(btns);
    el.appendChild(out);

    // FADER + METER
    const lower = document.createElement("div");
    lower.className = "ws-lower";
    const meter = createMeterEl(true);
    const readout = document.createElement("div");
    readout.className = "ws-db";
    readout.textContent = fmtDb(gainToDb(track.volume ?? 1)) + " dB";
    const fader = createFader({
      value: track.volume ?? 1, label: track.name,
      onChange: g => { track.volume = g; readout.textContent = fmtDb(gainToDb(g)) + " dB"; commitTrack(track); }
    });
    lower.appendChild(fader);
    lower.appendChild(meter);
    el.appendChild(lower);
    el.appendChild(readout);

    const name = document.createElement("div");
    name.className = "ws-name";
    name.textContent = track.name || `Track ${index + 1}`;
    name.title = "Double-click to rename";
    name.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      const v = prompt("Track name:", track.name);
      if (v && v.trim()) { pushHistory(); track.name = v.trim(); window.renderMixer(); renderSidebarTracks(); renderSequencer(); onCommit(); }
    });
    el.appendChild(name);

    el.addEventListener("click", () => {
      if (index !== activeTrackIndex) { setActiveTrack(index, { silent: true }); window.renderMixer(); renderSequencer(); }
    });

    strip[track.id] = { meter, kind: "track" };
    return el;
  }

  function renderBusStrip(bus) {
    const el = document.createElement("div");
    el.className = "ws ws-bus";
    el.innerHTML = `<div class="ws-head"><div class="ws-num">${bus.key}</div><div class="ws-type">FX RETURN</div></div>`;
    el.appendChild(renderInsertSection(bus, bus.inserts, () => rtGraph?.buses[bus.key]?.update(bus), `${bus.name} return — Inserts`));
    const out = section("", "ws-out");
    out.appendChild(row(createKnob({
      label: "Pan", min: -1, max: 1, step: 0.01, value: bus.pan ?? 0, default: 0, color: "wk-blue",
      format: v => Math.abs(v) < 0.005 ? "C" : (v < 0 ? "L" : "R") + Math.round(Math.abs(v) * 100),
      onChange: v => { bus.pan = v; rtGraph?.buses[bus.key]?.update(bus); }
    })));
    const btns = document.createElement("div");
    btns.className = "ws-btns";
    btns.appendChild(btn("CUT", !!bus.mute, "mute", "Mute return", (b) => { pushHistory(); bus.mute = !bus.mute; b.classList.toggle("on", bus.mute); rtGraph?.buses[bus.key]?.update(bus); onCommit(); }));
    out.appendChild(btns);
    el.appendChild(out);
    const spacer = document.createElement("div");
    spacer.className = "ws-spacer";
    el.appendChild(spacer);
    const lower = document.createElement("div");
    lower.className = "ws-lower";
    const meter = createMeterEl(false);
    const readout = document.createElement("div");
    readout.className = "ws-db";
    readout.textContent = fmtDb(gainToDb(bus.volume)) + " dB";
    lower.appendChild(createFader({ value: bus.volume, label: bus.name, onChange: g => { bus.volume = g; readout.textContent = fmtDb(gainToDb(g)) + " dB"; rtGraph?.buses[bus.key]?.update(bus); } }));
    lower.appendChild(meter);
    el.appendChild(lower);
    el.appendChild(readout);
    const name = document.createElement("div");
    name.className = "ws-name";
    name.textContent = bus.name;
    name.title = "Double-click to rename";
    name.addEventListener("dblclick", () => {
      const v = prompt("Return name:", bus.name);
      if (v && v.trim()) { pushHistory(); bus.name = v.trim(); window.renderMixer(); onCommit(); }
    });
    el.appendChild(name);
    strip[bus.id] = { meter, kind: "bus", key: bus.key };
    return el;
  }

  function renderMasterStrip() {
    const m = mixerState.master;
    const el = document.createElement("div");
    el.className = "ws ws-master";
    el.innerHTML = `<div class="ws-head"><div class="ws-num">M</div><div class="ws-type">MASTER</div></div>`;
    el.appendChild(renderInsertSection(m, m.inserts, () => rtGraph?.master.update(m), "Master — Inserts"));
    const quick = section("Mastering");
    const addChain = btn("Add mastering chain", false, "wide", "EQ → Bus Comp → Width → Limiter", () => {
      pushHistory();
      m.inserts.push(FX.newFx("eq"), FX.newFx("buscomp", { threshold: -8, ratio: "2", attack: "30", makeup: 1 }), FX.newFx("width", { width: 1.1, bassMono: 120 }), FX.newFx("limiter", { gain: 2, ceiling: -0.5 }));
      rtGraph?.master.update(m); window.renderMixer(); onCommit();
    });
    quick.appendChild(addChain);
    el.appendChild(quick);
    const out = section("", "ws-out");
    const btns = document.createElement("div");
    btns.className = "ws-btns";
    btns.appendChild(btn("MONO", !!m.mono, "", "Master mono check", (b) => { m.mono = !m.mono; b.classList.toggle("on", m.mono); rtGraph?.master.update(m); }));
    out.appendChild(btns);
    el.appendChild(out);
    const spacer = document.createElement("div");
    spacer.className = "ws-spacer";
    el.appendChild(spacer);
    const lower = document.createElement("div");
    lower.className = "ws-lower";
    const meter = createMeterEl(true);
    const readout = document.createElement("div");
    readout.className = "ws-db";
    readout.textContent = fmtDb(gainToDb(m.volume)) + " dB";
    lower.appendChild(createFader({ value: m.volume, label: "Master", onChange: g => { m.volume = g; readout.textContent = fmtDb(gainToDb(g)) + " dB"; rtGraph?.master.update(m); } }));
    lower.appendChild(meter);
    el.appendChild(lower);
    el.appendChild(readout);
    const name = document.createElement("div");
    name.className = "ws-name";
    name.textContent = "Master";
    el.appendChild(name);
    strip.master = { meter, kind: "master" };
    return el;
  }

  function renderMixer() {
    const root = document.getElementById("mixerStrips");
    if (!root) return;
    if (activeKnobGesture) return; // never rebuild under the user's mouse
    ensureTracks();
    tracks.forEach(normalizeTrackMix);
    syncEngine();
    const scroll = root.scrollLeft;
    root.innerHTML = "";
    Object.keys(strip).forEach(k => delete strip[k]);
    const chans = document.createElement("div");
    chans.className = "ws-group";
    tracks.forEach((t, i) => chans.appendChild(renderChannelStrip(t, i)));
    root.appendChild(chans);
    const buses = document.createElement("div");
    buses.className = "ws-group ws-group-bus";
    mixerState.buses.forEach(b => buses.appendChild(renderBusStrip(b)));
    root.appendChild(buses);
    root.appendChild(renderMasterStrip());
    root.scrollLeft = scroll;
    startMeters();
  }

  function renderMixerIfVisible() {
    if (document.getElementById("mixerView")?.classList.contains("visible")) renderMixer();
  }

  // ---------------------------------------------------------------------------
  // Meter loop (only while something is visible)
  // ---------------------------------------------------------------------------
  function startMeters() {
    if (meterRaf) return;
    const tick = () => {
      meterRaf = null;
      const g = rtGraph;
      const mixerVisible = document.getElementById("mixerView")?.classList.contains("visible");
      if (g && mixerVisible) {
        Object.entries(strip).forEach(([id, ref]) => {
          if (ref.kind === "track") {
            const ch = g.channels.get(id);
            if (ch?.meter) paintMeter(ref.meter, ch.meter.read(), ch.reduction());
          } else if (ref.kind === "bus") {
            const b = g.buses[ref.key];
            if (b?.meter) paintMeter(ref.meter, b.meter.read());
          } else if (ref.kind === "master") {
            if (g.master.meter) paintMeter(ref.meter, g.master.meter.read(), g.master.reduction());
          }
        });
      }
      const hdr = document.getElementById("masterMeterHeader");
      if (g && hdr && g.master.meter) paintMeter(hdr, g.master.meter.read());
      if (mixerVisible || hdr) meterRaf = requestAnimationFrame(tick);
    };
    meterRaf = requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------------------
  // FX editor modal (generic, schema-driven)
  // ---------------------------------------------------------------------------
  function ensureFxModal() {
    let m = document.getElementById("fxModal");
    if (m) return m;
    m = document.createElement("div");
    m.id = "fxModal";
    m.className = "modal-backdrop fx-modal";
    m.innerHTML = `<div class="modal-dialog fx-dialog"><div class="modal-header"><span id="fxModalTitle">FX</span><button type="button" id="fxModalClose">×</button></div><div class="fx-body" id="fxModalBody"></div></div>`;
    document.body.appendChild(m);
    m.addEventListener("click", (e) => { if (e.target === m) m.classList.remove("visible"); });
    m.querySelector("#fxModalClose").addEventListener("click", () => m.classList.remove("visible"));
    return m;
  }

  function openFxEditor(owner, fxList, idx, onChanged, titleText) {
    const fx = fxList[idx];
    const def = FX.FX_TYPES[fx?.type];
    if (!def) return;
    const m = ensureFxModal();
    m.querySelector("#fxModalTitle").textContent = `${titleText || ""} · ${def.name}`;
    const body = m.querySelector("#fxModalBody");
    body.innerHTML = "";
    fx.params = { ...FX.defaultParams(fx.type), ...fx.params };
    const top = document.createElement("div");
    top.className = "fx-top";
    top.appendChild(btn(fx.bypass ? "Bypassed" : "Active", !fx.bypass, "", "Bypass", (b) => {
      pushHistory(); fx.bypass = !fx.bypass; b.textContent = fx.bypass ? "Bypassed" : "Active"; b.classList.toggle("on", !fx.bypass); onChanged(); window.renderMixer(); onCommit();
    }));
    top.appendChild(btn("Reset", false, "", "Reset parameters", () => { pushHistory(); fx.params = FX.defaultParams(fx.type); onChanged(); openFxEditor(owner, fxList, idx, onChanged, titleText); onCommit(); }));
    body.appendChild(top);
    const grid = document.createElement("div");
    grid.className = "fx-grid";
    def.params.forEach(spec => {
      const cell = document.createElement("div");
      cell.className = "fx-cell";
      if (spec.type === "select") {
        cell.innerHTML = `<label>${escapeHtml(spec.label)}</label>`;
        const sel = document.createElement("select");
        sel.innerHTML = spec.options.map(o => `<option value="${escapeHtml(o)}" ${String(fx.params[spec.id]) === o ? "selected" : ""}>${escapeHtml(o)}${spec.unit && o !== "Auto" && o !== "Off" ? " " + spec.unit : ""}</option>`).join("");
        sel.addEventListener("change", () => { pushHistory(); fx.params[spec.id] = sel.value; onChanged(); onCommit(); });
        cell.appendChild(sel);
      } else if (spec.type === "toggle") {
        cell.appendChild(btn(spec.label, !!fx.params[spec.id], "", spec.label, (b) => {
          pushHistory(); fx.params[spec.id] = !fx.params[spec.id]; b.classList.toggle("on", fx.params[spec.id]); onChanged(); onCommit();
        }));
      } else {
        cell.appendChild(createKnob({
          label: spec.label, min: spec.min, max: spec.max, step: spec.step, log: !!spec.log, size: "lg",
          value: fx.params[spec.id], default: spec.default, format: v => FX.formatParam(spec, v),
          onChange: v => { fx.params[spec.id] = v; onChanged(); valueEl.textContent = FX.formatParam(spec, v); }
        }));
        const valueEl = document.createElement("div");
        valueEl.className = "fx-val";
        valueEl.textContent = FX.formatParam(spec, fx.params[spec.id]);
        cell.appendChild(valueEl);
      }
      grid.appendChild(cell);
    });
    body.appendChild(grid);
    m.classList.add("visible");
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  window.WAWMixer = {
    SEND_KEYS,
    get state() { return mixerState; },
    // buses are always A-D, so an existing graph can simply be re-synced in place
    set state(v) { mixerState = normalizeMixerState(v); rtGraph?.syncAll(); },
    serialize: () => JSON.parse(JSON.stringify(mixerState)),
    normalizeTrackMix,
    defaultStrip,
    getRealtimeGraph,
    getTrackInput,
    syncEngine,
    updateTrackEngine,
    createOfflineGraph,
    createKnob,
    createFader,
    createMeterEl,
    paintMeter,
    startMeters,
    openFxEditor,
    renderInsertSection,
    gainToDb,
    dbToGain
  };

  // replaces the old (purely cosmetic) mixer renderer in app.js
  window.renderMixer = renderMixer;
})();
