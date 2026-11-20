// WAW analog synth factory presets.
// Sound-design recipes in the style of classic 70s/80s analog mono- and
// polysynths. Every preset is a partial patch merged onto the synth defaults
// (WAWSynth.fullPatch), so it only lists what differs.
(function () {
  "use strict";
  // shorthand for envelopes: amp + filter ADSR
  const amp = (a, d, s, r) => ({ attack: a, decay: d, sustain: s, release: r });
  const fenv = (amt, a, d, s, r) => ({ filterEnv: amt, filterAttack: a, filterDecay: d, filterSustain: s, filterRelease: r });
  const P = (name, ...parts) => Object.assign({ name }, ...parts);

  const BANK = {
    Bass: [
      P("Classic Mono Bass", { wave: "sawtooth", osc2Wave: "square", osc2Mix: 0.5, osc2Octave: -1, polyMode: "mono", cutoff: 420, filterQ: 3, filterSlope: 24, keyTrack: 0.3, gain: 0.3 }, amp(0.003, 0.3, 0.75, 0.12), fenv(2400, 0.003, 0.28, 0.15, 0.15)),
      P("Fat Ladder Bass", { wave: "sawtooth", osc2Wave: "sawtooth", osc2Mix: 0.6, osc2Detune: 9, subLevel: 0.5, subWave: "square", polyMode: "mono", cutoff: 300, filterQ: 4, filterSlope: 24, drive: 0.25, gain: 0.28 }, amp(0.002, 0.4, 0.8, 0.1), fenv(3000, 0.002, 0.35, 0.1, 0.1)),
      P("Pulse Bass", { wave: "pulse", pulseWidth: 0.28, subLevel: 0.4, polyMode: "mono", cutoff: 700, filterQ: 2.5, filterSlope: 24, gain: 0.3 }, amp(0.002, 0.25, 0.7, 0.1), fenv(1800, 0.002, 0.2, 0.2, 0.1)),
      P("Acid Squelch", { wave: "sawtooth", polyMode: "mono", glide: 0.06, cutoff: 380, filterQ: 14, filterSlope: 24, keyTrack: 0.2, velToFilter: 0.7, drive: 0.18, gain: 0.15 }, amp(0.002, 0.18, 0.5, 0.08), fenv(4200, 0.002, 0.18, 0, 0.08)),
      P("Acid Square", { wave: "square", polyMode: "mono", glide: 0.05, cutoff: 450, filterQ: 13, filterSlope: 24, velToFilter: 0.7, drive: 0.3, gain: 0.2 }, amp(0.002, 0.2, 0.45, 0.08), fenv(3600, 0.002, 0.22, 0, 0.08)),
      P("Funk Pluck Bass", { wave: "sawtooth", osc2Wave: "pulse", osc2PulseWidth: 0.3, osc2Mix: 0.4, cutoff: 500, filterQ: 5, filterSlope: 24, velToFilter: 0.6, gain: 0.3 }, amp(0.001, 0.22, 0.2, 0.08), fenv(3800, 0.001, 0.12, 0, 0.08)),
      P("Synth Pop Bass", { wave: "sawtooth", unison: 2, unisonDetune: 10, cutoff: 900, filterQ: 2, filterSlope: 24, chorus: 0.15, gain: 0.26 }, amp(0.002, 0.3, 0.6, 0.15), fenv(2200, 0.002, 0.25, 0.2, 0.15)),
      P("Rubber Bass", { wave: "triangle", osc2Wave: "sine", osc2Octave: -1, osc2Mix: 0.6, polyMode: "mono", glide: 0.08, cutoff: 1200, filterQ: 6, gain: 0.32 }, amp(0.003, 0.3, 0.7, 0.12), fenv(1500, 0.003, 0.15, 0.1, 0.1)),
      P("Deep Sub", { wave: "sine", osc2Wave: "triangle", osc2Octave: -1, osc2Mix: 0.3, cutoff: 600, keyTrack: 0, polyMode: "mono", gain: 0.36 }, amp(0.005, 0.2, 0.95, 0.15)),
      P("Reese Growl", { wave: "sawtooth", unison: 3, unisonDetune: 32, osc1Octave: -1, subLevel: 0.5, cutoff: 900, filterQ: 2.5, filterSlope: 24, lfoTarget: "filter", lfoRate: 0.3, lfoAmount: 350, drive: 0.35, gain: 0.24 }, amp(0.01, 0.3, 0.9, 0.2)),
      P("Wobble Machine", { wave: "sawtooth", osc2Wave: "square", osc2Mix: 0.5, osc2Octave: -1, cutoff: 350, filterQ: 9, filterSlope: 24, lfoTarget: "filter", lfoRate: 2.5, lfoAmount: 1000, lfoWave: "triangle", drive: 0.22, gain: 0.14 }, amp(0.005, 0.2, 0.9, 0.15)),
      P("FM Slap Bass", { wave: "sine", osc2Wave: "sine", osc2Mode: "fm", fmAmount: 0.7, osc1Octave: -1, subLevel: 0.25, cutoff: 5000, velToFilter: 0.4, gain: 0.3 }, amp(0.001, 0.35, 0.3, 0.1)),
      P("Hollow Bass", { wave: "pulse", pulseWidth: 0.12, osc2Wave: "triangle", osc2Octave: -1, osc2Mix: 0.5, cutoff: 1100, filterQ: 3, gain: 0.3 }, amp(0.002, 0.3, 0.6, 0.12), fenv(900, 0.002, 0.2, 0.2, 0.1)),
      P("Pedal Bass", { wave: "sawtooth", osc2Wave: "sawtooth", osc2Octave: -1, osc2Mix: 0.7, osc2Detune: 6, polyMode: "mono", glide: 0.1, cutoff: 260, filterQ: 2, filterSlope: 24, keyTrack: 0.2, gain: 0.32 }, amp(0.02, 0.6, 0.85, 0.4), fenv(1400, 0.02, 0.6, 0.3, 0.4)),
      P("Electro Bass", { wave: "square", osc2Wave: "square", osc2Octave: -1, osc2Mix: 0.5, cutoff: 1400, filterQ: 3, drive: 0.25, gain: 0.26 }, amp(0.001, 0.15, 0.4, 0.06), fenv(2500, 0.001, 0.1, 0, 0.06)),
      P("Dub Sine Bass", { wave: "sine", subLevel: 0.3, cutoff: 900, polyMode: "mono", glide: 0.04, gain: 0.36 }, amp(0.006, 0.4, 0.8, 0.25)),
      P("Saw Stack Bass", { wave: "sawtooth", unison: 5, unisonDetune: 20, osc1Octave: -1, cutoff: 700, filterSlope: 24, filterQ: 1.5, gain: 0.2 }, amp(0.003, 0.4, 0.7, 0.15), fenv(2600, 0.003, 0.3, 0.1, 0.12)),
      P("Sync-ish Bass", { wave: "sawtooth", osc2Wave: "sawtooth", osc2Mode: "fm", fmAmount: 0.25, osc2Semi: 7, cutoff: 1600, filterQ: 4, filterSlope: 24, gain: 0.26 }, amp(0.002, 0.25, 0.6, 0.1), fenv(3000, 0.002, 0.2, 0.1, 0.1)),
      P("Plucked Upright", { wave: "triangle", osc2Wave: "sine", osc2Mix: 0.4, cutoff: 800, filterQ: 1.5, keyTrack: 0.5, velToFilter: 0.5, gain: 0.34 }, amp(0.002, 0.6, 0.1, 0.2), fenv(1600, 0.002, 0.15, 0, 0.15)),
      P("Trance Off-Beat", { wave: "sawtooth", unison: 2, unisonDetune: 14, cutoff: 600, filterQ: 3, filterSlope: 24, gain: 0.26 }, amp(0.001, 0.12, 0, 0.06), fenv(3200, 0.001, 0.12, 0, 0.06)),
    ],
    Lead: [
      P("Fat Solo Lead", { wave: "sawtooth", osc2Wave: "sawtooth", osc2Mix: 0.7, osc2Detune: 8, polyMode: "mono", glide: 0.07, cutoff: 1800, filterQ: 3, filterSlope: 24, lfoTarget: "pitch", lfoRate: 5.5, lfoAmount: 14, lfoDelay: 0.6, delaySend: 0.18, gain: 0.24 }, amp(0.005, 0.3, 0.8, 0.2), fenv(3500, 0.005, 0.4, 0.4, 0.2)),
      P("Square Solo", { wave: "square", polyMode: "mono", glide: 0.05, cutoff: 3200, filterQ: 2, lfoTarget: "pitch", lfoRate: 5.8, lfoAmount: 12, lfoDelay: 0.5, delaySend: 0.2, gain: 0.22 }, amp(0.005, 0.2, 0.85, 0.2), fenv(1500, 0.005, 0.3, 0.3, 0.2)),
      P("Pulse Lead", { wave: "pulse", pulseWidth: 0.2, osc2Wave: "pulse", osc2PulseWidth: 0.35, osc2Mix: 0.5, osc2Detune: 7, polyMode: "mono", glide: 0.04, cutoff: 2600, filterQ: 2.5, delaySend: 0.15, gain: 0.22 }, amp(0.004, 0.2, 0.8, 0.2), fenv(2500, 0.004, 0.25, 0.3, 0.2)),
      P("Screaming Sync", { wave: "sawtooth", osc2Wave: "sawtooth", osc2Mode: "fm", fmAmount: 0.45, osc2Semi: 12, polyMode: "mono", glide: 0.04, cutoff: 4500, filterQ: 3, drive: 0.4, delaySend: 0.18, gain: 0.2 }, amp(0.003, 0.3, 0.85, 0.2), fenv(3000, 0.003, 0.5, 0.3, 0.2)),
      P("Prog Rock Lead", { wave: "sawtooth", osc2Wave: "square", osc2Mix: 0.6, osc2Octave: 1, osc2Detune: 5, polyMode: "mono", glide: 0.09, cutoff: 1500, filterQ: 5, filterSlope: 24, drive: 0.2, lfoTarget: "pitch", lfoRate: 6, lfoAmount: 18, lfoDelay: 0.8, gain: 0.22 }, amp(0.01, 0.3, 0.8, 0.25), fenv(4500, 0.01, 0.6, 0.3, 0.25)),
      P("Whistle Lead", { wave: "sine", osc2Wave: "triangle", osc2Octave: 1, osc2Mix: 0.2, polyMode: "mono", glide: 0.06, cutoff: 6000, lfoTarget: "pitch", lfoRate: 5.2, lfoAmount: 10, lfoDelay: 0.4, reverbSend: 0.25, gain: 0.24 }, amp(0.03, 0.2, 0.9, 0.3)),
      P("Chip Lead", { wave: "pulse", pulseWidth: 0.125, polyMode: "mono", cutoff: 12000, lfoTarget: "pitch", lfoRate: 7, lfoAmount: 30, velSens: 0.1, gain: 0.18 }, amp(0.001, 0.05, 0.9, 0.05)),
      P("Supersaw Lead", { wave: "sawtooth", unison: 7, unisonDetune: 38, unisonSpread: 1, cutoff: 7000, filterSlope: 24, delaySend: 0.2, reverbSend: 0.25, gain: 0.16 }, amp(0.005, 0.3, 0.85, 0.3)),
      P("Ring Mod Lead", { wave: "sawtooth", osc2Wave: "sine", osc2Mode: "ring", osc2Mix: 0.6, osc2Semi: 7, cutoff: 5000, filterQ: 2, delaySend: 0.2, gain: 0.22 }, amp(0.005, 0.2, 0.7, 0.2)),
      P("Soft Flute", { wave: "triangle", noise: 0.06, cutoff: 2600, filterQ: 1.2, lfoTarget: "pitch", lfoRate: 4.8, lfoAmount: 8, lfoDelay: 0.5, reverbSend: 0.3, gain: 0.26 }, amp(0.06, 0.2, 0.85, 0.25)),
      P("Hard Square Saw", { wave: "square", osc2Wave: "sawtooth", osc2Mix: 0.6, osc2Detune: 11, cutoff: 5200, filterQ: 1.5, drive: 0.3, gain: 0.2 }, amp(0.002, 0.2, 0.8, 0.15)),
      P("Funky Res Lead", { wave: "sawtooth", polyMode: "mono", cutoff: 700, filterQ: 10, filterSlope: 24, velToFilter: 0.8, gain: 0.22 }, amp(0.003, 0.25, 0.6, 0.15), fenv(4000, 0.003, 0.25, 0.1, 0.15)),
      P("Talk Box", { wave: "sawtooth", osc2Wave: "sawtooth", osc2Mix: 0.5, osc2Detune: 6, filterType: "bandpass", cutoff: 900, filterQ: 6, lfoTarget: "filter", lfoRate: 0.8, lfoAmount: 600, gain: 0.26 }, amp(0.01, 0.2, 0.85, 0.2)),
      P("Mono Glide Saw", { wave: "sawtooth", polyMode: "mono", glide: 0.15, cutoff: 3000, filterQ: 4, filterSlope: 24, gain: 0.23 }, amp(0.005, 0.25, 0.65, 0.15), fenv(2500, 0.005, 0.3, 0.2, 0.15)),
      P("Lucky Lead", { wave: "square", osc2Wave: "sawtooth", osc2Octave: 1, osc2Mix: 0.5, polyMode: "mono", glide: 0.06, cutoff: 1300, filterQ: 3, filterSlope: 24, lfoTarget: "pitch", lfoRate: 5.6, lfoAmount: 16, lfoDelay: 0.7, delaySend: 0.25, reverbSend: 0.2, gain: 0.22 }, amp(0.01, 0.4, 0.85, 0.4), fenv(3800, 0.01, 0.5, 0.45, 0.4)),
      P("Brassy Lead", { wave: "sawtooth", unison: 2, unisonDetune: 12, cutoff: 1200, filterQ: 1.5, filterSlope: 24, gain: 0.22 }, amp(0.04, 0.3, 0.75, 0.2), fenv(3500, 0.06, 0.3, 0.45, 0.2)),
      P("Theremin", { wave: "sine", polyMode: "mono", glide: 0.25, lfoTarget: "pitch", lfoRate: 6.2, lfoAmount: 20, cutoff: 8000, reverbSend: 0.35, gain: 0.26 }, amp(0.08, 0.2, 0.95, 0.4)),
      P("Bit Lead", { wave: "square", osc2Wave: "square", osc2Semi: 12, osc2Mix: 0.4, cutoff: 9000, drive: 0.5, velSens: 0.3, gain: 0.17 }, amp(0.001, 0.08, 0.8, 0.08)),
      P("Mellow Sine Lead", { wave: "sine", osc2Wave: "sine", osc2Octave: 1, osc2Mix: 0.25, polyMode: "mono", glide: 0.05, lfoTarget: "pitch", lfoRate: 5, lfoAmount: 9, lfoDelay: 0.5, delaySend: 0.2, gain: 0.26 }, amp(0.02, 0.2, 0.9, 0.35)),
      P("Fifth Lead", { wave: "sawtooth", osc2Wave: "sawtooth", osc2Semi: 7, osc2Mix: 0.6, cutoff: 3500, filterQ: 2, filterSlope: 24, delaySend: 0.2, gain: 0.2 }, amp(0.005, 0.25, 0.8, 0.25)),
    ],
    Pad: [
      P("Classic Poly Pad", { wave: "sawtooth", unison: 3, unisonDetune: 16, cutoff: 1800, filterQ: 1.2, filterSlope: 24, keyTrack: 0.5, chorus: 0.6, reverbSend: 0.3, gain: 0.17 }, amp(0.6, 0.8, 0.8, 1.2), fenv(1200, 0.8, 1.2, 0.4, 1.2)),
      P("Warm Analog Pad", { wave: "sawtooth", osc2Wave: "pulse", osc2PulseWidth: 0.35, osc2Mix: 0.6, osc2Detune: 7, cutoff: 1500, filterQ: 0.9, filterSlope: 24, chorus: 0.5, reverbSend: 0.35, gain: 0.18 }, amp(0.8, 1, 0.85, 1.5), fenv(900, 1, 1.5, 0.5, 1.5)),
      P("Sweep Pad", { wave: "sawtooth", unison: 3, unisonDetune: 20, cutoff: 500, filterQ: 4, filterSlope: 24, chorus: 0.4, reverbSend: 0.4, gain: 0.17 }, amp(1, 1, 0.85, 2), fenv(4000, 2.5, 3, 0.3, 2)),
      P("Glass Pad", { wave: "triangle", osc2Wave: "sine", osc2Octave: 1, osc2Mix: 0.4, osc2Detune: 5, cutoff: 6000, chorus: 0.5, reverbSend: 0.45, gain: 0.2 }, amp(0.5, 1, 0.8, 1.8)),
      P("Dark Pad", { wave: "sawtooth", osc2Wave: "square", osc2Octave: -1, osc2Mix: 0.5, subLevel: 0.3, cutoff: 700, filterQ: 2, filterSlope: 24, lfoTarget: "filter", lfoRate: 0.15, lfoAmount: 300, lfoWave: "triangle", reverbSend: 0.4, gain: 0.18 }, amp(1.5, 1, 0.9, 2)),
      P("Choir Pad", { wave: "triangle", unison: 4, unisonDetune: 14, filterType: "bandpass", cutoff: 1400, filterQ: 1.4, chorus: 0.4, reverbSend: 0.4, lfoTarget: "pitch", lfoRate: 4.5, lfoAmount: 5, gain: 0.24 }, amp(0.7, 0.7, 0.8, 1.4)),
      P("PWM Pad", { wave: "pulse", pulseWidth: 0.3, osc2Wave: "pulse", osc2PulseWidth: 0.45, osc2Mix: 0.7, osc2Detune: 9, cutoff: 2200, filterSlope: 24, chorus: 0.7, reverbSend: 0.3, gain: 0.18 }, amp(0.5, 0.8, 0.85, 1.2)),
      P("Space Pad", { wave: "sawtooth", unison: 5, unisonDetune: 26, unisonSpread: 1, noise: 0.05, cutoff: 2500, filterSlope: 24, lfoTarget: "filter", lfoRate: 0.2, lfoAmount: 500, delaySend: 0.25, reverbSend: 0.55, gain: 0.15 }, amp(1.4, 1.5, 0.8, 2.5)),
      P("Soft Sine Pad", { wave: "sine", osc2Wave: "sine", osc2Octave: 1, osc2Mix: 0.2, osc2Detune: 8, chorus: 0.5, reverbSend: 0.4, gain: 0.24 }, amp(0.6, 0.6, 0.9, 1.5)),
      P("Eighties Pad", { wave: "sawtooth", osc2Wave: "sawtooth", osc2Detune: 12, osc2Mix: 0.8, cutoff: 2600, filterQ: 1, filterSlope: 24, chorus: 0.75, reverbSend: 0.4, gain: 0.16 }, amp(0.3, 1, 0.8, 1.3), fenv(800, 0.4, 1, 0.5, 1.3)),
      P("Breathing Pad", { wave: "sawtooth", unison: 3, unisonDetune: 15, cutoff: 900, filterQ: 3, filterSlope: 24, lfoTarget: "filter", lfoRate: 0.35, lfoAmount: 700, lfoWave: "sine", chorus: 0.4, reverbSend: 0.35, gain: 0.17 }, amp(0.8, 1, 0.85, 1.5)),
      P("Hollow Pad", { wave: "pulse", pulseWidth: 0.1, osc2Wave: "triangle", osc2Octave: 1, osc2Mix: 0.4, cutoff: 3000, chorus: 0.5, reverbSend: 0.4, gain: 0.2 }, amp(0.6, 1, 0.8, 1.6)),
      P("Shimmer Pad", { wave: "triangle", osc2Wave: "sawtooth", osc2Octave: 2, osc2Mix: 0.15, unison: 3, unisonDetune: 12, cutoff: 7000, delaySend: 0.3, reverbSend: 0.6, gain: 0.18 }, amp(1, 1, 0.8, 2.5)),
      P("Ice Pad", { wave: "sine", osc2Wave: "sine", osc2Mode: "fm", osc2Octave: 2, fmAmount: 0.2, chorus: 0.5, reverbSend: 0.5, gain: 0.22 }, amp(0.4, 1.5, 0.6, 2)),
      P("Analog Strings Pad", { wave: "sawtooth", unison: 5, unisonDetune: 20, unisonSpread: 0.9, cutoff: 3600, filterSlope: 24, lfoTarget: "pitch", lfoRate: 5.3, lfoAmount: 5, chorus: 0.5, reverbSend: 0.35, gain: 0.15 }, amp(0.4, 0.5, 0.85, 1)),
      P("Drifting Pad", { wave: "sawtooth", osc2Wave: "sawtooth", osc2Mix: 0.7, osc2Detune: 15, lfoTarget: "pitch", lfoRate: 0.25, lfoAmount: 12, cutoff: 1700, filterSlope: 24, chorus: 0.4, reverbSend: 0.45, gain: 0.17 }, amp(1.2, 1, 0.85, 2)),
      P("Noise Wash", { wave: "sine", noise: 0.7, filterType: "bandpass", cutoff: 1200, filterQ: 3, lfoTarget: "filter", lfoRate: 0.1, lfoAmount: 800, reverbSend: 0.6, gain: 0.18 }, amp(2, 1, 0.9, 3)),
      P("Velvet Pad", { wave: "triangle", osc2Wave: "sawtooth", osc2Mix: 0.35, osc2Detune: 6, cutoff: 1600, filterQ: 0.8, filterSlope: 24, chorus: 0.6, reverbSend: 0.35, gain: 0.2 }, amp(0.5, 0.8, 0.85, 1.4)),
    ],
    Strings: [
      P("String Machine", { wave: "sawtooth", unison: 5, unisonDetune: 22, unisonSpread: 0.9, cutoff: 4200, filterSlope: 24, lfoTarget: "pitch", lfoRate: 5.2, lfoAmount: 6, chorus: 0.6, reverbSend: 0.3, gain: 0.15 }, amp(0.35, 0.4, 0.85, 0.9)),
      P("Bright Strings", { wave: "sawtooth", unison: 4, unisonDetune: 18, cutoff: 7000, chorus: 0.5, reverbSend: 0.3, gain: 0.15 }, amp(0.15, 0.3, 0.9, 0.7)),
      P("Slow Strings", { wave: "sawtooth", unison: 5, unisonDetune: 24, cutoff: 2800, filterSlope: 24, chorus: 0.6, reverbSend: 0.4, gain: 0.15 }, amp(1.2, 0.5, 0.9, 1.8)),
      P("Octave Strings", { wave: "sawtooth", osc2Wave: "sawtooth", osc2Octave: 1, osc2Mix: 0.5, unison: 3, unisonDetune: 16, cutoff: 5000, chorus: 0.55, reverbSend: 0.3, gain: 0.14 }, amp(0.3, 0.4, 0.85, 0.9)),
      P("Pizzicato", { wave: "sawtooth", unison: 2, unisonDetune: 10, cutoff: 1500, keyTrack: 0.6, reverbSend: 0.3, gain: 0.24 }, amp(0.002, 0.18, 0, 0.15), fenv(3000, 0.002, 0.12, 0, 0.1)),
      P("Cello Section", { wave: "sawtooth", osc1Octave: -1, unison: 3, unisonDetune: 14, cutoff: 1400, filterQ: 1.2, filterSlope: 24, lfoTarget: "pitch", lfoRate: 5, lfoAmount: 7, lfoDelay: 0.4, reverbSend: 0.3, gain: 0.18 }, amp(0.18, 0.4, 0.9, 0.6)),
      P("Lush Ensemble", { wave: "sawtooth", osc2Wave: "pulse", osc2PulseWidth: 0.4, osc2Mix: 0.5, unison: 4, unisonDetune: 20, cutoff: 3500, filterSlope: 24, chorus: 0.8, reverbSend: 0.45, gain: 0.13 }, amp(0.5, 0.6, 0.85, 1.4)),
      P("Tremolo Strings", { wave: "sawtooth", unison: 4, unisonDetune: 18, cutoff: 3800, lfoTarget: "amp", lfoRate: 7, lfoAmount: 600, chorus: 0.4, reverbSend: 0.3, gain: 0.16 }, amp(0.2, 0.3, 0.9, 0.7)),
      P("Synth Violin", { wave: "sawtooth", polyMode: "mono", glide: 0.04, cutoff: 2600, filterQ: 1.5, filterSlope: 24, lfoTarget: "pitch", lfoRate: 5.6, lfoAmount: 14, lfoDelay: 0.5, reverbSend: 0.3, gain: 0.22 }, amp(0.12, 0.3, 0.9, 0.4)),
      P("Dark Ensemble", { wave: "sawtooth", unison: 5, unisonDetune: 22, cutoff: 1200, filterQ: 1.5, filterSlope: 24, chorus: 0.6, reverbSend: 0.5, gain: 0.16 }, amp(0.8, 0.6, 0.9, 1.6)),
    ],
    Brass: [
      P("Poly Brass", { wave: "sawtooth", unison: 2, unisonDetune: 10, cutoff: 900, filterQ: 1.2, filterSlope: 24, velToFilter: 0.5, gain: 0.22 }, amp(0.04, 0.3, 0.75, 0.2), fenv(3600, 0.06, 0.35, 0.35, 0.2)),
      P("Brass Stab", { wave: "sawtooth", osc2Wave: "sawtooth", osc2Mix: 0.6, osc2Detune: 9, cutoff: 1100, filterSlope: 24, velToFilter: 0.6, gain: 0.22 }, amp(0.01, 0.25, 0.4, 0.15), fenv(4200, 0.02, 0.22, 0.1, 0.15)),
      P("Jump Brass", { wave: "sawtooth", osc2Wave: "sawtooth", osc2Detune: 7, osc2Mix: 0.8, cutoff: 1800, filterQ: 1, filterSlope: 24, chorus: 0.3, gain: 0.2 }, amp(0.005, 0.4, 0.7, 0.3), fenv(2800, 0.01, 0.35, 0.4, 0.3)),
      P("Soft Horns", { wave: "sawtooth", cutoff: 700, filterQ: 0.8, filterSlope: 24, lfoTarget: "pitch", lfoRate: 5, lfoAmount: 6, lfoDelay: 0.6, reverbSend: 0.3, gain: 0.24 }, amp(0.12, 0.4, 0.8, 0.4), fenv(1800, 0.15, 0.5, 0.4, 0.4)),
      P("Bright Brass", { wave: "sawtooth", unison: 3, unisonDetune: 12, cutoff: 1500, filterQ: 2, filterSlope: 24, drive: 0.15, gain: 0.2 }, amp(0.03, 0.3, 0.8, 0.25), fenv(5000, 0.05, 0.4, 0.4, 0.25)),
      P("Funk Brass", { wave: "pulse", pulseWidth: 0.35, osc2Wave: "sawtooth", osc2Mix: 0.6, cutoff: 1000, filterSlope: 24, velToFilter: 0.7, gain: 0.22 }, amp(0.005, 0.18, 0.3, 0.1), fenv(4500, 0.01, 0.15, 0.1, 0.1)),
      P("Sync Brass", { wave: "sawtooth", osc2Wave: "sawtooth", osc2Mode: "fm", fmAmount: 0.2, osc2Semi: 12, cutoff: 1400, filterSlope: 24, gain: 0.2 }, amp(0.03, 0.3, 0.75, 0.25), fenv(3500, 0.05, 0.4, 0.3, 0.25)),
      P("Trumpet Lead", { wave: "sawtooth", polyMode: "mono", glide: 0.03, cutoff: 900, filterQ: 1.5, filterSlope: 24, lfoTarget: "pitch", lfoRate: 5.5, lfoAmount: 10, lfoDelay: 0.5, reverbSend: 0.25, gain: 0.24 }, amp(0.04, 0.3, 0.85, 0.2), fenv(3000, 0.05, 0.3, 0.5, 0.2)),
      P("Swell Brass", { wave: "sawtooth", unison: 3, unisonDetune: 14, cutoff: 500, filterSlope: 24, chorus: 0.3, reverbSend: 0.3, gain: 0.2 }, amp(0.6, 0.4, 0.9, 0.5), fenv(3500, 1.2, 0.8, 0.6, 0.5)),
      P("Tuba Bass", { wave: "sawtooth", osc1Octave: -1, cutoff: 400, filterQ: 1.2, filterSlope: 24, gain: 0.3 }, amp(0.04, 0.3, 0.8, 0.2), fenv(1200, 0.05, 0.3, 0.3, 0.2)),
    ],
    Keys: [
      P("FM E-Piano", { wave: "sine", osc2Wave: "sine", osc2Mode: "fm", osc2Octave: 1, fmAmount: 0.35, cutoff: 9000, velToFilter: 0.6, velSens: 0.9, chorus: 0.3, gain: 0.26 }, amp(0.002, 1.1, 0.15, 0.5), fenv(1500, 0.002, 0.6, 0, 0.4)),
      P("Tine Piano", { wave: "sine", osc2Wave: "sine", osc2Mode: "fm", osc2Octave: 2, fmAmount: 0.22, velSens: 0.9, chorus: 0.4, gain: 0.28 }, amp(0.001, 1.6, 0.1, 0.6)),
      P("Analog Piano", { wave: "triangle", osc2Wave: "sawtooth", osc2Mix: 0.3, osc2Detune: 4, cutoff: 1200, keyTrack: 0.7, velToFilter: 0.7, velSens: 0.9, reverbSend: 0.2, gain: 0.26 }, amp(0.002, 1.4, 0.05, 0.5), fenv(3500, 0.002, 0.8, 0.05, 0.4)),
      P("Clav", { wave: "pulse", pulseWidth: 0.15, cutoff: 2200, filterQ: 3, filterType: "bandpass", keyTrack: 0.6, velToFilter: 0.5, gain: 0.26 }, amp(0.001, 0.3, 0.2, 0.08), fenv(2500, 0.001, 0.15, 0, 0.08)),
      P("Synth Keys", { wave: "sawtooth", osc2Wave: "square", osc2Mix: 0.4, cutoff: 2000, filterSlope: 24, velToFilter: 0.5, chorus: 0.3, gain: 0.22 }, amp(0.003, 0.6, 0.4, 0.4), fenv(2000, 0.003, 0.4, 0.2, 0.3)),
      P("Glass Keys", { wave: "triangle", cutoff: 9500, filterQ: 1.6, detune: 3, gain: 0.24 }, amp(0.005, 0.45, 0.22, 0.45)),
      P("Noir Keys", { wave: "triangle", cutoff: 4200, filterQ: 2, detune: 2, gain: 0.24 }, amp(0.015, 0.32, 0.38, 0.62)),
      P("Lo-Fi Keys", { wave: "triangle", osc2Wave: "sine", osc2Mix: 0.3, osc2Octave: 1, cutoff: 2600, filterQ: 1.2, lfoTarget: "pitch", lfoRate: 4.5, lfoAmount: 8, drive: 0.15, gain: 0.25 }, amp(0.008, 0.6, 0.3, 0.4)),
      P("Harpsichord", { wave: "pulse", pulseWidth: 0.25, osc2Wave: "sawtooth", osc2Octave: 1, osc2Mix: 0.4, cutoff: 5000, keyTrack: 0.6, reverbSend: 0.2, gain: 0.22 }, amp(0.001, 0.8, 0, 0.3), fenv(3000, 0.001, 0.3, 0, 0.3)),
      P("Toy Piano", { wave: "sine", osc2Wave: "sine", osc2Mode: "fm", osc2Semi: 19, fmAmount: 0.4, gain: 0.24 }, amp(0.001, 0.5, 0, 0.3)),
      P("Reed Piano", { wave: "triangle", osc2Wave: "square", osc2Mix: 0.2, cutoff: 1800, filterQ: 1.5, velToFilter: 0.7, lfoTarget: "amp", lfoRate: 5, lfoAmount: 250, gain: 0.26 }, amp(0.002, 0.8, 0.3, 0.3), fenv(1800, 0.002, 0.4, 0.1, 0.3)),
      P("Stab Chords", { wave: "sawtooth", unison: 3, unisonDetune: 16, cutoff: 1800, filterSlope: 24, reverbSend: 0.3, delaySend: 0.15, gain: 0.18 }, amp(0.002, 0.25, 0, 0.2), fenv(3500, 0.002, 0.2, 0, 0.15)),
      P("House Chord", { wave: "sawtooth", osc2Wave: "square", osc2Mix: 0.5, cutoff: 1300, filterQ: 3, filterSlope: 24, chorus: 0.3, reverbSend: 0.25, gain: 0.2 }, amp(0.002, 0.35, 0.1, 0.25), fenv(2500, 0.002, 0.25, 0, 0.2)),
      P("Soft Tine EP", { wave: "sine", osc2Wave: "sine", osc2Mode: "fm", osc2Octave: 1, fmAmount: 0.15, chorus: 0.45, reverbSend: 0.25, velSens: 0.9, gain: 0.3 }, amp(0.003, 1.5, 0.3, 0.6)),
    ],
    Organ: [
      P("Drawbar Organ", { wave: "sine", osc2Wave: "sine", osc2Octave: 1, osc2Mix: 0.6, subLevel: 0.6, chorus: 0.4, velSens: 0, gain: 0.22 }, amp(0.005, 0.05, 1, 0.08)),
      P("Rock Organ", { wave: "square", osc2Wave: "sine", osc2Octave: 1, osc2Mix: 0.5, subLevel: 0.4, drive: 0.35, cutoff: 5000, lfoTarget: "amp", lfoRate: 6.5, lfoAmount: 200, velSens: 0, gain: 0.2 }, amp(0.005, 0.05, 1, 0.1)),
      P("Combo Organ", { wave: "pulse", pulseWidth: 0.25, osc2Wave: "square", osc2Octave: 1, osc2Mix: 0.4, cutoff: 4000, lfoTarget: "pitch", lfoRate: 6, lfoAmount: 10, velSens: 0, gain: 0.2 }, amp(0.003, 0.05, 1, 0.06)),
      P("Church Organ", { wave: "sine", osc2Wave: "triangle", osc2Octave: 1, osc2Mix: 0.5, subLevel: 0.8, reverbSend: 0.6, velSens: 0, gain: 0.22 }, amp(0.08, 0.1, 1, 0.6)),
      P("Soft Organ", { wave: "square", cutoff: 6200, filterQ: 1, detune: -7, subLevel: 0.3, velSens: 0, gain: 0.21 }, amp(0.02, 0.08, 0.86, 0.22)),
      P("Percussive Organ", { wave: "sine", osc2Wave: "sine", osc2Semi: 19, osc2Mix: 0.6, subLevel: 0.5, velSens: 0, chorus: 0.3, gain: 0.22 }, amp(0.002, 0.25, 0.75, 0.08)),
    ],
    Pluck: [
      P("Analog Pluck", { wave: "sawtooth", cutoff: 600, filterQ: 3, filterSlope: 24, keyTrack: 0.5, delaySend: 0.2, gain: 0.24 }, amp(0.001, 0.3, 0, 0.2), fenv(4500, 0.001, 0.18, 0, 0.15)),
      P("Bright Pluck", { wave: "square", cutoff: 9000, filterQ: 2.2, gain: 0.22 }, amp(0.005, 0.15, 0, 0.1)),
      P("Trance Pluck", { wave: "sawtooth", unison: 5, unisonDetune: 25, cutoff: 1200, filterSlope: 24, delaySend: 0.3, reverbSend: 0.2, gain: 0.2 }, amp(0.002, 0.25, 0, 0.25), fenv(6000, 0.002, 0.2, 0, 0.2)),
      P("Marimba", { wave: "triangle", cutoff: 5200, filterQ: 3.5, gain: 0.26 }, amp(0.003, 0.22, 0, 0.12)),
      P("Kalimba", { wave: "sine", osc2Wave: "sine", osc2Mode: "fm", osc2Octave: 2, fmAmount: 0.15, cutoff: 8000, reverbSend: 0.2, gain: 0.28 }, amp(0.001, 0.5, 0, 0.4)),
      P("Harp", { wave: "triangle", osc2Wave: "sine", osc2Mix: 0.3, osc2Octave: 1, cutoff: 4500, keyTrack: 0.8, velToFilter: 0.6, reverbSend: 0.35, gain: 0.25 }, amp(0.002, 1.2, 0, 1)),
      P("Pulse Pluck", { wave: "pulse", pulseWidth: 0.2, cutoff: 900, filterQ: 4, filterSlope: 24, delaySend: 0.25, gain: 0.24 }, amp(0.001, 0.2, 0, 0.15), fenv(3500, 0.001, 0.12, 0, 0.1)),
      P("Koto Pluck", { wave: "sawtooth", osc2Wave: "triangle", osc2Octave: 1, osc2Mix: 0.4, cutoff: 1800, filterQ: 4, keyTrack: 0.7, reverbSend: 0.3, gain: 0.24 }, amp(0.001, 0.8, 0, 0.5), fenv(2500, 0.001, 0.25, 0, 0.3)),
      P("Guitar Pluck", { wave: "sawtooth", osc2Wave: "pulse", osc2PulseWidth: 0.3, osc2Mix: 0.4, cutoff: 1400, filterQ: 2, keyTrack: 0.6, drive: 0.2, gain: 0.24 }, amp(0.001, 1, 0.05, 0.3), fenv(3000, 0.001, 0.3, 0, 0.2)),
      P("Pop Pluck", { wave: "square", osc2Wave: "sawtooth", osc2Octave: 1, osc2Mix: 0.3, cutoff: 1600, filterQ: 2, filterSlope: 24, delaySend: 0.25, gain: 0.22 }, amp(0.001, 0.18, 0, 0.12), fenv(3500, 0.001, 0.1, 0, 0.1)),
      P("Water Drop", { wave: "sine", osc2Wave: "sine", osc2Mode: "fm", osc2Octave: 1, fmAmount: 0.6, cutoff: 9000, delaySend: 0.3, reverbSend: 0.3, gain: 0.24 }, amp(0.001, 0.15, 0, 0.1)),
      P("Muted Pluck", { wave: "triangle", cutoff: 900, filterQ: 1.5, keyTrack: 0.5, gain: 0.3 }, amp(0.001, 0.12, 0, 0.08)),
    ],
    Bells: [
      P("FM Bell", { wave: "sine", osc2Wave: "sine", osc2Mode: "fm", osc2Semi: 7, osc2Octave: 1, fmAmount: 0.8, cutoff: 12000, reverbSend: 0.3, gain: 0.22 }, amp(0.001, 1.8, 0, 1.6)),
      P("Tubular Bell", { wave: "sine", osc2Wave: "sine", osc2Mode: "fm", osc2Semi: 9, osc2Octave: 1, fmAmount: 0.6, reverbSend: 0.4, gain: 0.22 }, amp(0.001, 3, 0, 2.5)),
      P("Glockenspiel", { wave: "sine", osc2Wave: "sine", osc2Mode: "fm", osc2Octave: 2, osc2Semi: 3, fmAmount: 0.3, osc1Octave: 1, reverbSend: 0.25, gain: 0.2 }, amp(0.001, 1, 0, 0.8)),
      P("Vibraphone", { wave: "sine", osc2Wave: "sine", osc2Octave: 2, osc2Mix: 0.15, lfoTarget: "amp", lfoRate: 5.5, lfoAmount: 300, reverbSend: 0.3, gain: 0.28 }, amp(0.002, 2, 0, 1.2)),
      P("Ring Bell", { wave: "triangle", osc2Wave: "sine", osc2Mode: "ring", osc2Mix: 0.8, osc2Semi: 11, osc2Octave: 1, reverbSend: 0.4, gain: 0.24 }, amp(0.001, 1.5, 0, 1.5)),
      P("Music Box", { wave: "sine", osc2Wave: "triangle", osc2Octave: 2, osc2Mix: 0.2, osc1Octave: 1, reverbSend: 0.35, gain: 0.24 }, amp(0.001, 0.9, 0, 0.6)),
      P("Celesta", { wave: "triangle", osc2Wave: "sine", osc2Mode: "fm", osc2Octave: 2, fmAmount: 0.18, osc1Octave: 1, reverbSend: 0.3, gain: 0.22 }, amp(0.001, 0.7, 0, 0.5)),
      P("Gamelan", { wave: "sine", osc2Wave: "square", osc2Mode: "ring", osc2Mix: 0.6, osc2Semi: 5, reverbSend: 0.4, gain: 0.22 }, amp(0.001, 1.6, 0, 1.4)),
    ],
    Sequence: [
      P("Berlin Sequence", { wave: "sawtooth", cutoff: 500, filterQ: 6, filterSlope: 24, keyTrack: 0.4, delaySend: 0.3, reverbSend: 0.2, gain: 0.24 }, amp(0.002, 0.2, 0, 0.15), fenv(3000, 0.002, 0.15, 0, 0.12)),
      P("Arp Pulse", { wave: "pulse", pulseWidth: 0.3, cutoff: 1500, filterQ: 3, filterSlope: 24, delaySend: 0.3, gain: 0.22 }, amp(0.001, 0.15, 0.2, 0.1), fenv(2500, 0.001, 0.1, 0, 0.1)),
      P("Bubble Arp", { wave: "square", cutoff: 800, filterQ: 10, filterSlope: 24, keyTrack: 0.6, delaySend: 0.3, gain: 0.22 }, amp(0.001, 0.12, 0, 0.1), fenv(4000, 0.001, 0.08, 0, 0.08)),
      P("Octave Arp", { wave: "sawtooth", osc2Wave: "sawtooth", osc2Octave: 1, osc2Mix: 0.6, cutoff: 1800, filterSlope: 24, delaySend: 0.35, reverbSend: 0.2, gain: 0.2 }, amp(0.001, 0.18, 0.1, 0.12)),
      P("Synthwave Arp", { wave: "sawtooth", unison: 3, unisonDetune: 14, cutoff: 1200, filterQ: 2, filterSlope: 24, chorus: 0.4, delaySend: 0.35, reverbSend: 0.3, gain: 0.2 }, amp(0.001, 0.22, 0.1, 0.2), fenv(3000, 0.001, 0.15, 0, 0.15)),
      P("Blip Seq", { wave: "sine", osc2Wave: "square", osc2Mode: "fm", fmAmount: 0.3, delaySend: 0.3, gain: 0.24 }, amp(0.001, 0.08, 0, 0.05)),
      P("Acid Seq", { wave: "sawtooth", cutoff: 350, filterQ: 15, filterSlope: 24, velToFilter: 0.8, drive: 0.18, delaySend: 0.2, gain: 0.13 }, amp(0.002, 0.15, 0.4, 0.06), fenv(4000, 0.002, 0.15, 0, 0.06)),
      P("Hypno Seq", { wave: "triangle", osc2Wave: "pulse", osc2PulseWidth: 0.2, osc2Mix: 0.5, cutoff: 1100, filterQ: 5, filterSlope: 24, lfoTarget: "filter", lfoRate: 0.2, lfoAmount: 600, delaySend: 0.3, gain: 0.22 }, amp(0.001, 0.2, 0, 0.15)),
    ],
    FX: [
      P("Noise Sweep", { wave: "sine", noise: 0.9, filterType: "bandpass", cutoff: 600, filterQ: 6, reverbSend: 0.5, gain: 0.15 }, amp(1.2, 1, 0.6, 1.5), fenv(6000, 1.5, 1.5, 0.4, 1.5)),
      P("Laser Zap", { wave: "square", osc2Wave: "sawtooth", osc2Mode: "fm", fmAmount: 1, glide: 0.2, cutoff: 12000, gain: 0.2 }, amp(0.001, 0.15, 0, 0.1)),
      P("Riser", { wave: "sawtooth", unison: 5, unisonDetune: 30, noise: 0.3, cutoff: 300, filterSlope: 24, filterQ: 4, reverbSend: 0.4, gain: 0.16 }, amp(3, 0.5, 1, 1), fenv(9000, 4, 1, 1, 1)),
      P("Down Lifter", { wave: "sawtooth", noise: 0.4, cutoff: 9000, filterQ: 3, filterSlope: 24, reverbSend: 0.5, gain: 0.16 }, amp(0.01, 3, 0, 1), fenv(-8000, 0.01, 3, 0, 1)),
      P("Sci-Fi Wobble", { wave: "sine", osc2Wave: "square", osc2Mode: "ring", osc2Mix: 0.7, lfoTarget: "pitch", lfoRate: 8, lfoAmount: 400, delaySend: 0.3, gain: 0.2 }, amp(0.01, 0.5, 0.8, 0.8)),
      P("Wind", { wave: "sine", noise: 1, filterType: "bandpass", cutoff: 900, filterQ: 4, lfoTarget: "filter", lfoRate: 0.25, lfoAmount: 900, reverbSend: 0.5, gain: 0.2 }, amp(1.5, 1, 0.9, 2)),
      P("Alarm", { wave: "square", lfoTarget: "pitch", lfoRate: 4, lfoAmount: 500, lfoWave: "square", cutoff: 4000, gain: 0.16 }, amp(0.001, 0.1, 1, 0.1)),
      P("Space Drone", { wave: "sawtooth", osc2Wave: "sawtooth", osc2Semi: 7, osc2Mix: 0.6, osc1Octave: -1, cutoff: 600, filterQ: 6, filterSlope: 24, lfoTarget: "filter", lfoRate: 0.08, lfoAmount: 900, delaySend: 0.3, reverbSend: 0.6, gain: 0.16 }, amp(2, 1, 1, 3)),
      P("Metallic Hit", { wave: "square", osc2Wave: "square", osc2Mode: "ring", osc2Mix: 0.9, osc2Semi: 6, osc2Octave: 2, reverbSend: 0.3, gain: 0.2 }, amp(0.001, 0.6, 0, 0.5)),
      P("Bird Chirps", { wave: "sine", lfoTarget: "pitch", lfoRate: 12, lfoAmount: 700, lfoWave: "sawtooth", osc1Octave: 2, delaySend: 0.3, gain: 0.18 }, amp(0.01, 0.2, 0.3, 0.2)),
    ],
  };

  // fold in the earlier built-in presets (deduplicated by name)
  function mergeLegacy() {
    const legacy = window.WAWSynth?.PRESETS || {};
    const map = { Basics: "Lead", Keys: "Keys", Pads: "Pad", Leads: "Lead", Bass: "Bass", Plucks: "Pluck", FX: "FX" };
    Object.entries(legacy).forEach(([group, items]) => {
      const cat = map[group] || "FX";
      BANK[cat] = BANK[cat] || [];
      Object.values(items).forEach(p => {
        if (BANK[cat].some(x => x.name === p.name)) return;
        const copy = { ...p };
        // level-match the older presets to the new bank (resonant + driven ones were hot)
        if (copy.name === "Wobble Bass") Object.assign(copy, { gain: 0.12, drive: 0.1, filterQ: 6 });
        BANK[cat].push(copy);
      });
    });
  }
  mergeLegacy();

  /** flat list: [{ id, category, name, patch }] */
  function list() {
    const out = [];
    Object.entries(BANK).forEach(([category, items]) => items.forEach((p, i) => {
      const { name, ...patch } = p;
      out.push({ id: `${category}/${i}`, category, name, patch });
    }));
    return out;
  }

  window.WAWSynthPresets = { BANK, list, categories: () => Object.keys(BANK) };
})();
