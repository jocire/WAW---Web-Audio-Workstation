// WAW FX library — insert effects for channel strips, buses and the master.
// Every effect type exposes a parameter schema (rendered generically by the UI)
// and a factory:  create(ctx, params) -> { input, output, set(params), dispose(), meter?() }
// Effects work with both realtime AudioContexts and OfflineAudioContexts (WAV export).
(function () {
  "use strict";

  const dbToGain = db => Math.pow(10, db / 20);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function smooth(param, value, ctx, time = 0.02) {
    if (!param) return;
    const v = Number.isFinite(value) ? value : 0;
    try { param.setTargetAtTime(v, ctx.currentTime, time); } catch (e) { param.value = v; }
  }

  function currentBpm() {
    try { return parseFloat(document.getElementById("bpmInput")?.value) || 120; } catch (e) { return 120; }
  }

  // ----- AudioWorklet module loading (gate, bitcrusher, recorder) -----
  const workletPromises = new WeakMap();
  function ensureWorklets(ctx) {
    if (!ctx?.audioWorklet) return Promise.resolve(false);
    if (!workletPromises.has(ctx)) {
      const p = ctx.audioWorklet.addModule("js/worklets.js?v=6fdb494420")
        .then(() => { ctx.__wawWorklets = true; return true; })
        .catch(err => { console.warn("AudioWorklet unavailable:", err); return false; });
      workletPromises.set(ctx, p);
    }
    return workletPromises.get(ctx);
  }
  function makeWorklet(ctx, name, options) {
    if (!ctx.__wawWorklets) return null;
    try { return new AudioWorkletNode(ctx, name, options); } catch (e) { return null; }
  }

  // ----- dry/wet helper -----
  function wetDry(ctx) {
    const input = ctx.createGain();
    const output = ctx.createGain();
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    input.connect(dry); dry.connect(output); wet.connect(output);
    return {
      input, output, dry, wet,
      setMix(mix) {
        const m = clamp(mix, 0, 1);
        // equal-power crossfade
        smooth(dry.gain, Math.cos(m * Math.PI / 2), ctx);
        smooth(wet.gain, Math.sin(m * Math.PI / 2), ctx);
      }
    };
  }

  // ----- curves / impulse responses -----
  function saturationCurve(amount, type) {
    const n = 2048;
    const curve = new Float32Array(n);
    const k = 1 + amount * 40;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      let y;
      if (type === "tube") {
        // asymmetric soft clip -> even harmonics
        y = x >= 0 ? Math.tanh(k * x) / Math.tanh(k) : Math.tanh(k * 0.8 * x) / Math.tanh(k * 0.8);
      } else if (type === "hard") {
        y = clamp(x * k * 0.5, -1, 1);
      } else if (type === "fold") {
        y = Math.sin(x * (1 + amount * 6) * Math.PI / 2);
      } else {
        // tape: smooth arctan
        y = Math.atan(k * x) / Math.atan(k);
      }
      curve[i] = y;
    }
    return curve;
  }

  const irCache = new Map();
  function makeImpulse(ctx, seconds, decay, damping, preDelay) {
    const key = [ctx.sampleRate, seconds.toFixed(2), decay.toFixed(2), damping.toFixed(2), preDelay.toFixed(3)].join(":");
    const cached = irCache.get(key);
    if (cached) return cached;
    const rate = ctx.sampleRate;
    const pre = Math.floor(preDelay * rate);
    const len = Math.max(1, Math.floor(seconds * rate) + pre);
    const ir = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = ir.getChannelData(ch);
      let lp = 0;
      for (let i = pre; i < len; i++) {
        const t = (i - pre) / (len - pre);
        const env = Math.pow(1 - t, decay * 2.2);
        const noise = Math.random() * 2 - 1;
        // progressive one-pole damping: tail gets darker over time
        const a = clamp(damping * (0.15 + t * 0.85), 0, 0.98);
        lp = lp * a + noise * (1 - a);
        data[i] = lp * env;
      }
      // a few early reflections
      for (let r = 0; r < 6; r++) {
        const pos = pre + Math.floor((0.004 + Math.random() * 0.03) * rate);
        if (pos < len) data[pos] += (Math.random() * 0.6 + 0.2) * (ch ? -1 : 1);
      }
    }
    if (irCache.size > 24) irCache.clear();
    irCache.set(key, ir);
    return ir;
  }

  const SYNC_DIVISIONS = {
    "1/1": 4, "1/2": 2, "1/2d": 3, "1/4": 1, "1/4d": 1.5, "1/4t": 2 / 3,
    "1/8": 0.5, "1/8d": 0.75, "1/8t": 1 / 3, "1/16": 0.25, "1/16d": 0.375, "1/32": 0.125
  };
  function syncedSeconds(division) {
    const beats = SYNC_DIVISIONS[division];
    return beats ? beats * 60 / currentBpm() : null;
  }

  // =====================================================================
  // Effect definitions
  // =====================================================================
  const FX_TYPES = {};

  // ---------------- Parametric EQ (4 band + HPF/LPF) ----------------
  FX_TYPES.eq = {
    name: "Parametric EQ",
    category: "EQ",
    params: [
      { id: "hpf", label: "HPF", min: 20, max: 1000, step: 1, default: 20, unit: "Hz", log: true },
      { id: "lowFreq", label: "Low Freq", min: 30, max: 600, step: 1, default: 100, unit: "Hz", log: true },
      { id: "lowGain", label: "Low Gain", min: -18, max: 18, step: 0.1, default: 0, unit: "dB" },
      { id: "lmFreq", label: "LM Freq", min: 100, max: 2500, step: 1, default: 400, unit: "Hz", log: true },
      { id: "lmGain", label: "LM Gain", min: -18, max: 18, step: 0.1, default: 0, unit: "dB" },
      { id: "lmQ", label: "LM Q", min: 0.2, max: 10, step: 0.1, default: 1 },
      { id: "hmFreq", label: "HM Freq", min: 600, max: 9000, step: 1, default: 2500, unit: "Hz", log: true },
      { id: "hmGain", label: "HM Gain", min: -18, max: 18, step: 0.1, default: 0, unit: "dB" },
      { id: "hmQ", label: "HM Q", min: 0.2, max: 10, step: 0.1, default: 1 },
      { id: "highFreq", label: "High Freq", min: 1500, max: 18000, step: 1, default: 8000, unit: "Hz", log: true },
      { id: "highGain", label: "High Gain", min: -18, max: 18, step: 0.1, default: 0, unit: "dB" },
      { id: "lpf", label: "LPF", min: 1000, max: 20000, step: 1, default: 20000, unit: "Hz", log: true },
      { id: "output", label: "Output", min: -18, max: 18, step: 0.1, default: 0, unit: "dB" },
    ],
    create(ctx) {
      const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.Q.value = 0.707;
      const low = ctx.createBiquadFilter(); low.type = "lowshelf";
      const lm = ctx.createBiquadFilter(); lm.type = "peaking";
      const hm = ctx.createBiquadFilter(); hm.type = "peaking";
      const high = ctx.createBiquadFilter(); high.type = "highshelf";
      const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.Q.value = 0.707;
      const out = ctx.createGain();
      hp.connect(low); low.connect(lm); lm.connect(hm); hm.connect(high); high.connect(lp); lp.connect(out);
      return {
        input: hp, output: out,
        set(p) {
          smooth(hp.frequency, p.hpf, ctx); smooth(lp.frequency, Math.min(p.lpf, ctx.sampleRate / 2 - 100), ctx);
          smooth(low.frequency, p.lowFreq, ctx); smooth(low.gain, p.lowGain, ctx);
          smooth(lm.frequency, p.lmFreq, ctx); smooth(lm.gain, p.lmGain, ctx); smooth(lm.Q, p.lmQ, ctx);
          smooth(hm.frequency, p.hmFreq, ctx); smooth(hm.gain, p.hmGain, ctx); smooth(hm.Q, p.hmQ, ctx);
          smooth(high.frequency, Math.min(p.highFreq, ctx.sampleRate / 2 - 100), ctx); smooth(high.gain, p.highGain, ctx);
          smooth(out.gain, dbToGain(p.output), ctx);
        },
        dispose() { [hp, low, lm, hm, high, lp, out].forEach(n => n.disconnect()); }
      };
    }
  };

  // ---------------- Compressor ----------------
  FX_TYPES.compressor = {
    name: "Compressor",
    category: "Dynamics",
    params: [
      { id: "threshold", label: "Threshold", min: -60, max: 0, step: 0.5, default: -18, unit: "dB" },
      { id: "ratio", label: "Ratio", min: 1, max: 20, step: 0.1, default: 4, unit: ":1" },
      { id: "knee", label: "Knee", min: 0, max: 30, step: 1, default: 6, unit: "dB" },
      { id: "attack", label: "Attack", min: 0.1, max: 200, step: 0.1, default: 10, unit: "ms", log: true },
      { id: "release", label: "Release", min: 10, max: 2000, step: 1, default: 150, unit: "ms", log: true },
      { id: "makeup", label: "Make-up", min: 0, max: 24, step: 0.1, default: 0, unit: "dB" },
      { id: "mix", label: "Mix", min: 0, max: 1, step: 0.01, default: 1 },
    ],
    create(ctx) {
      const wd = wetDry(ctx);
      const comp = ctx.createDynamicsCompressor();
      const makeup = ctx.createGain();
      wd.input.connect(comp); comp.connect(makeup); makeup.connect(wd.wet);
      return {
        input: wd.input, output: wd.output,
        set(p) {
          smooth(comp.threshold, p.threshold, ctx); smooth(comp.ratio, p.ratio, ctx); smooth(comp.knee, p.knee, ctx);
          smooth(comp.attack, p.attack / 1000, ctx); smooth(comp.release, p.release / 1000, ctx);
          smooth(makeup.gain, dbToGain(p.makeup), ctx); wd.setMix(p.mix);
        },
        meter: () => comp.reduction,
        dispose() { [wd.input, wd.output, wd.dry, wd.wet, comp, makeup].forEach(n => n.disconnect()); }
      };
    }
  };

  // ---------------- SSL-style bus compressor ----------------
  FX_TYPES.buscomp = {
    name: "Bus Compressor",
    category: "Dynamics",
    params: [
      { id: "threshold", label: "Threshold", min: -30, max: 0, step: 0.5, default: -10, unit: "dB" },
      { id: "ratio", label: "Ratio", type: "select", options: ["2", "4", "10"], default: "4" },
      { id: "attack", label: "Attack", type: "select", options: ["0.1", "0.3", "1", "3", "10", "30"], default: "10", unit: "ms" },
      { id: "release", label: "Release", type: "select", options: ["0.1", "0.3", "0.6", "1.2", "Auto"], default: "Auto", unit: "s" },
      { id: "makeup", label: "Make-up", min: 0, max: 15, step: 0.1, default: 2, unit: "dB" },
      { id: "hpSidechain", label: "SC HPF", type: "toggle", default: false },
      { id: "mix", label: "Mix", min: 0, max: 1, step: 0.01, default: 1 },
    ],
    create(ctx) {
      // DynamicsCompressor has no sidechain input; "SC HPF" is approximated by
      // compressing a high-passed copy mixed back with the untouched lows.
      const wd = wetDry(ctx);
      const comp = ctx.createDynamicsCompressor();
      comp.knee.value = 4;
      const makeup = ctx.createGain();
      const scHp = ctx.createBiquadFilter(); scHp.type = "highpass"; scHp.frequency.value = 20;
      const lowKeep = ctx.createBiquadFilter(); lowKeep.type = "lowpass"; lowKeep.frequency.value = 20;
      const lowGain = ctx.createGain(); lowGain.gain.value = 0;
      wd.input.connect(scHp); scHp.connect(comp); comp.connect(makeup); makeup.connect(wd.wet);
      wd.input.connect(lowKeep); lowKeep.connect(lowGain); lowGain.connect(wd.wet);
      return {
        input: wd.input, output: wd.output,
        set(p) {
          smooth(comp.threshold, p.threshold, ctx);
          smooth(comp.ratio, parseFloat(p.ratio) || 4, ctx);
          smooth(comp.attack, (parseFloat(p.attack) || 10) / 1000, ctx);
          const rel = p.release === "Auto" ? 0.25 : parseFloat(p.release) || 0.3;
          smooth(comp.release, rel, ctx);
          smooth(makeup.gain, dbToGain(p.makeup), ctx);
          smooth(scHp.frequency, p.hpSidechain ? 120 : 10, ctx);
          smooth(lowKeep.frequency, p.hpSidechain ? 120 : 10, ctx);
          smooth(lowGain.gain, p.hpSidechain ? 1 : 0, ctx);
          wd.setMix(p.mix);
        },
        meter: () => comp.reduction,
        dispose() { [wd.input, wd.output, wd.dry, wd.wet, comp, makeup, scHp, lowKeep, lowGain].forEach(n => n.disconnect()); }
      };
    }
  };

  // ---------------- Limiter (mastering) ----------------
  FX_TYPES.limiter = {
    name: "Limiter",
    category: "Dynamics",
    params: [
      { id: "gain", label: "Input Gain", min: 0, max: 18, step: 0.1, default: 0, unit: "dB" },
      { id: "ceiling", label: "Ceiling", min: -12, max: 0, step: 0.1, default: -0.3, unit: "dB" },
      { id: "release", label: "Release", min: 10, max: 1000, step: 1, default: 80, unit: "ms", log: true },
    ],
    create(ctx) {
      const inGain = ctx.createGain();
      const comp = ctx.createDynamicsCompressor();
      comp.knee.value = 0; comp.ratio.value = 20; comp.attack.value = 0.001;
      const clip = ctx.createWaveShaper();
      clip.oversample = "4x";
      inGain.connect(comp); comp.connect(clip);
      let lastCeil = null;
      return {
        input: inGain, output: clip,
        set(p) {
          smooth(inGain.gain, dbToGain(p.gain), ctx);
          // fast high-ratio compressor does the gain riding just below the ceiling...
          smooth(comp.threshold, p.ceiling - 1.5, ctx);
          smooth(comp.release, p.release / 1000, ctx);
          // ...and a hard clip at the ceiling catches the remaining overshoot
          if (lastCeil !== p.ceiling) {
            lastCeil = p.ceiling;
            const c = dbToGain(p.ceiling), n = 2048, curve = new Float32Array(n);
            for (let i = 0; i < n; i++) { const x = (i * 2) / (n - 1) - 1; curve[i] = clamp(x, -c, c); }
            clip.curve = curve;
          }
        },
        meter: () => comp.reduction,
        dispose() { [inGain, comp, clip].forEach(n2 => n2.disconnect()); }
      };
    }
  };

  // ---------------- Noise gate (AudioWorklet) ----------------
  FX_TYPES.gate = {
    name: "Gate",
    category: "Dynamics",
    params: [
      { id: "threshold", label: "Threshold", min: -90, max: 0, step: 0.5, default: -45, unit: "dB" },
      { id: "range", label: "Range", min: -90, max: 0, step: 1, default: -80, unit: "dB" },
      { id: "attack", label: "Attack", min: 0.1, max: 50, step: 0.1, default: 2, unit: "ms", log: true },
      { id: "hold", label: "Hold", min: 0, max: 500, step: 1, default: 30, unit: "ms" },
      { id: "release", label: "Release", min: 5, max: 2000, step: 1, default: 120, unit: "ms", log: true },
    ],
    create(ctx) {
      const node = makeWorklet(ctx, "waw-gate", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      if (!node) {
        const pass = ctx.createGain();
        return { input: pass, output: pass, set() {}, dispose() { pass.disconnect(); }, unavailable: true };
      }
      const P = n => node.parameters.get(n);
      return {
        input: node, output: node,
        set(p) {
          smooth(P("threshold"), p.threshold, ctx); smooth(P("range"), p.range, ctx);
          smooth(P("attack"), p.attack / 1000, ctx); smooth(P("hold"), p.hold / 1000, ctx);
          smooth(P("release"), p.release / 1000, ctx);
        },
        dispose() { node.disconnect(); }
      };
    }
  };

  // ---------------- Reverb (algorithmic IR + convolution) ----------------
  FX_TYPES.reverb = {
    name: "Reverb",
    category: "Space",
    params: [
      { id: "size", label: "Decay", min: 0.2, max: 8, step: 0.05, default: 2.2, unit: "s" },
      { id: "shape", label: "Density", min: 0.3, max: 3, step: 0.05, default: 1.2 },
      { id: "damping", label: "Damping", min: 0, max: 0.95, step: 0.01, default: 0.5 },
      { id: "preDelay", label: "Pre-delay", min: 0, max: 200, step: 1, default: 15, unit: "ms" },
      { id: "lowCut", label: "Low Cut", min: 20, max: 1000, step: 1, default: 150, unit: "Hz", log: true },
      { id: "highCut", label: "High Cut", min: 1000, max: 20000, step: 1, default: 9000, unit: "Hz", log: true },
      { id: "mix", label: "Mix", min: 0, max: 1, step: 0.01, default: 0.3 },
    ],
    create(ctx) {
      const wd = wetDry(ctx);
      const conv = ctx.createConvolver();
      const lc = ctx.createBiquadFilter(); lc.type = "highpass";
      const hc = ctx.createBiquadFilter(); hc.type = "lowpass";
      wd.input.connect(lc); lc.connect(hc); hc.connect(conv); conv.connect(wd.wet);
      let lastKey = "";
      return {
        input: wd.input, output: wd.output,
        set(p) {
          const key = [p.size, p.shape, p.damping, p.preDelay].join("|");
          if (key !== lastKey) {
            lastKey = key;
            conv.buffer = makeImpulse(ctx, p.size, p.shape, p.damping, p.preDelay / 1000);
          }
          smooth(lc.frequency, p.lowCut, ctx); smooth(hc.frequency, Math.min(p.highCut, ctx.sampleRate / 2 - 100), ctx);
          wd.setMix(p.mix);
        },
        dispose() { [wd.input, wd.output, wd.dry, wd.wet, conv, lc, hc].forEach(n => n.disconnect()); }
      };
    }
  };

  // ---------------- Delay (stereo / ping-pong, tempo sync) ----------------
  FX_TYPES.delay = {
    name: "Delay",
    category: "Space",
    params: [
      { id: "sync", label: "Sync", type: "select", options: ["Off", ...Object.keys(SYNC_DIVISIONS)], default: "1/8d" },
      { id: "time", label: "Time", min: 1, max: 2000, step: 1, default: 375, unit: "ms" },
      { id: "feedback", label: "Feedback", min: 0, max: 0.95, step: 0.01, default: 0.35 },
      { id: "pingpong", label: "Ping-Pong", type: "toggle", default: true },
      { id: "lowCut", label: "Low Cut", min: 20, max: 2000, step: 1, default: 200, unit: "Hz", log: true },
      { id: "highCut", label: "High Cut", min: 1000, max: 20000, step: 1, default: 6000, unit: "Hz", log: true },
      { id: "mix", label: "Mix", min: 0, max: 1, step: 0.01, default: 0.25 },
    ],
    create(ctx) {
      const wd = wetDry(ctx);
      const split = ctx.createChannelSplitter(2);
      const merge = ctx.createChannelMerger(2);
      const dl = ctx.createDelay(4), dr = ctx.createDelay(4);
      const fbL = ctx.createGain(), fbR = ctx.createGain();
      const lc = ctx.createBiquadFilter(); lc.type = "highpass";
      const hc = ctx.createBiquadFilter(); hc.type = "lowpass";
      const inMono = ctx.createGain();
      // input -> filters -> L delay ; feedback crosses L->R->L in ping-pong mode
      wd.input.connect(lc); lc.connect(hc); hc.connect(inMono);
      inMono.connect(dl);
      dl.connect(fbL); dr.connect(fbR);
      dl.connect(merge, 0, 0); dr.connect(merge, 0, 1);
      merge.connect(wd.wet);
      let pp = null;
      void split;
      return {
        input: wd.input, output: wd.output,
        set(p) {
          const t = (p.sync && p.sync !== "Off" ? syncedSeconds(p.sync) : null) ?? p.time / 1000;
          smooth(dl.delayTime, clamp(t, 0.001, 4), ctx, 0.05);
          smooth(dr.delayTime, clamp(t, 0.001, 4), ctx, 0.05);
          smooth(fbL.gain, p.feedback, ctx); smooth(fbR.gain, p.feedback, ctx);
          smooth(lc.frequency, p.lowCut, ctx); smooth(hc.frequency, Math.min(p.highCut, ctx.sampleRate / 2 - 100), ctx);
          if (pp !== !!p.pingpong) {
            pp = !!p.pingpong;
            try { fbL.disconnect(); fbR.disconnect(); inMono.disconnect(dr); } catch (e) {}
            if (pp) { fbL.connect(dr); fbR.connect(dl); }
            else { inMono.connect(dr); fbL.connect(dl); fbR.connect(dr); }
          }
          wd.setMix(p.mix);
        },
        dispose() { [wd.input, wd.output, wd.dry, wd.wet, dl, dr, fbL, fbR, lc, hc, inMono, merge].forEach(n => n.disconnect()); }
      };
    }
  };

  // ---------------- Chorus ----------------
  FX_TYPES.chorus = {
    name: "Chorus",
    category: "Modulation",
    params: [
      { id: "rate", label: "Rate", min: 0.05, max: 8, step: 0.01, default: 0.8, unit: "Hz", log: true },
      { id: "depth", label: "Depth", min: 0, max: 1, step: 0.01, default: 0.5 },
      { id: "delay", label: "Delay", min: 5, max: 40, step: 0.5, default: 15, unit: "ms" },
      { id: "mix", label: "Mix", min: 0, max: 1, step: 0.01, default: 0.5 },
    ],
    create(ctx) {
      const wd = wetDry(ctx);
      const merge = ctx.createChannelMerger(2);
      const dl = ctx.createDelay(0.1), dr = ctx.createDelay(0.1);
      const lfoL = ctx.createOscillator(), lfoR = ctx.createOscillator();
      const depthL = ctx.createGain(), depthR = ctx.createGain();
      lfoL.connect(depthL); depthL.connect(dl.delayTime);
      lfoR.connect(depthR); depthR.connect(dr.delayTime);
      wd.input.connect(dl); wd.input.connect(dr);
      dl.connect(merge, 0, 0); dr.connect(merge, 0, 1); merge.connect(wd.wet);
      lfoL.start(); lfoR.start();
      // offset the right LFO phase by starting it with a different frequency for a moment
      return {
        input: wd.input, output: wd.output,
        set(p) {
          smooth(lfoL.frequency, p.rate, ctx); smooth(lfoR.frequency, p.rate * 1.07, ctx);
          const base = p.delay / 1000;
          smooth(dl.delayTime, base, ctx); smooth(dr.delayTime, base * 1.13, ctx);
          smooth(depthL.gain, base * 0.5 * p.depth, ctx); smooth(depthR.gain, base * 0.5 * p.depth, ctx);
          wd.setMix(p.mix);
        },
        dispose() { try { lfoL.stop(); lfoR.stop(); } catch (e) {} [wd.input, wd.output, wd.dry, wd.wet, dl, dr, lfoL, lfoR, depthL, depthR, merge].forEach(n => n.disconnect()); }
      };
    }
  };

  // ---------------- Phaser ----------------
  FX_TYPES.phaser = {
    name: "Phaser",
    category: "Modulation",
    params: [
      { id: "rate", label: "Rate", min: 0.05, max: 8, step: 0.01, default: 0.4, unit: "Hz", log: true },
      { id: "depth", label: "Depth", min: 0, max: 1, step: 0.01, default: 0.7 },
      { id: "center", label: "Center", min: 200, max: 4000, step: 1, default: 900, unit: "Hz", log: true },
      { id: "feedback", label: "Feedback", min: 0, max: 0.9, step: 0.01, default: 0.4 },
      { id: "stages", label: "Stages", type: "select", options: ["4", "6", "8"], default: "6" },
      { id: "mix", label: "Mix", min: 0, max: 1, step: 0.01, default: 0.5 },
    ],
    create(ctx) {
      const wd = wetDry(ctx);
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      const fb = ctx.createGain();
      const stages = [];
      for (let i = 0; i < 8; i++) { const f = ctx.createBiquadFilter(); f.type = "allpass"; f.Q.value = 0.6; stages.push(f); lfoGain.connect(f.frequency); }
      lfo.connect(lfoGain); lfo.start();
      let count = 0;
      function wire(n) {
        if (n === count) return;
        count = n;
        try { wd.input.disconnect(); } catch (e) {}
        stages.forEach(s => { try { s.disconnect(); } catch (e) {} });
        try { fb.disconnect(); } catch (e) {}
        wd.input.connect(wd.dry);
        wd.input.connect(stages[0]);
        for (let i = 0; i < n - 1; i++) stages[i].connect(stages[i + 1]);
        stages[n - 1].connect(wd.wet);
        stages[n - 1].connect(fb); fb.connect(stages[0]);
      }
      return {
        input: wd.input, output: wd.output,
        set(p) {
          wire(parseInt(p.stages, 10) || 6);
          smooth(lfo.frequency, p.rate, ctx);
          stages.forEach(s => smooth(s.frequency, p.center, ctx));
          smooth(lfoGain.gain, p.center * 0.9 * p.depth, ctx);
          smooth(fb.gain, p.feedback, ctx);
          wd.setMix(p.mix);
        },
        dispose() { try { lfo.stop(); } catch (e) {} [wd.input, wd.output, wd.dry, wd.wet, lfo, lfoGain, fb, ...stages].forEach(n => n.disconnect()); }
      };
    }
  };

  // ---------------- Saturator ----------------
  FX_TYPES.saturator = {
    name: "Saturator",
    category: "Color",
    params: [
      { id: "type", label: "Type", type: "select", options: ["tape", "tube", "hard", "fold"], default: "tape" },
      { id: "drive", label: "Drive", min: 0, max: 1, step: 0.01, default: 0.3 },
      { id: "tone", label: "Tone", min: 1000, max: 20000, step: 1, default: 12000, unit: "Hz", log: true },
      { id: "output", label: "Output", min: -24, max: 6, step: 0.1, default: -2, unit: "dB" },
      { id: "mix", label: "Mix", min: 0, max: 1, step: 0.01, default: 1 },
    ],
    create(ctx) {
      const wd = wetDry(ctx);
      const pre = ctx.createGain();
      const shaper = ctx.createWaveShaper(); shaper.oversample = "4x";
      const tone = ctx.createBiquadFilter(); tone.type = "lowpass";
      const out = ctx.createGain();
      wd.input.connect(pre); pre.connect(shaper); shaper.connect(tone); tone.connect(out); out.connect(wd.wet);
      let lastKey = "";
      return {
        input: wd.input, output: wd.output,
        set(p) {
          const key = p.type + p.drive;
          if (key !== lastKey) { lastKey = key; shaper.curve = saturationCurve(p.drive, p.type); }
          smooth(pre.gain, 1 + p.drive * 2, ctx);
          smooth(tone.frequency, Math.min(p.tone, ctx.sampleRate / 2 - 100), ctx);
          smooth(out.gain, dbToGain(p.output), ctx);
          wd.setMix(p.mix);
        },
        dispose() { [wd.input, wd.output, wd.dry, wd.wet, pre, shaper, tone, out].forEach(n => n.disconnect()); }
      };
    }
  };

  // ---------------- Auto filter ----------------
  FX_TYPES.filter = {
    name: "Auto Filter",
    category: "Filter",
    params: [
      { id: "type", label: "Type", type: "select", options: ["lowpass", "highpass", "bandpass", "notch"], default: "lowpass" },
      { id: "freq", label: "Cutoff", min: 40, max: 18000, step: 1, default: 2000, unit: "Hz", log: true },
      { id: "q", label: "Resonance", min: 0.1, max: 20, step: 0.1, default: 2 },
      { id: "lfoSync", label: "LFO Sync", type: "select", options: ["Off", ...Object.keys(SYNC_DIVISIONS)], default: "Off" },
      { id: "lfoRate", label: "LFO Rate", min: 0.05, max: 20, step: 0.01, default: 1, unit: "Hz", log: true },
      { id: "lfoDepth", label: "LFO Depth", min: 0, max: 1, step: 0.01, default: 0 },
      { id: "mix", label: "Mix", min: 0, max: 1, step: 0.01, default: 1 },
    ],
    create(ctx) {
      const wd = wetDry(ctx);
      const f = ctx.createBiquadFilter();
      const lfo = ctx.createOscillator(); const lfoGain = ctx.createGain();
      lfo.connect(lfoGain); lfoGain.connect(f.frequency); lfo.start();
      wd.input.connect(f); f.connect(wd.wet);
      return {
        input: wd.input, output: wd.output,
        set(p) {
          f.type = p.type;
          smooth(f.frequency, p.freq, ctx); smooth(f.Q, p.q, ctx);
          const synced = p.lfoSync && p.lfoSync !== "Off" ? syncedSeconds(p.lfoSync) : null;
          smooth(lfo.frequency, synced ? 1 / synced : p.lfoRate, ctx);
          smooth(lfoGain.gain, p.freq * 0.9 * p.lfoDepth, ctx);
          wd.setMix(p.mix);
        },
        dispose() { try { lfo.stop(); } catch (e) {} [wd.input, wd.output, wd.dry, wd.wet, f, lfo, lfoGain].forEach(n => n.disconnect()); }
      };
    }
  };

  // ---------------- Tremolo / auto-pan ----------------
  FX_TYPES.tremolo = {
    name: "Tremolo / Pan",
    category: "Modulation",
    params: [
      { id: "mode", label: "Mode", type: "select", options: ["tremolo", "autopan"], default: "tremolo" },
      { id: "sync", label: "Sync", type: "select", options: ["Off", ...Object.keys(SYNC_DIVISIONS)], default: "1/8" },
      { id: "rate", label: "Rate", min: 0.1, max: 20, step: 0.01, default: 4, unit: "Hz", log: true },
      { id: "depth", label: "Depth", min: 0, max: 1, step: 0.01, default: 0.5 },
    ],
    create(ctx) {
      const input = ctx.createGain();
      const amp = ctx.createGain();
      const pan = ctx.createStereoPanner();
      const lfo = ctx.createOscillator(); const ampDepth = ctx.createGain(); const panDepth = ctx.createGain();
      lfo.connect(ampDepth); ampDepth.connect(amp.gain);
      lfo.connect(panDepth); panDepth.connect(pan.pan);
      lfo.start();
      input.connect(amp); amp.connect(pan);
      return {
        input, output: pan,
        set(p) {
          const synced = p.sync && p.sync !== "Off" ? syncedSeconds(p.sync) : null;
          smooth(lfo.frequency, synced ? 1 / synced : p.rate, ctx);
          if (p.mode === "autopan") {
            smooth(amp.gain, 1, ctx); smooth(ampDepth.gain, 0, ctx); smooth(panDepth.gain, p.depth, ctx);
          } else {
            smooth(amp.gain, 1 - p.depth / 2, ctx); smooth(ampDepth.gain, p.depth / 2, ctx); smooth(panDepth.gain, 0, ctx);
          }
        },
        dispose() { try { lfo.stop(); } catch (e) {} [input, amp, pan, lfo, ampDepth, panDepth].forEach(n => n.disconnect()); }
      };
    }
  };

  // ---------------- Bitcrusher (AudioWorklet) ----------------
  FX_TYPES.bitcrusher = {
    name: "Bitcrusher",
    category: "Color",
    params: [
      { id: "bits", label: "Bits", min: 1, max: 16, step: 1, default: 8 },
      { id: "downsample", label: "Downsample", min: 1, max: 40, step: 1, default: 4 },
      { id: "mix", label: "Mix", min: 0, max: 1, step: 0.01, default: 1 },
    ],
    create(ctx) {
      const wd = wetDry(ctx);
      const node = makeWorklet(ctx, "waw-bitcrusher", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      if (node) { wd.input.connect(node); node.connect(wd.wet); }
      return {
        input: wd.input, output: wd.output, unavailable: !node,
        set(p) {
          if (node) { smooth(node.parameters.get("bits"), p.bits, ctx, 0.001); smooth(node.parameters.get("downsample"), p.downsample, ctx, 0.001); }
          wd.setMix(node ? p.mix : 0);
        },
        dispose() { [wd.input, wd.output, wd.dry, wd.wet].forEach(n => n.disconnect()); node?.disconnect(); }
      };
    }
  };

  // ---------------- Stereo width (mid/side) ----------------
  FX_TYPES.width = {
    name: "Stereo Width",
    category: "Mastering",
    params: [
      { id: "width", label: "Width", min: 0, max: 2, step: 0.01, default: 1.2 },
      { id: "bassMono", label: "Mono Bass", min: 20, max: 300, step: 1, default: 20, unit: "Hz", log: true },
      { id: "output", label: "Output", min: -12, max: 6, step: 0.1, default: 0, unit: "dB" },
    ],
    create(ctx) {
      const input = ctx.createGain();
      const split = ctx.createChannelSplitter(2);
      const merge = ctx.createChannelMerger(2);
      // M = (L+R)/2, S = (L-R)/2 ; L' = M + w*S, R' = M - w*S
      const lToM = ctx.createGain(); lToM.gain.value = 0.5;
      const rToM = ctx.createGain(); rToM.gain.value = 0.5;
      const lToS = ctx.createGain(); lToS.gain.value = 0.5;
      const rToS = ctx.createGain(); rToS.gain.value = -0.5;
      const mid = ctx.createGain(); const side = ctx.createGain();
      const sideHp = ctx.createBiquadFilter(); sideHp.type = "highpass"; sideHp.frequency.value = 20;
      const sideL = ctx.createGain(); const sideR = ctx.createGain();
      const out = ctx.createGain();
      input.connect(split);
      split.connect(lToM, 0); split.connect(rToM, 1); split.connect(lToS, 0); split.connect(rToS, 1);
      lToM.connect(mid); rToM.connect(mid); lToS.connect(side); rToS.connect(side);
      side.connect(sideHp); sideHp.connect(sideL); sideHp.connect(sideR);
      mid.connect(merge, 0, 0); mid.connect(merge, 0, 1);
      sideL.connect(merge, 0, 0); sideR.connect(merge, 0, 1);
      merge.connect(out);
      return {
        input, output: out,
        set(p) {
          smooth(sideL.gain, p.width, ctx); smooth(sideR.gain, -p.width, ctx);
          smooth(sideHp.frequency, p.bassMono, ctx);
          smooth(out.gain, dbToGain(p.output), ctx);
        },
        dispose() { [input, split, merge, lToM, rToM, lToS, rToS, mid, side, sideHp, sideL, sideR, out].forEach(n => n.disconnect()); }
      };
    }
  };

  // ---------------- Utility (gain / phase / mono) ----------------
  FX_TYPES.utility = {
    name: "Utility",
    category: "Utility",
    params: [
      { id: "gain", label: "Gain", min: -36, max: 24, step: 0.1, default: 0, unit: "dB" },
      { id: "invertL", label: "Invert L", type: "toggle", default: false },
      { id: "invertR", label: "Invert R", type: "toggle", default: false },
      { id: "mono", label: "Mono", type: "toggle", default: false },
    ],
    create(ctx) {
      const input = ctx.createGain();
      const split = ctx.createChannelSplitter(2);
      const merge = ctx.createChannelMerger(2);
      const gl = ctx.createGain(), gr = ctx.createGain();
      const monoNode = ctx.createGain();
      const out = ctx.createGain();
      input.connect(split); split.connect(gl, 0); split.connect(gr, 1);
      gl.connect(merge, 0, 0); gr.connect(merge, 0, 1);
      merge.connect(monoNode); monoNode.connect(out);
      return {
        input, output: out,
        set(p) {
          smooth(gl.gain, p.invertL ? -1 : 1, ctx, 0.005); smooth(gr.gain, p.invertR ? -1 : 1, ctx, 0.005);
          monoNode.channelCountMode = "explicit";
          monoNode.channelCount = p.mono ? 1 : 2;
          smooth(out.gain, dbToGain(p.gain), ctx);
        },
        dispose() { [input, split, merge, gl, gr, monoNode, out].forEach(n => n.disconnect()); }
      };
    }
  };

  // =====================================================================
  function defaultParams(type) {
    const def = FX_TYPES[type];
    const p = {};
    (def?.params || []).forEach(s => { p[s.id] = s.default; });
    return p;
  }

  function createInstance(ctx, fx) {
    const def = FX_TYPES[fx.type];
    if (!def) return null;
    const params = { ...defaultParams(fx.type), ...(fx.params || {}) };
    const inst = def.create(ctx, params);
    inst.set(params);
    return inst;
  }

  function newFx(type, params = {}) {
    return {
      id: "fx_" + Math.random().toString(36).slice(2, 9),
      type,
      bypass: false,
      params: { ...defaultParams(type), ...params }
    };
  }

  function formatParam(spec, v) {
    if (spec.type === "toggle") return v ? "On" : "Off";
    if (spec.type === "select") return String(v) + (spec.unit ? " " + spec.unit : "");
    if (spec.unit === "Hz") return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2) + " kHz" : Math.round(v) + " Hz";
    if (spec.unit === "dB") return (v > 0 ? "+" : "") + Number(v).toFixed(1) + " dB";
    if (spec.unit === "ms") return (v < 10 ? Number(v).toFixed(1) : Math.round(v)) + " ms";
    if (spec.unit === ":1") return Number(v).toFixed(1) + ":1";
    if (spec.unit === "s") return Number(v).toFixed(2) + " s";
    if (spec.max <= 1 && spec.min >= 0) return Math.round(v * 100) + "%";
    return Number(v).toFixed(spec.step < 1 ? 2 : 0);
  }

  window.WAWFX = { FX_TYPES, ensureWorklets, makeWorklet, createInstance, newFx, defaultParams, formatParam, dbToGain, saturationCurve, makeImpulse };
})();
