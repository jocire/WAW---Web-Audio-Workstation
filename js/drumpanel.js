// WAW Drum Synth panel: a classic analog drum-machine front panel.
// Master section (kit character) + 16 instrument channels (level, tune,
// decay, tone, snappy, pan + trigger pad) + kit browser. Edits go into the
// active track's drum808Patch (undoable, shared with collaborators).
(function () {
  "use strict";
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const LS_USER = "waw.drumUserKits";
  let modal = null, track = null, renderedSig = "";

  const fmtPct = v => Math.round(v * 100) + "%";
  const fmtX = v => "×" + v.toFixed(2);
  const fmtSemi = v => (v > 0 ? "+" : "") + Math.round(v) + " st";
  const fmtPan = v => Math.abs(v) < 0.01 ? "C" : (v < 0 ? "L" : "R") + Math.round(Math.abs(v) * 100);
  // which instruments have a "snappy" (noise / attack) control
  const HAS_SNAP = new Set(["snare", "clap", "rimshot", "claves", "maracas"]);
  // channel colours, in the spirit of classic drum machines (by group)
  const GROUP = { kick: "g1", rimshot: "g2", snare: "g1", clap: "g2", closedHat: "g3", openHat: "g3", cymbal: "g3", cowbell: "g4", lowTom: "g1", midTom: "g1", highTom: "g1", claves: "g4", lowConga: "g2", midConga: "g2", highConga: "g2", maracas: "g4" };

  function kit() { return { ...createDefault808Patch(), ...(track?.drum808Patch || {}) }; }
  function ensurePatch() {
    if (!track) return null;
    if (!track.drum808Patch || typeof track.drum808Patch !== "object") track.drum808Patch = createDefault808Patch();
    track.drum808Patch.voices = track.drum808Patch.voices || {};
    return track.drum808Patch;
  }
  function markEdited() {
    const p = ensurePatch();
    if (p.presetName && !p.presetName.endsWith(" *")) p.presetName += " *";
    updateDisplay();
  }

  function knob(label, min, max, value, def, onChange, opts = {}) {
    const el = window.WAWMixer.createKnob({
      label, min, max, step: opts.step ?? (max - min) / 200, log: !!opts.log, size: "md", color: opts.color || "wk-cream",
      value: clamp(value, min, max), default: def, format: opts.fmt || (v => v.toFixed(2)), onChange
    });
    el.querySelector(".wk-label").insertAdjacentHTML("afterend", `<span class="vs-val">${(opts.fmt || (v => v.toFixed(2)))(clamp(value, min, max))}</span>`);
    const knobEl = el.querySelector(".wk"), valEl = el.querySelector(".vs-val");
    new MutationObserver(() => { valEl.textContent = knobEl.getAttribute("aria-valuetext") || ""; }).observe(knobEl, { attributes: true, attributeFilter: ["aria-valuetext"] });
    return el;
  }
  const kitKnob = (key, label, min, max, opts = {}) => {
    const k = kit();
    return knob(label, min, max, Number(k[key] ?? opts.def ?? 1), opts.def ?? createDefault808Patch()[key] ?? 1, v => { ensurePatch()[key] = v; markEdited(); }, opts);
  };
  const voiceKnob = (id, key, label, min, max, opts = {}) => {
    const k = kit();
    const vs = window.WAWDrums.voiceSettings(k, id);
    const fallback = opts.fallback != null ? opts.fallback : (key === "tone" ? (k.tone ?? 1) : key === "snap" ? (k.snap ?? 0.55) : 0);
    const val = Number.isFinite(vs[key]) ? vs[key] : fallback;
    return knob(label, min, max, val, opts.def ?? fallback, v => {
      const p = ensurePatch();
      p.voices[id] = { ...window.WAWDrums.voiceSettings(p, id), [key]: v };
      markEdited();
    }, opts);
  };

  function ensureModal() {
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = "drumMachineModal";
    modal.className = "modal-backdrop vs-backdrop dm-backdrop";
    modal.innerHTML = `<div class="vs-dialog dm-dialog" role="dialog" aria-label="Drum Synth">
      <div class="vs-body dm-body">
        <header class="vs-head">
          <div class="vs-brand dm-brand"><b>WAW</b> RD-16<span>Analog Rhythm Synthesizer · no samples</span></div>
          <div class="vs-lcd" aria-live="polite">
            <button type="button" class="vs-nav" data-nav="-1" aria-label="Previous kit">◀</button>
            <div class="vs-lcd-text"><span class="vs-lcd-cat"></span><span class="vs-lcd-name"></span></div>
            <button type="button" class="vs-nav" data-nav="1" aria-label="Next kit">▶</button>
          </div>
          <div class="vs-head-btns">
            <button type="button" data-act="browse">Kits</button>
            <button type="button" data-act="save">Save</button>
            <button type="button" data-act="init" title="Back to the classic kit">Init</button>
            <button type="button" class="vs-close" data-act="close" aria-label="Close">×</button>
          </div>
        </header>
        <div class="dm-master"></div>
        <div class="dm-channels"></div>
        <div class="vs-browser" hidden></div>
      </div>
    </div>`;
    document.body.appendChild(modal);
    modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
    modal.querySelector(".vs-head").addEventListener("click", (e) => {
      const a = e.target.closest("[data-act]")?.dataset.act;
      const nav = e.target.closest("[data-nav]")?.dataset.nav;
      if (nav) stepKit(Number(nav));
      if (a === "close") close();
      else if (a === "browse") toggleBrowser();
      else if (a === "save") saveUserKit();
      else if (a === "init") loadKit({ name: "Analog Classic", id: "Classic/0", kit: {}, voices: {} });
    });
    document.addEventListener("keydown", (e) => { if (e.code === "Escape" && modal.classList.contains("visible")) { if (!modal.querySelector(".vs-browser").hidden) toggleBrowser(false); else close(); } });
    return modal;
  }

  function render() {
    renderedSig = JSON.stringify(track?.drum808Patch || {});
    const master = modal.querySelector(".dm-master");
    master.innerHTML = `<h4>Master</h4><div class="vs-row"></div>`;
    master.querySelector(".vs-row").append(
      kitKnob("pitch", "Tune", 0.5, 2, { log: true, fmt: fmtX, color: "wk-orange" }),
      kitKnob("decay", "Decay", 0.3, 3, { log: true, fmt: fmtX, color: "wk-orange" }),
      kitKnob("tone", "Tone", 0, 1.8, { fmt: fmtPct, color: "wk-orange" }),
      kitKnob("punch", "Punch", 0, 1.6, { fmt: fmtPct }),
      kitKnob("snap", "Snappy", 0, 1.2, { fmt: fmtPct }),
      kitKnob("noise", "Noise", 0, 1.5, { fmt: fmtPct }),
      kitKnob("hatDecay", "Hat Dec", 0, 1.5, { fmt: fmtPct }),
      kitKnob("tomDecay", "Tom Dec", 0, 1.5, { fmt: fmtPct }),
      kitKnob("cowbellTune", "Bell Tune", 0.7, 1.4, { fmt: fmtX }),
      kitKnob("drive", "Drive", 0, 1, { fmt: fmtPct, color: "wk-red" }),
      kitKnob("stereo", "Stereo", 0, 1, { fmt: fmtPct, color: "wk-blue" }),
      kitKnob("gain", "Volume", 0, 1.5, { fmt: fmtPct, color: "wk-red" }),
    );
    const ch = modal.querySelector(".dm-channels");
    ch.innerHTML = "";
    DRUM_808_VOICES.forEach((v, i) => {
      const strip = document.createElement("div");
      strip.className = `dm-ch ${GROUP[v.id] || "g1"}`;
      strip.innerHTML = `<div class="dm-ch-name">${escapeHtml(v.label)}</div><div class="dm-ch-knobs"></div>
        <button type="button" class="dm-pad" data-note="${v.note}" data-pad="${i}" title="${escapeHtml(v.label)} · MIDI ${v.note} · key ${escapeHtml(window.WAWPadMap?.keyLabel(i) ?? v.key)}"><span>${escapeHtml(window.WAWPadMap?.keyLabel(i) ?? v.key)}</span></button>`;
      const kn = strip.querySelector(".dm-ch-knobs");
      kn.append(
        voiceKnob(v.id, "level", "Level", 0, 1.5, { fallback: 1, def: 1, fmt: fmtPct, color: "wk-red" }),
        voiceKnob(v.id, "tune", "Tune", -12, 12, { step: 0.5, fallback: 0, def: 0, fmt: fmtSemi, color: "wk-orange" }),
        voiceKnob(v.id, "decay", "Decay", 0.2, 3, { log: true, fallback: 1, def: 1, fmt: fmtX }),
        voiceKnob(v.id, "tone", "Tone", 0, 1.8, { fmt: fmtPct }),
        HAS_SNAP.has(v.id) ? voiceKnob(v.id, "snap", "Snappy", 0, 1.2, { fmt: fmtPct }) : voiceKnob(v.id, "pan", "Pan", -1, 1, { fallback: 0, def: 0, fmt: fmtPan, color: "wk-blue" }),
        HAS_SNAP.has(v.id) ? voiceKnob(v.id, "pan", "Pan", -1, 1, { fallback: 0, def: 0, fmt: fmtPan, color: "wk-blue" }) : document.createElement("span"),
      );
      const pad = strip.querySelector(".dm-pad");
      pad.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        window.WAWPadMap?.setLearnPad?.(i);
        play808Hit(v.note, e.shiftKey ? 127 : 105, track);
        pad.classList.add("hit"); setTimeout(() => pad.classList.remove("hit"), 120);
      });
      ch.appendChild(strip);
    });
    updateDisplay();
  }

  // ---------------------------------------------------------------------------
  // kits
  // ---------------------------------------------------------------------------
  function userKits() { try { return JSON.parse(localStorage.getItem(LS_USER) || "[]"); } catch (e) { return []; } }
  function allKits() {
    return [...userKits().map((u, i) => ({ id: `User/${i}`, category: "User", ...u })), ...window.WAWDrumKits.list()];
  }
  function loadKit(k) {
    if (!track) return;
    pushHistory();
    track.drum808Patch = { ...createDefault808Patch(), ...structuredClone(k.kit || {}), voices: structuredClone(k.voices || {}), presetName: k.name, presetId: k.id || "" };
    window.WAWCollab?.notifyChange?.();
    render();
    statusEl.textContent = `Drum kit: ${k.name}`;
  }
  function stepKit(dir) {
    const list = allKits();
    let i = list.findIndex(k => k.id === track?.drum808Patch?.presetId);
    i = i < 0 ? 0 : (i + dir + list.length) % list.length;
    loadKit(list[i]);
    auditionKit();
  }
  let audTimers = [];
  function auditionKit() {
    audTimers.forEach(clearTimeout); audTimers = [];
    // kick - hat - snare - hat
    [[36, 0], [42, 140], [38, 280], [42, 420], [36, 560], [46, 700]].forEach(([n, t]) => audTimers.push(setTimeout(() => play808Hit(n, 105, track), t)));
  }
  function updateDisplay() {
    if (!modal || !track) return;
    const p = track.drum808Patch || {};
    modal.querySelector(".vs-lcd-cat").textContent = ((p.presetId || "").split("/")[0] || "Kit").toUpperCase();
    modal.querySelector(".vs-lcd-name").textContent = p.presetName || "Custom";
  }
  function saveUserKit() {
    const p = ensurePatch();
    const name = prompt("Save kit as:", (p.presetName || "My Kit").replace(/ \*$/, ""));
    if (!name || !name.trim()) return;
    const { presetName, presetId, voices, ...kitPart } = p;
    void presetName; void presetId;
    const u = userKits().filter(k => k.name !== name.trim());
    u.unshift({ name: name.trim(), kit: kitPart, voices: structuredClone(voices || {}) });
    try { localStorage.setItem(LS_USER, JSON.stringify(u)); } catch (e) { statusEl.textContent = "Could not save the kit (browser storage full?)"; return; }
    p.presetName = name.trim(); p.presetId = "User/0";
    updateDisplay();
    statusEl.textContent = `Saved kit "${name.trim()}" (User category).`;
  }
  function toggleBrowser(force) {
    const b = modal.querySelector(".vs-browser");
    const show = force ?? b.hidden;
    b.hidden = !show;
    if (!show) return;
    const list = allKits();
    const cats = [...new Set(list.map(k => k.category))];
    let cat = (track?.drum808Patch?.presetId || "").split("/")[0] || cats[0];
    if (!cats.includes(cat)) cat = cats[0];
    const draw = () => {
      b.innerHTML = `<div class="vs-br-head"><strong>Drum kits</strong><button type="button" class="vs-br-close" aria-label="Close kit browser">×</button></div>
        <div class="vs-br-body">
          <nav class="vs-br-cats">${cats.map(c => `<button type="button" class="${c === cat ? "on" : ""}" data-cat="${escapeHtml(c)}">${escapeHtml(c)} <small>${list.filter(k => k.category === c).length}</small></button>`).join("")}</nav>
          <ul class="vs-br-list">${list.filter(k => k.category === cat).map(k => `<li><button type="button" data-id="${escapeHtml(k.id)}" class="${k.id === track?.drum808Patch?.presetId ? "on" : ""}">${escapeHtml(k.name)}</button></li>`).join("")}</ul>
        </div>`;
      b.querySelector(".vs-br-close").addEventListener("click", () => toggleBrowser(false));
      b.querySelectorAll("[data-cat]").forEach(x => x.addEventListener("click", () => { cat = x.dataset.cat; draw(); }));
      b.querySelectorAll("[data-id]").forEach(x => x.addEventListener("click", () => {
        loadKit(list.find(k => k.id === x.dataset.id));
        b.querySelectorAll("[data-id]").forEach(y => y.classList.toggle("on", y === x));
        auditionKit();
      }));
    };
    draw();
  }

  function open(t = getActiveTrack()) {
    if (!t || t.type === "audio") return;
    track = t;
    ensurePatch();
    ensureModal();
    render();
    modal.classList.add("visible");
  }
  function close() { modal?.classList.remove("visible"); toggleBrowser(false); window.WAWCollab?.notifyChange?.(); }
  function refresh() {
    if (!modal?.classList.contains("visible") || !track) return;
    const fresh = tracks.find(x => x.id === track.id);
    if (!fresh || fresh.instrument !== "808") { close(); return; }
    if (fresh === track && JSON.stringify(fresh.drum808Patch || {}) === renderedSig) return;
    if (modal.querySelector(".wk:active")) return;
    track = fresh;
    render();
  }

  const currentTrack = () => (modal?.classList.contains("visible") ? track : null);
  window.WAWDrumPanel = { open, close, refresh, currentTrack };
})();
