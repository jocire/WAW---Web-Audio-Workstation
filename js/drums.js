// WAW Drum Synth — 100 % real-time synthesis, no samples.
// Modelled on the circuits of classic analog drum machines:
//  * kick/toms/congas: "bridged-T" style resonator = sine with pitch envelope + click
//  * snare: two tuned resonators + filtered noise ("snappy")
//  * hats/cymbal: six detuned square oscillators at metallic ratios -> band-pass/high-pass
//  * cowbell: two square oscillators -> band-pass, two-stage envelope
//  * clap: multi-trigger noise bursts + reverberant tail
(function () {
  "use strict";
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  // the six oscillator frequencies of the 808 metal section (Hz)
  const METAL_FREQS = [205.3, 304.4, 369.6, 522.7, 540, 800];

  const VOICE_DEFAULTS = { tune: 0, decay: 1, level: 1 };

  function voiceSettings(kit, id) {
    return { ...VOICE_DEFAULTS, ...((kit.voices || {})[id] || {}) };
  }

  /**
   * Trigger one drum voice.
   * @param when absolute AudioContext time
   * @returns AudioScheduledSourceNode[] (for stop/cleanup)
   */
  function trigger(ctx, destination, voiceId, velocity, kitIn, when) {
    const kit = kitIn || {};
    const vs = voiceSettings(kit, voiceId);
    const t0 = Math.max(when, ctx.currentTime);
    const vel = clamp(velocity / 127, 0.02, 1.2);
    const pitch = (kit.pitch ?? 1) * Math.pow(2, (vs.tune || 0) / 12);
    const tone = kit.tone ?? 1;
    const decayScale = (kit.decay ?? 1) * (vs.decay ?? 1);
    const punch = kit.punch ?? 0.8;
    const noiseLevel = kit.noise ?? 0.7;
    const snap = kit.snap ?? 0.55;
    const sources = [];

    // voice output -> kit drive -> kit pan -> destination
    const out = ctx.createGain();
    out.gain.value = vel * (kit.gain ?? 1) * (vs.level ?? 1);
    let node = out;
    if ((kit.drive ?? 0) > 0.001) {
      const sh = ctx.createWaveShaper();
      sh.curve = makeDriveCurve(kit.drive);
      sh.oversample = "2x";
      node.connect(sh); node = sh;
    }
    if (ctx.createStereoPanner) {
      const pn = ctx.createStereoPanner();
      pn.pan.value = clamp((kit.pan ?? 0) + (VOICE_PAN[voiceId] || 0) * (kit.stereo ?? 0.5), -1, 1);
      node.connect(pn); node = pn;
    }
    node.connect(destination);

    const env = (gainNode, peak, attack, decay, curve = "exp") => {
      const g = gainNode.gain;
      g.setValueAtTime(0.0001, t0);
      g.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + Math.max(0.0005, attack));
      if (curve === "exp") g.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
      else g.linearRampToValueAtTime(0, t0 + attack + decay);
    };

    // resonator: sine (or triangle) with a fast downward pitch envelope
    const resonator = (freq, decay, peak, bendRatio = 1, bendTime = 0.03, type = "sine") => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq * bendRatio, t0);
      if (bendRatio !== 1) o.frequency.exponentialRampToValueAtTime(freq, t0 + bendTime);
      env(g, peak, 0.0008, decay);
      o.connect(g); g.connect(out);
      o.start(t0); o.stop(t0 + decay + 0.1);
      sources.push(o);
      return o;
    };

    const noise = (decay, peak, type, freq, q = 0.8, attack = 0.0008) => {
      const src = ctx.createBufferSource();
      src.buffer = createNoiseBuffer(ctx, Math.max(0.2, decay + 0.1));
      const f = ctx.createBiquadFilter();
      f.type = type; f.frequency.value = Math.min(freq, ctx.sampleRate / 2 - 200); f.Q.value = q;
      const g = ctx.createGain();
      env(g, peak, attack, decay);
      src.connect(f); f.connect(g); g.connect(out);
      src.start(t0); src.stop(t0 + decay + 0.1);
      sources.push(src);
      return g;
    };

    // six-oscillator metal bank -> band-pass -> high-pass -> envelope
    const metal = (decay, peak, bpFreq, hpFreq, attack = 0.0005) => {
      const sum = ctx.createGain();
      sum.gain.value = 0.18;
      METAL_FREQS.forEach(f => {
        const o = ctx.createOscillator();
        o.type = "square";
        o.frequency.value = f * pitch;
        o.connect(sum);
        o.start(t0); o.stop(t0 + decay + 0.15);
        sources.push(o);
      });
      const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = Math.min(bpFreq, ctx.sampleRate / 2 - 200); bp.Q.value = 0.9;
      const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = Math.min(hpFreq, ctx.sampleRate / 2 - 300);
      const g = ctx.createGain();
      env(g, peak, attack, decay);
      sum.connect(bp); bp.connect(hp); hp.connect(g); g.connect(out);
      return g;
    };

    switch (voiceId) {
      case "kick": {
        const f = 49 * pitch * (0.85 + tone * 0.25);
        resonator(f, 0.42 * decayScale, 1.3, 2.4 + punch * 1.6, 0.025 + (1 - punch) * 0.03);
        // beater click: very short high resonator + filtered noise tick
        resonator(f * 6, 0.012, 0.35 * punch, 1.6, 0.005, "triangle");
        if (noiseLevel > 0.02) noise(0.008, 0.25 * punch * noiseLevel, "lowpass", 3500);
        break;
      }
      case "snare": {
        resonator(180 * pitch, 0.14 * decayScale, 0.55, 1.35, 0.01, "sine");
        resonator(330 * pitch, 0.09 * decayScale, 0.35, 1.25, 0.008, "sine");
        noise((0.12 + 0.2 * decayScale) * (0.6 + snap * 0.6), 0.75 * noiseLevel * (0.5 + snap * 0.8), "highpass", 1800 + tone * 1500);
        noise(0.06, 0.25 * noiseLevel, "bandpass", 5000 + tone * 2000, 1.2);
        break;
      }
      case "clap": {
        // three quick bursts + a longer "reverb" tail (as in the analog circuit)
        [0, 0.011, 0.023].forEach(off => {
          const src = ctx.createBufferSource();
          src.buffer = createNoiseBuffer(ctx, 0.2);
          const f = ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 1100 + tone * 700; f.Q.value = 1.4;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t0 + off);
          g.gain.exponentialRampToValueAtTime(0.5 * noiseLevel, t0 + off + 0.001);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.012 + snap * 0.01);
          src.connect(f); f.connect(g); g.connect(out);
          src.start(t0 + off); src.stop(t0 + off + 0.1);
          sources.push(src);
        });
        noise(0.25 * decayScale + snap * 0.1, 0.32 * noiseLevel, "bandpass", 1200 + tone * 600, 1.1, 0.03);
        break;
      }
      case "rimshot":
        resonator(455 * pitch, 0.03, 0.6, 1, 0.01, "triangle");
        resonator(1667 * pitch, 0.02, 0.45, 1, 0.01, "triangle");
        noise(0.012 + snap * 0.01, 0.25 * noiseLevel, "highpass", 2500);
        break;
      case "closedHat":
        metal((0.03 + (kit.hatDecay ?? 0.45) * 0.08) * (vs.decay ?? 1), 0.85, 10000 * (0.8 + tone * 0.3), 7000);
        noise(0.025, 0.08 * noiseLevel, "highpass", 9000);
        break;
      case "openHat":
        metal((0.18 + (kit.hatDecay ?? 0.45) * 0.55) * (vs.decay ?? 1), 0.7, 10000 * (0.8 + tone * 0.3), 7000);
        noise(0.15, 0.06 * noiseLevel, "highpass", 9000);
        break;
      case "cymbal":
        metal((0.5 + (kit.hatDecay ?? 0.45) * 1.1) * (vs.decay ?? 1), 0.55, 7600 * (0.8 + tone * 0.3), 4500);
        metal(0.12, 0.4, 3600, 2800);
        break;
      case "cowbell": {
        const tune = (kit.cowbellTune ?? 1);
        const sum = ctx.createGain(); sum.gain.value = 0.5;
        [540, 800].forEach(f => {
          const o = ctx.createOscillator(); o.type = "square"; o.frequency.value = f * tune * pitch;
          o.connect(sum); o.start(t0); o.stop(t0 + 0.6 * decayScale + 0.1); sources.push(o);
        });
        const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 2640 * tune; bp.Q.value = 1.5;
        const g = ctx.createGain();
        // two-stage: sharp initial drop, then longer tail
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.9, t0 + 0.001);
        g.gain.exponentialRampToValueAtTime(0.3, t0 + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.03 + 0.4 * decayScale);
        sum.connect(bp); bp.connect(g); g.connect(out);
        break;
      }
      case "claves":
        resonator(2500 * pitch, 0.035 + snap * 0.02, 0.7, 1, 0.01, "sine");
        break;
      case "lowTom": case "midTom": case "highTom": {
        const base = voiceId === "lowTom" ? 90 : voiceId === "midTom" ? 128 : 172;
        resonator(base * pitch, (0.2 + (kit.tomDecay ?? 0.7) * 0.45) * decayScale, 0.85, 1.35, 0.08);
        noise(0.03, 0.08 * noiseLevel, "lowpass", 1800);
        break;
      }
      case "lowConga": case "midConga": case "highConga": {
        const base = voiceId === "lowConga" ? 165 : voiceId === "midConga" ? 250 : 370;
        resonator(base * pitch, (0.12 + (kit.tomDecay ?? 0.7) * 0.18) * decayScale, 0.8, 1.15, 0.015);
        break;
      }
      case "maracas":
        noise(0.03 + snap * 0.03, 0.45 * noiseLevel + 0.1, "highpass", 6000 + tone * 2000, 0.8, 0.004);
        break;
      default:
        noise(0.1, 0.4 * noiseLevel, "highpass", 2400);
    }
    return sources;
  }

  // gentle stereo placement per voice (scaled by kit.stereo)
  const VOICE_PAN = {
    closedHat: 0.35, openHat: 0.35, cymbal: -0.4, lowTom: -0.4, midTom: 0, highTom: 0.4,
    lowConga: -0.5, midConga: -0.2, highConga: 0.2, maracas: 0.55, cowbell: 0.25, claves: -0.3, rimshot: -0.1
  };

  window.WAWDrums = { trigger, METAL_FREQS, VOICE_DEFAULTS, voiceSettings };
})();

