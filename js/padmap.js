// WAW pad controller mapping: which MIDI notes and computer keys trigger the 16
// pads of the Sampler and the Drum Synth.
//
// The map is a property of the user's controller, not of the song, so it is
// stored in this browser (localStorage) and shared by every project:
//   { midi: { "<note>": padIndex }, keys: { "<KeyboardEvent.code>": padIndex } }
// Incoming notes / keys are translated to the pad's own note (Sampler: 36+pad,
// Drum Synth: its GM drum note), so recorded clips stay standard and play the
// same on any setup. Unmapped MIDI notes pass through unchanged (so a GM drum
// controller keeps working without learning anything).
(function () {
  "use strict";
  const LS = "waw.padMap";
  const PADS = 16;
  const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const noteName = n => `${NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
  const defaultKeys = () => Object.fromEntries(PAD_KEY_CODES.map((c, i) => [c, i]));

  let map = load();
  function load() {
    try {
      const m = JSON.parse(localStorage.getItem(LS) || "{}");
      const keys = m.keys && Object.keys(m.keys).length ? m.keys : defaultKeys();
      return { midi: m.midi && typeof m.midi === "object" ? m.midi : {}, keys };
    } catch (e) { return { midi: {}, keys: defaultKeys() }; }
  }
  function save() { try { localStorage.setItem(LS, JSON.stringify(map)); } catch (e) {} changed(); }

  const listeners = new Set();
  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function changed() { listeners.forEach(fn => { try { fn(); } catch (e) {} }); }

  /** "sampler" | "808" when the active track is a pad instrument */
  function padInstrument() {
    const t = getActiveTrack();
    if (!t || t.type === "audio") return null;
    return t.instrument === "sampler" || t.instrument === "808" ? t.instrument : null;
  }
  function padNote(inst, pad) { return inst === "808" ? DRUM_808_VOICES[pad].note : 36 + pad; }

  /** translate an incoming controller note for the active pad instrument */
  function translate(note) {
    const inst = padInstrument();
    if (!inst) return note;
    const pad = map.midi[note];
    return pad == null ? note : padNote(inst, pad);
  }
  /** pad note for a computer key (null when the key is not mapped or no pad instrument is active) */
  function keyNote(code) {
    const inst = padInstrument();
    const pad = map.keys[code];
    return inst && pad != null ? padNote(inst, pad) : null;
  }

  // labels for the pad buttons
  function keyLabel(pad) {
    const code = Object.keys(map.keys).find(c => map.keys[c] === pad);
    if (!code) return "–";
    return code.replace(/^Key|^Digit/, "").replace(/^Numpad/, "Num").replace(/^Arrow/, "↑").slice(0, 5);
  }
  function midiLabel(pad, inst = "sampler") {
    const learned = Object.keys(map.midi).filter(n => map.midi[n] === pad).map(Number);
    if (learned.length) return noteName(learned[0]);
    return noteName(padNote(inst, pad));
  }
  function isLearned(pad) { return Object.values(map.midi).includes(pad); }

  // ---------------------------------------------------------------------------
  // learn mode
  // ---------------------------------------------------------------------------
  const learn = { mode: null, pad: null };
  function startLearn(mode, pad = 0) {
    learn.mode = mode; learn.pad = pad;
    statusEl.textContent = mode === "midi"
      ? `MIDI Learn: hit the controller pad for pad ${pad + 1} (click another pad to choose it, Esc to finish).`
      : `Key Learn: press the key for pad ${pad + 1} (click another pad to choose it, Esc to finish).`;
    changed();
  }
  function stopLearn() {
    if (!learn.mode) return;
    learn.mode = null; learn.pad = null;
    statusEl.textContent = "Pad mapping saved.";
    changed();
  }
  function setLearnPad(pad) { if (learn.mode) startLearn(learn.mode, pad); }
  function nextPad() {
    if (learn.pad >= PADS - 1) { stopLearn(); return; }
    startLearn(learn.mode, learn.pad + 1);
  }

  /** called for every incoming note-on; returns true when the note was used for learning */
  function handleMidiLearn(note) {
    if (learn.mode !== "midi" || learn.pad == null) return false;
    Object.keys(map.midi).forEach(n => { if (map.midi[n] === learn.pad) delete map.midi[n]; });
    map.midi[note] = learn.pad;
    save();
    statusEl.textContent = `Pad ${learn.pad + 1} ← MIDI note ${note} (${noteName(note)}).`;
    setTimeout(nextPad, 250);
    return true;
  }
  /** called for keydown; returns true when the key was used for learning */
  function handleKeyLearn(e) {
    if (!learn.mode) return false;
    if (e.code === "Escape") { e.preventDefault(); stopLearn(); return true; }
    if (learn.mode !== "key" || learn.pad == null || e.repeat) return false;
    if (e.ctrlKey || e.metaKey || e.altKey || ["Space", "Tab", "Enter", "ShiftLeft", "ShiftRight", "Backspace", "Delete"].includes(e.code)) return false;
    e.preventDefault(); e.stopPropagation();
    // one key per pad, one pad per key
    Object.keys(map.keys).forEach(c => { if (map.keys[c] === learn.pad || c === e.code) delete map.keys[c]; });
    map.keys[e.code] = learn.pad;
    save();
    statusEl.textContent = `Pad ${learn.pad + 1} ← key ${e.code.replace(/^Key|^Digit/, "")}.`;
    setTimeout(nextPad, 150);
    return true;
  }

  function resetMidi() { map.midi = {}; save(); statusEl.textContent = "Pad MIDI mapping reset (notes 36–51 / GM drums)."; }
  function resetKeys() { map.keys = defaultKeys(); save(); statusEl.textContent = "Pad keys reset (Z–V, A–F, Q–R, 1–4)."; }

  /** the controller-mapping toolbar used in the Sampler and Drum Synth dialogs */
  function toolbarHtml() {
    return `<div class="padmap-bar">
      <span class="padmap-title">Controller</span>
      <button type="button" data-pm="midi" class="${learn.mode === "midi" ? "on" : ""}" title="Click, then hit your controller pads in order (pad 1, 2, 3…)">MIDI Learn</button>
      <button type="button" data-pm="key" class="${learn.mode === "key" ? "on" : ""}" title="Click, then press a key for each pad in order">Key Learn</button>
      <button type="button" data-pm="resetMidi" title="Back to notes 36–51 (Sampler) / GM drum notes (Drum Synth)">Reset MIDI</button>
      <button type="button" data-pm="resetKeys" title="Back to Z–V, A–F, Q–R, 1–4">Reset keys</button>
    </div>`;
  }
  function attachToolbar(root, firstPad = () => 0) {
    root.querySelectorAll("[data-pm]").forEach(b => b.addEventListener("click", (e) => {
      e.stopPropagation();
      const a = b.dataset.pm;
      if (a === "midi" || a === "key") { if (learn.mode === a) stopLearn(); else startLearn(a, firstPad()); }
      else if (a === "resetMidi") resetMidi();
      else if (a === "resetKeys") resetKeys();
    }));
  }

  window.WAWPadMap = {
    translate, keyNote, keyLabel, midiLabel, isLearned, padNote, padInstrument,
    learn, startLearn, stopLearn, setLearnPad, handleMidiLearn, handleKeyLearn,
    resetMidi, resetKeys, toolbarHtml, attachToolbar, onChange, noteName,
    get map() { return map; }
  };
})();
