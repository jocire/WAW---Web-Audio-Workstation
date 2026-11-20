// WAW analog synth panel: a hardware-style front panel for the track synth
// (oscillators, mixer, filter + envelope, amp envelope, LFO, voice, output),
// a categorised preset browser and a playable keyboard.
// Edits go straight into the active track's synthPatch (undoable, shared with
// collaborators); every new note uses the current settings.
(function () {
  "use strict";
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const LS_USER = "waw.synthUserPresets";
  const LS_FAV = "waw.synthPresetBrowserCat";

  let modal = null, track = null, kbOctave = 3;

  // ---- formatting ----
  const fmtTime = v => v < 1 ? Math.round(v * 1000) + " ms" : v.toFixed(2) + " s";
  const fmtHz = v => v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2) + " kHz" : Math.round(v) + " Hz";
  const fmtPct = v => Math.round(v * 100) + "%";
  const fmtSigned = (v, unit = "") => (v > 0 ? "+" : "") + (Number.isInteger(v) ? v : v.toFixed(1)) + unit;

  // ---- wave icons ----
  const WAVES = {
    sawtooth: '<path d="M2 15 L12 3 L12 15 L22 3 L22 15"/>',
    pulse: '<path d="M2 15 V4 H8 V15 H22 V4"/>',
    square: '<path d="M2 15 V4 H12 V15 H22 V4"/>',
    triangle: '<path d="M2 15 L7 4 L12 15 L17 4 L22 15"/>',
    sine: '<path d="M2 9.5 C5 1, 8 1, 12 9.5 S19 18, 22 9.5"/>',
    off: '<path d="M6 5 L18 14 M18 5 L6 14"/>',
  };
  const waveIcon = w => `<svg viewBox="0 0 24 18" width="22" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round">${WAVES[w] || ""}</svg>`;

  function patch() { return window.WAWSynth.fullPatch(track?.synthPatch); }
  function setParam(key, value) {
    if (!track) return;
    track.synthPatch = track.synthPatch || {};
    track.synthPatch[key] = value;
    if (key !== "presetName" && track.synthPatch.presetName && !track.synthPatch.presetName.endsWith("*")) track.synthPatch.presetName += " *";
    updateDisplay();
    drawEnvs();
  }

  // ---------------------------------------------------------------------------
  // building blocks
  // ---------------------------------------------------------------------------
  function knob(key, label, min, max, opts = {}) {
    const p = patch();
    const el = window.WAWMixer.createKnob({
      label, min, max, step: opts.step ?? (max - min) / 200, log: !!opts.log, size: "md", color: opts.color || "wk-cream",
      value: clamp(Number(p[key] ?? opts.def ?? min), min, max), default: opts.def ?? window.WAWSynth.fullPatch({})[key] ?? min,
      format: opts.fmt || (v => v.toFixed(2)),
      onChange: v => setParam(key, opts.int ? Math.round(v) : v)
    });
    el.dataset.key = key;
    el.querySelector(".wk-label").insertAdjacentHTML("afterend", `<span class="vs-val" data-val="${key}">${(opts.fmt || (v => v.toFixed(2)))(clamp(Number(p[key] ?? opts.def ?? min), min, max))}</span>`);
    // live value readout under the knob (mirrors the knob's own value text)
    const knobEl = el.querySelector(".wk"), valEl = el.querySelector(".vs-val");
    new MutationObserver(() => { valEl.textContent = knobEl.getAttribute("aria-valuetext") || ""; })
      .observe(knobEl, { attributes: true, attributeFilter: ["aria-valuetext"] });
    return el;
  }

  function waveSelect(key, options, opts = {}) {
    const p = patch();
    const box = document.createElement("div");
    box.className = "vs-waves";
    box.setAttribute("role", "radiogroup");
    box.setAttribute("aria-label", opts.label || key);
    options.forEach(w => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "vs-wave" + ((p[key] || options[0]) === w ? " on" : "");
      b.title = w === "sawtooth" ? "Saw" : w[0].toUpperCase() + w.slice(1);
      b.setAttribute("aria-label", b.title);
      b.innerHTML = waveIcon(w);
      b.addEventListener("click", () => {
        pushHistory();
        setParam(key, w);
        box.querySelectorAll(".vs-wave").forEach(x => x.classList.toggle("on", x === b));
        window.WAWCollab?.notifyChange?.();
        opts.onPick?.(w);
      });
      box.appendChild(b);
    });
    return box;
  }

  function segmented(key, options, opts = {}) {
    const p = patch();
    const box = document.createElement("div");
    box.className = "vs-seg";
    box.setAttribute("aria-label", opts.label || key);
    options.forEach(([val, text]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.className = String(p[key]) === String(val) ? "on" : "";
      b.addEventListener("click", () => {
        pushHistory();
        setParam(key, typeof val === "number" ? val : val);
        box.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
        window.WAWCollab?.notifyChange?.();
      });
      box.appendChild(b);
    });
    if (opts.label) { const wrap = document.createElement("div"); wrap.className = "vs-seg-wrap"; wrap.innerHTML = `<span class="vs-seg-label">${opts.label}</span>`; wrap.appendChild(box); return wrap; }
    return box;
  }

  // base widths keep each panel row like a hardware front panel (sections grow to fill)
  const SEC_W = { "Oscillator 1": 176, "Oscillator 2": 214, "Mixer": 112, "Filter": 200, "Filter Envelope": 212, "LFO": 196, "Voice": 120, "Amp Envelope": 212, "Output": 168 };
  function section(title, cls, children) {
    const s = document.createElement("section");
    s.className = "vs-sec " + (cls || "");
    s.style.flexBasis = (SEC_W[title] || 160) + "px";
    s.innerHTML = `<h4>${title}</h4><div class="vs-row"></div>`;
    const row = s.querySelector(".vs-row");
    children.forEach(c => { if (c) row.appendChild(c); });
    return s;
  }
  const br = () => { const d = document.createElement("div"); d.className = "vs-br"; return d; };

  function envGraph(prefix) {
    const c = document.createElement("canvas");
    c.className = "vs-env";
    c.dataset.env = prefix;
    c.width = 150; c.height = 46;
    return c;
  }
  function drawEnvs() {
    if (!modal) return;
    const p = patch();
    modal.querySelectorAll("canvas.vs-env").forEach(c => {
      const isF = c.dataset.env === "filter";
      const A = isF ? p.filterAttack : p.attack, D = isF ? p.filterDecay : p.decay, S = isF ? p.filterSustain : p.sustain, R = isF ? p.filterRelease : p.release;
      const g = c.getContext("2d"), w = c.width, h = c.height, pad = 4;
      g.clearRect(0, 0, w, h);
      const hold = 0.35, total = A + D + hold + R || 1;
      const x = t => pad + (t / total) * (w - pad * 2), y = l => h - pad - l * (h - pad * 2);
      g.strokeStyle = isF ? "#fbbf24" : "#86efac"; g.lineWidth = 2; g.beginPath();
      g.moveTo(x(0), y(0)); g.lineTo(x(A), y(1)); g.lineTo(x(A + D), y(S)); g.lineTo(x(A + D + hold), y(S)); g.lineTo(x(total), y(0));
      g.stroke();
      g.globalAlpha = 0.15; g.fillStyle = g.strokeStyle; g.lineTo(x(0), y(0)); g.fill(); g.globalAlpha = 1;
    });
  }

  // ---------------------------------------------------------------------------
  // panel
  // ---------------------------------------------------------------------------
  function ensureModal() {
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = "vintageSynthModal";
    modal.className = "modal-backdrop vs-backdrop";
    modal.innerHTML = `<div class="vs-dialog" role="dialog" aria-label="Synthesizer">
      <div class="vs-cheek left"></div>
      <div class="vs-body">
        <header class="vs-head">
          <div class="vs-brand"><b>WAW</b> PS-8<span>Programmable Polyphonic Synthesizer</span></div>
          <div class="vs-lcd" aria-live="polite">
            <button type="button" class="vs-nav" data-nav="-1" aria-label="Previous preset">◀</button>
            <div class="vs-lcd-text"><span class="vs-lcd-cat"></span><span class="vs-lcd-name"></span></div>
            <button type="button" class="vs-nav" data-nav="1" aria-label="Next preset">▶</button>
          </div>
          <div class="vs-head-btns">
            <button type="button" data-act="browse">Presets</button>
            <button type="button" data-act="save">Save</button>
            <button type="button" data-act="random" title="Random patch">Random</button>
            <button type="button" data-act="init" title="Initialise patch">Init</button>
            <button type="button" class="vs-close" data-act="close" aria-label="Close">×</button>
          </div>
        </header>
        <div class="vs-panel"></div>
        <div class="vs-keys-wrap">
          <div class="vs-oct"><button type="button" data-oct="-1" aria-label="Octave down">◀</button><span class="vs-oct-val"></span><button type="button" data-oct="1" aria-label="Octave up">▶</button></div>
          <div class="vs-keys"></div>
        </div>
        <div class="vs-browser" hidden></div>
      </div>
      <div class="vs-cheek right"></div>
    </div>`;
    document.body.appendChild(modal);
    modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
    modal.querySelector(".vs-head").addEventListener("click", (e) => {
      const a = e.target.closest("[data-act]")?.dataset.act;
      const nav = e.target.closest("[data-nav]")?.dataset.nav;
      if (nav) stepPreset(Number(nav));
      if (a === "close") close();
      else if (a === "browse") toggleBrowser();
      else if (a === "save") saveUserPreset();
      else if (a === "random") randomPatch();
      else if (a === "init") loadPreset({ name: "Init", patch: {} });
    });
    modal.querySelector(".vs-oct").addEventListener("click", (e) => {
      const d = Number(e.target.closest("[data-oct]")?.dataset.oct || 0);
      if (!d) return;
      kbOctave = clamp(kbOctave + d, 1, 6);
      buildKeys();
    });
    document.addEventListener("keydown", (e) => { if (e.code === "Escape" && modal.classList.contains("visible")) { if (!modal.querySelector(".vs-browser").hidden) toggleBrowser(false); else close(); } });
    return modal;
  }

  let renderedSig = "";
  function render() {
    renderedSig = JSON.stringify(track?.synthPatch || {});
    const panel = modal.querySelector(".vs-panel");
    panel.innerHTML = "";
    const p = patch();
    const pwKnob1 = knob("pulseWidth", "PW", 0.05, 0.5, { color: "wk-cream", fmt: fmtPct });
    const pwKnob2 = knob("osc2PulseWidth", "PW", 0.05, 0.5, { color: "wk-cream", fmt: fmtPct });
    const showPw = () => { const q = patch(); pwKnob1.classList.toggle("vs-dim", q.wave !== "pulse"); pwKnob2.classList.toggle("vs-dim", q.osc2Wave !== "pulse"); };

    const row1 = document.createElement("div"); row1.className = "vs-line";
    row1.append(
      section("Oscillator 1", "c-osc", [
        waveSelect("wave", ["sawtooth", "pulse", "square", "triangle", "sine"], { label: "Osc 1 wave", onPick: showPw }), br(),
        knob("osc1Octave", "Octave", -2, 2, { step: 1, int: true, fmt: v => fmtSigned(Math.round(v)) }),
        pwKnob1,
        knob("detune", "Tune", -100, 100, { step: 1, fmt: v => fmtSigned(Math.round(v), "c"), def: 0 }),
      ]),
      section("Oscillator 2", "c-osc", [
        waveSelect("osc2Wave", ["off", "sawtooth", "pulse", "square", "triangle", "sine"], { label: "Osc 2 wave", onPick: showPw }), br(),
        knob("osc2Octave", "Octave", -2, 2, { step: 1, int: true, fmt: v => fmtSigned(Math.round(v)) }),
        knob("osc2Semi", "Semi", -12, 12, { step: 1, int: true, fmt: v => fmtSigned(Math.round(v)) }),
        knob("osc2Detune", "Fine", -50, 50, { step: 0.5, fmt: v => fmtSigned(Math.round(v), "c") }),
        pwKnob2, br(),
        segmented("osc2Mode", [["mix", "Mix"], ["fm", "FM"], ["ring", "Ring"]], { label: "Mode" }),
        knob("fmAmount", "FM / X-Mod", 0, 1.5, { fmt: fmtPct }),
      ]),
      section("Mixer", "c-mix", [
        knob("osc1Level", "Osc 1", 0, 1.2, { fmt: fmtPct, color: "wk-silver" }),
        knob("osc2Mix", "Osc 2", 0, 1.2, { fmt: fmtPct, color: "wk-silver" }), br(),
        knob("subLevel", "Sub", 0, 1, { fmt: fmtPct, color: "wk-silver" }),
        knob("noise", "Noise", 0, 1, { fmt: fmtPct, color: "wk-silver" }), br(),
        segmented("subWave", [["sine", "Sub ∿"], ["square", "Sub ⊓"]]),
      ]),
      section("Filter", "c-filter", [
        segmented("filterType", [["lowpass", "LP"], ["bandpass", "BP"], ["highpass", "HP"]]),
        segmented("filterSlope", [[12, "12 dB"], [24, "24 dB"]]), br(),
        knob("cutoff", "Cutoff", 30, 18000, { log: true, step: 1, fmt: fmtHz, color: "wk-orange" }),
        knob("filterQ", "Reso", 0.3, 20, { log: true, step: 0.05, fmt: v => v.toFixed(1), color: "wk-orange" }),
        knob("filterEnv", "Env Amt", -8000, 8000, { step: 10, fmt: v => fmtSigned(Math.round(v), " Hz"), color: "wk-orange", def: 0 }), br(),
        knob("keyTrack", "Key Trk", 0, 1, { fmt: fmtPct }),
        knob("velToFilter", "Vel", 0, 1, { fmt: fmtPct }),
      ]),
      section("Filter Envelope", "c-env", [
        envGraph("filter"), br(),
        knob("filterAttack", "A", 0.001, 6, { log: true, step: 0.001, fmt: fmtTime, color: "wk-orange" }),
        knob("filterDecay", "D", 0.001, 6, { log: true, step: 0.001, fmt: fmtTime, color: "wk-orange" }),
        knob("filterSustain", "S", 0, 1, { fmt: fmtPct, color: "wk-orange" }),
        knob("filterRelease", "R", 0.005, 8, { log: true, step: 0.001, fmt: fmtTime, color: "wk-orange" }),
      ]),
    );
    const row2 = document.createElement("div"); row2.className = "vs-line";
    row2.append(
      section("LFO", "c-lfo", [
        waveSelect("lfoWave", ["sine", "triangle", "square", "sawtooth"], { label: "LFO wave" }), br(),
        knob("lfoRate", "Rate", 0.02, 25, { log: true, step: 0.01, fmt: v => v.toFixed(2) + " Hz", color: "wk-blue" }),
        knob("lfoAmount", "Depth", 0, 1000, { step: 1, fmt: v => Math.round(v), color: "wk-blue" }),
        knob("lfoDelay", "Delay", 0, 4, { step: 0.01, fmt: fmtTime, color: "wk-blue" }), br(),
        segmented("lfoTarget", [["pitch", "Pitch"], ["filter", "Filter"], ["amp", "Amp"], ["pan", "Pan"]], { label: "Dest" }),
      ]),
      section("Voice", "c-voice", [
        segmented("polyMode", [["poly", "Poly"], ["mono", "Mono"]]), br(),
        knob("glide", "Glide", 0, 1.5, { step: 0.005, fmt: fmtTime, color: "wk-silver" }),
        knob("unison", "Unison", 1, 7, { step: 1, int: true, fmt: v => Math.round(v) + "×", color: "wk-silver" }), br(),
        knob("unisonDetune", "Spread", 0, 60, { step: 0.5, fmt: v => Math.round(v) + "c", color: "wk-silver" }),
        knob("unisonSpread", "Width", 0, 1, { fmt: fmtPct, color: "wk-silver" }),
      ]),
      section("Amp Envelope", "c-env", [
        envGraph("amp"), br(),
        knob("attack", "A", 0.001, 6, { log: true, step: 0.001, fmt: fmtTime, color: "wk-green" }),
        knob("decay", "D", 0.001, 6, { log: true, step: 0.001, fmt: fmtTime, color: "wk-green" }),
        knob("sustain", "S", 0, 1, { fmt: fmtPct, color: "wk-green" }),
        knob("release", "R", 0.005, 8, { log: true, step: 0.001, fmt: fmtTime, color: "wk-green" }), br(),
        knob("velSens", "Velocity", 0, 1, { fmt: fmtPct }),
      ]),
      section("Output", "c-out", [
        knob("drive", "Drive", 0, 1, { fmt: fmtPct, color: "wk-red" }),
        knob("chorus", "Chorus", 0, 1, { fmt: fmtPct, color: "wk-blue" }),
        knob("delaySend", "Delay", 0, 1, { fmt: fmtPct, color: "wk-blue" }), br(),
        knob("reverbSend", "Reverb", 0, 1, { fmt: fmtPct, color: "wk-blue" }),
        knob("pan", "Pan", -1, 1, { fmt: v => Math.abs(v) < 0.01 ? "C" : (v < 0 ? "L" : "R") + Math.round(Math.abs(v) * 100), def: 0 }),
        knob("gain", "Volume", 0, 0.6, { fmt: v => Math.round((v / 0.25) * 100) + "%", color: "wk-red" }),
      ]),
    );
    panel.append(row1, row2);
    showPw();
    drawEnvs();
    updateDisplay();
    buildKeys();
  }

  // ---------------------------------------------------------------------------
  // presets
  // ---------------------------------------------------------------------------
  function userPresets() { try { return JSON.parse(localStorage.getItem(LS_USER) || "[]"); } catch (e) { return []; } }
  function allPresets() {
    const factory = window.WAWSynthPresets.list();
    const user = userPresets().map((u, i) => ({ id: `User/${i}`, category: "User", name: u.name, patch: u.patch }));
    return [...user, ...factory];
  }

  function loadPreset(pr) {
    if (!track) return;
    pushHistory();
    track.synthPatch = { ...structuredClone(pr.patch || {}), presetName: pr.name, presetId: pr.id || "" };
    window.WAWCollab?.notifyChange?.();
    render();
    statusEl.textContent = `Synth preset: ${pr.name}`;
  }

  function stepPreset(dir) {
    const list = allPresets();
    const cur = track?.synthPatch?.presetId;
    let i = list.findIndex(p => p.id === cur);
    i = i < 0 ? 0 : (i + dir + list.length) % list.length;
    loadPreset(list[i]);
    audition();
  }

  function updateDisplay() {
    if (!modal || !track) return;
    const sp = track.synthPatch || {};
    const id = sp.presetId || "";
    modal.querySelector(".vs-lcd-cat").textContent = (id.split("/")[0] || "Patch").toUpperCase();
    modal.querySelector(".vs-lcd-name").textContent = sp.presetName || "Custom";
  }

  function toggleBrowser(force) {
    const b = modal.querySelector(".vs-browser");
    const show = force ?? b.hidden;
    b.hidden = !show;
    if (!show) return;
    const list = allPresets();
    const cats = [...new Set(list.map(p => p.category))];
    let cat = (() => { try { return localStorage.getItem(LS_FAV); } catch (e) { return null; } })() || (track?.synthPatch?.presetId || "").split("/")[0] || cats[0];
    if (!cats.includes(cat)) cat = cats[0];
    const draw = (q = "") => {
      const items = list.filter(p => (q ? p.name.toLowerCase().includes(q.toLowerCase()) : p.category === cat));
      b.innerHTML = `
        <div class="vs-br-head"><input type="search" class="vs-br-search" placeholder="Search ${list.length} presets…" value="${escapeHtml(q)}"><button type="button" class="vs-br-close" aria-label="Close preset browser">×</button></div>
        <div class="vs-br-body">
          <nav class="vs-br-cats">${cats.map(c => `<button type="button" class="${c === cat && !q ? "on" : ""}" data-cat="${escapeHtml(c)}">${escapeHtml(c)} <small>${list.filter(p => p.category === c).length}</small></button>`).join("")}</nav>
          <ul class="vs-br-list">${items.map(p => `<li><button type="button" data-id="${escapeHtml(p.id)}" class="${p.id === track?.synthPatch?.presetId ? "on" : ""}">${escapeHtml(p.name)}${q ? ` <small>${escapeHtml(p.category)}</small>` : ""}</button>${p.category === "User" ? `<button type="button" class="vs-br-del" data-del="${escapeHtml(p.id)}" aria-label="Delete ${escapeHtml(p.name)}">×</button>` : ""}</li>`).join("") || "<li class='vs-br-empty'>No presets</li>"}</ul>
        </div>`;
      const search = b.querySelector(".vs-br-search");
      search.addEventListener("input", () => { const pos = search.selectionStart; draw(search.value); const s2 = b.querySelector(".vs-br-search"); s2.focus(); s2.setSelectionRange(pos, pos); });
      b.querySelector(".vs-br-close").addEventListener("click", () => toggleBrowser(false));
      b.querySelectorAll("[data-cat]").forEach(x => x.addEventListener("click", () => { cat = x.dataset.cat; try { localStorage.setItem(LS_FAV, cat); } catch (e) {} draw(); }));
      b.querySelectorAll("[data-id]").forEach(x => x.addEventListener("click", () => {
        loadPreset(list.find(p => p.id === x.dataset.id));
        b.querySelectorAll("[data-id]").forEach(y => y.classList.toggle("on", y === x));
        audition();
      }));
      b.querySelectorAll("[data-del]").forEach(x => x.addEventListener("click", () => {
        const idx = Number(x.dataset.del.split("/")[1]);
        const u = userPresets(); const gone = u.splice(idx, 1)[0];
        if (gone && confirm(`Delete user preset "${gone.name}"?`)) { try { localStorage.setItem(LS_USER, JSON.stringify(u)); } catch (e) {} list.splice(0, list.length, ...allPresets()); draw(q); }
      }));
    };
    draw();
    b.querySelector(".vs-br-search")?.focus();
  }

  function saveUserPreset() {
    if (!track) return;
    const base = (track.synthPatch?.presetName || "My Patch").replace(/ \*$/, "");
    const name = prompt("Save preset as:", base);
    if (!name || !name.trim()) return;
    const { presetName, presetId, ...rest } = track.synthPatch || {};
    void presetName; void presetId;
    const u = userPresets().filter(p => p.name !== name.trim());
    u.unshift({ name: name.trim(), patch: rest });
    try { localStorage.setItem(LS_USER, JSON.stringify(u)); } catch (e) { statusEl.textContent = "Could not save the preset (browser storage full?)"; return; }
    track.synthPatch.presetName = name.trim();
    track.synthPatch.presetId = "User/0";
    updateDisplay();
    statusEl.textContent = `Saved preset "${name.trim()}" (User category).`;
  }

  function randomPatch() {
    const r = (a, b) => a + Math.random() * (b - a);
    const pick = a => a[Math.floor(Math.random() * a.length)];
    const waves = ["sawtooth", "pulse", "square", "triangle", "sine"];
    const pad = Math.random() < 0.35;
    loadPreset({
      name: "Random", patch: {
        wave: pick(waves), pulseWidth: r(0.1, 0.5), osc2Wave: pick(["off", ...waves]), osc2Mix: r(0.2, 0.9), osc2Detune: r(-15, 15), osc2Octave: pick([-1, 0, 0, 1]), osc2Semi: pick([0, 0, 0, 7, 12, 5]),
        osc2Mode: pick(["mix", "mix", "mix", "fm", "ring"]), fmAmount: r(0.05, 0.6), subLevel: pick([0, 0, r(0.2, 0.6)]), noise: pick([0, 0, 0, r(0.02, 0.2)]),
        unison: pick([1, 1, 2, 3, 5]), unisonDetune: r(8, 30), cutoff: Math.exp(r(Math.log(200), Math.log(8000))), filterQ: r(0.6, 8), filterSlope: pick([12, 24]),
        filterEnv: r(-1000, 5000), filterAttack: pad ? r(0.2, 2) : r(0.001, 0.05), filterDecay: r(0.1, 1.5), filterSustain: r(0, 0.6), filterRelease: r(0.1, 1.5),
        attack: pad ? r(0.3, 1.5) : r(0.001, 0.03), decay: r(0.1, 1.2), sustain: r(0.2, 0.9), release: pad ? r(0.8, 2.5) : r(0.08, 0.5),
        lfoRate: r(0.1, 7), lfoAmount: pick([0, 0, r(50, 500)]), lfoTarget: pick(["pitch", "filter", "filter", "amp"]), lfoWave: pick(["sine", "triangle", "square"]),
        chorus: r(0, 0.6), reverbSend: r(0, 0.4), delaySend: r(0, 0.3), gain: 0.2
      }
    });
    audition();
  }

  // short audition note when browsing
  let auditionTimer = null;
  function audition() {
    if (!track) return;
    clearTimeout(auditionTimer);
    const n = 12 * (kbOctave + 1) + 12; // C one octave above the keyboard start
    previewNoteOn(n, 100, track);
    auditionTimer = setTimeout(() => previewNoteOff(n, track.id), 450);
  }

  // ---------------------------------------------------------------------------
  // keyboard (2 octaves + top C)
  // ---------------------------------------------------------------------------
  function buildKeys() {
    const kb = modal.querySelector(".vs-keys");
    modal.querySelector(".vs-oct-val").textContent = "C" + kbOctave;
    const start = 12 * (kbOctave + 1);
    const notes = Array.from({ length: 25 }, (_, i) => start + i);
    const black = n => [1, 3, 6, 8, 10].includes(n % 12);
    let whiteIdx = 0;
    kb.innerHTML = notes.map(n => {
      if (black(n)) return `<button type="button" class="vs-key black" data-n="${n}" style="left:calc(${whiteIdx} * var(--wkw) - var(--bkw) / 2)" aria-label="Note ${n}"></button>`;
      const html = `<button type="button" class="vs-key white" data-n="${n}" aria-label="Note ${n}">${n % 12 === 0 ? `<span>C${Math.floor(n / 12) - 1}</span>` : ""}</button>`;
      whiteIdx++;
      return html;
    }).join("");
    kb.style.setProperty("--whites", whiteIdx);
    const held = new Map();
    const on = (el, pointerId) => { const n = Number(el.dataset.n); if (held.has(pointerId) && held.get(pointerId) === n) return; off(pointerId); held.set(pointerId, n); el.classList.add("down"); previewNoteOn(n, 105, track); };
    const off = (pointerId) => { const n = held.get(pointerId); if (n == null) return; held.delete(pointerId); kb.querySelector(`[data-n="${n}"]`)?.classList.remove("down"); previewNoteOff(n, track?.id); };
    kb.onpointerdown = (e) => { const k = e.target.closest(".vs-key"); if (!k) return; e.preventDefault(); try { kb.setPointerCapture(e.pointerId); } catch (_) {} on(k, e.pointerId); };
    kb.onpointermove = (e) => { if (!held.has(e.pointerId)) return; const k = document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".vs-key"); if (k && kb.contains(k)) on(k, e.pointerId); };
    kb.onpointerup = kb.onpointercancel = (e) => off(e.pointerId);
  }

  // ---------------------------------------------------------------------------
  function open(t = getActiveTrack()) {
    if (!t || t.type === "audio") return;
    track = t;
    track.synthPatch = track.synthPatch || {};
    ensureModal();
    render();
    modal.classList.add("visible");
    modal.querySelector(".vs-dialog").focus?.();
  }
  function close() { modal?.classList.remove("visible"); toggleBrowser(false); window.WAWCollab?.notifyChange?.(); }
  /** after undo / remote edits the track object may have been replaced */
  function refresh() {
    if (!modal?.classList.contains("visible") || !track) return;
    const fresh = tracks.find(x => x.id === track.id);
    if (!fresh || fresh.instrument !== "synth") { close(); return; }
    // re-render only when the patch changed, and never in the middle of a knob drag
    if (fresh === track && JSON.stringify(fresh.synthPatch || {}) === renderedSig) return;
    if (modal.querySelector(".wk:active")) return;
    track = fresh;
    render();
  }

  window.WAWSynthPanel = { open, close, refresh };
})();