// ---------------------------------------------------------------------------
// Per-voice editor in the Drum Synth modal (tune / decay / level per pad)
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  const padsEl = document.getElementById("drum808ModalPads");
  const nameEl = document.getElementById("drumVoiceName");
  const ctrls = ["Tune", "Decay", "Level"].map(k => ({
    key: k.toLowerCase(),
    input: document.getElementById("drumVoice" + k),
    out: document.getElementById("drumVoice" + k + "Val")
  }));
  if (!padsEl || ctrls.some(c => !c.input)) return;
  let selectedId = "kick";

  const kit = () => getActiveTrack()?.drum808Patch;
  const showVoice = () => {
    const voice = DRUM_808_VOICES.find(v => v.id === selectedId) || DRUM_808_VOICES[0];
    nameEl.textContent = voice.label;
    const vs = window.WAWDrums.voiceSettings(kit() || {}, selectedId);
    ctrls.forEach(c => {
      c.input.value = vs[c.key];
      c.out.textContent = Number(vs[c.key]).toFixed(c.key === "tune" ? 1 : 2);
    });
    padsEl.querySelectorAll(".drum808-pad").forEach(p => p.classList.toggle("selected", Number(p.dataset.note) === voice.note));
  };

  padsEl.addEventListener("click", (e) => {
    const pad = e.target.closest(".drum808-pad");
    if (!pad) return;
    const voice = DRUM_808_VOICES.find(v => v.note === Number(pad.dataset.note));
    if (voice) { selectedId = voice.id; showVoice(); }
  });

  ctrls.forEach(c => {
    c.input.addEventListener("pointerdown", () => beginHistoryGesture());
    c.input.addEventListener("input", () => {
      const k = kit();
      if (!k) return;
      k.voices = k.voices || {};
      k.voices[selectedId] = { ...window.WAWDrums.voiceSettings(k, selectedId), [c.key]: parseFloat(c.input.value) };
      drum808State.voices = k.voices;
      c.out.textContent = Number(c.input.value).toFixed(c.key === "tune" ? 1 : 2);
    });
    c.input.addEventListener("change", () => { commitHistoryGesture(); window.WAWCollab?.notifyChange?.(); });
  });

  // refresh whenever the modal opens
  new MutationObserver(() => {
    if (document.getElementById("drum808Modal")?.classList.contains("visible")) showVoice();
  }).observe(document.getElementById("drum808Modal"), { attributes: true, attributeFilter: ["class"] });
});
