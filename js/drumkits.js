// WAW Drum Synth factory kits: kit-wide character + per-instrument settings
// (voices: { id: { tune (semitones), decay, level, tone, snap, pan } }).
// All sounds are synthesized (js/drums.js); nothing is sample based.
(function () {
  "use strict";
  // kits default to a little headroom (0.85); hot / heavily driven kits get less level
  const HOT = new Set(["Trap 808", "Drill", "Hard Techno", "Industrial", "Warehouse", "Miami Bass", "Chip Drums", "Cassette"]);
  const K = (name, kit, voices = {}) => ({ name, kit: { gain: HOT.has(name) ? 0.75 : 0.85, ...kit }, voices });

  const BANK = {
    Classic: [
      K("Analog Classic", { pitch: 1, decay: 1, tone: 1, punch: 0.8, snap: 0.55, noise: 0.7, hatDecay: 0.45, tomDecay: 0.7, drive: 0.12, stereo: 0.5 }),
      K("Long Boom", { pitch: 0.92, decay: 1.6, tone: 0.8, punch: 0.6, snap: 0.5, noise: 0.6, hatDecay: 0.5, tomDecay: 0.9, drive: 0.15 }, { kick: { decay: 2.2, level: 1.15 } }),
      K("Tight Classic", { pitch: 1.08, decay: 0.7, tone: 1.1, punch: 1, snap: 0.7, noise: 0.7, hatDecay: 0.3, tomDecay: 0.5, drive: 0.1 }),
      K("Vintage Machine", { pitch: 0.97, decay: 1.1, tone: 0.75, punch: 0.7, snap: 0.6, noise: 0.85, hatDecay: 0.55, tomDecay: 0.8, drive: 0.25, stereo: 0.3 }),
    ],
    "Electro & Hip Hop": [
      K("Electro Funk", { pitch: 1.05, decay: 0.9, tone: 1.2, punch: 1.1, snap: 0.75, noise: 0.8, hatDecay: 0.35, tomDecay: 0.6, drive: 0.2 }, { clap: { level: 1.15 }, cowbell: { level: 0.9 } }),
      K("Miami Bass", { pitch: 0.88, decay: 1.4, tone: 0.9, punch: 0.9, snap: 0.6, noise: 0.7, hatDecay: 0.4, tomDecay: 0.8, drive: 0.25 }, { kick: { decay: 2.6, level: 1.2, tune: -2 } }),
      K("Boom Bap", { pitch: 0.95, decay: 0.9, tone: 0.7, punch: 1.2, snap: 0.8, noise: 0.9, hatDecay: 0.3, tomDecay: 0.6, drive: 0.35, stereo: 0.25 }, { snare: { tone: 0.6, snap: 0.9 }, closedHat: { level: 0.8 } }),
      K("Breakdance", { pitch: 1.1, decay: 0.8, tone: 1.3, punch: 1, snap: 0.9, noise: 0.85, hatDecay: 0.3, tomDecay: 0.5, drive: 0.2 }, { rimshot: { level: 1.1 }, clap: { snap: 1 } }),
      K("West Coast", { pitch: 0.9, decay: 1.2, tone: 0.85, punch: 0.8, snap: 0.6, noise: 0.6, hatDecay: 0.45, tomDecay: 0.7, drive: 0.2 }, { kick: { decay: 1.8 }, clap: { level: 1.2 } }),
    ],
    "House & Techno": [
      K("Deep House", { pitch: 1, decay: 0.95, tone: 0.9, punch: 0.9, snap: 0.6, noise: 0.6, hatDecay: 0.4, tomDecay: 0.6, drive: 0.1, stereo: 0.6 }, { openHat: { decay: 1.2 }, clap: { level: 1.1 } }),
      K("Warehouse", { pitch: 0.95, decay: 0.8, tone: 1.2, punch: 1.3, snap: 0.75, noise: 0.8, hatDecay: 0.35, tomDecay: 0.5, drive: 0.45, stereo: 0.4 }, { kick: { level: 1.2 }, rimshot: { level: 1.2 } }),
      K("Minimal Click", { pitch: 1.15, decay: 0.55, tone: 1.4, punch: 1.2, snap: 0.5, noise: 0.5, hatDecay: 0.2, tomDecay: 0.4, drive: 0.05, stereo: 0.7 }, { kick: { decay: 0.8 }, claves: { level: 1.2 } }),
      K("Acid Techno", { pitch: 1, decay: 0.85, tone: 1.1, punch: 1.2, snap: 0.7, noise: 0.75, hatDecay: 0.3, tomDecay: 0.6, drive: 0.5 }, { closedHat: { level: 1.1 }, openHat: { decay: 0.8 } }),
      K("Detroit", { pitch: 1.02, decay: 1, tone: 1, punch: 1, snap: 0.65, noise: 0.7, hatDecay: 0.45, tomDecay: 0.7, drive: 0.3, stereo: 0.55 }, { clap: { level: 1.15, snap: 0.8 } }),
      K("Hard Techno", { pitch: 0.92, decay: 0.75, tone: 1.3, punch: 1.5, snap: 0.8, noise: 0.9, hatDecay: 0.25, tomDecay: 0.5, drive: 0.75, stereo: 0.35 }, { kick: { level: 1.3, decay: 1.1 } }),
      K("Disco House", { pitch: 1.03, decay: 1, tone: 1.15, punch: 0.9, snap: 0.6, noise: 0.7, hatDecay: 0.6, tomDecay: 0.7, drive: 0.15, stereo: 0.6 }, { openHat: { decay: 1.3, level: 1.1 }, cowbell: { level: 0.8 } }),
    ],
    "Trap & Modern": [
      K("Trap 808", { pitch: 0.85, decay: 2.2, tone: 0.9, punch: 0.7, snap: 0.75, noise: 0.75, hatDecay: 0.25, tomDecay: 0.8, drive: 0.35, stereo: 0.5 }, { kick: { decay: 3, level: 1.25, tune: -3 }, closedHat: { level: 0.9, tone: 1.3 } }),
      K("Drill", { pitch: 0.9, decay: 1.8, tone: 1, punch: 0.9, snap: 0.9, noise: 0.85, hatDecay: 0.2, tomDecay: 0.6, drive: 0.4 }, { kick: { decay: 2.6, tune: -1 }, snare: { tune: 2, snap: 1 }, rimshot: { level: 1.2 } }),
      K("Future Bass", { pitch: 1.05, decay: 1.2, tone: 1.2, punch: 1, snap: 0.8, noise: 0.7, hatDecay: 0.3, tomDecay: 0.6, drive: 0.25, stereo: 0.8 }, { clap: { level: 1.25 } }),
      K("Reggaeton", { pitch: 1, decay: 1, tone: 1, punch: 1, snap: 0.75, noise: 0.8, hatDecay: 0.35, tomDecay: 0.6, drive: 0.25 }, { snare: { tune: 3, decay: 0.8 }, kick: { level: 1.1 } }),
      K("Footwork", { pitch: 1.1, decay: 1.3, tone: 1.1, punch: 1.1, snap: 0.6, noise: 0.6, hatDecay: 0.25, tomDecay: 0.7, drive: 0.3, stereo: 0.6 }, { kick: { decay: 1.8 }, clap: { level: 1.1 } }),
    ],
    "Lo-Fi & Tape": [
      K("Lo-Fi Dusty", { pitch: 0.95, decay: 0.85, tone: 0.55, punch: 0.7, snap: 0.6, noise: 1, hatDecay: 0.3, tomDecay: 0.6, drive: 0.45, stereo: 0.2 }),
      K("Tape Saturated", { pitch: 0.97, decay: 1, tone: 0.7, punch: 0.9, snap: 0.65, noise: 0.9, hatDecay: 0.4, tomDecay: 0.7, drive: 0.6, stereo: 0.3 }),
      K("Chill Hop", { pitch: 0.93, decay: 0.9, tone: 0.65, punch: 0.6, snap: 0.5, noise: 0.85, hatDecay: 0.35, tomDecay: 0.5, drive: 0.3, stereo: 0.35 }, { snare: { tone: 0.5 }, rimshot: { level: 1.1 } }),
      K("Cassette", { pitch: 1.02, decay: 0.8, tone: 0.5, punch: 0.8, snap: 0.7, noise: 1.1, hatDecay: 0.3, tomDecay: 0.6, drive: 0.7, stereo: 0.15 }),
    ],
    "Funk & Disco": [
      K("Disco Kit", { pitch: 1.04, decay: 1, tone: 1.15, punch: 0.9, snap: 0.6, noise: 0.7, hatDecay: 0.7, tomDecay: 0.9, drive: 0.1, stereo: 0.6 }, { openHat: { decay: 1.4 }, lowTom: { decay: 1.3 }, midTom: { decay: 1.3 }, highTom: { decay: 1.3 } }),
      K("Funk Machine", { pitch: 1.06, decay: 0.85, tone: 1.1, punch: 1, snap: 0.75, noise: 0.75, hatDecay: 0.35, tomDecay: 0.7, drive: 0.2 }, { cowbell: { level: 1 }, rimshot: { level: 1.1 } }),
      K("Synth Pop", { pitch: 1.08, decay: 1.1, tone: 1.2, punch: 0.9, snap: 0.7, noise: 0.75, hatDecay: 0.45, tomDecay: 1, drive: 0.15, stereo: 0.7 }, { snare: { decay: 1.5 }, clap: { level: 1.15 } }),
      K("Synthwave", { pitch: 0.98, decay: 1.4, tone: 1, punch: 1, snap: 0.8, noise: 0.8, hatDecay: 0.4, tomDecay: 1.2, drive: 0.2, stereo: 0.7 }, { snare: { decay: 2, level: 1.15 }, lowTom: { decay: 1.6 } }),
    ],
    "World & Percussion": [
      K("Latin Percussion", { pitch: 1.05, decay: 1, tone: 1.1, punch: 0.8, snap: 0.6, noise: 0.7, hatDecay: 0.4, tomDecay: 0.8, drive: 0.1, stereo: 0.8 }, { lowConga: { level: 1.2 }, midConga: { level: 1.2 }, highConga: { level: 1.2 }, claves: { level: 1.1 }, maracas: { level: 1.2 } }),
      K("Afro Groove", { pitch: 0.98, decay: 1.2, tone: 0.95, punch: 0.8, snap: 0.55, noise: 0.65, hatDecay: 0.45, tomDecay: 1, drive: 0.15, stereo: 0.75 }, { lowTom: { level: 1.1 }, cowbell: { level: 1.1, tune: -2 } }),
      K("Bongo Box", { pitch: 1.15, decay: 0.8, tone: 1.2, punch: 0.7, snap: 0.6, noise: 0.6, hatDecay: 0.3, tomDecay: 0.6, drive: 0.1, stereo: 0.8 }, { highConga: { tune: 4 }, midConga: { tune: 3 } }),
    ],
    Experimental: [
      K("Industrial", { pitch: 0.8, decay: 1.2, tone: 1.4, punch: 1.4, snap: 1, noise: 1.2, hatDecay: 0.6, tomDecay: 0.9, drive: 0.9, stereo: 0.4 }, { cymbal: { tune: -5 }, clap: { decay: 1.8 } }),
      K("Glitch", { pitch: 1.3, decay: 0.45, tone: 1.5, punch: 1.2, snap: 0.4, noise: 0.9, hatDecay: 0.15, tomDecay: 0.3, drive: 0.5, stereo: 1 }, { kick: { tune: 5 }, snare: { tune: 7 }, maracas: { level: 0.85 } }),
      K("Chip Drums", { pitch: 1.25, decay: 0.6, tone: 1.6, punch: 1.3, snap: 0.5, noise: 1, hatDecay: 0.2, tomDecay: 0.4, drive: 0.6, stereo: 0.2 }),
      K("Ambient Soft", { pitch: 0.95, decay: 1.6, tone: 0.6, punch: 0.4, snap: 0.4, noise: 0.5, hatDecay: 0.8, tomDecay: 1.2, drive: 0, stereo: 0.9 }, { kick: { level: 0.85 }, cymbal: { decay: 2 } }),
      K("Pitched Down", { pitch: 0.65, decay: 1.5, tone: 0.8, punch: 0.9, snap: 0.6, noise: 0.8, hatDecay: 0.6, tomDecay: 1, drive: 0.4 }),
    ],
  };

  function list() {
    const out = [];
    Object.entries(BANK).forEach(([category, items]) => items.forEach((k, i) => out.push({ id: `${category}/${i}`, category, ...k })));
    return out;
  }

  window.WAWDrumKits = { BANK, list };
})();
