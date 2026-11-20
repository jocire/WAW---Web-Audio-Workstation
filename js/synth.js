// WAW subtractive/FM synth voice + preset bank.
// One voice builder is shared by live playing, scheduled playback and offline
// WAV rendering (these used to be three diverging copies in app.js).
(function () {
  "use strict";
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

  // Extra parameters added on top of app.js' createDefaultSynthPatch()
  const EXTRA_DEFAULTS = {
    osc1Octave: 0,
    osc2Octave: 0,
    osc2Semi: 0,
    osc2Mode: "mix",      // mix | fm | ring
    fmAmount: 0.3,
    unison: 1,
    unisonDetune: 12,     // cents (total spread)
    unisonSpread: 0.6,    // stereo
    subLevel: 0,
    subWave: "sine",
    filterType: "lowpass",
    filterSlope: 12,      // 12 | 24 dB/oct
    keyTrack: 0.3,
    velSens: 0.8,         // velocity -> amplitude
    velToFilter: 0.2,     // velocity -> cutoff
    lfoWave: "sine",
    polyMode: "poly"      // poly | mono (live playing / glide)
  };

  function fullPatch(patch) {
    const base = typeof createDefaultSynthPatch === "function" ? createDefaultSynthPatch() : {};
    return { ...base, ...EXTRA_DEFAULTS, ...(patch || {}) };
  }

  /**
   * Build one synth voice.
   * @returns {{sources: AudioScheduledSourceNode[], env: GainNode, release: number, stop(time:number): void}}
   * t1 == null -> held note (live playing); call stop(time) to release.
   */
  function buildSynthVoice(ctx, destination, midiNote, velocity, patchIn, t0, t1 = null, opts = {}) {
    const p = fullPatch(patchIn);
    const vel = clamp((velocity ?? 100) / 127, 0, 1);
    const sources = [];
    const freq1 = mtof(midiNote + 12 * (p.osc1Octave || 0));
    const glideFrom = Number.isFinite(opts.glideFrom) && p.glide > 0.001 ? mtof(opts.glideFrom + 12 * (p.osc1Octave || 0)) : null;

    const env = ctx.createGain();
    env.gain.value = 0;
    const voiceIn = ctx.createGain();     // oscillators sum here
    const tremolo = ctx.createGain();     // LFO -> amp
    voiceIn.connect(tremolo);

    // ---- oscillator 1 (with unison) ----
    const unison = clamp(Math.round(p.unison || 1), 1, 7);
    const osc1s = [];
    const uniGain = 1 / Math.sqrt(unison);
    for (let u = 0; u < unison; u++) {
      const o = ctx.createOscillator();
      o.type = p.wave;
      const spreadPos = unison === 1 ? 0 : (u / (unison - 1)) * 2 - 1; // -1..1
      o.detune.value = (p.detune || 0) + spreadPos * (p.unisonDetune || 0) / 2;
      if (glideFrom) {
        o.frequency.setValueAtTime(glideFrom, t0);
        o.frequency.exponentialRampToValueAtTime(freq1, t0 + p.glide);
      } else o.frequency.setValueAtTime(freq1, t0);
      const g = ctx.createGain();
      g.gain.value = uniGain;
      o.connect(g);
      if (unison > 1 && ctx.createStereoPanner) {
        const pan = ctx.createStereoPanner();
        pan.pan.value = spreadPos * (p.unisonSpread ?? 0.6);
        g.connect(pan); pan.connect(voiceIn);
      } else g.connect(voiceIn);
      osc1s.push(o);
      sources.push(o);
    }

    // ---- oscillator 2: mix / FM / ring ----
    const osc2On = p.osc2Wave && p.osc2Wave !== "off";
    if (osc2On) {
      const o2 = ctx.createOscillator();
      o2.type = p.osc2Wave;
      const f2 = mtof(midiNote + 12 * (p.osc2Octave || 0) + (p.osc2Semi || 0));
      o2.frequency.setValueAtTime(f2, t0);
      o2.detune.value = (p.detune || 0) + (p.osc2Detune || 0);
      sources.push(o2);
      if (p.osc2Mode === "fm") {
        const fm = ctx.createGain();
        // modulation index scales with carrier frequency
        fm.gain.value = (p.fmAmount ?? 0.3) * freq1 * 4;
        o2.connect(fm);
        osc1s.forEach(o => fm.connect(o.frequency));
        // optionally also hear some of osc2
        if ((p.osc2Mix ?? 0) > 0.001) { const g2 = ctx.createGain(); g2.gain.value = p.osc2Mix * 0.5; o2.connect(g2); g2.connect(voiceIn); }
      } else if (p.osc2Mode === "ring") {
        // osc1 * osc2 : route voiceIn through a gain whose gain is driven by osc2
        const ring = ctx.createGain();
        ring.gain.value = 0;
        o2.connect(ring.gain);
        const ringAmt = ctx.createGain(); ringAmt.gain.value = clamp(p.osc2Mix ?? 0.5, 0, 1);
        const dryAmt = ctx.createGain(); dryAmt.gain.value = 1 - clamp(p.osc2Mix ?? 0.5, 0, 1);
        voiceIn.disconnect();
        voiceIn.connect(ring); ring.connect(ringAmt); ringAmt.connect(tremolo);
        voiceIn.connect(dryAmt); dryAmt.connect(tremolo);
      } else if ((p.osc2Mix ?? 0) > 0.001) {
        const g2 = ctx.createGain();
        g2.gain.value = p.osc2Mix;
        o2.connect(g2); g2.connect(voiceIn);
      }
    }

    // ---- sub oscillator ----
    if ((p.subLevel ?? 0) > 0.001) {
      const sub = ctx.createOscillator();
      sub.type = p.subWave || "sine";
      sub.frequency.setValueAtTime(freq1 / 2, t0);
      const sg = ctx.createGain(); sg.gain.value = p.subLevel * 0.8;
      sub.connect(sg); sg.connect(voiceIn);
      sources.push(sub);
    }

    // ---- noise ----
    if ((p.noise ?? 0) > 0.001) {
      const n = ctx.createBufferSource();
      n.buffer = createNoiseBuffer(ctx, t1 == null ? 2 : Math.max(0.05, t1 - t0 + (p.release || 0) + 0.1));
      n.loop = t1 == null;
      const ng = ctx.createGain(); ng.gain.value = p.noise;
      n.connect(ng); ng.connect(voiceIn);
      sources.push(n);
    }

    // ---- filter (12/24 dB) with key tracking + velocity + envelope ----
    const f1 = ctx.createBiquadFilter();
    f1.type = p.filterType || "lowpass";
    f1.Q.value = p.filterQ ?? 0.8;
    let filterOut = f1;
    let f2 = null;
    if (Number(p.filterSlope) === 24) {
      f2 = ctx.createBiquadFilter();
      f2.type = f1.type;
      f2.Q.value = Math.max(0.5, (p.filterQ ?? 0.8) * 0.6);
      f1.connect(f2);
      filterOut = f2;
    }
    const keyMul = Math.pow(2, ((midiNote - 60) / 12) * (p.keyTrack ?? 0));
    const velMul = 1 + (p.velToFilter ?? 0) * (vel - 0.6) * 2;
    const nyq = ctx.sampleRate / 2 - 100;
    const cutoff = clamp((p.cutoff || 8000) * keyMul * velMul, 30, nyq);
    const envPeak = clamp(cutoff + (p.filterEnv || 0) * velMul, 30, nyq);
    const fA = Math.max(0.001, p.filterAttack ?? 0.01);
    const fD = Math.max(0.001, p.filterDecay ?? 0.25);
    [f1, f2].forEach(f => {
      if (!f) return;
      f.frequency.setValueAtTime(cutoff, t0);
      f.frequency.linearRampToValueAtTime(envPeak, t0 + fA);
      f.frequency.linearRampToValueAtTime(cutoff, t0 + fA + fD);
    });

    // ---- amp envelope ----
    const velAmp = (1 - (p.velSens ?? 0.8)) + (p.velSens ?? 0.8) * Math.max(0.05, vel);
    const peak = velAmp * (p.gain ?? 0.25);
    const A = Math.max(0.001, p.attack ?? 0.01);
    const D = Math.max(0.001, p.decay ?? 0.1);
    const S = clamp(p.sustain ?? 0.8, 0, 1);
    const R = Math.max(0.005, p.release ?? 0.25);
    env.gain.setValueAtTime(0, t0);
    if (t1 == null) {
      // held note: attack + decay, release happens in stop()
      env.gain.linearRampToValueAtTime(peak, t0 + A);
      env.gain.linearRampToValueAtTime(peak * S, t0 + A + D);
    } else {
      // scheduled note: compute the envelope explicitly so notes shorter than
      // attack+decay release from the level they actually reached
      const end = Math.max(t1, t0 + 0.005);
      if (end >= t0 + A + D) {
        env.gain.linearRampToValueAtTime(peak, t0 + A);
        env.gain.linearRampToValueAtTime(peak * S, t0 + A + D);
        env.gain.setValueAtTime(peak * S, end);
      } else if (end >= t0 + A) {
        env.gain.linearRampToValueAtTime(peak, t0 + A);
        env.gain.linearRampToValueAtTime(peak + (peak * S - peak) * ((end - t0 - A) / D), end);
      } else {
        env.gain.linearRampToValueAtTime(peak * ((end - t0) / A), end);
      }
      env.gain.linearRampToValueAtTime(0, end + R);
    }

    tremolo.connect(f1);
    filterOut.connect(env);

    // ---- per-voice pan (patch pan + LFO pan) ----
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) { pan.pan.value = clamp(p.pan ?? 0, -1, 1); env.connect(pan); }
    const outNode = pan || env;

    // ---- LFO ----
    if ((p.lfoRate ?? 0) > 0.001 && (p.lfoAmount ?? 0) > 0.001) {
      const lfo = ctx.createOscillator();
      lfo.type = p.lfoWave || "sine";
      lfo.frequency.value = p.lfoRate;
      const lg = ctx.createGain();
      lfo.connect(lg);
      const amt = p.lfoAmount; // 0..1000 in the UI
      switch (p.lfoTarget) {
        case "filter":
          lg.gain.value = amt;
          lg.connect(f1.frequency); if (f2) lg.connect(f2.frequency);
          break;
        case "amp":
          tremolo.gain.value = 1 - Math.min(0.5, amt / 2000);
          lg.gain.value = Math.min(0.5, amt / 2000);
          lg.connect(tremolo.gain);
          break;
        case "pan":
          lg.gain.value = Math.min(1, amt / 1000);
          if (pan) lg.connect(pan.pan);
          break;
        default: // pitch (cents)
          lg.gain.value = amt;
          osc1s.forEach(o => lg.connect(o.detune));
      }
      sources.push(lfo);
    }

    // drive / chorus / delay / space are patch-level colour FX (shared helper in app.js)
    connectSynthOutput(ctx, outNode, destination, { ...p, pan: 0 }, 0);

    sources.forEach(s => s.start(t0));

    const voice = {
      sources, env, release: R,
      stop(time) {
        const t = Math.max(time, ctx.currentTime);
        try {
          env.gain.cancelScheduledValues(t);
          // hold the current value then release
          const cur = env.gain.value;
          env.gain.setValueAtTime(cur, t);
          env.gain.linearRampToValueAtTime(0, t + R);
        } catch (e) {}
        sources.forEach(s => { try { s.stop(t + R + 0.05); } catch (e) {} });
      }
    };

    if (t1 != null) {
      const end = Math.max(t1, t0 + 0.005);
      sources.forEach(s => s.stop(end + R + 0.05));
    }
    return voice;
  }

  // ---------------------------------------------------------------------------
  // Preset bank (partial patches merged onto the defaults)
  // ---------------------------------------------------------------------------
  const PRESETS = {
    Basics: {
      init: { name: "Init" },
      softSine: { name: "Soft Sine", wave: "sine", attack: 0.02, decay: 0.15, sustain: 0.85, release: 0.35, cutoff: 6000, gain: 0.22 },
    },
    Keys: {
      glassKeys: { name: "Glass Keys", wave: "triangle", attack: 0.005, decay: 0.45, sustain: 0.22, release: 0.45, cutoff: 9500, filterQ: 1.6, detune: 3, gain: 0.24 },
      noirKeys: { name: "Noir Keys", wave: "triangle", attack: 0.015, decay: 0.32, sustain: 0.38, release: 0.62, cutoff: 4200, filterQ: 2, detune: 2, gain: 0.24 },
      softOrgan: { name: "Soft Organ", wave: "square", attack: 0.02, decay: 0.08, sustain: 0.86, release: 0.22, cutoff: 6200, filterQ: 1, detune: -7, subLevel: 0.3, gain: 0.21 },
      fmEpiano: { name: "FM E-Piano", wave: "sine", osc2Wave: "sine", osc2Mode: "fm", osc2Octave: 1, fmAmount: 0.35, attack: 0.002, decay: 1.1, sustain: 0.15, release: 0.5, cutoff: 9000, filterEnv: 1500, filterDecay: 0.6, velToFilter: 0.6, velSens: 0.9, chorus: 0.3, gain: 0.26 },
      lofiKeys: { name: "Lo-Fi Keys", wave: "triangle", osc2Wave: "sine", osc2Mix: 0.3, osc2Octave: 1, attack: 0.008, decay: 0.6, sustain: 0.3, release: 0.4, cutoff: 2600, filterQ: 1.2, lfoTarget: "pitch", lfoRate: 4.5, lfoAmount: 8, drive: 0.15, gain: 0.25 },
      fmBell: { name: "FM Bell", wave: "sine", osc2Wave: "sine", osc2Mode: "fm", osc2Semi: 7, osc2Octave: 1, fmAmount: 0.8, attack: 0.001, decay: 1.8, sustain: 0, release: 1.6, cutoff: 12000, reverbSend: 0.3, gain: 0.22 },
    },
    Pads: {
      warmPad: { name: "Warm Pad", wave: "triangle", attack: 0.4, decay: 0.5, sustain: 0.9, release: 1, cutoff: 5000, filterQ: 0.6, detune: -4, osc2Wave: "sine", osc2Mix: 0.28, osc2Detune: 7, chorus: 0.42, reverbSend: 0.28, gain: 0.2 },
      slowChoir: { name: "Slow Choir", wave: "triangle", attack: 0.75, decay: 0.65, sustain: 0.78, release: 1.4, cutoff: 3600, filterQ: 1.1, detune: 6, filterType: "bandpass", filterQ2: 1, unison: 3, unisonDetune: 14, gain: 0.22 },
      airPad: { name: "Air Pad", wave: "sine", attack: 0.9, decay: 0.8, sustain: 0.82, release: 1.8, cutoff: 7200, filterQ: 0.5, detune: 8, osc2Wave: "triangle", osc2Mix: 0.24, osc2Detune: -9, noise: 0.04, chorus: 0.55, reverbSend: 0.45, gain: 0.18 },
      junoPad: { name: "Poly Pad", wave: "sawtooth", unison: 3, unisonDetune: 18, attack: 0.5, decay: 0.8, sustain: 0.75, release: 1.2, cutoff: 2400, filterQ: 1.4, filterSlope: 24, keyTrack: 0.5, chorus: 0.6, lfoTarget: "filter", lfoRate: 0.3, lfoAmount: 300, gain: 0.17 },
      strings: { name: "String Ensemble", wave: "sawtooth", unison: 5, unisonDetune: 22, unisonSpread: 0.9, attack: 0.35, decay: 0.4, sustain: 0.85, release: 0.9, cutoff: 4200, filterSlope: 24, lfoTarget: "pitch", lfoRate: 5.2, lfoAmount: 6, chorus: 0.4, reverbSend: 0.3, gain: 0.15 },
      dronePad: { name: "Dark Drone", wave: "sawtooth", osc2Wave: "square", osc2Mix: 0.4, osc2Octave: -1, subLevel: 0.4, attack: 1.5, decay: 1, sustain: 0.9, release: 2, cutoff: 900, filterQ: 3, filterSlope: 24, lfoTarget: "filter", lfoRate: 0.12, lfoAmount: 500, lfoWave: "triangle", reverbSend: 0.4, gain: 0.18 },
    },
    Leads: {
      sawLead: { name: "Saw Lead", wave: "sawtooth", attack: 0.01, decay: 0.18, sustain: 0.7, release: 0.25, cutoff: 10000, filterQ: 1.4, detune: -3, osc2Wave: "sawtooth", osc2Mix: 0.22, osc2Detune: 9, drive: 0.18, delaySend: 0.14, gain: 0.24 },
      squareLead: { name: "Square Lead", wave: "square", attack: 0.008, decay: 0.12, sustain: 0.65, release: 0.18, cutoff: 7600, filterQ: 1.8, detune: 4, gain: 0.23 },
      supersaw: { name: "Supersaw", wave: "sawtooth", unison: 7, unisonDetune: 35, unisonSpread: 1, attack: 0.01, decay: 0.3, sustain: 0.8, release: 0.35, cutoff: 9000, filterSlope: 24, subLevel: 0.25, reverbSend: 0.2, gain: 0.16 },
      chipLead: { name: "Chiptune", wave: "square", osc2Wave: "square", osc2Mix: 0.3, osc2Octave: 1, attack: 0.001, decay: 0.05, sustain: 0.9, release: 0.05, cutoff: 12000, lfoTarget: "pitch", lfoRate: 6, lfoAmount: 25, velSens: 0.2, gain: 0.18 },
      ringLead: { name: "Ring Mod Lead", wave: "sawtooth", osc2Wave: "sine", osc2Mode: "ring", osc2Mix: 0.6, osc2Semi: 7, attack: 0.005, decay: 0.2, sustain: 0.7, release: 0.2, cutoff: 6000, filterQ: 2, delaySend: 0.2, gain: 0.22 },
      monoGlide: { name: "Mono Glide", wave: "sawtooth", polyMode: "mono", glide: 0.12, attack: 0.005, decay: 0.25, sustain: 0.6, release: 0.15, cutoff: 3200, filterQ: 4, filterEnv: 2500, filterDecay: 0.3, filterSlope: 24, gain: 0.24 },
      brass: { name: "Brass Stab", wave: "sawtooth", unison: 2, unisonDetune: 10, attack: 0.04, decay: 0.3, sustain: 0.6, release: 0.2, cutoff: 1400, filterEnv: 3200, filterAttack: 0.06, filterDecay: 0.35, velToFilter: 0.5, gain: 0.22 },
    },
    Bass: {
      analogBass: { name: "Analog Bass", wave: "square", attack: 0.01, decay: 0.2, sustain: 0.8, release: 0.15, cutoff: 3000, filterQ: 1.2, detune: -2, osc2Wave: "square", osc2Mix: 0.18, osc2Detune: -12, drive: 0.12, gain: 0.28 },
      subBass: { name: "Sub Bass", wave: "sine", attack: 0.01, decay: 0.18, sustain: 0.9, release: 0.18, cutoff: 1400, filterQ: 0.9, osc2Wave: "sine", osc2Mix: 0.22, osc2Detune: -12, gain: 0.34, keyTrack: 0 },
      acidBass: { name: "Acid Bass", wave: "sawtooth", attack: 0.005, decay: 0.12, sustain: 0.45, release: 0.08, cutoff: 2200, filterQ: 6.5, detune: 5, filterEnv: 3600, filterAttack: 0.01, filterDecay: 0.22, lfoTarget: "filter", lfoRate: 3.8, lfoAmount: 420, drive: 0.32, gain: 0.28 },
      pluckBass: { name: "Pluck Bass", wave: "square", attack: 0.004, decay: 0.18, sustain: 0.12, release: 0.1, cutoff: 2600, filterQ: 4, filterEnv: 1800, filterAttack: 0.005, filterDecay: 0.16, drive: 0.18, gain: 0.3 },
      reese: { name: "Reese Bass", wave: "sawtooth", unison: 2, unisonDetune: 28, osc1Octave: -1, subLevel: 0.5, attack: 0.01, decay: 0.3, sustain: 0.9, release: 0.2, cutoff: 1100, filterQ: 2, filterSlope: 24, lfoTarget: "filter", lfoRate: 0.25, lfoAmount: 250, drive: 0.3, gain: 0.24 },
      wobble: { name: "Wobble Bass", wave: "sawtooth", osc2Wave: "square", osc2Mix: 0.5, osc2Octave: -1, attack: 0.005, decay: 0.2, sustain: 0.9, release: 0.15, cutoff: 500, filterQ: 8, filterSlope: 24, lfoTarget: "filter", lfoRate: 3, lfoAmount: 900, lfoWave: "triangle", drive: 0.4, gain: 0.24 },
      fmBass: { name: "FM Bass", wave: "sine", osc2Wave: "sine", osc2Mode: "fm", osc2Octave: 0, fmAmount: 0.6, osc1Octave: -1, attack: 0.002, decay: 0.35, sustain: 0.4, release: 0.1, cutoff: 5000, velToFilter: 0.4, subLevel: 0.3, gain: 0.3 },
    },
    Plucks: {
      brightPluck: { name: "Bright Pluck", wave: "square", attack: 0.005, decay: 0.15, sustain: 0, release: 0.1, cutoff: 9000, filterQ: 2.2, gain: 0.22 },
      marimbaPluck: { name: "Marimba Pluck", wave: "triangle", attack: 0.003, decay: 0.22, sustain: 0, release: 0.12, cutoff: 5200, filterQ: 3.5, gain: 0.26 },
      tranceePluck: { name: "Trance Pluck", wave: "sawtooth", unison: 5, unisonDetune: 25, attack: 0.002, decay: 0.25, sustain: 0, release: 0.25, cutoff: 1200, filterEnv: 6000, filterDecay: 0.2, filterSlope: 24, delaySend: 0.3, reverbSend: 0.2, gain: 0.2 },
      kalimba: { name: "Kalimba", wave: "sine", osc2Wave: "sine", osc2Mode: "fm", osc2Octave: 2, fmAmount: 0.15, attack: 0.001, decay: 0.5, sustain: 0, release: 0.4, cutoff: 8000, reverbSend: 0.2, gain: 0.28 },
      harp: { name: "Harp", wave: "triangle", osc2Wave: "sine", osc2Mix: 0.3, osc2Octave: 1, attack: 0.002, decay: 1.2, sustain: 0, release: 1, cutoff: 4500, keyTrack: 0.8, velToFilter: 0.6, reverbSend: 0.35, gain: 0.25 },
    },
    FX: {
      noiseSweep: { name: "Noise Sweep", wave: "sine", noise: 0.9, gain: 0.15, attack: 1.2, decay: 1, sustain: 0.6, release: 1.5, cutoff: 600, filterType: "bandpass", filterQ: 6, filterEnv: 6000, filterAttack: 1.5, filterDecay: 1.5, reverbSend: 0.5 },
      laserZap: { name: "Laser Zap", wave: "square", osc2Wave: "sawtooth", osc2Mode: "fm", fmAmount: 1, attack: 0.001, decay: 0.15, sustain: 0, release: 0.1, cutoff: 12000, glide: 0.2, gain: 0.2 },
    }
  };

  function presetPatch(id) {
    for (const group of Object.values(PRESETS)) {
      if (group[id]) { const { name, ...rest } = group[id]; void name; return fullPatch(rest); }
    }
    return null;
  }

  function buildPresetOptions(selectEl) {
    if (!selectEl) return;
    selectEl.innerHTML = Object.entries(PRESETS).map(([g, items]) =>
      `<optgroup label="${g}">${Object.entries(items).map(([id, p]) => `<option value="${id}">${escapeHtml(p.name)}</option>`).join("")}</optgroup>`
    ).join("");
  }

  // ---------------------------------------------------------------------------
  // Extra synth UI controls (anything with data-synth-param in the synth modal)
  // ---------------------------------------------------------------------------
  function readExtraParams(target) {
    document.querySelectorAll("#synthControls [data-synth-param]").forEach(el => {
      const key = el.dataset.synthParam;
      if (el.tagName === "SELECT") {
        const num = Number(el.value);
        target[key] = el.dataset.numeric === "true" && Number.isFinite(num) ? num : el.value;
      } else if (el.type === "checkbox") target[key] = el.checked;
      else target[key] = parseFloat(el.value);
      const out = document.getElementById(el.id + "Val");
      if (out) out.textContent = formatExtra(key, target[key]);
    });
  }

  function writeExtraParams(patch) {
    const p = fullPatch(patch);
    document.querySelectorAll("#synthControls [data-synth-param]").forEach(el => {
      const key = el.dataset.synthParam;
      if (el.type === "checkbox") el.checked = !!p[key];
      else el.value = p[key];
      const out = document.getElementById(el.id + "Val");
      if (out) out.textContent = formatExtra(key, p[key]);
    });
    return p;
  }

  function formatExtra(key, v) {
    if (typeof v !== "number") return String(v);
    if (key === "unisonDetune") return Math.round(v) + "c";
    if (key === "unison" || key.endsWith("Octave") || key === "osc2Semi") return (v > 0 && key !== "unison" ? "+" : "") + Math.round(v);
    return v.toFixed(2);
  }

  function attachExtraControlHandlers() {
    document.querySelectorAll("#synthControls [data-synth-param]").forEach(el => {
      el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => updateSynthFromUI());
    });
  }

  window.WAWSynth = { EXTRA_DEFAULTS, fullPatch, buildSynthVoice, PRESETS, presetPatch, buildPresetOptions, readExtraParams, writeExtraParams, attachExtraControlHandlers };
})();

document.addEventListener("DOMContentLoaded", () => {
  const sel = document.getElementById("synthPreset");
  if (sel) {
    window.WAWSynth.buildPresetOptions(sel);
    if (typeof renderCustomSynthPresets === "function") renderCustomSynthPresets();
  }
  window.WAWSynth.attachExtraControlHandlers();
});
