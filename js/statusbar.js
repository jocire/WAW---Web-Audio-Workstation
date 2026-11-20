// WAW status bar (page footer): latest status message / hover help, shortcut
// hints for the current view, live indicators (REC, MIDI in, snap, audio
// engine, saved state, collaborators), a keyboard-shortcut sheet, and a
// collapse toggle (remembered).
(function () {
  "use strict";
  const LS_COLLAPSED = "waw.statusBarCollapsed";
  const $ = id => document.getElementById(id);

  const HINTS = {
    sequencer: "Ctrl+wheel zoom · Ctrl+E split · Ctrl+D duplicate · Alt+drag automation point = free · right-click clip for more",
    editor: "Click to draw · drag to select · Ctrl+Q quantize · ↑/↓ transpose · ←/→ nudge · Shift+wheel pitch zoom",
    mixer: "Drag knobs/faders · Shift = fine · double-click = reset · wheel = step",
    projects: "Save keeps the project in this browser · Export JSON includes the audio",
  };

  const SHORTCUTS = [
    ["Transport", [
      ["Space", "Play / stop (stops recording)"],
      ["Home / End", "Go to start (loop start) / end"],
      ["Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y", "Undo / redo"],
    ]],
    ["Tracks", [
      ["Alt+N", "New track"],
      ["Alt+1 … Alt+9", "Select track 1–9"],
    ]],
    ["Arrange view (selected clip)", [
      ["Ctrl+C / X / V", "Copy / cut / paste clip"],
      ["Ctrl+D", "Duplicate clip"],
      ["Ctrl+E", "Split clip at the playhead"],
      ["Delete", "Delete clip"],
      ["Ctrl+wheel", "Zoom time"],
      ["Alt+drag", "Move automation points without snapping"],
    ]],
    ["MIDI editor", [
      ["Ctrl+A", "Select all notes"],
      ["Ctrl+C / X / V / D", "Copy / cut / paste / duplicate notes"],
      ["Ctrl+Q", "Quantize (selection or all)"],
      ["↑ / ↓ (Shift = octave)", "Transpose selection"],
      ["← / →", "Nudge selection by the grid"],
      ["Shift+wheel", "Zoom pitch"],
    ]],
    ["Playing instruments", [
      ["A W S E D F T G Y H U J K", "Piano keys (synth tracks)"],
      ["Z / X", "Octave down / up (synth tracks)"],
      ["Pad keys (shown on each pad)", "Sampler / Drum Synth pads; Shift = full velocity"],
      ["Esc", "Finish MIDI / Key Learn"],
    ]],
  ];

  let dirty = false;
  let lastStatus = "";
  let statusAt = 0;
  let midiTimer = null;

  function build() {
    const footer = document.querySelector("footer.global-footer");
    if (!footer) return;
    // keep the app's existing #helpText element (app.js holds a reference to it)
    const helpEl = document.getElementById("helpText");
    footer.id = "statusBar";
    footer.innerHTML = `
      <div class="sb-bar">
        <button type="button" class="sb-btn sb-toggle" id="sbToggle" title="Collapse the status bar" aria-label="Collapse the status bar">▾</button>
        <div class="sb-msg" id="sbMsg" aria-live="polite"><span class="sb-msg-icon" id="sbMsgIcon"></span><span class="sb-msg-text" id="sbMsgText"></span></div>
        <div class="sb-hint" id="sbHint"></div>
        <div class="sb-ind">
          <span class="sb-rec" id="sbRec" hidden>● REC <b id="sbRecTime">0:00</b></span>
          <span class="sb-led" id="sbMidi" title="MIDI input activity"><i></i>MIDI</span>
          <button type="button" class="sb-btn sb-chip" id="sbSnap" title="Snap / grid for drawing, moving and quantizing">Snap 1/8</button>
          <span class="sb-chip sb-audio" id="sbAudio" title="Audio engine">Audio off</span>
          <span class="sb-chip sb-saved" id="sbSaved" title="Project state">Saved</span>
          <span class="sb-chip sb-peers" id="sbPeers" hidden title="Collaborators in this session"></span>
          <button type="button" class="sb-btn" id="sbKeys" title="Keyboard shortcuts" aria-label="Keyboard shortcuts">⌨</button>
        </div>
      </div>`;
    if (helpEl) { helpEl.style.display = "none"; footer.appendChild(helpEl); }

    $("sbToggle").addEventListener("click", () => setCollapsed(!document.body.classList.contains("sb-collapsed")));
    $("sbKeys").addEventListener("click", openShortcuts);
    $("sbSnap").addEventListener("click", (e) => {
      const sel = document.getElementById("gridSelect");
      if (!sel) return;
      const r = e.currentTarget.getBoundingClientRect();
      const items = [...sel.options].map(o => ({
        label: (o.value === sel.value ? "✓ " : "   ") + o.textContent,
        action: () => { sel.value = o.value; sel.dispatchEvent(new Event("change", { bubbles: true })); refresh(); }
      }));
      window.WAWWorkspace?.popupMenu(r.left, r.top - items.length * 28 - 8, items);
    });

    // status messages (the #status element lives in a sidebar panel that is often hidden)
    const statusEl = document.getElementById("status");
    if (statusEl) {
      new MutationObserver(() => { lastStatus = statusEl.textContent.trim(); statusAt = Date.now(); showMessage(); })
        .observe(statusEl, { childList: true, characterData: true, subtree: true });
      lastStatus = statusEl.textContent.trim();
    }
    // hover help (written into #helpText by the app's help system)
    new MutationObserver(showMessage).observe($("helpText"), { childList: true, characterData: true, subtree: true });

    try { setCollapsed(localStorage.getItem(LS_COLLAPSED) === "1", false); } catch (e) {}
    showMessage();
    refresh();
    setInterval(refresh, 250);
  }

  function setCollapsed(on, save = true) {
    document.body.classList.toggle("sb-collapsed", on);
    const t = $("sbToggle");
    if (t) { t.textContent = on ? "▴" : "▾"; t.title = on ? "Show the status bar" : "Collapse the status bar"; t.setAttribute("aria-label", t.title); }
    if (save) { try { localStorage.setItem(LS_COLLAPSED, on ? "1" : "0"); } catch (e) {} }
    window.dispatchEvent(new Event("resize")); // canvases re-measure
  }

  const DEFAULT_HELP = /^Hover over any control/;
  function showMessage() {
    const help = $("helpText")?.textContent.trim() || "";
    const hovering = help && !DEFAULT_HELP.test(help);
    const text = hovering ? help : (lastStatus || "Ready.");
    const msg = $("sbMsgText"), icon = $("sbMsgIcon");
    if (!msg) return;
    msg.textContent = text;
    msg.title = text;
    icon.textContent = hovering ? "ⓘ" : "›";
    $("sbMsg").classList.toggle("is-help", !!hovering);
    // flag problems so they are not missed
    $("sbMsg").classList.toggle("is-warn", !hovering && /fail|unavailable|could not|not supported|silent|error|no audio/i.test(text));
    $("sbMsg").classList.toggle("is-fresh", !hovering && Date.now() - statusAt < 1500);
  }

  function refresh() {
    // shortcut hints for the current view
    const view = typeof currentView !== "undefined" ? currentView : "sequencer";
    const hint = $("sbHint");
    if (hint) { const h = HINTS[view] || ""; if (hint.textContent !== h) { hint.textContent = h; hint.title = h; } }

    // recording
    const rec = $("sbRec");
    if (rec) {
      const on = typeof isRecording !== "undefined" && isRecording;
      rec.hidden = !on;
      if (on && typeof audioCtx !== "undefined" && audioCtx) {
        const s = Math.max(0, audioCtx.currentTime - recordingStartTime);
        $("sbRecTime").textContent = `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
      }
    }

    // snap
    const sel = document.getElementById("gridSelect");
    const snap = $("sbSnap");
    if (sel && snap) snap.textContent = "Snap " + (sel.selectedOptions[0]?.textContent || sel.value).replace(" bar", "").replace(/^1$/, "1 bar");

    // audio engine
    const a = $("sbAudio");
    if (a) {
      const ctx = typeof audioCtx !== "undefined" ? audioCtx : null;
      if (!ctx) { a.textContent = "Audio off"; a.className = "sb-chip sb-audio"; a.title = "The audio engine starts on the first play / click"; }
      else {
        const ms = Math.round(((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000);
        const ok = ctx.state === "running";
        a.textContent = ok ? `${(ctx.sampleRate / 1000).toFixed(1)} kHz · ${ms} ms` : `Audio ${ctx.state}`;
        a.className = "sb-chip sb-audio" + (ok ? " ok" : " warn");
        a.title = ok ? "Audio engine running (sample rate · output latency)" : "Audio is paused by the browser: click anywhere or press Play";
      }
    }

    // saved / unsaved
    const sv = $("sbSaved");
    if (sv) { sv.textContent = dirty ? "● Unsaved" : "Saved"; sv.classList.toggle("dirty", dirty); }

    // collaborators
    const p = $("sbPeers");
    const st = window.WAWCollab?.state;
    if (p) {
      const live = !!st?.room;
      p.hidden = !live;
      if (live) p.textContent = `👥 ${st.peers.size + 1}`;
    }
    showMessage();
  }

  function midiActivity() {
    const led = $("sbMidi");
    if (!led) return;
    led.classList.add("on");
    clearTimeout(midiTimer);
    midiTimer = setTimeout(() => led.classList.remove("on"), 120);
  }

  // ---- keyboard shortcut sheet ----
  /** "Ctrl+C / X / V" -> <kbd>Ctrl+C</kbd> / <kbd>X</kbd> …; descriptive parts stay plain */
  function keyHtml(k) {
    return k.split(/(\s\/\s|\sor\s|\s…\s)/).map(tok => {
      if (/^\s(\/|or|…)\s$/.test(tok)) return `<span class="sc-sep">${tok.trim()}</span>`;
      const m = /^(\S+)(\s\(.*\))?$/.exec(tok);
      if (m && m[1].length <= 14 && !/^(Pad|Piano)$/.test(m[1])) return `<kbd>${m[1]}</kbd>${m[2] ? `<span class="sc-note">${m[2]}</span>` : ""}`;
      return `<span class="sc-note">${tok}</span>`;
    }).join(" ");
  }
  let sheet = null;
  function openShortcuts() {
    if (!sheet) {
      sheet = document.createElement("div");
      sheet.className = "modal-backdrop";
      sheet.id = "shortcutsModal";
      sheet.innerHTML = `<div class="modal-dialog shortcuts-dialog" role="dialog" aria-label="Keyboard shortcuts">
        <div class="modal-header"><span>Keyboard shortcuts</span><button type="button" class="sc-close" aria-label="Close">×</button></div>
        <div class="sc-body">${SHORTCUTS.map(([group, rows]) => `<section><h3>${group}</h3><dl>${rows.map(([k, d]) => `<dt>${keyHtml(k)}</dt><dd>${d}</dd>`).join("")}</dl></section>`).join("")}</div>
      </div>`;
      document.body.appendChild(sheet);
      sheet.addEventListener("click", (e) => { if (e.target === sheet || e.target.closest(".sc-close")) sheet.classList.remove("visible"); });
      document.addEventListener("keydown", (e) => { if (e.code === "Escape" && sheet.classList.contains("visible")) sheet.classList.remove("visible"); });
    }
    sheet.classList.add("visible");
  }

  document.addEventListener("DOMContentLoaded", build);

  window.WAWStatusBar = {
    markDirty() { dirty = true; },
    markSaved() { dirty = false; },
    midiActivity, openShortcuts, setCollapsed
  };
})();
