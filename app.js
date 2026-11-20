  // ---------- THEORY / CONFIG ----------
  const SCALES = {
    major:  [0, 2, 4, 5, 7, 9, 11],
    minor:  [0, 2, 3, 5, 7, 8, 10],
    pent:   [0, 3, 5, 7, 10],
  };

  const TONICS = {
    "C": 0, "C#": 1, "Db": 1,
    "D": 2, "D#": 3, "Eb": 3,
    "E": 4,
    "F": 5, "F#": 6, "Gb": 6,
    "G": 7, "G#": 8, "Ab": 8,
    "A": 9, "A#": 10, "Bb": 10,
    "B": 11
  };

  const FIFTHS_ORDER = ["C", "G", "D", "A", "E", "B", "F#", "Db", "Ab", "Eb", "Bb", "F"];

  const NOTE_SEMITONES = {
    "C": 0, "C#": 1, "Db": 1,
    "D": 2, "D#": 3, "Eb": 3,
    "E": 4,
    "F": 5, "F#": 6, "Gb": 6,
    "G": 7, "G#": 8, "Ab": 8,
    "A": 9, "A#": 10, "Bb": 10,
    "B": 11
  };

  const KEY_LABEL_WIDTH = 42;

  // Escape user-provided text (track/clip/project names) before inserting it via innerHTML.
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, ch => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[ch]);
  }

  function midiToNoteName(m) {
    if (m == null || isNaN(m)) return "";
    m = Math.round(m);
    const names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
    const semitone = ((m % 12) + 12) % 12;
    const octave = Math.floor(m / 12) - 1;
    return names[semitone] + octave;
  }

  function noteNameToMidi(name) {
    if (!name) return NaN;
    const match = name.trim().match(/^([A-Ga-g])([#b]?)(-?\d+)$/);
    if (!match) return NaN;
    let [, letter, accidental, octaveStr] = match;
    letter = letter.toUpperCase();
    const key = letter + (accidental || "");
    const semitone = NOTE_SEMITONES[key];
    if (semitone == null) return NaN;
    const octave = parseInt(octaveStr, 10);
    if (isNaN(octave)) return NaN;
    return (octave + 1) * 12 + semitone;
  }

// ---------- SEQUENCER RENDERING ----------
const sequencerGrid = document.getElementById("sequencerGrid");

  // -------- SEQUENCER (global) time window --------
  let seqViewStartSec = 0;     // left edge in seconds
  let seqViewDuration = 32;    // how much time is visible (seconds)
  let seqPxPerBeat = 60;       // zoom (px per beat), persistent

  function updateSeqViewFromScroll() {
    if (!sequencerGrid) return;

    const pxPerSec = getSeqPxPerSec();

    // visible lane window in seconds; exclude the sticky track-label gutter
    const usableWidth = Math.max(10, sequencerGrid.clientWidth - getSeqLabelWidth());
    seqViewDuration = Math.max(1, usableWidth / pxPerSec);

    // left edge in seconds
    seqViewStartSec = (sequencerGrid.scrollLeft / pxPerSec);

    drawSequencerRuler(lastPlayheadSec);
  }

  // keep ruler synced while scrolling
  sequencerGrid?.addEventListener("scroll", () => {
    updateSeqViewFromScroll();
  });


  // convert bpm -> px/sec based on zoom
  function getSeqPxPerSec() {
    const bpm = parseFloat(bpmInput?.value) || 120;
    const secPerBeat = 60 / bpm;
    return seqPxPerBeat / secPerBeat;
  }

  // snap to grid (uses your gridValue + getGridSeconds)
  function snapSec(sec) {
    const bpm = parseFloat(bpmInput?.value) || 120;
    const secPerBeat = 60 / bpm;
    const gridSec = getGridSeconds(secPerBeat);
    return quantizeTime(sec, gridSec, swingAmount, true);
  }

  // Re-map every stored song time after a tempo-map edit so content keeps its
  // bar/beat position (generalises the old uniform BPM rescale).
  function remapAllTimes(map) {
    const mapNote = n => { const s = map(n.startSec), e = map(n.endSec); n.startSec = s; n.endSec = Math.max(s + 0.001, e); };
    tracks.forEach(t => {
      (t.notes || []).forEach(mapNote);
      (t.clips || []).forEach(c => {
        const s0 = c.startSec, e0 = c.endSec;
        const local = c.audio ? null : getClipLocalNotes(c);
        c.startSec = map(s0);
        if (c.audio && !c.audio.warp?.on) {
          // un-warped audio keeps its real duration (only its position moves)
          c.endSec = c.startSec + (e0 - s0);
        } else {
          c.endSec = Math.max(c.startSec + 0.01, map(e0));
        }
        if (local) {
          c.notesSnapshot = local.map(n => ({ ...n, startSec: map(s0 + n.startSec) - c.startSec, endSec: Math.max(map(s0 + n.startSec) - c.startSec + 0.001, map(s0 + n.endSec) - c.startSec) }));
        }
        window.WAWWarp?.onClipRemapped?.(c, s0, e0);
      });
      window.WAWAutomation?.remapTrack?.(t, map);
    });
    window.WAWAutomation?.remapGlobal?.(map);
    const lStart = loopStartSec, lEnd = loopEndSec;
    loopStartSec = map(lStart); loopEndSec = map(lEnd);
    clipLoopStartSec = map(clipLoopStartSec); clipLoopEndSec = map(clipLoopEndSec);
    const vEnd = map(viewStartSec + viewDuration);
    viewStartSec = map(viewStartSec); viewDuration = Math.max(0.5, vEnd - viewStartSec);
    if (lastPlayheadSec != null) lastPlayheadSec = map(lastPlayheadSec);
    if (tracks[activeTrackIndex]) notes = tracks[activeTrackIndex].notes;
    updateTimeView();
    renderSequencer();
    drawPianoRoll(lastPlayheadSec);
    drawVelocityLane();
    drawAllLoopBars(lastPlayheadSec);
    restartPlaybackFromCurrentPosition();
  }

function renderSequencer() {
  if (!sequencerGrid) return;
  ensureTracks();

  // Preserve horizontal scroll so rerenders don't jump the view
  const prevScrollLeft = sequencerGrid.scrollLeft;

  // Rebuild lanes
  sequencerGrid.innerHTML = "";

  const pxPerSec = getSeqPxPerSec();
  const bpm = parseFloat(bpmInput?.value) || timelineBpm || 120;
  const secPerBar = (60 / bpm) * 4;

  // Determine max clip end (including active loop end so users can scroll across the full loop)
  const maxClipEnd = Math.max(
    8,
    loopEnabled ? loopEndSec : 0,
    ...tracks.flatMap(t => (t.clips || []).map(c => c.endSec))
  );

  // Always allow viewport width even if no clips
  const songLen = Math.max(
    maxClipEnd + secPerBar * 2,
    seqViewStartSec + seqViewDuration
  );

  const laneWidthPx = songLen * pxPerSec;

  window.WAWTempo?.buildGlobalRow(sequencerGrid, { pxPerSec, laneWidthPx });
  window.WAWWorkspace?.syncZoomBar?.();

  tracks.forEach((t, ti) => {
    if (!t.color) t.color = getTrackColor(ti);

    const row = document.createElement("div");
    row.className = "seq-track-row" + (ti === activeTrackIndex ? " active" : "");
    row.dataset.trackIndex = ti;

    const kindLabel = t.type === "audio" ? "Audio" : (t.instrument === "808" ? "Drums" : t.instrument === "sampler" ? "Sampler" : "Synth");
    row.classList.toggle("is-audio", t.type === "audio");
    row.classList.toggle("is-muted", !!t.mute);
    row.innerHTML = `
      <div class="seq-row-label" style="border-left:4px solid ${t.color}">
        <div class="seq-label-top"><span class="seq-label-name">${escapeHtml(t.name || `Track ${ti + 1}`)}</span><span class="seq-label-kind">${kindLabel}</span></div>
        <div class="seq-label-btns">
          <button type="button" class="tb-m ${t.mute ? "on" : ""}" data-tb="mute" title="Mute">M</button>
          <button type="button" class="tb-s ${t.solo ? "on" : ""}" data-tb="solo" title="Solo">S</button>
          <button type="button" class="tb-r ${t.armed ? "on" : ""}" data-tb="arm" title="Record arm" aria-label="Record arm">${window.WAWIcons?.record || "R"}</button>
          ${t.type === "audio" ? `<button type="button" class="tb-i ${t.monitor ? "on" : ""}" data-tb="monitor" title="Input monitoring" aria-label="Input monitoring">${window.WAWIcons?.monitor || "I"}</button>` : ""}
          <button type="button" class="tb-a ${t.automation?.show ? "on" : ""} ${(t.automation?.lanes || []).some(l => l.points.length) ? "has" : ""}" data-tb="auto" title="Show automation lanes" aria-label="Automation lanes">${window.WAWIcons?.automation || "A"}</button>
        </div>
      </div>
      <div class="seq-row-lane"></div>
    `;

    const lane = row.querySelector(".seq-row-lane");
    const label = row.querySelector(".seq-row-label");
    lane.style.width = laneWidthPx + "px";

    label?.addEventListener("click", (e) => {
      e.stopPropagation();
      const tb = e.target.closest("[data-tb]")?.dataset.tb;
      if (tb) { window.WAWWorkspace?.trackButton(t, tb); return; }
      setActiveTrack(ti, { silent: true });
      renderSequencer();
      renderMixer();
    });
    label?.addEventListener("dblclick", (e) => {
      if (e.target.closest("[data-tb]")) return;
      const v = prompt("Track name:", t.name);
      if (v && v.trim()) { pushHistory(); t.name = v.trim(); renderSequencer(); renderSidebarTracks(); renderMixer(); }
    });
    label?.addEventListener("contextmenu", (e) => {
      e.preventDefault(); e.stopPropagation();
      setActiveTrack(ti, { silent: true });
      window.WAWWorkspace?.showTrackMenu(ti, e.clientX, e.clientY);
    });

    // Use pointerdown/pointerup with a movement threshold so dragging across
    // an empty lane does not accidentally spawn a new clip on mouse-up.
    let laneDownX = 0;
    let laneDownY = 0;
    let laneTracking = false;

    lane.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest(".seq-clip")) return;
      laneTracking = true;
      laneDownX = e.clientX;
      laneDownY = e.clientY;
    });

    lane.addEventListener("pointerup", (e) => {
      if (!laneTracking) return;
      laneTracking = false;

      if (e.button !== 0 || e.target.closest(".seq-clip")) return;
      if (Math.hypot(e.clientX - laneDownX, e.clientY - laneDownY) > 4) return;

      e.stopPropagation();
      if (t.type === "audio") { setActiveTrack(ti, { silent: true }); renderSequencer(); return; }

      const rect = lane.getBoundingClientRect();
      const xPx = e.clientX - rect.left;
      const rawStartSec = Math.max(0, xPx / pxPerSec);

      // Default 4-bar clip anchored to the bar start (follows tempo + meter changes)
      const startBar = window.WAWTempo.position(rawStartSec).bar;
      const startSec = window.WAWTempo.barToSec(startBar);
      const endSec = window.WAWTempo.barToSec(startBar + 4);

      // Prevent overlap with existing clips on this track
      const existing = (t.clips || []).find(
        c => startSec < c.endSec && endSec > c.startSec
      );
      if (existing) return;

      setActiveTrack(ti, { silent: true });
      pushHistory();

      const clip = new Clip({ startSec, endSec, notesSnapshot: [] });
      clip.name = `Clip ${(t.clips?.length || 0) + 1}`;
      t.clips.push(clip);

      setSelectedClip(ti, clip.id);
      setGlobalLoopToClip(clip);

      renderSequencer();
    });

    lane.addEventListener("pointercancel", () => {
      laneTracking = false;
    });

    // Draw clips + thumbnails
    (t.clips || []).forEach(clip => {
      const clipEl = document.createElement("div");
      clipEl.className = "seq-clip";

      if (
        selectedClipRef &&
        selectedClipRef.trackIndex === ti &&
        selectedClipRef.clipId === clip.id
      ) {
        clipEl.classList.add("selected");
      }

      if (clip.isRecordingLive) {
        clipEl.classList.add("recording");
        liveRecordingClipEl = clipEl;
      }

      clipEl.dataset.trackIndex = ti;
      clipEl.dataset.clipId = clip.id;

      clipEl.style.left  = (clip.startSec * pxPerSec) + "px";
      clipEl.style.width = Math.max(8, (clip.endSec - clip.startSec) * pxPerSec) + "px";

      clipEl.innerHTML = `
        <canvas class="clip-thumb"></canvas>
        <div class="handle left" data-handle="left"></div>
        <div class="handle right" data-handle="right"></div>
        <div class="clip-title">${escapeHtml(clip.name || "Clip")}</div>
      `;

      lane.appendChild(clipEl);

      // Wait one frame so CSS sizes resolve, then draw the thumbnail
      const thumb = clipEl.querySelector(".clip-thumb");
      if (clip.audio) clipEl.classList.add("audio");
      if (clip.muted) clipEl.classList.add("muted");
      requestAnimationFrame(() => {
        if (thumb && thumb.isConnected) {
          drawClipPreview(thumb, clip);
        }
      });
    });

    sequencerGrid.appendChild(row);
    // automation / take lanes under the track
    window.WAWAutomation?.appendLanes?.(sequencerGrid, t, ti, { pxPerSec, laneWidthPx });
    window.WAWComp?.appendLanes?.(sequencerGrid, t, ti, { pxPerSec, laneWidthPx });
  });

  // Restore scroll synchronously after DOM rebuild to avoid a 1-frame visual snap
  sequencerGrid.scrollLeft = prevScrollLeft;

  // Update background grid AFTER rows exist
  updateSequencerBackgroundGrid();

  // Defer canvas sizing + ruler/loop redraw until after layout settles
  requestAnimationFrame(() => {
    resizeCanvases();
    updateSeqViewFromScroll();

    drawSequencerRuler(lastPlayheadSec);
    drawAllLoopBars(lastPlayheadSec);
    window.WAWCollab?.paintPresence?.();
  });
}

// end renderSequencer()

let seqGridLabelW = 0;

function getSeqLabelWidth() {
  const labelEl = document.querySelector(".seq-row-label");
  if (labelEl) return labelEl.offsetWidth || 0;
  const firstRow = document.querySelector(".seq-track-row");
  if (!firstRow) return 0;
  const cols = getComputedStyle(firstRow).gridTemplateColumns.split(" ");
  return parseFloat(cols[0]) || 0;
}

function updateSequencerBackgroundGrid() {
  if (!sequencerGrid) return;
  if (window.WAWTempo && !window.WAWTempo.isSimple()) {
    // non-uniform bars: draw the actual bar/beat lines as an SVG background
    seqGridLabelW = getSeqLabelWidth();
    const pxPerSec = getSeqPxPerSec();
    const widthPx = Math.max(sequencerGrid.scrollWidth, sequencerGrid.clientWidth);
    const lines = window.WAWTempo.gridLines(0, widthPx / pxPerSec, pxPerSec, 8)
      .filter(l => l.kind !== "sub")
      .map(l => `<rect x="${(l.sec * pxPerSec).toFixed(1)}" y="0" width="${l.kind === "bar" ? 2 : 1}" height="10" fill="${l.kind === "bar" ? "rgba(96,165,250,0.12)" : "rgba(255,255,255,0.06)"}"/>`).join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(widthPx)}" height="10" preserveAspectRatio="none">${lines}</svg>`;
    sequencerGrid.style.backgroundColor = "#0a0c14";
    sequencerGrid.style.backgroundImage = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
    sequencerGrid.style.backgroundSize = `${Math.ceil(widthPx)}px 100%`;
    sequencerGrid.style.backgroundRepeat = "no-repeat";
    sequencerGrid.style.backgroundPosition = `${seqGridLabelW}px 0`;
    return;
  }
  sequencerGrid.style.backgroundSize = "";
  sequencerGrid.style.backgroundRepeat = "";

  const bpm = parseFloat(bpmInput?.value) || 120;
  const secPerBeat = 60 / bpm;
  const beatsPerBar = 4;

  const pxPerBeat = seqPxPerBeat;
  const pxPerBar  = pxPerBeat * beatsPerBar;

  seqGridLabelW = getSeqLabelWidth();

  sequencerGrid.style.backgroundColor = "#0a0c14";
  sequencerGrid.style.backgroundImage = `
    repeating-linear-gradient(
      to right,
      rgba(255,255,255,0.06) 0,
      rgba(255,255,255,0.06) 1px,
      transparent 1px,
      transparent ${pxPerBeat}px
    ),
    repeating-linear-gradient(
      to right,
      rgba(96,165,250,0.12) 0,
      rgba(96,165,250,0.12) 2px,
      transparent 2px,
      transparent ${pxPerBar}px
    )
  `;

  sequencerGrid.style.backgroundAttachment = "local";
  sequencerGrid.style.backgroundPosition =
    `${seqGridLabelW - sequencerGrid.scrollLeft}px 0px`;
}

// ---- Clip dragging/resizing ----
const seqDrag = {
  active: false,
  mode: null,          // "move" | "resizeL" | "resizeR"
  trackIndex: -1,
  clipId: null,
  startMouseX: 0,
  origStart: 0,
  origEnd: 0,
  origNotesSnapshot: [],
};
let seqContextTarget = null;
let selectedClipRef = null;
let clipClipboard = null;

function setSelectedClip(trackIndex, clipId) {
  selectedClipRef = Number.isInteger(trackIndex) && clipId
    ? { trackIndex, clipId }
    : null;

  document.querySelectorAll(".seq-clip.selected").forEach(el => {
    const isSelected = selectedClipRef &&
      Number(el.dataset.trackIndex) === selectedClipRef.trackIndex &&
      el.dataset.clipId === selectedClipRef.clipId;
    el.classList.toggle("selected", Boolean(isSelected));
  });
}

function getSelectedClipRef() {
  if (!selectedClipRef) return null;
  const t = tracks[selectedClipRef.trackIndex];
  const clip = (t?.clips || []).find(c => c.id === selectedClipRef.clipId);
  return clip ? { track: t, clip, trackIndex: selectedClipRef.trackIndex } : null;
}

function restartPlaybackFromCurrentPosition() {
  if (!isPlaying) return;
  const restartAtSec = lastPlayheadSec || playbackRangeStartSec || 0;
  stopPlayback();
  lastPlayheadSec = restartAtSec;
  playheadWasManuallySet = true;
  playNotes(getAllNotesMixdown());
}

function deleteClip(trackIndex, clipId) {
  const t = tracks[trackIndex];
  if (!t?.clips) return false;
  const clipIndex = t.clips.findIndex(c => c.id === clipId);
  if (clipIndex < 0) return false;

  const clip = t.clips[clipIndex];
  pushHistory();
  t.clips.splice(clipIndex, 1);
  t.notes = (t.notes || []).filter(n =>
    n.endSec <= clip.startSec || n.startSec >= clip.endSec
  );
  if (tracks[activeTrackIndex] === t) notes = t.notes;
  if (activeClipId === clip.id) activeClipId = null;
  setSelectedClip(null, null);
  renderSequencer();
  renderMixer();
  restartPlaybackFromCurrentPosition();
  statusEl.textContent = `Deleted ${clip.name || "clip"}.`;
  return true;
}

function deleteSelectedClip() {
  const selected = getSelectedClipRef();
  if (!selected) return false;
  return deleteClip(selected.trackIndex, selected.clip.id);
}

function refreshClipAfterEdit(track, clip, message = "") {
  syncTrackNotesFromClip(track, clip);
  renderSequencer();
  renderMixer();
  restartPlaybackFromCurrentPosition();
  if (message) statusEl.textContent = message;
}

function getNextAvailableClipStart(track, desiredStart, duration, ignoreClipId = null) {
  let start = Math.max(0, desiredStart);
  const clips = (track?.clips || [])
    .filter(c => c.id !== ignoreClipId)
    .sort((a, b) => a.startSec - b.startSec);

  let moved = true;
  while (moved) {
    moved = false;
    for (const clip of clips) {
      if (start < clip.endSec && start + duration > clip.startSec) {
        start = clip.endSec;
        moved = true;
      }
    }
  }
  return start;
}

function copyClip(trackIndex, clipId) {
  const track = tracks[trackIndex];
  const clip = (track?.clips || []).find(c => c.id === clipId);
  if (!clip) return false;

  clipClipboard = {
    name: clip.name || "Clip",
    duration: Math.max(0.1, clip.endSec - clip.startSec),
    notesSnapshot: getClipLocalNotes(clip).map(n => ({ ...n })),
    audio: clip.audio ? { ...clip.audio } : null
  };
  statusEl.textContent = `Copied ${clip.name || "clip"}.`;
  return true;
}

function cutClip(trackIndex, clipId) {
  if (!copyClip(trackIndex, clipId)) return false;
  return deleteClip(trackIndex, clipId);
}

function pasteClip(trackIndex, atSec = null) {
  if (!clipClipboard) return false;
  const track = tracks[trackIndex] || getActiveTrack();
  if (!track) return false;
  // audio clips go on audio tracks, MIDI clips on instrument tracks
  if (!!clipClipboard.audio !== (track.type === "audio")) {
    statusEl.textContent = clipClipboard.audio ? "Paste audio clips onto an audio track." : "Paste MIDI clips onto an instrument track.";
    return false;
  }

  const duration = Math.max(0.1, clipClipboard.duration);
  const desiredStart = atSec != null && isFinite(atSec)
    ? atSec
    : (lastPlayheadSec || 0);
  const startSec = getNextAvailableClipStart(track, snapSec(desiredStart), duration);
  const pasted = new Clip({
    startSec,
    endSec: startSec + duration,
    notesSnapshot: clipClipboard.notesSnapshot.map(n => ({ ...n }))
  });
  pasted.name = `${clipClipboard.name || "Clip"} Copy`;
  if (clipClipboard.audio) pasted.audio = { ...clipClipboard.audio };

  pushHistory();
  track.clips = track.clips || [];
  track.clips.push(pasted);
  syncTrackNotesFromClip(track, pasted);
  setActiveTrack(tracks.indexOf(track), { silent: true });
  setSelectedClip(tracks.indexOf(track), pasted.id);
  renderSequencer();
  renderMixer();
  restartPlaybackFromCurrentPosition();
  statusEl.textContent = `Pasted ${pasted.name}.`;
  return true;
}

function duplicateClip(trackIndex, clipId) {
  const track = tracks[trackIndex];
  const clip = (track?.clips || []).find(c => c.id === clipId);
  if (!clip) return false;

  const duration = Math.max(0.1, clip.endSec - clip.startSec);
  const startSec = getNextAvailableClipStart(track, clip.endSec, duration, clip.id);
  const duplicate = new Clip({
    startSec,
    endSec: startSec + duration,
    notesSnapshot: getClipLocalNotes(clip).map(n => ({ ...n }))
  });
  duplicate.name = `${clip.name || "Clip"} Copy`;
  if (clip.audio) duplicate.audio = { ...clip.audio };

  pushHistory();
  track.clips.push(duplicate);
  syncTrackNotesFromClip(track, duplicate);
  setSelectedClip(trackIndex, duplicate.id);
  renderSequencer();
  renderMixer();
  restartPlaybackFromCurrentPosition();
  statusEl.textContent = `Duplicated ${clip.name || "clip"}.`;
  return true;
}

function quantizeClip(trackIndex, clipId) {
  const track = tracks[trackIndex];
  const clip = (track?.clips || []).find(c => c.id === clipId);
  if (!clip) return false;

  pushHistory();
  const bpm = parseFloat(bpmInput.value) || 120;
  const secPerBeat = 60 / bpm;
  const gridSec = getGridSeconds(secPerBeat);
  const clipLen = Math.max(0.1, clip.endSec - clip.startSec);
  clip.notesSnapshot = getClipLocalNotes(clip).map(n => {
    const dur = Math.max(0.05, n.endSec - n.startSec);
    const startSec = Math.min(Math.max(0, quantizeTime(n.startSec, gridSec, swingAmount, true, clip.startSec)), Math.max(0, clipLen - 0.05));
    return {
      ...n,
      startSec,
      endSec: Math.min(clipLen, startSec + dur)
    };
  }).filter(n => n.endSec > n.startSec);
  refreshClipAfterEdit(track, clip, `Quantized ${clip.name || "clip"}.`);
  return true;
}

function humanizeClip(trackIndex, clipId) {
  const track = tracks[trackIndex];
  const clip = (track?.clips || []).find(c => c.id === clipId);
  if (!clip) return false;

  pushHistory();
  const clipLen = Math.max(0.1, clip.endSec - clip.startSec);
  const maxTime = 0.02;
  const maxVel = 10;
  clip.notesSnapshot = getClipLocalNotes(clip).map(n => {
    const dur = Math.max(0.05, n.endSec - n.startSec);
    const offset = (Math.random() * 2 - 1) * maxTime;
    const startSec = Math.min(Math.max(0, n.startSec + offset), Math.max(0, clipLen - dur));
    const deltaVel = Math.round((Math.random() * 2 - 1) * maxVel);
    return {
      ...n,
      startSec,
      endSec: Math.min(clipLen, startSec + dur),
      velocity: Math.min(127, Math.max(1, (n.velocity ?? 100) + deltaVel))
    };
  });
  refreshClipAfterEdit(track, clip, `Humanized ${clip.name || "clip"}.`);
  return true;
}

function renameClip(trackIndex, clipId) {
  const track = tracks[trackIndex];
  const clip = (track?.clips || []).find(c => c.id === clipId);
  if (!clip) return false;
  const nextName = prompt("Clip name:", clip.name || "Clip");
  if (nextName == null) return false;
  const name = nextName.trim();
  if (!name) return false;
  pushHistory();
  clip.name = name;
  renderSequencer();
  statusEl.textContent = `Renamed clip to "${name}".`;
  return true;
}

function clearClipNotes(trackIndex, clipId) {
  const track = tracks[trackIndex];
  const clip = (track?.clips || []).find(c => c.id === clipId);
  if (!clip) return false;
  pushHistory();
  clip.notesSnapshot = [];
  refreshClipAfterEdit(track, clip, `Cleared ${clip.name || "clip"}.`);
  return true;
}

function setLoopToClip(trackIndex, clipId) {
  const track = tracks[trackIndex];
  const clip = (track?.clips || []).find(c => c.id === clipId);
  if (!clip) return false;
  pushHistory();
  setGlobalLoopToClip(clip);
  drawAllLoopBars(lastPlayheadSec);
  statusEl.textContent = `Loop set to ${clip.name || "clip"}.`;
  return true;
}

let sequencerInteractionsAttached = false;

function attachSequencerInteractions() {
  if (!sequencerGrid || sequencerInteractionsAttached) return;
  sequencerInteractionsAttached = true;

  let seqDragMoved = false;

  // Use pointer events (works for mouse + touch)
  sequencerGrid.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    seqDragMoved = false;

    const clipEl = e.target.closest(".seq-clip");
    if (!clipEl) return;

    e.preventDefault();
    try { clipEl.setPointerCapture(e.pointerId); } catch (_) {}

    const ti = Number(clipEl.dataset.trackIndex);
    const clipId = clipEl.dataset.clipId;

    const t = tracks[ti];
    const clip = (t.clips || []).find(c => c.id === clipId);
    if (!clip) return;

    // detect resize handles vs body
    const handle = e.target.dataset.handle;
    let mode = "move";
    if (handle === "left") mode = "resizeL";
    if (handle === "right") mode = "resizeR";

    seqDrag.active = true;
    seqDrag.mode = mode;
    seqDrag.trackIndex = ti;
    seqDrag.clipId = clipId;
    seqDrag.startMouseX = e.clientX;
    seqDrag.origStart = clip.startSec;
    seqDrag.origEnd = clip.endSec;
    seqDrag.origNotesSnapshot = (clip.notesSnapshot || []).map(n => ({ ...n }));
    seqDrag.origOffset = clip.audio?.offset ?? 0;
    beginHistoryGesture();

    // select + set active track
    setActiveTrack(ti, { silent: true });
    setSelectedClip(ti, clipId);
  });

  sequencerGrid.addEventListener("pointermove", (e) => {
    if (!seqDrag.active) return;

    seqDragMoved = true;

    const pxPerSec = getSeqPxPerSec();
    const dxPx = e.clientX - seqDrag.startMouseX;
    const dSec = dxPx / pxPerSec;

    const ti = seqDrag.trackIndex;
    const t = tracks[ti];
    const clip = (t.clips || []).find(c => c.id === seqDrag.clipId);
    if (!clip) return;

    const minLen = 0.1;

    if (seqDrag.mode === "move") {
      let ns = seqDrag.origStart + dSec;
      let ne = seqDrag.origEnd + dSec;
      const dur = ne - ns;

      ns = snapSec(Math.max(0, ns));
      ne = ns + dur;

      clip.startSec = ns;
      clip.endSec = ne;
    }

    if (seqDrag.mode === "resizeL") {
      let ns = seqDrag.origStart + dSec;
      ns = snapSec(Math.max(0, ns));
      ns = Math.min(ns, clip.endSec - minLen);
      clip.startSec = ns;
      if (clip.audio) window.WAWAudio.trimAudioClip(clip, seqDrag.origStart, seqDrag.origEnd, seqDrag.origOffset);
      else trimClipToCurrentBounds(t, clip, seqDrag.origNotesSnapshot, seqDrag.origStart);
    }

    if (seqDrag.mode === "resizeR") {
      let ne = seqDrag.origEnd + dSec;
      ne = snapSec(ne);
      ne = Math.max(ne, clip.startSec + minLen);
      clip.endSec = ne;
      if (clip.audio) window.WAWAudio.trimAudioClip(clip, seqDrag.origStart, seqDrag.origEnd, seqDrag.origOffset);
      else trimClipToCurrentBounds(t, clip, seqDrag.origNotesSnapshot, seqDrag.origStart);
    }

    // Update only the dragged clip element instead of rebuilding every lane
    // on each pointermove (which was very expensive with many clips/tracks).
    updateClipElementGeometry(ti, clip, seqDrag.mode !== "move");
  });

  function updateClipElementGeometry(ti, clip, redrawThumb) {
    const pxPerSec = getSeqPxPerSec();
    const clipEl = sequencerGrid.querySelector(
      `.seq-clip[data-track-index="${ti}"][data-clip-id="${CSS.escape(clip.id)}"]`
    );
    const lane = clipEl?.parentElement;
    const neededWidth = (clip.endSec + (60 / (parseFloat(bpmInput?.value) || 120)) * 8) * pxPerSec;
    if (!clipEl || !lane || lane.offsetWidth < neededWidth) {
      // lane must grow (or element is missing) -> full rebuild
      renderSequencer();
      return;
    }
    clipEl.style.left = (clip.startSec * pxPerSec) + "px";
    clipEl.style.width = Math.max(8, (clip.endSec - clip.startSec) * pxPerSec) + "px";
    if (redrawThumb) {
      const thumb = clipEl.querySelector(".clip-thumb");
      if (thumb) drawClipPreview(thumb, clip);
    }
  }

  function endDrag() {
    if (!seqDrag.active) return;
    const t = tracks[seqDrag.trackIndex];
    const clip = (t?.clips || []).find(c => c.id === seqDrag.clipId);
    const didChange = clip && (
      Math.abs(clip.startSec - seqDrag.origStart) > 0.0001 ||
      Math.abs(clip.endSec - seqDrag.origEnd) > 0.0001
    );
    if (clip && !clip.audio && seqDrag.mode && seqDrag.mode !== "move") {
      trimClipToCurrentBounds(t, clip, seqDrag.origNotesSnapshot, seqDrag.origStart);
    }
    if (clip && !clip.audio && didChange && seqDrag.mode === "move") {
      // Move the track's editor notes along with the clip; otherwise stale
      // copies stayed at the old position and showed up as ghost notes.
      const oldStart = seqDrag.origStart;
      const oldEnd = seqDrag.origEnd;
      t.notes = (t.notes || []).filter(n => n.endSec <= oldStart || n.startSec >= oldEnd);
      if (tracks[activeTrackIndex] === t) notes = t.notes;
      syncTrackNotesFromClip(t, clip);
    }
    if (clip && didChange && activeClipId === clip.id) syncEditorToClipBounds(clip);
    seqDrag.active = false;
    seqDrag.mode = null;
    seqDrag.origNotesSnapshot = [];
    if (didChange) {
      commitHistoryGesture();
      renderSequencer();
      restartPlaybackFromCurrentPosition();
    } else {
      cancelHistoryGesture();
    }
  }

  sequencerGrid.addEventListener("pointerup", endDrag);
  sequencerGrid.addEventListener("pointercancel", endDrag);

  // Prevent click after dragging from triggering unwanted behaviors
    sequencerGrid.addEventListener("click", (e) => {
      if (seqDragMoved) {
        e.stopPropagation();
        e.preventDefault();
      }
   });


  // double click clip = open editor
  sequencerGrid.addEventListener("dblclick", (e) => {
    const clipEl = e.target.closest(".seq-clip");
    if (!clipEl) return;
    const ti = Number(clipEl.dataset.trackIndex);
    const clipId = clipEl.dataset.clipId;
    setActiveTrack(ti, { silent:true });
    if (tracks[ti]?.clips?.find(c => c.id === clipId)?.audio) { window.WAWAudio.openClipEditor(ti, clipId); return; }
    openClipInEditor(clipId);
  });
}

let seqPlayheadEl = null;

function ensureSeqPlayhead() {
  const viewEl = document.getElementById("sequencerView");
  if (!viewEl || seqPlayheadEl) return;

  seqPlayheadEl = document.createElement("div");
  seqPlayheadEl.className = "seq-playhead";
  viewEl.style.position = "relative";
  viewEl.appendChild(seqPlayheadEl);
}

sequencerGrid?.addEventListener("wheel", (e) => {
  const pxPerSec = getSeqPxPerSec();

  if (e.ctrlKey) {
    e.preventDefault();

    const mouseX = e.clientX;
    const rect = sequencerGrid.getBoundingClientRect();
    const labelW = getSeqLabelWidth();
    const xInGrid = Math.max(0, mouseX - rect.left - labelW + sequencerGrid.scrollLeft);

    const beforeSec = xInGrid / pxPerSec;

    const before = seqPxPerBeat;
    const factor = (e.deltaY > 0) ? 0.9 : 1.1;
    seqPxPerBeat = Math.min(200, Math.max(4, seqPxPerBeat * factor)); // 4 = whole songs fit (zoom bar "Fit")
    if (before === seqPxPerBeat) return;

    renderSequencer();

    // keep mouse anchored
    const afterPxPerSec = getSeqPxPerSec();
    const afterX = beforeSec * afterPxPerSec;
    sequencerGrid.scrollLeft = afterX - (mouseX - rect.left - labelW);

  } else if (e.shiftKey) {
    // Shift+wheel = scroll through the tracks (there is no horizontal scrollbar
    // any more, the vertical one may be off-screen with few tracks)
    e.preventDefault();
    sequencerGrid.scrollTop += e.deltaY || e.deltaX;
  } else {
    // normal wheel = horizontal pan (trackpads: use the larger axis)
    e.preventDefault();
    sequencerGrid.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  }
}, { passive:false });

sequencerGrid.addEventListener("contextmenu", (e) => {
  const lane = e.target.closest(".seq-row-lane");
  if (!lane || lane.closest(".seq-extra-row")) return; // tempo/automation/take lanes have their own menus
  e.preventDefault();

  const clipEl = e.target.closest(".seq-clip");
  seqContextTarget = clipEl ? {
    type: "clip",
    trackIndex: Number(clipEl.dataset.trackIndex),
    clipId: clipEl.dataset.clipId
  } : { type:"lane", trackIndex: Number(lane.closest(".seq-track-row").dataset.trackIndex) };
  if (seqContextTarget.type === "clip") {
    setActiveTrack(seqContextTarget.trackIndex, { silent: true });
    setSelectedClip(seqContextTarget.trackIndex, seqContextTarget.clipId);
  }

  showContextMenu(e.clientX, e.clientY, seqContextTarget.type);
});

function getClipLocalNotes(clip) {
  const ns = clip.notesSnapshot || [];
  if (!ns.length) return [];

  const clipLen = Math.max(0.0001, clip.endSec - clip.startSec);

  // Detect whether snapshot times are GLOBAL (absolute) or CLIP-LOCAL (0..clipLen).
  // Your stopClipRecording clones global notes without offsetting :contentReference[oaicite:1]{index=1}
  // but collectSequencerNotesInRange assumes local :contentReference[oaicite:2]{index=2}.
  // So we auto-detect.
  const looksGlobal =
    ns.some(n => n.startSec >= clip.startSec - 0.001) &&
    ns.some(n => n.startSec > clipLen + 0.001);

  return ns
    .map(n => {
      const start = looksGlobal ? (n.startSec - clip.startSec) : n.startSec;
      const end   = looksGlobal ? (n.endSec   - clip.startSec) : n.endSec;
      return { ...n, startSec: start, endSec: end };
    })
    .filter(n => n.endSec > 0 && n.startSec < clipLen);
}

// audio clips show their waveform, MIDI clips a mini piano roll
function drawClipPreview(canvas, clip) {
  if (clip.audio) window.WAWAudio?.drawClipWave(canvas, clip);
  else drawClipThumbnail(canvas, clip);
}

function drawClipThumbnail(canvas, clip) {
  if (!canvas) return;

  const notes = getClipLocalNotes(clip);
  if (!notes.length) {
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.clearRect(0,0,canvas.width,canvas.height);
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth  || canvas.parentElement.clientWidth  || 1;
  const h = canvas.clientHeight || canvas.parentElement.clientHeight || 1;

  canvas.width  = Math.max(1, Math.floor(w * dpr));
  canvas.height = Math.max(1, Math.floor(h * dpr));

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const clipLen = Math.max(0.0001, clip.endSec - clip.startSec);

  const minNote = Math.min(...notes.map(n => n.midiNote));
  const maxNote = Math.max(...notes.map(n => n.midiNote));
  const noteRange = Math.max(1, maxNote - minNote + 1);

  const rowH = Math.max(2, h / noteRange);

  for (const n of notes) {
    const x = (n.startSec / clipLen) * w;
    const ww = Math.max(1, ((n.endSec - n.startSec) / clipLen) * w);

    const y = h - ((n.midiNote - minNote + 1) / noteRange) * h;

    const vel = Math.min(1, Math.max(0, (n.velocity ?? 100) / 127)); // MIDI 1..127 -> 0..1
    ctx.fillStyle = `rgba(255,255,255,${0.12 + vel * 0.6})`;

    ctx.fillRect(x, y, ww, rowH);
  }
}
function trimClipToCurrentBounds(track, clip, sourceSnapshot = clip.notesSnapshot || [], sourceClipStart = clip.startSec) {
  if (!track || !clip) return;

  const clipLen = Math.max(0.0001, clip.endSec - clip.startSec);
  const sourceEnd = (seqDrag?.origEnd ?? clip.endSec);
  const sourceLen = Math.max(0.0001, sourceEnd - sourceClipStart);
  const looksGlobal =
    sourceSnapshot.some(n => n.startSec >= sourceClipStart - 0.001) &&
    sourceSnapshot.some(n => n.startSec > sourceLen + 0.001);

  const trimmedLocal = sourceSnapshot
    .map(n => {
      const localStart = looksGlobal ? n.startSec - sourceClipStart : n.startSec;
      const localEnd = looksGlobal ? n.endSec - sourceClipStart : n.endSec;
      const globalStart = sourceClipStart + localStart;
      const globalEnd = sourceClipStart + localEnd;
      const newLocalStart = globalStart - clip.startSec;
      const newLocalEnd = globalEnd - clip.startSec;
      return {
        ...n,
        startSec: Math.max(0, newLocalStart),
        endSec: Math.min(clipLen, newLocalEnd)
      };
    })
    .filter(n => n.endSec > n.startSec);

  clip.notesSnapshot = trimmedLocal;

  const outsideClip = (track.notes || []).filter(n =>
    n.endSec <= clip.startSec || n.startSec >= clip.endSec
  );
  const globalTrimmed = trimmedLocal.map(n => ({
    ...n,
    startSec: clip.startSec + n.startSec,
    endSec: clip.startSec + n.endSec
  }));
  track.notes = [...outsideClip, ...globalTrimmed].sort((a, b) => a.startSec - b.startSec || a.midiNote - b.midiNote);
  if (tracks[activeTrackIndex] === track) notes = track.notes;
}

function syncTrackNotesFromClip(track, clip) {
  if (!track || !clip) return;
  const globalNotes = getClipLocalNotes(clip).map(n => ({
    ...n,
    startSec: clip.startSec + n.startSec,
    endSec: clip.startSec + n.endSec
  }));
  const outsideClip = (track.notes || []).filter(n =>
    n.endSec <= clip.startSec || n.startSec >= clip.endSec
  );
  track.notes = [...outsideClip, ...globalNotes].sort((a, b) => a.startSec - b.startSec || a.midiNote - b.midiNote);
  if (tracks[activeTrackIndex] === track) notes = track.notes;
}

// ---------- CLIP RECORDING ----------
  function startClipRecording() {
    setView("sequencer", { silent:true });
    ensureTracks();
    clipRecordTrackIndex = activeTrackIndex;
    clipRecordStartNoteCount = tracks[clipRecordTrackIndex]?.notes?.length || 0;  

    clipRecordStartSec =
      (lastPlayheadSec != null) ? lastPlayheadSec :
      (loopEnabled ? loopStartSec : 0);

    // FORCE the core recorder to anchor here when no loop
    lastPlayheadSec = clipRecordStartSec;
    playheadWasManuallySet = true;

    isRecordingClip = true;
    const seqRecordBtn = document.getElementById("seqRecordBtn");
    const seqStopBtn = document.getElementById("seqStopBtn");
    if (seqRecordBtn) seqRecordBtn.disabled = true;
    if (seqStopBtn) seqStopBtn.disabled = false;

    startRecording();
  }

  function stopClipRecording() {
    if (!isRecordingClip) return;

    isRecordingClip = false;
    const seqRecordBtn = document.getElementById("seqRecordBtn");
    const seqStopBtn = document.getElementById("seqStopBtn");
    if (seqRecordBtn) seqRecordBtn.disabled = false;
    if (seqStopBtn) seqStopBtn.disabled = true;

    // stopRecording() finalizes the live recording clip created by
    // startRecordingCore(). Building another clip here produced a duplicate,
    // overlapping clip containing the same notes.
    stopRecording();
  }

  function collectSequencerNotesInRange(rangeStart, rangeEnd, sourceTracks = tracks) {
  const out = [];

  sourceTracks.forEach(t => {
    (t.clips || []).forEach(clip => {
      if (clip.endSec <= rangeStart || clip.startSec >= rangeEnd) return;
      if (clip.muted) return;

      getClipLocalNotes(clip).forEach(n => {
        const gn = { ...n };
        gn.startSec = clip.startSec + n.startSec;
        gn.endSec   = clip.startSec + n.endSec;
        gn.trackId = t.id;
        gn.trackName = t.name;
        gn.trackVolume = t.volume ?? 1;
        gn.trackPan = t.pan ?? 0;
        gn.instrument = t.instrument ?? "synth";
        out.push(gn);
      });
    });
  });

  return out;
}

  function saveEditorNotesToActiveClip() {
    if (activeClipId == null) return;

    const t = tracks[activeTrackIndex];
    const clip = (t.clips || []).find(c => c.id === activeClipId);
    if (!clip) return;

    // Convert global editor notes → clip-local snapshot
    const clipLen = Math.max(0.0001, clip.endSec - clip.startSec);
    clip.notesSnapshot = (t.notes || [])
      .filter(n => n.endSec > clip.startSec && n.startSec < clip.endSec)
      .map(n => ({
        ...n,
        startSec: Math.max(0, n.startSec - clip.startSec),
        endSec: Math.min(clipLen, n.endSec - clip.startSec)
      }))
      .filter(n => n.endSec > n.startSec);
  }  

  let activeClipId = null;

  function getActiveClip() {
    if (activeClipId == null) return null;
    const t = tracks[activeTrackIndex];
    return (t?.clips || []).find(c => c.id === activeClipId) || null;
  }

  function getEditorClipBounds() {
    const clip = getActiveClip();
    if (!clip) return null;
    return {
      start: clip.startSec,
      end: clip.endSec,
      duration: Math.max(0.1, clip.endSec - clip.startSec)
    };
  }

  function setGlobalLoopToClip(clip) {
    if (!clip) return;
    loopEnabled = true;
    loopStartSec = clip.startSec;
    loopEndSec = clip.endSec;
    loopBtn?.classList.toggle("active", true);
  }

  function fitPitchToNotes(noteArray = notes) {
    if (!noteArray.length) {
      viewMinNote = GLOBAL_MIN_NOTE;
      viewMaxNote = GLOBAL_MAX_NOTE;
      return;
    }

    const minMidi = Math.min(...noteArray.map(n => n.midiNote));
    const maxMidi = Math.max(...noteArray.map(n => n.midiNote));
    const padNotes = 2;
    let newMin = Math.max(GLOBAL_MIN_NOTE, minMidi - padNotes);
    let newMax = Math.min(GLOBAL_MAX_NOTE, maxMidi + padNotes);

    if (newMax - newMin < 12) {
      const center = (newMin + newMax) / 2;
      newMin = Math.max(GLOBAL_MIN_NOTE, Math.floor(center - 6));
      newMax = Math.min(GLOBAL_MAX_NOTE, Math.ceil(center + 6));
    }

    viewMinNote = newMin;
    viewMaxNote = newMax;
  }

 // ---------- SYNC EDITOR TO CLIP ----------
  function syncEditorToClipBounds(clip) {
    if (!clip) return;

    // editor zoom to clip
    viewStartSec = clip.startSec;
    viewDuration = Math.max(1, clip.endSec - clip.startSec);

    // LOCAL editor loop = clip bounds
    clipLoopEnabled = true;
    clipLoopStartSec = clip.startSec;
    clipLoopEndSec   = clip.endSec;

    drawPianoRoll(lastPlayheadSec);
    drawVelocityLane();
    drawAllLoopBars(lastPlayheadSec);
  }

  function openClipInEditor(clipId) {
    const t = tracks[activeTrackIndex];
    const clip = (t.clips || []).find(c => c.id === clipId);
    if (!clip) return;

    activeClipId = clipId;
    setGlobalLoopToClip(clip);
    syncTrackNotesFromClip(t, clip);
    setView("editor", { silent:true });

    if (activeClipId === clip.id && currentView === "editor") {
      syncEditorToClipBounds(clip);
    }

    // zoom editor to clip
    viewStartSec = clip.startSec;
    viewDuration = Math.max(1, clip.endSec - clip.startSec);
    syncEditorToClipBounds(clip);
    fitPitchToNotes(t.notes.filter(n => n.startSec < clip.endSec && n.endSec > clip.startSec));

    drawPianoRoll(clip.startSec);
    drawVelocityLane();
    drawAllLoopBars(clip.startSec);
  }
  

  // ---------- MIXER RENDERING ----------
  const mixerStrips = document.getElementById("mixerStrips");

  // The channel strip / console UI lives in js/mixer.js (window.renderMixer).

  function render808PadPanel() {
    return `
      <div class="drum808-panel">
        ${DRUM_808_VOICES.map((v, i) => `
          <button type="button" class="drum808-pad" data-note="${v.note}" data-pad="${i}" title="${v.label} · MIDI ${window.WAWPadMap?.midiLabel(i, "808") ?? v.note} · key ${window.WAWPadMap?.keyLabel(i) ?? v.key}">
            <span>${v.label}</span>
            <small>${window.WAWPadMap?.keyLabel(i) ?? v.key}</small>
          </button>
        `).join("")}
      </div>
    `;
  }

  function attach808PadEvents(root) {
    root.querySelectorAll(".drum808-pad").forEach(pad => {
      pad.addEventListener("click", (e) => {
        e.stopPropagation();
        const note = Number(pad.dataset.note);
        window.WAWPadMap?.setLearnPad(Number(pad.dataset.pad)); // choose the pad to learn
        trigger808PadNote(note, 112);
      });
    });
  }

  function render808ModalPads() {
    if (!drum808ModalPads) return;
    const PM = window.WAWPadMap;
    drum808ModalPads.innerHTML = DRUM_808_VOICES.map((v, i) => `
      <button type="button" class="drum808-pad${PM?.learn.mode && PM.learn.pad === i ? " learning" : ""}" data-note="${v.note}" data-pad="${i}" title="${v.label} · MIDI ${PM?.midiLabel(i, "808") ?? v.note} · key ${PM?.keyLabel(i) ?? v.key}">
        <span>${v.label}</span>
        <small>${PM?.keyLabel(i) ?? v.key} · ${PM?.midiLabel(i, "808") ?? v.note}</small>
      </button>
    `).join("");
    attach808PadEvents(drum808ModalPads);
    // controller mapping toolbar above the pads
    if (PM) {
      drum808ModalPads.parentElement?.querySelector(".padmap-bar")?.remove();
      drum808ModalPads.insertAdjacentHTML("beforebegin", PM.toolbarHtml());
      PM.attachToolbar(drum808ModalPads.parentElement, () => 0);
    }
  }




  // ---------- DATA STRUCTURES ----------
  class NoteEvent {
    constructor(startSec, endSec, midiNote, velocity, scaleDegree = null, octave = null) {
      this.startSec = startSec;
      this.endSec = endSec;
      this.midiNote = midiNote;
      this.velocity = velocity;
      this.scaleDegree = scaleDegree;
      this.octave = octave;
    }
  }

  class Clip {
    constructor({ id, startSec, endSec, notesSnapshot }) {
      this.id = id || ("clip_" + Math.random().toString(36).slice(2,9));
      this.startSec = startSec; // in song seconds
      this.endSec = endSec;
      this.notesSnapshot = notesSnapshot || []; 
      // store actual notes for this clip, relative or absolute (pick one)
    }
  }

  const GLOBAL_MIN_NOTE = 21;   // A0
  const GLOBAL_MAX_NOTE = 108;  // C8
  let viewMinNote = GLOBAL_MIN_NOTE;
  let viewMaxNote = GLOBAL_MAX_NOTE;

  let tonicName = "C";
  let tonicSemitone = 0;
  let scalePattern = SCALES.major;

  // ---------- GLOBAL STATE ----------
  let audioCtx = null;
  let micStream = null;
  let processorNode = null;
  let sampleRate = 44100;
  const bufferSize = 1024;
  let timelineBpm = 120;

  let hpFilterNode = null;
  let lpFilterNode = null;
  let analyserNode = null;
  let recordAnimId = null;

  let audioUnlocked = false;  

  let isRecordingClip = false;
  let clipRecordStartSec = 0;
  let clipRecordTrackIndex = 0;
  let clipRecordStartNoteCount = 0;
  let liveRecordingClip = null;
  let liveRecordingClipEl = null;

  function unlockAudioContext() {
    if (audioUnlocked) return;

    ensureAudioContext();
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume();
    }
    audioUnlocked = true;
  }
  
  // ---------- VIEW MANAGEMENT ----------
  let currentView = "sequencer"; 
  let sequencerRecordButtonsAttached = false;
  // "sequencer" | "editor" | "mixer"

  function setView(view, opts = {}) {
    // BEFORE switching views: if leaving editor → save clip notes
    if (currentView === "editor" && view !== "editor") {
      saveEditorNotesToActiveClip();
    }
    currentView = view;   

    // show/hide main areas
    document.getElementById("sequencerView")?.classList.toggle("visible", view === "sequencer");
    document.getElementById("midiEditorView")?.classList.toggle("visible", view === "editor");
    document.getElementById("mixerView")?.classList.toggle("visible", view === "mixer");
    document.getElementById("projectsView")?.classList.toggle("visible", view === "projects");

    // header buttons
    document.getElementById("addTrackBtn")?.classList.toggle("hidden", view !== "sequencer");
    document.getElementById("goSequencerBtn")?.classList.toggle("active", view === "sequencer");
    document.getElementById("goMixerBtn")?.classList.toggle("active", view === "mixer");
    document.getElementById("goProjectsBtn")?.classList.toggle("active", view === "projects");
    document.getElementById("goEditorBtn")?.classList.toggle("active", view === "editor");

    // sidebar template conditions
    document.querySelectorAll("[data-sidebar-for]").forEach(el => {
      const allowed = el.dataset.sidebarFor.split(",").map(s => s.trim());
      el.classList.toggle("hidden", !allowed.includes(view));
    });

    // editor-specific redraws
    if (view === "editor") {
      ensureTracks();
      drawPianoRoll(lastPlayheadSec);
      drawVelocityLane();
      drawAllLoopBars(lastPlayheadSec);
    }

    if (!opts.silent) {
      toast(
        view === "sequencer"
          ? "Sequencer"
          : view === "mixer"
          ? "Mixer"
          : view === "projects"
          ? "Projects"
          : "MIDI Editor"
      );
    }

    if (view !== "editor" && view !== "sequencer") {
      stopAllComputerKeyboardNotes();
    }

    // --------------------------------------------------------
    // IMPORTANT: perform resize and redraw AFTER absolutely
    // all DOM/UI changes are applied
    // --------------------------------------------------------
    requestAnimationFrame(() => {
      resizeCanvases();
      drawCircleOfFifths();
      drawPianoRoll(lastPlayheadSec);
      drawVelocityLane();
      drawAllLoopBars(lastPlayheadSec);
      drawTuner(null, 0, null);
    });
  }

  // ---------- UNDO / REDO ----------
  const HISTORY_LIMIT = 100;   // keep last 100 edits
  const HISTORY_KEY = "voiceMidiHistory_v2"; // bumped for multitrack

  let undoStack = [];
  let redoStack = [];
  let historyLocked = false; // prevent recursion when restoring

  function makeSnapshot() {
  ensureTracks();
  // Deep copy: tracks now carry nested mixer state (strip, inserts, sends,
  // sampler pads...). A shallow copy would share those objects with the live
  // project, so later edits would silently rewrite the undo history.
  return {
    tracks: structuredClone(tracks.map(t => ({ ...t }))),
    mixer: window.WAWMixer ? window.WAWMixer.serialize() : undefined,
    tempoMap: window.WAWTempo ? window.WAWTempo.serialize() : undefined,
    automation: window.WAWAutomation ? window.WAWAutomation.serializeGlobal() : undefined,
    activeTrackIndex,
    loopStartSec,
    loopEndSec,
    timelineBpm,
    tonicName,
    scaleId: scaleSelect ? scaleSelect.value : "major",
  };
}

function restoreSnapshot(snap) {
  if (!snap) return;
  historyLocked = true;

  // Backward compatible: v1 snapshots had only notes[]
  if (!snap.tracks) {
    tracks = [createTrack("Track 1")];
    tracks[0].notes = (snap.notes || []).map(o => new NoteEvent(
      o.startSec, o.endSec, o.midiNote, o.velocity, o.scaleDegree, o.octave
    ));
    activeTrackIndex = 0;
  } else {
    tracks = snap.tracks.map(t => ({
      ...t,
      notes: (t.notes || []).map(o => new NoteEvent(
        o.startSec, o.endSec, o.midiNote, o.velocity, o.scaleDegree, o.octave
      )),
      clips: (t.clips || []).map(c => ({
        ...c,
        notesSnapshot: (c.notesSnapshot || []).map(o => new NoteEvent(
          o.startSec, o.endSec, o.midiNote, o.velocity, o.scaleDegree, o.octave
        )),
      })),
    })).map((track, index) => normalizeTrack(track, index));
    activeTrackIndex = snap.activeTrackIndex ?? 0;
  }

  // re-alias global notes
  ensureTracks();
  if (snap.mixer && window.WAWMixer) window.WAWMixer.state = snap.mixer;

  loopStartSec = snap.loopStartSec ?? 0;
  loopEndSec   = snap.loopEndSec ?? 0;
  timelineBpm  = snap.timelineBpm ?? timelineBpm;
  if (window.WAWTempo) {
    window.WAWTempo.setState(snap.tempoMap || { tempos: [{ beat: 0, bpm: timelineBpm }] }, timelineBpm);
    timelineBpm = window.WAWTempo.state.tempos[0].bpm;
  }
  window.WAWAutomation?.restoreGlobal?.(snap.automation);

  tonicName = snap.tonicName ?? tonicName;
  if (scaleSelect && snap.scaleId) {
    scaleSelect.value = snap.scaleId;
  }
  if (typeof updateScaleFromUI === "function") {
    updateScaleFromUI();
  } else if (typeof updateScaleSettings === "function") {
    updateScaleSettings();
  }

  historyLocked = false;

  // Keep the BPM field in sync with the restored timeline
  if (bpmInput && snap.timelineBpm) bpmInput.value = snap.timelineBpm;

  // Selection indices refer to the old notes array
  selectedNotes.clear();
  lastSelectedNoteIndex = -1;
  if (activeClipId && !getActiveClip()) activeClipId = null;
  if (selectedClipRef && !getSelectedClipRef()) selectedClipRef = null;

  drawPianoRoll();
  drawVelocityLane();
  drawAllLoopBars();
}

  // Snapshot taken at the start of a drag gesture; committed on release only if
  // something actually changed. This makes undo restore the *pre*-edit state.
  let pendingHistorySnapshot = null;

  function pushSnapshotToUndo(snap) {
    undoStack.push(snap);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack.length = 0;
    updateUndoRedoButtons();
    window.WAWStatusBar?.markDirty();
    // every undoable edit is also a candidate for sharing with collaborators
    window.WAWCollab?.notifyChange?.();
  }

  function pushHistory() {
    if (historyLocked) return;
    pushSnapshotToUndo(makeSnapshot());
  }

  function beginHistoryGesture() {
    if (historyLocked) return;
    pendingHistorySnapshot = makeSnapshot();
  }

  function commitHistoryGesture() {
    if (!pendingHistorySnapshot) return;
    pushSnapshotToUndo(pendingHistorySnapshot);
    pendingHistorySnapshot = null;
  }

  function cancelHistoryGesture() {
    pendingHistorySnapshot = null;
  }

  function refreshAfterHistoryChange() {
    renderSidebarTracks();
    renderSequencer();
    renderMixer();
    // open editors hold references to the replaced track/clip objects
    window.WAWSampler?.refreshIfStale?.();
    window.WAWAudio?.refreshEditor?.();
    window.WAWAudio?.syncMonitoring?.();
    updateUndoRedoButtons();
    restartPlaybackFromCurrentPosition();
  }

  function undo() {
    if (!undoStack.length) return;
    const current = makeSnapshot();
    const prev = undoStack.pop();
    redoStack.push(current);
    restoreSnapshot(prev);
    refreshAfterHistoryChange();
  }

  function redo() {
    if (!redoStack.length) return;
    const current = makeSnapshot();
    const next = redoStack.pop();
    undoStack.push(current);
    restoreSnapshot(next);
    refreshAfterHistoryChange();
  }

  // Undo history used to be written to localStorage on every edit (up to 100 full
  // project snapshots) but was never read back. That wasted time on each edit and
  // could exhaust the storage quota shared with the project library, so it is
  // no longer persisted. Remove any stale copy left by older versions.
  try { localStorage.removeItem(HISTORY_KEY); } catch (e) {}

  function updateUndoRedoButtons() {
    const undoBtn = document.getElementById("undoBtn");
    const redoBtn = document.getElementById("redoBtn");
    if (undoBtn) undoBtn.disabled = !undoStack.length;
    if (redoBtn) redoBtn.disabled = !redoStack.length;
  }
  
  // ---------- RECORDING / PLAYBACK STATE ----------

  // Input monitor / mixer
  let inputMonitorGain = null;
  let currentInputLevel = 0;
  
  // Recording state
  let isRecording = false;
  let recordingStartTime = 0;


  /* ---------------- MULTITRACK (Step 2B) ----------------
    We keep a global `notes` alias for the ACTIVE track so
    the rest of the app needs minimal changes.
  ------------------------------------------------------- */
  let tracks = [];
  let activeTrackIndex = 0;
  let notes = []; // alias -> points to tracks[activeTrackIndex].notes
  const TRACK_INSTRUMENTS = new Set(["synth", "808", "sampler"]);
  const TRACK_TYPES = new Set(["midi", "audio"]);

  function createDefaultSynthPatch() {
    return {
      wave: "sine",
      attack: 0.01,
      decay: 0.1,
      sustain: 0.8,
      release: 0.25,
      cutoff: 8000,
      filterQ: 0.8,
      detune: 0,
      osc2Wave: "off",
      osc2Mix: 0,
      osc2Detune: 0,
      noise: 0,
      glide: 0,
      filterEnv: 0,
      filterAttack: 0.01,
      filterDecay: 0.25,
      lfoTarget: "pitch",
      lfoRate: 0,
      lfoAmount: 0,
      drive: 0,
      pan: 0,
      chorus: 0,
      delaySend: 0,
      reverbSend: 0,
      gain: 0.25
    };
  }

  function createDefault808Patch() {
    return {
      presetName: "Classic 808",
      tone: 1,
      decay: 1,
      pitch: 1,
      punch: 0.8,
      snap: 0.55,
      noise: 0.7,
      hatDecay: 0.45,
      tomDecay: 0.7,
      cowbellTune: 1,
      drive: 0.12,
      pan: 0,
      stereo: 0.5,
      gain: 0.95,
      voices: {} // per-voice { tune (semitones), decay, level }
    };
  }

  function normalizeTrack(track, fallbackIndex = 0) {
    track.id = track.id || "trk_" + Math.random().toString(36).slice(2, 9);
    track.name = track.name || `Track ${fallbackIndex + 1}`;
    track.type = TRACK_TYPES.has(track.type) ? track.type : "midi";
    track.notes = Array.isArray(track.notes) ? track.notes : [];
    track.clips = Array.isArray(track.clips) ? track.clips : [];
    // repair clips saved with NaN positions (takes recorded while the playhead was NaN):
    // move them to the song start so they become visible and playable again
    track.clips.forEach(c => {
      if (Number.isFinite(c.startSec) && Number.isFinite(c.endSec) && c.endSec > c.startSec) return;
      const len = Number.isFinite(c.endSec - c.startSec) && c.endSec > c.startSec ? c.endSec - c.startSec
        : (c.audio?.sampleId && window.WAWSamples?.get(c.audio.sampleId)?.duration) || 4;
      c.startSec = 0;
      c.endSec = len;
    });
    track.notes = track.notes.filter(n => Number.isFinite(n.startSec) && Number.isFinite(n.endSec));
    track.instrument = TRACK_INSTRUMENTS.has(track.instrument) ? track.instrument : "synth";
    track.mono = !!track.mono;
    track.volume = Number.isFinite(track.volume) ? track.volume : 1;
    track.pan = Number.isFinite(track.pan) ? track.pan : 0;
    track.mute = !!track.mute;
    track.solo = !!track.solo;
    track.color = track.color || null;
    track.synthPatch = {
      ...createDefaultSynthPatch(),
      ...(track.synthPatch || {})
    };
    track.drum808Patch = {
      ...createDefault808Patch(),
      ...(track.drum808Patch || {})
    };
    track.drum808Patch.voices = { ...(track.drum808Patch.voices || {}) };
    track.armed = !!track.armed;
    track.monitor = !!track.monitor;
    window.WAWMixer?.normalizeTrackMix(track);
    window.WAWSampler?.normalizeTrack(track);
    return track;
  }

  function createTrack(name = null, { type = "midi", instrument = "synth" } = {}) {
    const id = "trk_" + Math.random().toString(36).slice(2, 9);
    return normalizeTrack({
      id,
      name: name || `Track ${tracks.length + 1}`,
      type,
      notes: [],
      clips: [], // sequencer blocks
      instrument,
      mono: false,
      volume: 1,
      pan: 0,
      mute: false,
      solo: false,
      color: null,
      synthPatch: createDefaultSynthPatch(),
      drum808Patch: createDefault808Patch(),
    }, tracks.length);
  }

  function ensureTracks() {
    if (!tracks.length) {
      tracks.push(createTrack("Track 1"));
    }
    tracks.forEach((track, index) => normalizeTrack(track, index));
    activeTrackIndex = Math.min(activeTrackIndex, tracks.length - 1);
    notes = tracks[activeTrackIndex].notes;
  }

  function getActiveTrack() {
    ensureTracks();
    return tracks[activeTrackIndex];
  }

// ---------------------------------------------------------
// Track sidebar UI sync (defensive)
// ---------------------------------------------------------
function updateTrackSidebarControls(trackIndex = activeTrackIndex) {
  const track = tracks?.[trackIndex];
  if (!track) return;

  // Example controls — adjust selectors to your DOM.
  const nameInput   = document.querySelector("#trackNameInput");
  const instrSelect = document.querySelector("#instrumentSelect");
  const volSlider   = document.querySelector("#trackVolume");
  const panSlider   = document.querySelector("#trackPan");
  const muteBtn     = document.querySelector("#trackMuteBtn");
  const soloBtn     = document.querySelector("#trackSoloBtn");

  if (nameInput)   nameInput.value = track.name ?? `Track ${trackIndex + 1}`;
  if (instrSelect) instrSelect.value = track.instrument ?? "synth";

  if (volSlider) {
    volSlider.value = track.volume ?? 0.8;
    // if you show numeric labels:
    const lbl = document.querySelector("#trackVolumeLabel");
    if (lbl) lbl.textContent = Number(volSlider.value).toFixed(2);
  }

  if (panSlider) {
    panSlider.value = track.pan ?? 0; // -1..1
    const lbl = document.querySelector("#trackPanLabel");
    if (lbl) lbl.textContent = Number(panSlider.value).toFixed(2);
  }

  if (muteBtn) muteBtn.classList.toggle("active", !!track.mute);
  if (soloBtn) soloBtn.classList.toggle("active", !!track.solo);

  // If you have per-track FX toggles etc., set them here the same way.
}


  function setActiveTrack(trackIdOrIndex, opts = {}) {
    ensureTracks();
    let i;
  if (typeof trackIdOrIndex === "number") {
    i = trackIdOrIndex;
  } else {
    i = tracks.findIndex(x => x.id === trackIdOrIndex);
  }

  if (i < 0 || i >= tracks.length) return;

  const t = tracks[i];
  if (i !== activeTrackIndex) stopAllComputerKeyboardNotes();
  activeTrackIndex = i;
  notes = t.notes;

  renderSidebarTracks();              // re-render list + highlight active track
  updateTrackSidebarControls(i);      // sync right sidebar to active track

  if (!opts.silent) {
    toast(`Active track: ${t.name || `Track ${i + 1}`}`);
  }
}
      
function addTrack(_e) {
  // ignore DOM events
  ensureTracks();
  const t = createTrack();     // name auto-generated
  tracks.push(t);

  setActiveTrack(tracks.length - 1, { silent: true });

  // left sidebar should show only active track
  renderSidebarTracks();

  // keep sequencer + mixer synced
  renderSequencer();
  renderMixer();

  toast(`Added ${t.name}`);
}


  function setActiveTrackNotes(newNotesArray) {
    ensureTracks();
    tracks[activeTrackIndex].notes = newNotesArray;
    notes = tracks[activeTrackIndex].notes; // re-alias
  }

  function updateTrackInstrument(trackId, instrument) {
    const track = tracks.find(x => x.id === trackId);
    if (!track || !TRACK_INSTRUMENTS.has(instrument)) return;
    if (track.instrument === instrument) return;

    pushHistory();
    track.instrument = instrument;

    if (track.id === tracks[activeTrackIndex]?.id) {
      notes = track.notes;
    }

    renderSidebarTracks();
    updateTrackSidebarControls(tracks.findIndex(x => x.id === track.id));
    renderSequencer();
    renderMixer();
  }

  function normalizePlaybackNote(n, track) {
    return {
      ...n,
      velocity: Math.max(1, Math.min(127, Math.round(n.velocity ?? 100))),
      trackId: track?.id ?? n.trackId,
      trackName: track?.name ?? n.trackName,
      trackVolume: track?.volume ?? n.trackVolume ?? 1,
      trackPan: track?.pan ?? n.trackPan ?? 0,
      instrument: track?.instrument ?? n.instrument ?? "synth",
      synthPatch: {
        ...createDefaultSynthPatch(),
        ...(track?.synthPatch || n.synthPatch || {})
      },
      drum808Patch: {
        ...createDefault808Patch(),
        ...(track?.drum808Patch || n.drum808Patch || {})
      },
    };
  }

  function getPlayableTracks({ includeMuted = false, ignoreSolo = false } = {}) {
    ensureTracks();
    const anySolo = !ignoreSolo && tracks.some(t => t.solo);
    if (anySolo) return tracks.filter(t => t.solo);
    if (!includeMuted) return tracks.filter(t => !t.mute);
    return tracks;
  }

  function getAllNotesMixdown({ includeMuted = false, ignoreSolo = false } = {}) {
    // Playback reads clip snapshots; make sure edits made in the open MIDI editor
    // are included (previously they were only saved when leaving the editor, so
    // pressing Play in the editor played the old notes).
    if (currentView === "editor" && activeClipId != null) saveEditorNotesToActiveClip();
    const pool = getPlayableTracks({ includeMuted, ignoreSolo });
    const directNotes = pool.flatMap(t => {
      const clipsWithNotes = (t.clips || []).filter(c => (c.notesSnapshot || []).length);
      if (clipsWithNotes.length) return [];
      return (t.notes || [])
        .map(n => normalizePlaybackNote(n, t));
    });
    const clipNotes = collectSequencerNotesInRange(0, getBaseDuration(), pool)
      .map(n => normalizePlaybackNote(n, pool.find(t => t.id === n.trackId)));

    const seen = new Set();
    return [...directNotes, ...clipNotes]
      .filter(n => n.endSec > n.startSec)
      .filter(n => {
        const key = [
          n.trackId || "",
          n.startSec.toFixed(4),
          n.endSec.toFixed(4),
          n.midiNote,
          n.velocity
        ].join(":");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.startSec - b.startSec || a.midiNote - b.midiNote);
    
  }

  function previewNoteOn(note, velocity, track = getActiveTrack()) {
    const t = track;
    if (!t) return;
    if (t.mute) return;

    // If any solo tracks exist, only allow solo'd ones
    const hasSolo = tracks.some(x => x.solo);
    if (hasSolo && !t.solo) return;

    // track volume / pan are applied by the channel strip
    const vel = Math.max(1, Math.round(velocity || 100));

    if (t.instrument === "808") {
      play808Hit(note, vel, t);
      flash808Pad(note);
      return;
    }
    if (t.instrument === "sampler") {
      window.WAWSampler?.previewOn(t, note, vel);
      return;
    }
    synthVoiceOn(note, vel, t);
  }

  function previewNoteOff(note, trackId = null) {
    const t = trackId ? tracks.find(track => track.id === trackId) : getActiveTrack();
    if (!t) return;
    if (t.instrument === "808") return;
    if (t.instrument === "sampler") { window.WAWSampler?.previewOff(t, note); return; }
    synthVoiceOff(note, t.id);
  }

  /* -------------- END MULTITRACK ---------------- */

  /* =====================================================
   TRACK SIDEBAR UI (UI-1)
  ===================================================== */

  const TRACK_COLORS = [
    "#3b82f6", "#22c55e", "#eab308", "#ef4444",
    "#a855f7", "#06b6d4", "#f97316", "#14b8a6"
  ];

  function getTrackColor(i){
    return TRACK_COLORS[i % TRACK_COLORS.length];
  }

  function renderSidebarTracks() {
    ensureTracks();

    const tracksContainer = document.getElementById("tracksContainer");

    if (!tracksContainer) return;

    // Clear existing UI
    tracksContainer.innerHTML = "";

    // Only render the currently selected track in the left sidebar
    const selIndex =
      (activeTrackIndex != null && activeTrackIndex >= 0) ? activeTrackIndex : 0;
    
    const indices = tracks[selIndex] ? [selIndex] : [];

    indices.forEach((i) => {
      const t = tracks[i];
      if (!t) return;

      if (!t.color) t.color = getTrackColor(i);

      const row = document.createElement("div");
      row.className = "track-row" + (i === activeTrackIndex ? " active" : "");
      row.dataset.trackIndex = i;

      row.innerHTML = `
        <div class="track-row-top">
          <div class="track-title">
            <span class="track-color-dot" style="background:${t.color}"></span>
            <input class="track-name-input" type="text" value="${escapeHtml(t.name || `Track ${i+1}`)}" spellcheck="false">
          </div>
          <div class="track-btns">
            <button class="track-btn mute ${t.mute ? "active":""}" title="Mute track">M</button>
            <button class="track-btn solo ${t.solo ? "active":""}" title="Solo track">S</button>
            <button class="track-btn mono ${t.mono ? "active":""}" title="Toggle mono/stereo">
              ${t.mono ? "Mono" : "Stereo"}
            </button>
          </div>
        </div>

        ${t.type === "audio" ? `
        <div class="track-select-row"><label>Type</label><span class="track-type-badge">Audio track</span></div>` : `
        <div class="track-select-row">
          <label>Instrument</label>
          <select class="track-instrument" data-track-id="${escapeHtml(t.id)}">
            <option value="synth"   ${t.instrument==="synth"?"selected":""}>Synth</option>
            <option value="808"     ${t.instrument==="808"?"selected":""}>Drum Synth</option>
            <option value="sampler" ${t.instrument==="sampler"?"selected":""}>Sampler (16 pads)</option>
          </select>
        </div>`}

        <div class="track-instrument-panel"></div>

        <div class="track-mini">
          <div>
            <label>Volume</label>
            <input class="track-vol" type="range" min="0" max="2" step="0.01" value="${t.volume ?? 1}">
          </div>
          <div>
            <label>Pan</label>
            <input class="track-pan" type="range" min="-1" max="1" step="0.01" value="${t.pan ?? 0}">
          </div>
        </div>

        <div class="track-fx-row">
          ${(t.inserts || []).map(fx => `<span class="fx-chip ${fx.bypass ? "" : "active"}" data-fx-id="${escapeHtml(fx.id)}" title="Edit">${escapeHtml(window.WAWFX?.FX_TYPES[fx.type]?.name || fx.type)}</span>`).join("")}
          <span class="fx-chip add" data-fx="add" title="Open this track's insert FX chain">+ FX</span>
        </div>
      `;

      // Mount synth controls inside the active track row only
      const instPanel = row.querySelector(".track-instrument-panel");
      if (instPanel && t.type === "audio") {
        // per-track input routing (device, channels, gain, meter)
        instPanel.innerHTML = window.WAWAudio.trackPanelHtml(t);
        instPanel.dataset.trackId = t.id;
        window.WAWAudio.attachTrackPanel(instPanel, t, i);
      } else if (instPanel && i === activeTrackIndex && t.instrument === "sampler") {
        instPanel.innerHTML = window.WAWSampler.sidebarPanelHtml(t);
        window.WAWSampler.attachSidebarPanel(instPanel, t);
      } else if (instPanel && i === activeTrackIndex && t.instrument === "synth") {
        instPanel.innerHTML = `<button type="button" id="openSynthModalBtn" class="edit-synth-btn">Edit Synth</button>`;
        instPanel.querySelector("#openSynthModalBtn")?.addEventListener("click", (e) => {
          e.stopPropagation();
          openSynthModal();
        });
      } else if (instPanel && i === activeTrackIndex && t.instrument === "808") {
        instPanel.innerHTML = `<button type="button" class="edit-synth-btn">Edit 808</button>${render808PadPanel()}`;
        instPanel.querySelector(".edit-synth-btn")?.addEventListener("click", (e) => {
          e.stopPropagation();
          open808Modal();
        });
        attach808PadEvents(instPanel);
      }

      // --- interactions ---
      row.addEventListener("click", (e) => {
        const tag = e.target.tagName.toLowerCase();
        if (["input", "select", "option", "button"].includes(tag)) return;
        setActiveTrack(i);
      });

      const nameInput = row.querySelector(".track-name-input");
      nameInput.addEventListener("change", () => {
        t.name = nameInput.value.trim() || `Track ${i + 1}`;
        renderSidebarTracks();
        updateTrackSidebarControls(i);
      });

      row.querySelector(".track-btn.mute").addEventListener("click", (e) => {
        e.stopPropagation();
        t.mute = !t.mute;
        window.WAWMixer?.syncEngine();
        renderSidebarTracks();
        updateTrackSidebarControls(i);
        renderMixer();
        renderSequencer();
      });

      row.querySelector(".track-btn.solo").addEventListener("click", (e) => {
        e.stopPropagation();
        t.solo = !t.solo;
        window.WAWMixer?.syncEngine();
        renderSidebarTracks();
        updateTrackSidebarControls(i);
        renderMixer();
        renderSequencer();
      });

      const monoBtn = row.querySelector(".track-btn.mono");
      monoBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        t.mono = !t.mono;
        window.WAWMixer?.updateTrackEngine(t);
        renderSidebarTracks();
        updateTrackSidebarControls(i);
        toast(t.mono ? "Track set to MONO" : "Track set to STEREO");
      });

      const instSel = row.querySelector(".track-instrument");
      instSel?.addEventListener("change", (e) => {
        e.stopPropagation();
        updateTrackInstrument(e.currentTarget.dataset.trackId, e.currentTarget.value);
        releaseSelectFocus(e.currentTarget);
      });

      row.querySelector(".track-vol").addEventListener("input", (e) => {
        t.volume = parseFloat(e.target.value);
        window.WAWMixer?.updateTrackEngine(t);
      });
      row.querySelector(".track-vol").addEventListener("change", () => renderMixer());

      row.querySelector(".track-pan").addEventListener("input", (e) => {
        t.pan = parseFloat(e.target.value);
        window.WAWMixer?.updateTrackEngine(t);
      });
      row.querySelector(".track-pan").addEventListener("change", () => renderMixer());

      row.querySelectorAll(".fx-chip").forEach((chip) => {
        chip.addEventListener("click", (e) => {
          e.stopPropagation();
          if (chip.dataset.fx === "add") { window.WAWWorkspace?.openTrackFxChain(t); return; }
          const idx = (t.inserts || []).findIndex(fx => fx.id === chip.dataset.fxId);
          if (idx >= 0) window.WAWMixer.openFxEditor(t, t.inserts, idx, () => window.WAWMixer.updateTrackEngine(t), `${t.name} — Inserts`);
        });
      });

      tracksContainer.appendChild(row);
    });
  }
  
  // end renderSidebarTracks()
  document.getElementById("goMixerBtn")?.addEventListener("click", () => {
    setView("mixer");
    renderMixer();
  });

  document.getElementById("goSequencerBtn")?.addEventListener("click", () => {
    setView("sequencer");
    renderSequencer();
  });

  document.getElementById("goProjectsBtn")?.addEventListener("click", () => {
    setView("projects");
    renderProjectsLibrary();
  });


/* =====================================================
   END TRACK SIDEBAR UI
===================================================== */
  
// Detected note state
  let currentNote = null;
  let currentNoteStart = 0;
  let drawPreview = null;

  const pitchSmoothingFrames = 4;
  let lastPitches = [];

  // Playback / synth
  let isPlaying = false;
  let playbackStartTime = 0;
  // Audio sources scheduled for playback. Ended sources remove themselves, so this
  // no longer grows without bound while a loop plays for a long time.
  const scheduledOscs = new Set();
  function trackScheduledSources(sources) {
    sources.forEach(src => {
      scheduledOscs.add(src);
      src.addEventListener("ended", () => scheduledOscs.delete(src), { once: true });
    });
  }

  // Selection state (multi-select)
  let selectedNotes = new Set();
  let lastSelectedNoteIndex = -1;

  // Noise gate
  let noiseFloorRms = 0.002;
  let gateSensitivity = 0.2;
  let calibratingNoise = false;
  let noiseCalibRmsSum = 0;
  let noiseCalibCount = 0;

  // Note stability
  const MIN_NOTE_DURATION = 0.18;
  const JITTER_SEMITONES  = 2;
  const MERGE_GAP_SECONDS = 0.09;

  let stableMidi = null;
  let pendingMidi = null;
  let pendingCount = 0;

  const SWITCH_CENTS = 60;      // hysteresis threshold
  const HOLD_FRAMES = 6;        // must be stable this many frames

  // Time view
  // -------- EDITOR (single-clip) time window --------
  let viewStartSec = 0;   // editor only
  let viewDuration = 4;   // editor only

  let gridValue = "0.25"; 
  let swingAmount = 0;

  // MIDI
  let midiAccess = null;
  let activeMidiKeys = new Set();
  const activeComputerKeys = new Map();
  let computerKeyboardOctave = 4;
  let currentChordLabel = "";

  // DOM references
  const statusEl = document.getElementById("status");
  const bpmInput = document.getElementById("bpmInput");  
  const startMicBtn = document.getElementById("startMicBtn");
  const startRecBtn = document.getElementById("startRecBtn");
  const stopBtn = document.getElementById("stopBtn");
  const playBtn = document.getElementById("playBtn");
  const exportBtn = document.getElementById("exportBtn");
  const exportAudioBtn = document.getElementById("exportAudioBtn");
  const saveProjectBtn = document.getElementById("saveProjectBtn");
  const loadProjectBtn = document.getElementById("loadProjectBtn");
  const loadProjectInput = document.getElementById("loadProjectInput");
  const projectLibrarySaveBtn = document.getElementById("projectLibrarySaveBtn");
  const projectLibraryImportBtn = document.getElementById("projectLibraryImportBtn");
  const projectsList = document.getElementById("projectsList");
  const skinSelect = document.getElementById("skinSelect");
  const gateSlider = document.getElementById("gateSlider");
  const gateLabel = document.getElementById("gateLabel");
  const helpText = document.getElementById("helpText");

  // Canvas elements
  // ---------------------------------------------------------
  // Canvas refs (initialized after DOM is ready)
  // ---------------------------------------------------------
  let circleCanvas, pianoRollCanvas, velocityCanvas, tunerCanvas, eqCanvas;
  let circleCtx, prCtx, velCtx, tunerCtx, eqCtx;
  const scaleSelect = document.getElementById("scaleSelectCircle"); // if this is in header it may exist early; ok

  let tunerWidth = 0;
  let tunerHeight = 0;

  let eqWidth = 0;
  let eqHeight = 0;
  let eqDataArray = null;

  function initCanvases() {
    circleCanvas    = document.getElementById("circleCanvas");
    pianoRollCanvas = document.getElementById("pianoRollCanvas");
    velocityCanvas  = document.getElementById("velocityCanvas");
    tunerCanvas     = document.getElementById("tunerCanvas");
    eqCanvas        = document.getElementById("eqCanvas");

    circleCtx = circleCanvas?.getContext("2d") || null;
    prCtx     = pianoRollCanvas?.getContext("2d") || null;
    velCtx    = velocityCanvas?.getContext("2d") || null;
    tunerCtx  = tunerCanvas?.getContext("2d") || null;
    eqCtx     = eqCanvas?.getContext("2d") || null;
  }

  function attachPianoRollEvents() {
    if (!pianoRollCanvas) return; // safe guard

    pianoRollCanvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = pianoRollCanvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const keyLabelWidth = KEY_LABEL_WIDTH;
      const gridX0 = keyLabelWidth;
      const gridWidth = prWidth - keyLabelWidth;
      const baseDuration = getBaseDuration();
      const maxStart = Math.max(0, baseDuration - viewDuration);

      if (e.ctrlKey) {
        // Horizontal zoom around cursor
        const cursorT = viewStartSec + ((x - gridX0) / gridWidth) * viewDuration;
        const factor = Math.exp(e.deltaY * 0.001);
        let newDuration = viewDuration * factor;
        newDuration = Math.max(0.25, Math.min(newDuration, Math.max(baseDuration, 4)));
        viewStartSec = cursorT - (cursorT - viewStartSec) * (newDuration / viewDuration);
        viewDuration = newDuration;
        if (viewStartSec < 0) viewStartSec = 0;
        if (viewStartSec > maxStart) viewStartSec = maxStart;

      } else if (e.shiftKey) {

        const span = viewMaxNote - viewMinNote + 1;
        const factor = Math.exp(e.deltaY * 0.001);
        let newSpan = span * factor;
        newSpan = Math.max(12, Math.min(newSpan, GLOBAL_MAX_NOTE - GLOBAL_MIN_NOTE + 1));
        const center = (viewMinNote + viewMaxNote) / 2;
        viewMinNote = Math.round(center - newSpan / 2);
        viewMaxNote = Math.round(center + newSpan / 2);
        if (viewMinNote < GLOBAL_MIN_NOTE) {
          const diff = GLOBAL_MIN_NOTE - viewMinNote;
          viewMinNote += diff;
          viewMaxNote += diff;
        }
        if (viewMaxNote > GLOBAL_MAX_NOTE) {
          const diff = viewMaxNote - GLOBAL_MAX_NOTE;
          viewMinNote -= diff;
          viewMaxNote -= diff;
        }

      } else {
        // Horizontal scroll / pan
        const scrollAmount = (e.deltaY / 100) * (viewDuration * 0.1);
        viewStartSec = Math.min(maxStart, Math.max(0, viewStartSec + scrollAmount));
      }

      drawPianoRoll();
      drawVelocityLane();
    }, { passive: false });
  }

  // Filter controls DOM
  const hpSlider = document.getElementById("hpSlider");
  const hpLabel = document.getElementById("hpLabel");
  const lpSlider = document.getElementById("lpSlider");
  const lpLabel = document.getElementById("lpLabel");
  
  const inputGainSlider = document.getElementById("inputGainSlider");
  const monitorBtn = document.getElementById("monitorBtn");

  // Tracks sidebar DOM
  const tracksContainer = document.getElementById("tracksContainer");

  // Add track button
  const addTrackBtn = document.getElementById("addTrackBtn");
    addTrackBtn?.addEventListener("click", addTrack);
    // Alt+N / Alt+1..9 shortcuts are handled by a single listener near the end of this file.

  // Scale info DOM
  const scaleNotesEl = document.getElementById("scaleNotes");
  const scaleChordsEl = document.getElementById("scaleChords");

  // Instruments
  const instrumentSelect = document.getElementById("instrumentSelect");  

  // Input gain label
  const inputGainLabel = document.getElementById("inputGainLabel");

  // Context menu
  const contextMenu = document.getElementById("contextMenu");

  // Chord preset state
  let currentChordPreset = null; // e.g. { name: "I", intervals: [0, 2, 4] }

  // Synth UI
  const synthControls = document.getElementById("synthControls");
  const synthModal = document.getElementById("synthModal");
  const synthModalClose = document.getElementById("synthModalClose");
  const synthPreset = document.getElementById("synthPreset");
  const synthSavePresetBtn = document.getElementById("synthSavePresetBtn");
  const synthWave = document.getElementById("synthWave");
  const synthAttack = document.getElementById("synthAttack");
  const synthDecay = document.getElementById("synthDecay");
  const synthSustain = document.getElementById("synthSustain");
  const synthRelease = document.getElementById("synthRelease");
  const synthCutoff = document.getElementById("synthCutoff");
  const synthFilterQ = document.getElementById("synthFilterQ");
  const synthDetune = document.getElementById("synthDetune");
  const synthOsc2Wave = document.getElementById("synthOsc2Wave");
  const synthOsc2Mix = document.getElementById("synthOsc2Mix");
  const synthOsc2Detune = document.getElementById("synthOsc2Detune");
  const synthNoise = document.getElementById("synthNoise");
  const synthGlide = document.getElementById("synthGlide");
  const synthFilterEnv = document.getElementById("synthFilterEnv");
  const synthFilterAttack = document.getElementById("synthFilterAttack");
  const synthFilterDecay = document.getElementById("synthFilterDecay");
  const synthLfoTarget = document.getElementById("synthLfoTarget");
  const synthLfoRate = document.getElementById("synthLfoRate");
  const synthLfoAmount = document.getElementById("synthLfoAmount");
  const synthDrive = document.getElementById("synthDrive");
  const synthPan = document.getElementById("synthPan");
  const synthChorus = document.getElementById("synthChorus");
  const synthDelaySend = document.getElementById("synthDelaySend");
  const synthReverbSend = document.getElementById("synthReverbSend");
  const synthGain = document.getElementById("synthGain");
  const synthAttackVal = document.getElementById("synthAttackVal");
  const synthDecayVal = document.getElementById("synthDecayVal");
  const synthSustainVal = document.getElementById("synthSustainVal");
  const synthReleaseVal = document.getElementById("synthReleaseVal");
  const synthCutoffVal = document.getElementById("synthCutoffVal");
  const synthFilterQVal = document.getElementById("synthFilterQVal");
  const synthDetuneVal = document.getElementById("synthDetuneVal");
  const synthOsc2MixVal = document.getElementById("synthOsc2MixVal");
  const synthOsc2DetuneVal = document.getElementById("synthOsc2DetuneVal");
  const synthNoiseVal = document.getElementById("synthNoiseVal");
  const synthGlideVal = document.getElementById("synthGlideVal");
  const synthFilterEnvVal = document.getElementById("synthFilterEnvVal");
  const synthFilterAttackVal = document.getElementById("synthFilterAttackVal");
  const synthFilterDecayVal = document.getElementById("synthFilterDecayVal");
  const synthLfoRateVal = document.getElementById("synthLfoRateVal");
  const synthLfoAmountVal = document.getElementById("synthLfoAmountVal");
  const synthDriveVal = document.getElementById("synthDriveVal");
  const synthPanVal = document.getElementById("synthPanVal");
  const synthChorusVal = document.getElementById("synthChorusVal");
  const synthDelaySendVal = document.getElementById("synthDelaySendVal");
  const synthReverbSendVal = document.getElementById("synthReverbSendVal");
  const synthGainVal = document.getElementById("synthGainVal");

  const drum808Modal = document.getElementById("drum808Modal");
  const drum808ModalClose = document.getElementById("drum808ModalClose");
  const drum808ModalPads = document.getElementById("drum808ModalPads");
  const drum808Preset = document.getElementById("drum808Preset");
  const drum808SavePresetBtn = document.getElementById("drum808SavePresetBtn");
  const drum808Tone = document.getElementById("drum808Tone");
  const drum808Pitch = document.getElementById("drum808Pitch");
  const drum808Punch = document.getElementById("drum808Punch");
  const drum808Noise = document.getElementById("drum808Noise");
  const drum808Decay = document.getElementById("drum808Decay");
  const drum808Snap = document.getElementById("drum808Snap");
  const drum808HatDecay = document.getElementById("drum808HatDecay");
  const drum808TomDecay = document.getElementById("drum808TomDecay");
  const drum808CowbellTune = document.getElementById("drum808CowbellTune");
  const drum808Drive = document.getElementById("drum808Drive");
  const drum808Pan = document.getElementById("drum808Pan");
  const drum808Gain = document.getElementById("drum808Gain");
  const drum808ToneVal = document.getElementById("drum808ToneVal");
  const drum808PitchVal = document.getElementById("drum808PitchVal");
  const drum808PunchVal = document.getElementById("drum808PunchVal");
  const drum808NoiseVal = document.getElementById("drum808NoiseVal");
  const drum808DecayVal = document.getElementById("drum808DecayVal");
  const drum808SnapVal = document.getElementById("drum808SnapVal");
  const drum808HatDecayVal = document.getElementById("drum808HatDecayVal");
  const drum808TomDecayVal = document.getElementById("drum808TomDecayVal");
  const drum808CowbellTuneVal = document.getElementById("drum808CowbellTuneVal");
  const drum808DriveVal = document.getElementById("drum808DriveVal");
  const drum808PanVal = document.getElementById("drum808PanVal");
  const drum808GainVal = document.getElementById("drum808GainVal");

  // Synth state
  const SYNTH_CUSTOM_PRESETS_KEY = "easyDawSynthCustomPresets_v1";
  const DRUM808_CUSTOM_PRESETS_KEY = "easyDaw808CustomPresets_v1";
  const synthState = createDefaultSynthPatch();
  const drum808State = createDefault808Patch();
  let synthMasterGain = null;
  let synthFilter = null;
  const synthVoices = new Map(); // trackId:midiNote -> {osc, gain}
  const synthLastNoteByTrack = new Map();

  // 16 pads, MPC-style computer keyboard layout (pad 1 = bottom-left):
  //   1 2 3 4   -> pads 13-16
  //   Q W E R   -> pads  9-12
  //   A S D F   -> pads  5-8
  //   Z X C V   -> pads  1-4
  const PAD_KEY_CODES = ["KeyZ", "KeyX", "KeyC", "KeyV", "KeyA", "KeyS", "KeyD", "KeyF", "KeyQ", "KeyW", "KeyE", "KeyR", "Digit1", "Digit2", "Digit3", "Digit4"];
  const PAD_KEY_LABELS = PAD_KEY_CODES.map(c => c.replace(/^Key|^Digit/, ""));
  const DRUM_808_VOICES = [
    { note: 36, id: "kick", label: "Kick" },
    { note: 37, id: "rimshot", label: "Rim" },
    { note: 38, id: "snare", label: "Snare" },
    { note: 39, id: "clap", label: "Clap" },
    { note: 42, id: "closedHat", label: "CH" },
    { note: 46, id: "openHat", label: "OH" },
    { note: 49, id: "cymbal", label: "Cym" },
    { note: 56, id: "cowbell", label: "Cow" },
    { note: 41, id: "lowTom", label: "LT" },
    { note: 45, id: "midTom", label: "MT" },
    { note: 48, id: "highTom", label: "HT" },
    { note: 75, id: "claves", label: "Clave" },
    { note: 64, id: "lowConga", label: "LC" },
    { note: 63, id: "midConga", label: "MC" },
    { note: 62, id: "highConga", label: "HC" },
    { note: 70, id: "maracas", label: "Maraca" }
  ].map((v, i) => ({ ...v, key: PAD_KEY_LABELS[i] }));
  const DRUM_808_BY_NOTE = new Map(DRUM_808_VOICES.map(v => [v.note, v]));

  // -------- CLIPBOARD --------
  let clipboardNotes = [];
  let clipboardSpanSec = 0; // length of copied fragment  
  
  // Grid / swing controls
  const gridSelect = document.getElementById("gridSelect");
  const gridLabel = document.getElementById("gridLabel") 
               || (gridSelect ? gridSelect.closest("label") : null);

  const swingSlider = document.getElementById("swingSlider");
  const swingLabel = document.getElementById("swingLabel");
  const quantizeSelBtn = document.getElementById("quantizeSelBtn");
  const quantizeAllBtn = document.getElementById("quantizeAllBtn");
  const humanizeSelBtn = document.getElementById("humanizeSelBtn");
  const humanizeAllBtn = document.getElementById("humanizeAllBtn");

  // Cached sizes
  let prWidth = 0;
  let prHeight = 0;
  let velWidth = 0;
  let velHeight = 0;
  let pixelsPerSec = 100;
  let pixelsPerNote = 12;

  // Rectangle selection state
  const selectionState = {
    active: false,
    isClick: true,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0
  };

  const selectModeBtn  = document.getElementById("selectModeBtn");
  const drawModeBtn    = document.getElementById("drawModeBtn");
  const loopBtn        = document.getElementById("loopBtn");
  const overdubBtn     = document.getElementById("overdubBtn");
  const contextMenuEl  = document.getElementById("contextMenu");

  // ---- Edit mode (Select / Draw) ----
  let currentEditMode = localStorage.getItem("editMode") || "select";    // "select" | "draw"   

   // Active MIDI notes for chord recording
  const midiActiveNotes = new Map(); // midiNote -> { startSec, velocity, trackIndex }
  const activePreviewNotes = new Map(); // midiNote -> trackId

  const defaultHelpText = "Hover over any control to see what it does.";

  function applySkin(skin) {
    const validSkin = ["ssl", "modern", "silver"].includes(skin) ? skin : "ssl";
    document.body.dataset.skin = validSkin;
    if (skinSelect) skinSelect.value = validSkin;
    localStorage.setItem("easyDawSkin", validSkin);
  }

  applySkin(localStorage.getItem("easyDawSkin") || "ssl");
  skinSelect?.addEventListener("change", () => {
    applySkin(skinSelect.value);
    renderSequencer();
    renderMixer();
    drawPianoRoll(lastPlayheadSec);
    drawVelocityLane();
    drawAllLoopBars(lastPlayheadSec);
  });

  // ---------- LOOP / PLAYHEAD ----------
  let loopEnabled     = true;
  let loopStartSec = 0;
  let loopEndSec = 4;
  let playbackRangeStartSec = 0;
  let playbackRangeEndSec = 0;
  let playbackLoopTimerId = null;
  let lastPlayheadSec = null; // used by loop bar drawing
  let playheadWasManuallySet = false;
  let loopToggle      = document.getElementById("loopToggle");
  let overdubToggle   = document.getElementById("overdubToggle"); 
  let clipLoopEnabled = false;
  let clipLoopStartSec = 0;
  let clipLoopEndSec = 0;
  
  let overdubEnabled  = true;
  // --- Overdub / loop recording helpers ---
  let isBackgroundPlayback = false;   // are we playing old notes while recording?
  let recordingBaseSec = 0;           // where in song recording is anchored
  let recordingLoopLen = 0;           // 0 = no wrap, otherwise loop length

  document.getElementById("undoBtn")?.addEventListener("click", undo);
  document.getElementById("redoBtn")?.addEventListener("click", redo);

  // Overwrite / Overdub state (was previously undefined)
  let overwriteEnabled = true;
  const overwriteBtn = document.getElementById("overwriteBtn");

  function syncOverwriteBtnUI() {
    if (!overwriteBtn) return;
    overwriteBtn.classList.toggle("active", overwriteEnabled);
  }
  syncOverwriteBtnUI();

  if (overwriteBtn) {
    overwriteBtn.addEventListener("click", () => {
      overwriteEnabled = !overwriteEnabled;
      syncOverwriteBtnUI();
      toast(overwriteEnabled ? "Overwrite ON" : "Overwrite OFF");
    });
  }

  window.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || e.target.isContentEditable) return;

    const isMac = navigator.platform.toUpperCase().includes("MAC");
    const mod = isMac ? e.metaKey : e.ctrlKey;

    if (!mod) return;

    if (e.code === "KeyZ" && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if ((e.code === "KeyZ" && e.shiftKey) || e.code === "KeyY") {
      e.preventDefault();
      redo();
    }
  });

  // Header buttons
  if (loopBtn) {
    loopEnabled = loopBtn.classList.contains("active");
    loopBtn.addEventListener("click", () => {
      loopEnabled = !loopEnabled;
      loopBtn.classList.toggle("active", loopEnabled);
    });
  }

  if (overdubBtn) {
    overdubEnabled = overdubBtn.classList.contains("active");
    overdubBtn.addEventListener("click", () => {
      overdubEnabled = !overdubEnabled;
      overdubBtn.classList.toggle("active", overdubEnabled);
    });
  }

  // =====================================================
  // Toast function (missing in your current app.js)
  // =====================================================
  function toast(msg, duration = 2000) {
    const container = document.getElementById("toastContainer");
    if (!container) return console.log("Toast:", msg);

    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;

    container.appendChild(el);

    // allow fade-in animation
    requestAnimationFrame(() => el.classList.add("show"));

    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 300);
    }, duration);
  }

  // Fallback if you keep old toggles around
  if (loopToggle && !loopBtn) {
    loopEnabled = loopToggle.checked;
    loopToggle.addEventListener("change", () => {
      loopEnabled = loopToggle.checked;
    });
  }
  if (overdubToggle && !overdubBtn) {
    overdubEnabled = overdubToggle.checked;
    overdubToggle.addEventListener("change", () => {
      overdubEnabled = overdubToggle.checked;
    });
  }

  // Loop bar canvas (editor)
  const loopBarCanvas = document.getElementById("loopBarCanvas");
  const loopCtx = loopBarCanvas ? loopBarCanvas.getContext("2d") : null;
  let loopWidth = 0;
  let loopHeight = 0;

  // Loop bar canvas (sequencer)
  const seqLoopBarCanvas = document.getElementById("seqLoopBarCanvas");
  const seqLoopCtx = seqLoopBarCanvas ? seqLoopBarCanvas.getContext("2d") : null;
  let seqLoopWidth = 0;
  let seqLoopHeight = 0;

  // The sequencer ruler and the sequencer loop bar share one canvas
  // (#seqLoopBarCanvas). They used to be drawn by two different functions that
  // overwrote each other, so the loop region vanished during playback.
  // Draw everything (bar numbers, loop region, playhead) in one pass.
  function drawSequencerRuler(playheadSec = null) {
    drawLoopBarTo(
      seqLoopCtx, seqLoopWidth, seqLoopHeight,
      playheadSec,
      getActiveLoopForView("sequencer"),
      seqViewStartSec, seqViewDuration,
      getSeqLabelWidth()
    );
  }
// end drawSequencerRuler()

  // ---------- METRONOME ----------
  const metroToggle       = document.getElementById("metroToggle");
  const precountSelect    = document.getElementById("precountSelect");
  const metroVolSlider    = document.getElementById("metroVolSlider");
  const metroSoundSelect  = document.getElementById("metroSoundSelect");

  let metronomeEnabled    = true;
  let metronomePreBars    = 1;

  if (metroToggle) metroToggle.checked = true;
  if (precountSelect) precountSelect.value = "1";

  let metronomeVolume     = metroVolSlider ? (parseFloat(metroVolSlider.value) || 0.6) : 0.6;
  let metronomeSound      = metroSoundSelect ? metroSoundSelect.value : "beep";
  let lastMetroBeatIndex  = null;
  
  const appSettingsBtn = document.getElementById("appSettingsBtn");
  const appSettingsModal = document.getElementById("appSettingsModal");
  const appSettingsModalClose = document.getElementById("appSettingsModalClose");

  function openAppSettingsModal() {
    if (appSettingsModal) appSettingsModal.classList.add("visible");
  }

  function closeAppSettingsModal() {
    if (appSettingsModal) appSettingsModal.classList.remove("visible");
  }

  if (appSettingsBtn && appSettingsModal) {
    appSettingsBtn.addEventListener("click", openAppSettingsModal);
  }
  if (appSettingsModalClose && appSettingsModal) {
    appSettingsModalClose.addEventListener("click", closeAppSettingsModal);
  }

  // Close when clicking outside dialog
  if (appSettingsModal) {
    appSettingsModal.addEventListener("click", (e) => {
      if (e.target === appSettingsModal) closeAppSettingsModal();
    });
  }

    // ---------- METRONOME UI ----------
  if (metroToggle) {
    metroToggle.addEventListener("change", () => {
      metronomeEnabled = metroToggle.checked;
      lastMetroBeatIndex = null;
    });
  }
  if (precountSelect) {
    precountSelect.addEventListener("change", () => {
      metronomePreBars = parseInt(precountSelect.value, 10) || 0;
    });
  }
  if (metroVolSlider) {
    metroVolSlider.addEventListener("input", () => {
      metronomeVolume = parseFloat(metroVolSlider.value) || 0.6;
    });
  }
  if (metroSoundSelect) {
    metroSoundSelect.addEventListener("change", () => {
      metronomeSound = metroSoundSelect.value;
    });
  }

  if (bpmInput) {
    bpmInput.addEventListener("change", handleBpmChange);
  }
  
  function centsDiff(midiFloat, midiInt) {
    return (midiFloat - midiInt) * 100;
  }

  function cloneNote(n) {
    return new NoteEvent(
      n.startSec,
      n.endSec,
      n.midiNote,
      n.velocity,
      n.scaleDegree,
      n.octave
    );
  } 

  function decideStableNote(midiFloat) {
    const snapped = Math.round(midiFloat);
    const quant = quantizeMidiToScale(snapped, tonicSemitone, scalePattern);

    if (stableMidi == null) {
      stableMidi = quant;
      pendingMidi = null;
      pendingCount = 0;
      return stableMidi;
    }

    const centsFromStable = centsDiff(midiFloat, stableMidi);

    // if still within hysteresis band, keep stable
    if (Math.abs(centsFromStable) < SWITCH_CENTS) {
      pendingMidi = null;
      pendingCount = 0;
      return stableMidi;
    }

    // otherwise start/continue pending
    if (pendingMidi !== quant) {
      pendingMidi = quant;
      pendingCount = 1;
    } else {
      pendingCount++;
    }

    if (pendingCount >= HOLD_FRAMES) {
      stableMidi = pendingMidi;
      pendingMidi = null;
      pendingCount = 0;
    }

    return stableMidi;
  }

  function handleBpmChange() {
  const min = parseFloat(bpmInput.min) || 30;
  const max = parseFloat(bpmInput.max) || 240;
  let newBpm = parseFloat(bpmInput.value);
  if (!Number.isFinite(newBpm) || newBpm <= 0) newBpm = timelineBpm || 120;
  newBpm = Math.min(max, Math.max(min, newBpm));
  bpmInput.value = newBpm;
  if (newBpm === timelineBpm) return;

  // Changing tempo mid-take would desync the recording clock
  if (isRecording) {
    bpmInput.value = timelineBpm;
    toast("Stop recording before changing BPM");
    return;
  }

  // The BPM field edits the tempo map (the tempo in effect at the playhead when
  // the song has tempo changes); the map re-maps all content times.
  if (window.WAWTempo) {
    window.WAWTempo.setBpmFromField(newBpm, window.WAWTempo.state.tempos.length > 1 ? (lastPlayheadSec || 0) : 0);
    if (window.WAWTempo.state.tempos.length > 1) bpmInput.value = window.WAWTempo.state.tempos[0].bpm;
    return;
  }
  // Everything is stored in seconds, so keep musical positions (bars/beats)
  // by rescaling ALL tracks, clips and loop ranges — not just the active track.
  const factor = timelineBpm / newBpm; // higher BPM → shorter seconds
  const scaleNote = n => { n.startSec *= factor; n.endSec *= factor; };
  const hasContent = tracks.some(t => (t.notes || []).length || (t.clips || []).length);

  if (hasContent || loopEndSec > loopStartSec) {
    pushHistory();
    tracks.forEach(t => {
      (t.notes || []).forEach(scaleNote);
      (t.clips || []).forEach(c => {
        c.startSec *= factor;
        c.endSec *= factor;
        (c.notesSnapshot || []).forEach(scaleNote);
      });
    });
    loopStartSec *= factor;
    loopEndSec *= factor;
    clipLoopStartSec *= factor;
    clipLoopEndSec *= factor;
    viewStartSec *= factor;
    viewDuration *= factor;
    if (lastPlayheadSec != null) lastPlayheadSec *= factor;
  }

  timelineBpm = newBpm;

  updateTimeView();
  renderSequencer();
  drawPianoRoll(lastPlayheadSec);
  drawVelocityLane();
  drawAllLoopBars(lastPlayheadSec);
  restartPlaybackFromCurrentPosition();
}

  function updateScaleSettings() {
    tonicSemitone = TONICS[tonicName] || 0;
    const sc = scaleSelect.value;
    scalePattern = SCALES[sc] || SCALES.major;
    drawCircleOfFifths();
    retuneNotesToNewKey();
    if (currentView === "editor") {
      saveEditorNotesToActiveClip();
      renderSequencer();
    }
    refreshScaleUI();
    drawPianoRoll();
    drawVelocityLane();    
    drawAllLoopBars(lastPlayheadSec);
  }

  function retuneNotesToNewKey() {
    for (const n of notes) {
      if (n.scaleDegree == null || n.octave == null) continue;
      const newSemitone = scalePattern[n.scaleDegree % scalePattern.length];
      const newMidi = tonicSemitone + newSemitone + n.octave * 12;
      n.midiNote = newMidi;
    }

    const activeTrack = tracks[activeTrackIndex];
    (activeTrack?.clips || []).forEach(clip => {
      (clip.notesSnapshot || []).forEach(n => {
        if (n.scaleDegree == null || n.octave == null) return;
        const newSemitone = scalePattern[n.scaleDegree % scalePattern.length];
        n.midiNote = tonicSemitone + newSemitone + n.octave * 12;
      });
    });
  }

  function getBaseDuration() {
    const bpm = parseFloat(bpmInput?.value) || 120;
    const secPerBeat = 60 / bpm;
    const beatsPerBar = 4;

    const minBars = 8; // just a comfy minimum
    let maxEnd = minBars * beatsPerBar * secPerBeat;

    // include all clips
    tracks.forEach(t => {
      (t.clips || []).forEach(c => {
        maxEnd = Math.max(maxEnd, c.endSec);
      });
    });

    // include loop + playhead so playback never truncates
    maxEnd = Math.max(maxEnd, loopEndSec, lastPlayheadSec);

    // small tail padding
    return maxEnd + beatsPerBar * secPerBeat * 2;
  }


  function fitViewToNotes(noteArray = notes) {
    if (!noteArray.length) {
      // fallback defaults
      viewStartSec = 0;
      viewDuration = 4;
      viewMinNote = GLOBAL_MIN_NOTE;
      viewMaxNote = GLOBAL_MAX_NOTE;
      return;
    }

    // ---- Horizontal fit (time) ----
    const minStart = Math.min(...noteArray.map(n => n.startSec));
    const maxEnd   = Math.max(...noteArray.map(n => n.endSec));

    const padSec = 0.25; // little breathing room left/right
    const dur = Math.max(0.5, (maxEnd - minStart) + padSec * 2);

    viewStartSec = Math.max(0, minStart - padSec);
    viewDuration = Math.max(4, dur); // never zoom in tighter than 4s

    // ---- Vertical fit (pitch) ----
    const minMidi = Math.min(...noteArray.map(n => n.midiNote));
    const maxMidi = Math.max(...noteArray.map(n => n.midiNote));

    const padNotes = 2; // show a couple notes above/below
    let newMin = minMidi - padNotes;
    let newMax = maxMidi + padNotes;

    // clamp
    newMin = Math.max(GLOBAL_MIN_NOTE, newMin);
    newMax = Math.min(GLOBAL_MAX_NOTE, newMax);

    // ensure at least 12 semitones visible
    if (newMax - newMin < 12) {
      const center = (newMin + newMax) / 2;
      newMin = Math.max(GLOBAL_MIN_NOTE, Math.floor(center - 6));
      newMax = Math.min(GLOBAL_MAX_NOTE, Math.ceil(center + 6));
    }

    viewMinNote = newMin;
    viewMaxNote = newMax;
  }

  function updateTimeView() {
    const baseDuration = getBaseDuration();
    if (currentView === "sequencer") {
      // keep sequencer wide; don't clamp to 4s
      viewDuration = seqViewDuration;
      viewStartSec = seqViewStartSec;
    } else if (currentView === "editor" && getEditorClipBounds()) {
      const bounds = getEditorClipBounds();
      viewStartSec = bounds.start;
      viewDuration = bounds.duration;
    } else {
      // editor stays tight
      const fixedWindow = 4;
      viewDuration = fixedWindow;
    }  
    const maxStart = Math.max(0, baseDuration - viewDuration);
    if (viewStartSec > maxStart) viewStartSec = maxStart;
    if (viewStartSec < 0) viewStartSec = 0;
    if (currentView === "sequencer") {
    // write back
    seqViewDuration = viewDuration;
    seqViewStartSec = viewStartSec;
    }
  }

  function followRecordingPlayhead(songSec) {
  // keep playhead inside view with a right-side margin
  const margin = Math.max(0.1, viewDuration * 0.2); // 20% of window
  const rightEdge = viewStartSec + viewDuration;

  if (songSec > rightEdge - margin) {
    viewStartSec = songSec - (viewDuration - margin);
  }


  // clamp start to valid range based on current recording length
  const baseDur = Math.max(getBaseDuration(), songSec + 0.05);
  const maxStart = Math.max(0, baseDur - viewDuration);

  if (viewStartSec < 0) viewStartSec = 0;
  if (viewStartSec > maxStart) viewStartSec = maxStart;
}

function snapEndToCommonBars(endSec, bpm, beatsPerBar = 4) {
  const secPerBeat = 60 / bpm;
  const barSec = secPerBeat * beatsPerBar;

  const barsFloat = endSec / barSec;

  if (!isFinite(barsFloat) || barsFloat <= 0) {
    return barSec; // fallback 1 bar
  }

  // powers of two around barsFloat
  const lowerPow = Math.pow(2, Math.floor(Math.log2(barsFloat)));
  const upperPow = Math.pow(2, Math.ceil(Math.log2(barsFloat)));

  // how close are we?
  const tol = 0.15; // 15% tolerance window
  const lowerFrac = Math.abs(barsFloat - lowerPow) / lowerPow;
  const upperFrac = Math.abs(barsFloat - upperPow) / upperPow;

  let snappedBars;

  if (lowerFrac <= tol) {
    snappedBars = lowerPow;          // close to lower => snap down
  } else if (upperFrac <= tol) {
    snappedBars = upperPow;          // close to upper => snap up
  } else {
    snappedBars = upperPow;          // otherwise: snap UP (don’t cut notes off)
  }

  return snappedBars * barSec;
}


  // ---------- UI EVENT LISTENERS ----------
  if (scaleSelect) scaleSelect.addEventListener("change", updateScaleSettings);

  if (startMicBtn) startMicBtn.addEventListener("click", () => {
    if (micStream) {
      stopMic();
    } else {
      startMic();
    }
  });

  if (startRecBtn) startRecBtn.addEventListener("click", startRecording);
  // Stop button
  if (stopBtn) {
    stopBtn.addEventListener("click", () => {
      if (isRecordingClip) {
        stopClipRecording();     // <-- important
      } else if (isRecording) {
        stopRecording();
      } else if (isPlaying) {
        stopPlayback();
      }
    });
  }

  // Play button
  if (playBtn) playBtn.addEventListener("click", () => playNotes(getAllNotesMixdown()));

  // Export button
  exportBtn?.addEventListener("click", () => {
    const mixNotes = getAllNotesMixdown();
    if (!mixNotes.length) {
      statusEl.textContent = "No notes to export yet.";
      return;
    }
    
    // Build MIDI
    const bpm = parseFloat(bpmInput.value) || 120;
    const baseName = (prompt("Base filename (without extension):", "voice-to-midi") || "voice-to-midi")
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "_");

    const scaleId = scaleSelect.value;
    const scaleLabel = scaleId === "major" ? "maj" :
                      scaleId === "minor" ? "min" :
                      scaleId === "pent"  ? "min-pent" : scaleId;

    const fileName = `${baseName}_${tonicName}-${scaleLabel}_${bpm}bpm.mid`;

    const blob = buildMidiFile(mixNotes, bpm);
    downloadBlob(blob, fileName);
    statusEl.textContent = `Exported ${mixNotes.length} note(s) to MIDI as "${fileName}".`;
  });

  exportAudioBtn?.addEventListener("click", () => {
    exportWavMixdown().catch(err => {
      console.error(err);
      statusEl.textContent = "WAV export failed: " + err.message;
    });
  });

  saveProjectBtn?.addEventListener("click", saveProjectFile);
  loadProjectBtn?.addEventListener("click", () => loadProjectInput?.click());
  projectLibrarySaveBtn?.addEventListener("click", () => saveProjectToLibrary());
  projectLibraryImportBtn?.addEventListener("click", () => loadProjectInput?.click());
  loadProjectInput?.addEventListener("change", async () => {
    const file = loadProjectInput.files?.[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      // exported projects embed their audio (sampler pads + audio clips)
      if (payload.samples) await window.WAWSamples?.importSamples(payload.samples);
      loadProjectPayload(payload);
      const importedName = file.name.replace(/\.json$/i, "");
      saveProjectToLibrary(importedName, { newProject: true });
    } catch (err) {
      console.error(err);
      statusEl.textContent = "Project load failed: " + err.message;
    } finally {
      loadProjectInput.value = "";
    }
  });


  gateSlider.addEventListener("input", () => {
    gateSensitivity = parseFloat(gateSlider.value) || 0;
    gateLabel.textContent = gateSensitivity <= 0 ? "Off" : gateSensitivity.toFixed(1) + "x";
  });

  inputGainSlider.addEventListener("input", () => {
    const v = parseFloat(inputGainSlider.value) || 0;
    if (inputMonitorGain) {
      inputMonitorGain.gain.value = v * (monitorBtn.dataset.state === "on" ? 1 : 0);
    }
    if (inputGainLabel) {
      inputGainLabel.textContent = Math.round(v * 100) + "%";
    }
  });

  function formatHzLabel(v) {
    if (v >= 1000) return (v / 1000).toFixed(1) + " kHz";
    return v + " Hz";
  }

  hpSlider.addEventListener("input", () => {
    const v = parseFloat(hpSlider.value) || 80;
    if (hpFilterNode) hpFilterNode.frequency.value = v;
    hpLabel.textContent = formatHzLabel(v);
  });

  lpSlider.addEventListener("input", () => {
    const v = parseFloat(lpSlider.value) || 4000;
    if (lpFilterNode) lpFilterNode.frequency.value = v;
    lpLabel.textContent = formatHzLabel(v);
  });
  
  monitorBtn.dataset.state = "off";
  monitorBtn.addEventListener("click", () => {
    const newState = monitorBtn.dataset.state === "on" ? "off" : "on";
    monitorBtn.dataset.state = newState;
    monitorBtn.textContent = newState === "on" ? "Monitor On" : "Monitor Off";
    if (inputMonitorGain) {
      const baseGain = parseFloat(inputGainSlider.value) || 0;
      inputMonitorGain.gain.value = newState === "on" ? baseGain : 0;
    }
  });

  // Sidebar collapsible panels
  document.querySelectorAll(".panel").forEach(panel => {
    const header = panel.querySelector(".panel-header");
    if (!header) return;
    header.addEventListener("click", () => {
      panel.classList.toggle("collapsed");
      const toggle = panel.querySelector(".panel-toggle");
      if (toggle) toggle.textContent = panel.classList.contains("collapsed") ? "▲" : "▼";
    });
  });

  // Resize canvases on load + resize
  window.addEventListener("resize", () => {
    resizeCanvases();
    drawCircleOfFifths();
    drawPianoRoll();
    drawVelocityLane();
    drawTuner(null, 0, null);
    updateSeqViewFromScroll();              // refresh seqViewDuration/Start
    drawSequencerRuler(lastPlayheadSec);    // redraw bar numbers/grid
    drawAllLoopBars(lastPlayheadSec);       // redraw loop region
  });

    ["pointerdown", "touchstart", "keydown"].forEach(evt => {
    window.addEventListener(evt, () => {
      unlockAudioContext();
    }, { passive: true });
  });  

  const helpEntries = [
    [".title", "WAW: your current browser-based DAW workspace."],
    [".bpm-label", "BPM: sets song tempo for grid, recording, playback, and exports."],
    ["#bpmInput", "BPM: sets song tempo for grid, recording, playback, and exports."],
    [".metro-row", "Metronome: click on/off; sound and pre-count live in Settings."],
    ["#metroToggleBtn", "Metronome: click on/off; sound and pre-count live in Settings."],
    ["#goSequencerBtn", "Sequencer: arrange clips, select tracks, and play the active track."],
    ["#goMixerBtn", "Mixer: balance track volume, pan, mute, solo, and width."],
    ["#goProjectsBtn", "Projects: load, save, export, import, or delete local projects."],
    ["#goEditorBtn", "Editor: edit the open clip's MIDI notes and velocities."],
    [".view-switch", "Views: switch between arranging, mixing, projects, and clip editing."],
    ["#addTrackBtn", "Add Track: creates a new track. Alt+N also adds one."],
    ["#playBtn", "Play: starts playback from the playhead or active loop."],
    ["#stopBtn", "Stop: stops playback, recording, and held scheduled notes."],
    ["#startRecBtn", "Record: captures mic or MIDI notes into the active track."],
    ["#seqRecordBtn", "Clip Rec: records a new sequencer clip from the playhead."],
    ["#seqStopBtn", "Clip Stop: stops clip recording and creates the clip."],
    ["#loopBtn", "Loop: repeats playback or recording inside the loop range."],
    ["#overwriteBtn", "Overwrite: recording replaces notes in the loop instead of layering."],
    ["#exportBtn", "MIDI Export: saves the current mix as a MIDI file."],
    ["#exportAudioBtn", "WAV Export: renders the current mix to an audio file."],
    ["#saveProjectBtn", "Save: updates the open project and exports a JSON copy."],
    ["#loadProjectBtn", "Load: imports a project JSON file from your computer."],
    ["#appSettingsBtn", "Settings: skin, metronome pre-count, volume, and sound."],
    [".panel-header", "Panel Header: click to collapse or expand this section."],
    [".panel-toggle", "Panel Toggle: collapses or expands this sidebar panel."],
    [".subsection-title", "Section Label: groups related controls."],
    [".track-row", "Track: click to make it active for keyboard, MIDI, recording, and editing."],
    [".track-name-input", "Track Name: rename the active track."],
    [".track-instrument", "Instrument: choose Synth or the 808 Kit for this track."],
    [".edit-synth-btn", "Edit Instrument: opens the full sound panel for this track."],
    [".track-btn.mute", "Mute: silences this track in playback and live preview."],
    [".track-btn.solo", "Solo: plays this track alone unless other tracks are soloed."],
    [".track-btn.mono", "Stereo/Mono: toggles width; Mono centers the track."],
    [".track-vol", "Track Volume: sets this track's playback and live preview level."],
    [".track-pan", "Track Pan: moves this track left or right in the stereo field."],
    [".fx-chip", "FX Chip: toggles or reserves track effect slots."],
    [".drum808-pad", "808 Pad: click to audition this drum voice on the active track."],
    ["#drum808Preset", "808 Preset: loads a complete synthesized drum machine setting."],
    ["#drum808SavePresetBtn", "Save 808 Preset: stores the current drum machine settings."],
    ["#drum808Tone", "808 Tone: brightens or darkens the generated drum voices."],
    ["#drum808Pitch", "808 Pitch: shifts the whole drum machine up or down."],
    ["#drum808Punch", "808 Punch: adds sharper pitch attack to kicks and drums."],
    ["#drum808Noise", "808 Noise: controls snares, hats, claps, and cymbal texture."],
    ["#drum808Decay", "808 Decay: lengthens the body of kicks, snares, and cymbals."],
    ["#drum808Snap", "808 Snap: sharpens claps, snares, rimshots, and claves."],
    ["#drum808HatDecay", "Hat Decay: sets closed hat, open hat, and cymbal tail length."],
    ["#drum808TomDecay", "Tom Decay: sets how long the synthetic toms ring."],
    ["#drum808CowbellTune", "Cow Tune: retunes the dual oscillator cowbell voice."],
    ["#drum808Drive", "808 Drive: adds saturation to the whole drum machine."],
    ["#drum808Pan", "808 Pan: offsets the kit left or right before track panning."],
    ["#drum808Gain", "808 Level: sets the output level for this kit preset."],
    ["#seqLoopBarCanvas", "Sequencer Loop: drag to set loop; click to move the playhead."],
    ["#sequencerGrid .seq-row-label", "Track Lane Label: click to select this track for live playing."],
    ["#sequencerGrid .seq-row-lane", "Sequencer Lane: click empty space to create a 4-bar clip."],
    [".seq-clip .handle.left", "Clip Start: drag to trim the clip's beginning."],
    [".seq-clip .handle.right", "Clip End: drag to trim the clip's length."],
    [".seq-clip", "Clip: drag to move, double-click to edit, right-click for clip actions."],
    [".clip-thumb", "Clip Preview: shows the MIDI notes inside this clip."],
    [".clip-title", "Clip Title: the current clip name."],
    ["#circleCanvas", "Circle: click a key to set the song tonic."],
    ["#scaleSelectCircle", "Scale: choose the pitch set used by drawing and retuning."],
    ["#scaleNotes", "Scale Notes: shows the notes available in the current key."],
    [".scale-label", "Scale Label: names the musical information in this row."],
    ["#scaleChords", "Chord Presets: click a chord to draw that voicing."],
    ["#invBtn", "Inversion: cycles the selected chord voicing."],
    [".octave-controls button", "Voicing: move a chord tone up or down an octave."],
    ["#tunerCanvas", "Tuner: shows detected mic pitch, cents, and frequency."],
    ["#eqCanvas", "Spectrum: shows mic input after filtering."],
    ["#hpSlider", "Low Cut: removes rumble before pitch detection."],
    ["#lpSlider", "High Cut: removes hiss before pitch detection."],
    ["#gateSlider", "Gate: ignores quiet noise below the signal threshold."],
    ["#inputGainSlider", "Input Vol: adjusts mic level before detection."],
    ["#status", "Status: shows recording, mic, export, and project messages."],
    ["#startMicBtn", "Start Mic: requests microphone access for pitch recording."],
    ["#monitorBtn", "Monitor: sends filtered mic input to your speakers."],
    ["#loopBarCanvas", "Editor Loop: drag to set loop; click to move the playhead."],
    ["#pianoRollCanvas", "Piano Roll: draw, select, move, resize, and edit MIDI notes."],
    ["#selectModeBtn", "Select: click and drag notes or marquee-select groups."],
    ["#drawModeBtn", "Draw: click the piano roll to create notes or chords."],
    ["#gridSelect", "Grid: sets note, clip, loop, and quantize snap size."],
    ["#swingSlider", "Swing: delays alternate grid divisions for groove."],
    ["#swingLabel", "Swing Amount: shows the current groove percentage."],
    ["#undoBtn", "Undo: restores the previous edit."],
    ["#redoBtn", "Redo: reapplies the next undone edit."],
    ["#velocityCanvas", "Velocity: drag note bars up or down to change loudness."],
    [".mixer-strip", "Mixer Strip: channel controls for one track."],
    [".mix-title", "Mixer Track: click strip to select this track."],
    [".mix-mute", "Mute: silences this mixer channel."],
    [".mix-solo", "Solo: isolates this mixer channel for playback."],
    [".mix-width", "Width: toggles this channel between stereo and mono."],
    [".ssl-knob-wrap", "Mixer Knob: drag to adjust EQ, sends, or pan."],
    [".mix-vol", "Fader: controls this track's mixer volume."],
    [".ssl-meter", "Meter: shows this track's current signal level."],
    ["#projectLibrarySaveBtn", "Save Current: stores this session in the local library."],
    ["#projectLibraryImportBtn", "Import JSON: load a project file into the library."],
    [".projects-toolbar", "Projects Toolbar: save this session or import a JSON project."],
    [".project-card [data-action='load']", "Load Project: opens this saved project."],
    [".project-card [data-action='export']", "Export Project: downloads this project as JSON."],
    [".project-card [data-action='delete']", "Delete Project: removes this local library project."],
    [".project-card", "Project Card: local browser-saved project snapshot."],
    ["#skinSelect", "Skin: changes the DAW's visual theme."],
    ["#precountSelect", "Pre-count: adds bars before recording starts."],
    ["#metroVolSlider", "Metronome Volume: controls click loudness."],
    ["#metroSoundSelect", "Metronome Sound: chooses the click tone."],
    ["#appSettingsModalClose", "Close: hides Settings."],
    ["#synthPreset", "Synth Preset: loads a saved synth patch."],
    ["#synthSavePresetBtn", "Save Preset: stores current synth settings as a custom preset."],
    ["#synthModalClose", "Close Synth: hides the synth panel."],
    ["#synthWave", "Wave: chooses the oscillator shape."],
    ["#synthOsc2Wave", "Osc 2: adds a second oscillator for thicker patches."],
    ["#synthOsc2Mix", "Osc 2 Mix: blends the second oscillator into the sound."],
    ["#synthOsc2Detune", "Osc 2 Detune: offsets oscillator 2 in cents."],
    ["#synthNoise", "Noise: adds filtered noise for breath, pluck, or grit."],
    ["#synthGlide", "Glide: slides pitch from the previous note."],
    ["#synthAttack", "Attack: fade-in time for each synth note."],
    ["#synthDecay", "Decay: time from peak to sustain level."],
    ["#synthSustain", "Sustain: held level while a note is pressed."],
    ["#synthRelease", "Release: fade-out time after note-off."],
    ["#synthCutoff", "Filter: darkens or brightens the synth tone."],
    ["#synthFilterQ", "Resonance: boosts frequencies around the filter cutoff."],
    ["#synthDetune", "Detune: offsets pitch in cents for thicker or looser tone."],
    ["#synthFilterEnv", "Filter Env: moves the cutoff at note start."],
    ["#synthFilterAttack", "Filter Attack: time for the filter envelope to open."],
    ["#synthFilterDecay", "Filter Decay: time for the filter envelope to settle."],
    ["#synthLfoTarget", "LFO Target: choose pitch vibrato or filter wobble."],
    ["#synthLfoRate", "LFO Rate: speed of vibrato or wobble."],
    ["#synthLfoAmount", "LFO Amount: depth of vibrato or wobble."],
    ["#synthDrive", "Drive: adds saturation before the output."],
    ["#synthPan", "Patch Pan: offsets this patch left or right."],
    ["#synthChorus", "Chorus: adds a short doubled delay."],
    ["#synthDelaySend", "Delay: sends this patch into an echo."],
    ["#synthReverbSend", "Space: adds a short ambient reflection."],
    ["#synthGain", "Synth Volume: output level for this synth patch."],
    [".synth-value", "Synth Value: shows the current parameter value."],
    ["#panelHelp", "Help: hover any DAW control to see a short description here."],
    ["#contextMenu [data-action='quantizeSel']", "Quantize Selection: snaps selected notes to the grid."],
    ["#contextMenu [data-action='quantizeAll']", "Quantize All: snaps all active-track notes to the grid."],
    ["#contextMenu [data-action='humanizeSel']", "Humanize Selection: adds small timing and velocity variation."],
    ["#contextMenu [data-action='humanizeAll']", "Humanize All: adds small variation to all active-track notes."],
    ["#contextMenu [data-action='copySel']", "Copy Notes: copies selected notes to the note clipboard."],
    ["#contextMenu [data-action='paste']", "Paste Notes: inserts copied notes at the playhead."],
    ["#contextMenu [data-action='duplicateSel']", "Duplicate Notes: copies selected notes after their end."],
    ["#contextMenu [data-action='deleteSel']", "Delete Notes: removes selected notes."],
    ["#contextMenu [data-action='clipQuantize']", "Quantize Clip: snaps this clip's notes to the grid."],
    ["#contextMenu [data-action='clipHumanize']", "Humanize Clip: varies this clip's notes slightly."],
    ["#contextMenu [data-action='clipCopy']", "Copy Clip: copies this clip to the clip clipboard."],
    ["#contextMenu [data-action='clipCut']", "Cut Clip: copies then removes this clip."],
    ["#contextMenu [data-action='clipPaste']", "Paste Clip: inserts the copied clip after this clip."],
    ["#contextMenu [data-action='clipDuplicate']", "Duplicate Clip: creates a copy after this clip."],
    ["#contextMenu [data-action='clipRename']", "Rename Clip: changes this clip's title."],
    ["#contextMenu [data-action='clipOpen']", "Open Clip: edits this clip in the MIDI editor."],
    ["#contextMenu [data-action='clipSetLoop']", "Set Loop: matches the loop range to this clip."],
    ["#contextMenu [data-action='clipClear']", "Clear Clip: removes this clip's notes but keeps the clip."],
    ["#contextMenu [data-action='deleteClip']", "Delete Clip: removes this clip and its notes."],
    ["button", "Button: click to run this command."],
    ["select", "Menu: choose one option from the list."],
    ["input[type='range']", "Slider: drag to change this value."],
    ["input[type='number']", "Number: type or step to set this value."],
    ["input[type='text']", "Text: type a name or label."],
    ["canvas", "Canvas: interactive DAW display; hover a specific area for details."]
  ];

  function fitHelpText(text) {
    const clean = String(text || defaultHelpText).replace(/\s+/g, " ").trim();
    return clean.length > 96 ? clean.slice(0, 93).trimEnd() + "..." : clean;
  }

  function setHelpText(text) {
    if (helpText) helpText.textContent = fitHelpText(text);
  }

  function getHelpForTarget(target) {
    const direct = target?.closest?.("[data-help]");
    if (direct?.dataset.help) return direct.dataset.help;
    for (const [selector, text] of helpEntries) {
      if (target?.closest?.(selector)) return text;
    }
    return null;
  }

  function registerHelp(el, text) {
    if (typeof el === "string") el = document.getElementById(el);
    if (el) el.dataset.help = text;
  }

  document.addEventListener("mouseover", (e) => {
    const text = getHelpForTarget(e.target);
    if (text) setHelpText(text);
  }, true);

  document.addEventListener("focusin", (e) => {
    const text = getHelpForTarget(e.target);
    if (text) setHelpText(text);
  }, true);

  document.addEventListener("mouseout", (e) => {
    const from = e.target;
    const to = e.relatedTarget;
    if (to && from?.contains?.(to)) return;
    if (!to || !getHelpForTarget(to)) setHelpText(defaultHelpText);
  }, true);

  document.addEventListener("focusout", () => setHelpText(defaultHelpText), true);

  function load808PatchToUI(patch = createDefault808Patch()) {
    const merged = { ...createDefault808Patch(), ...patch };
    Object.assign(drum808State, merged);
    if (drum808Tone) drum808Tone.value = merged.tone;
    if (drum808Pitch) drum808Pitch.value = merged.pitch;
    if (drum808Punch) drum808Punch.value = merged.punch;
    if (drum808Noise) drum808Noise.value = merged.noise;
    if (drum808Decay) drum808Decay.value = merged.decay;
    if (drum808Snap) drum808Snap.value = merged.snap;
    if (drum808HatDecay) drum808HatDecay.value = merged.hatDecay;
    if (drum808TomDecay) drum808TomDecay.value = merged.tomDecay;
    if (drum808CowbellTune) drum808CowbellTune.value = merged.cowbellTune;
    if (drum808Drive) drum808Drive.value = merged.drive;
    if (drum808Pan) drum808Pan.value = merged.pan;
    if (drum808Gain) drum808Gain.value = merged.gain;
    const stereoEl = document.getElementById("drum808Stereo");
    if (stereoEl) stereoEl.value = merged.stereo ?? 0.5;
    update808ValueLabels(merged);
  }

  function update808ValueLabels(patch = drum808State) {
    drum808ToneVal.textContent = patch.tone.toFixed(2);
    drum808PitchVal.textContent = patch.pitch.toFixed(2);
    drum808PunchVal.textContent = patch.punch.toFixed(2);
    drum808NoiseVal.textContent = patch.noise.toFixed(2);
    drum808DecayVal.textContent = patch.decay.toFixed(2);
    drum808SnapVal.textContent = patch.snap.toFixed(2);
    drum808HatDecayVal.textContent = patch.hatDecay.toFixed(2);
    drum808TomDecayVal.textContent = patch.tomDecay.toFixed(2);
    drum808CowbellTuneVal.textContent = patch.cowbellTune.toFixed(2);
    drum808DriveVal.textContent = patch.drive.toFixed(2);
    drum808PanVal.textContent = patch.pan.toFixed(2);
    drum808GainVal.textContent = patch.gain.toFixed(2);
    const stereoVal = document.getElementById("drum808StereoVal");
    if (stereoVal) stereoVal.textContent = (patch.stereo ?? 0.5).toFixed(2);
  }

  function update808FromUI() {
    drum808State.tone = parseFloat(drum808Tone.value);
    drum808State.pitch = parseFloat(drum808Pitch.value);
    drum808State.punch = parseFloat(drum808Punch.value);
    drum808State.noise = parseFloat(drum808Noise.value);
    drum808State.decay = parseFloat(drum808Decay.value);
    drum808State.snap = parseFloat(drum808Snap.value);
    drum808State.hatDecay = parseFloat(drum808HatDecay.value);
    drum808State.tomDecay = parseFloat(drum808TomDecay.value);
    drum808State.cowbellTune = parseFloat(drum808CowbellTune.value);
    drum808State.drive = parseFloat(drum808Drive.value);
    drum808State.pan = parseFloat(drum808Pan.value);
    drum808State.gain = parseFloat(drum808Gain.value);
    const stereoEl = document.getElementById("drum808Stereo");
    if (stereoEl) drum808State.stereo = parseFloat(stereoEl.value);
    update808ValueLabels(drum808State);
    const track = getActiveTrack();
    if (track?.instrument === "808") track.drum808Patch = { ...drum808State };
  }

  function readCustom808Presets() {
    try {
      const raw = localStorage.getItem(DRUM808_CUSTOM_PRESETS_KEY);
      const presets = raw ? JSON.parse(raw) : [];
      return Array.isArray(presets) ? presets : [];
    } catch (e) {
      console.warn("Custom 808 presets read failed:", e);
      return [];
    }
  }

  function writeCustom808Presets(presets) {
    localStorage.setItem(DRUM808_CUSTOM_PRESETS_KEY, JSON.stringify(presets));
  }

  function renderCustom808Presets() {
    if (!drum808Preset) return;
    drum808Preset.querySelectorAll("option[data-custom='true']").forEach(option => option.remove());
    readCustom808Presets().forEach(preset => {
      const option = document.createElement("option");
      option.value = `custom:${preset.id}`;
      option.textContent = preset.name;
      option.dataset.custom = "true";
      drum808Preset.appendChild(option);
    });
  }

  function getCurrent808Patch() {
    update808FromUI();
    return { ...createDefault808Patch(), ...drum808State };
  }

  function saveCustom808Preset() {
    const name = (prompt("808 preset name:", "My 808") || "").trim();
    if (!name) return;
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "custom";
    const presets = readCustom808Presets();
    const existingIndex = presets.findIndex(preset => preset.id === id);
    if (existingIndex >= 0 && !confirm(`Replace custom 808 preset "${presets[existingIndex].name}"?`)) return;
    const item = {
      id,
      name,
      patch: getCurrent808Patch()
    };
    if (existingIndex >= 0) presets.splice(existingIndex, 1, item);
    else presets.push(item);
    writeCustom808Presets(presets);
    renderCustom808Presets();
    drum808Preset.value = `custom:${id}`;
    releaseSelectFocus(drum808Preset);
    statusEl.textContent = `Saved 808 preset "${name}".`;
  }

  function apply808Preset(id) {
    if (id?.startsWith("custom:")) {
      const presetId = id.slice("custom:".length);
      const preset = readCustom808Presets().find(item => item.id === presetId);
      if (preset?.patch) {
        load808PatchToUI(preset.patch);
        update808FromUI();
      }
      return;
    }

    const patch = createDefault808Patch();
    if (id === "deep") Object.assign(patch, { presetName: "Deep Club", tone: 0.55, pitch: 0.72, decay: 1.55, punch: 0.9, drive: 0.22, gain: 1.05 });
    if (id === "tight") Object.assign(patch, { presetName: "Tight Electro", tone: 0.9, pitch: 1.15, decay: 0.55, snap: 0.72, hatDecay: 0.2, tomDecay: 0.35, gain: 0.9 });
    if (id === "dirty") Object.assign(patch, { presetName: "Dirty Tape", tone: 0.7, pitch: 0.95, noise: 0.9, drive: 0.55, snap: 0.85, gain: 0.9 });
    if (id === "airy") Object.assign(patch, { presetName: "Air Hats", tone: 1, noise: 1, hatDecay: 0.9, snap: 0.45, decay: 0.9, drive: 0.06 });
    load808PatchToUI(patch);
    update808FromUI();
  }

  function open808Modal() {
    const track = getActiveTrack();
    if (track?.instrument !== "808") return;
    renderCustom808Presets();
    load808PatchToUI(track.drum808Patch);
    render808ModalPads();
    drum808Modal?.classList.add("visible");
  }

  function close808Modal() {
    drum808Modal?.classList.remove("visible");
  }

  drum808ModalClose?.addEventListener("click", close808Modal);
  drum808Modal?.addEventListener("click", (e) => {
    if (e.target === drum808Modal) close808Modal();
  });
  drum808Preset?.addEventListener("change", () => {
    apply808Preset(drum808Preset.value);
    releaseSelectFocus(drum808Preset);
  });
  drum808SavePresetBtn?.addEventListener("click", saveCustom808Preset);
  [drum808Tone, drum808Pitch, drum808Punch, drum808Noise, drum808Decay, drum808Snap, drum808HatDecay, drum808TomDecay, drum808CowbellTune, drum808Drive, drum808Pan, drum808Gain, document.getElementById("drum808Stereo")].forEach(el => {
    el?.addEventListener("input", update808FromUI);
  });
  drum808Modal?.addEventListener("change", releaseSynthBodyFocus, true);
  drum808Modal?.addEventListener("click", releaseSynthBodyFocus, true);
  drum808Modal?.addEventListener("pointerup", releaseSynthBodyFocus, true);

  // Synth UI handlers
  function loadSynthPatchToUI(patch = createDefaultSynthPatch()) {
    const merged = { ...createDefaultSynthPatch(), ...patch };
    Object.assign(synthState, merged);

    if (synthWave) synthWave.value = merged.wave;
    if (synthAttack) synthAttack.value = merged.attack;
    if (synthDecay) synthDecay.value = merged.decay;
    if (synthSustain) synthSustain.value = merged.sustain;
    if (synthRelease) synthRelease.value = merged.release;
    if (synthCutoff) synthCutoff.value = merged.cutoff;
    if (synthFilterQ) synthFilterQ.value = merged.filterQ;
    if (synthDetune) synthDetune.value = merged.detune;
    if (synthOsc2Wave) synthOsc2Wave.value = merged.osc2Wave;
    if (synthOsc2Mix) synthOsc2Mix.value = merged.osc2Mix;
    if (synthOsc2Detune) synthOsc2Detune.value = merged.osc2Detune;
    if (synthNoise) synthNoise.value = merged.noise;
    if (synthGlide) synthGlide.value = merged.glide;
    if (synthFilterEnv) synthFilterEnv.value = merged.filterEnv;
    if (synthFilterAttack) synthFilterAttack.value = merged.filterAttack;
    if (synthFilterDecay) synthFilterDecay.value = merged.filterDecay;
    if (synthLfoTarget) synthLfoTarget.value = merged.lfoTarget;
    if (synthLfoRate) synthLfoRate.value = merged.lfoRate;
    if (synthLfoAmount) synthLfoAmount.value = merged.lfoAmount;
    if (synthDrive) synthDrive.value = merged.drive;
    if (synthPan) synthPan.value = merged.pan;
    if (synthChorus) synthChorus.value = merged.chorus;
    if (synthDelaySend) synthDelaySend.value = merged.delaySend;
    if (synthReverbSend) synthReverbSend.value = merged.reverbSend;
    if (synthGain) synthGain.value = merged.gain;

    updateSynthValueLabels(merged);
    // extended voice parameters (unison, FM, filter type, ...) from js/synth.js
    if (window.WAWSynth) Object.assign(synthState, window.WAWSynth.writeExtraParams(merged));
    if (synthFilter) {
      synthFilter.frequency.value = merged.cutoff;
      synthFilter.Q.value = merged.filterQ;
    }
    if (synthMasterGain) synthMasterGain.gain.value = 1;
  }

  function updateSynthValueLabels(patch = synthState) {
    synthAttackVal.textContent = patch.attack.toFixed(2);
    synthDecayVal.textContent = patch.decay.toFixed(2);
    synthSustainVal.textContent = patch.sustain.toFixed(2);
    synthReleaseVal.textContent = patch.release.toFixed(2);
    synthCutoffVal.textContent = patch.cutoff >= 1000
      ? (patch.cutoff / 1000).toFixed(1) + "k"
      : patch.cutoff.toFixed(0);
    synthFilterQVal.textContent = patch.filterQ.toFixed(1);
    synthDetuneVal.textContent = Math.round(patch.detune).toString();
    synthOsc2MixVal.textContent = patch.osc2Mix.toFixed(2);
    synthOsc2DetuneVal.textContent = Math.round(patch.osc2Detune).toString();
    synthNoiseVal.textContent = patch.noise.toFixed(2);
    synthGlideVal.textContent = patch.glide.toFixed(2);
    synthFilterEnvVal.textContent = Math.round(patch.filterEnv).toString();
    synthFilterAttackVal.textContent = patch.filterAttack.toFixed(2);
    synthFilterDecayVal.textContent = patch.filterDecay.toFixed(2);
    synthLfoRateVal.textContent = patch.lfoRate.toFixed(1);
    synthLfoAmountVal.textContent = Math.round(patch.lfoAmount).toString();
    synthDriveVal.textContent = patch.drive.toFixed(2);
    synthPanVal.textContent = patch.pan.toFixed(2);
    synthChorusVal.textContent = patch.chorus.toFixed(2);
    synthDelaySendVal.textContent = patch.delaySend.toFixed(2);
    synthReverbSendVal.textContent = patch.reverbSend.toFixed(2);
    synthGainVal.textContent = patch.gain.toFixed(2);
  }

  function updateSynthFromUI() {
    synthState.wave = synthWave.value;
    synthState.attack = parseFloat(synthAttack.value);
    synthState.decay = parseFloat(synthDecay.value);
    synthState.sustain = parseFloat(synthSustain.value);
    synthState.release = parseFloat(synthRelease.value);
    synthState.cutoff = parseFloat(synthCutoff.value);
    synthState.filterQ = parseFloat(synthFilterQ.value);
    synthState.detune = parseFloat(synthDetune.value);
    synthState.osc2Wave = synthOsc2Wave.value;
    synthState.osc2Mix = parseFloat(synthOsc2Mix.value);
    synthState.osc2Detune = parseFloat(synthOsc2Detune.value);
    synthState.noise = parseFloat(synthNoise.value);
    synthState.glide = parseFloat(synthGlide.value);
    synthState.filterEnv = parseFloat(synthFilterEnv.value);
    synthState.filterAttack = parseFloat(synthFilterAttack.value);
    synthState.filterDecay = parseFloat(synthFilterDecay.value);
    synthState.lfoTarget = synthLfoTarget.value;
    synthState.lfoRate = parseFloat(synthLfoRate.value);
    synthState.lfoAmount = parseFloat(synthLfoAmount.value);
    synthState.drive = parseFloat(synthDrive.value);
    synthState.pan = parseFloat(synthPan.value);
    synthState.chorus = parseFloat(synthChorus.value);
    synthState.delaySend = parseFloat(synthDelaySend.value);
    synthState.reverbSend = parseFloat(synthReverbSend.value);
    synthState.gain = parseFloat(synthGain.value);

    updateSynthValueLabels(synthState);
    window.WAWSynth?.readExtraParams(synthState);

    const activeTrack = getActiveTrack();
    if (activeTrack?.instrument === "synth") {
      activeTrack.synthPatch = { ...synthState };
    }

    if (synthFilter) {
      synthFilter.frequency.value = synthState.cutoff;
      synthFilter.Q.value = synthState.filterQ;
    }
    if (synthMasterGain) {
      synthMasterGain.gain.value = 1;
    }
  }

  function readCustomSynthPresets() {
    try {
      const raw = localStorage.getItem(SYNTH_CUSTOM_PRESETS_KEY);
      const presets = raw ? JSON.parse(raw) : [];
      return Array.isArray(presets) ? presets : [];
    } catch (e) {
      console.warn("Custom synth presets read failed:", e);
      return [];
    }
  }

  function writeCustomSynthPresets(presets) {
    localStorage.setItem(SYNTH_CUSTOM_PRESETS_KEY, JSON.stringify(presets));
  }

  function renderCustomSynthPresets() {
    if (!synthPreset) return;
    synthPreset.querySelectorAll("option[data-custom='true']").forEach(option => option.remove());
    const presets = readCustomSynthPresets();
    presets.forEach(preset => {
      const option = document.createElement("option");
      option.value = `custom:${preset.id}`;
      option.textContent = preset.name;
      option.dataset.custom = "true";
      synthPreset.appendChild(option);
    });
  }

  function getCurrentSynthPatch() {
    updateSynthFromUI();
    return { ...createDefaultSynthPatch(), ...synthState };
  }

  function saveCustomSynthPreset() {
    const name = (prompt("Preset name:", "My Synth") || "").trim();
    if (!name) return;
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "custom";
    const presets = readCustomSynthPresets();
    const existingIndex = presets.findIndex(preset => preset.id === id);
    if (existingIndex >= 0 && !confirm(`Replace custom preset "${presets[existingIndex].name}"?`)) return;
    const item = {
      id,
      name,
      patch: getCurrentSynthPatch()
    };
    if (existingIndex >= 0) presets.splice(existingIndex, 1, item);
    else presets.push(item);
    writeCustomSynthPresets(presets);
    renderCustomSynthPresets();
    synthPreset.value = `custom:${id}`;
    releaseSelectFocus(synthPreset);
    statusEl.textContent = `Saved synth preset "${name}".`;
  }

  function applySynthPreset(id) {
    if (id?.startsWith("custom:")) {
      const presetId = id.slice("custom:".length);
      const preset = readCustomSynthPresets().find(item => item.id === presetId);
      if (preset?.patch) {
        loadSynthPatchToUI(preset.patch);
        updateSynthFromUI();
      }
      return;
    }
    // table-driven presets live in js/synth.js
    const patch = window.WAWSynth.presetPatch(id) || window.WAWSynth.fullPatch({});
    loadSynthPatchToUI(patch);
    updateSynthFromUI();
  }

  function releaseControlFocus(controlEl) {
    controlEl?.classList.remove("focus-visible");
    if (document.activeElement === controlEl) controlEl.blur();
  }

  function releaseSelectFocus(selectEl) {
    releaseControlFocus(selectEl);
  }

  function releaseSynthBodyFocus(e) {
    const control = e.target?.closest?.("#synthControls .synth-body select, #synthControls .synth-body input, #synthControls .synth-body button, #drum808Modal select, #drum808Modal input, #drum808Modal button");
    if (!control) return;
    requestAnimationFrame(() => releaseControlFocus(control));
  }

  function openSynthModal() {
    const track = getActiveTrack();
    if (track?.instrument !== "synth") return;
    loadSynthPatchToUI(track.synthPatch);
    synthModal?.classList.add("visible");
  }

  function closeSynthModal() {
    synthModal?.classList.remove("visible");
  }

  synthModalClose?.addEventListener("click", closeSynthModal);
  synthModal?.addEventListener("click", (e) => {
    if (e.target === synthModal) closeSynthModal();
  });

  synthPreset.addEventListener("change", () => {
    applySynthPreset(synthPreset.value);
    releaseSelectFocus(synthPreset);
  });
  synthSavePresetBtn?.addEventListener("click", saveCustomSynthPreset);
  synthWave.addEventListener("change", () => {
    updateSynthFromUI();
    releaseSelectFocus(synthWave);
  });
  [synthOsc2Wave, synthLfoTarget].forEach(el => {
    el?.addEventListener("change", () => {
      updateSynthFromUI();
      releaseSelectFocus(el);
    });
  });
  [
    synthAttack, synthDecay, synthSustain, synthRelease, synthCutoff,
    synthFilterQ, synthDetune, synthOsc2Mix, synthOsc2Detune, synthNoise,
    synthGlide, synthFilterEnv, synthFilterAttack, synthFilterDecay,
    synthLfoRate, synthLfoAmount, synthDrive, synthPan, synthChorus,
    synthDelaySend, synthReverbSend, synthGain
  ].forEach(el => {
    el?.addEventListener("input", updateSynthFromUI);
  });
  synthControls?.querySelector(".synth-body")?.addEventListener("change", releaseSynthBodyFocus, true);
  synthControls?.querySelector(".synth-body")?.addEventListener("click", releaseSynthBodyFocus, true);
  synthControls?.querySelector(".synth-body")?.addEventListener("pointerup", releaseSynthBodyFocus, true);
  renderCustomSynthPresets();
  renderCustom808Presets();

  // Grid & swing controls
  gridSelect.addEventListener("change", () => {
    gridValue = gridSelect.value; // e.g. "1", "0.5", "0.25", ...
  });
  swingSlider.addEventListener("input", () => {
    swingAmount = parseFloat(swingSlider.value) || 0;
    swingLabel.textContent = Math.round(swingAmount * 100) + "%";
  });  

  // ---------- AUDIO / MIC / RECORDING ----------
  // Drop a broken context (device unplugged, output switched, renderer crash)
  // so the next ensureAudioContext() call builds a fresh one.
  function discardAudioContext(reason) {
    if (!audioCtx) return;
    console.warn("AudioContext lost, will recreate on next use:", reason);
    const dead = audioCtx;
    const micWasOn = !!micStream;
    if (micWasOn) stopMic();
    audioCtx = null;
    synthMasterGain = null;
    synthFilter = null;
    audioUnlocked = false;
    try { if (dead.state !== "closed") dead.close(); } catch (e) {}
    if (statusEl) {
      statusEl.textContent = micWasOn
        ? "Audio device changed or failed. Click Start Mic to reconnect."
        : "Audio device changed or failed. Sound will resume on next play.";
    }
  }

let synthCompressor = null;

function ensureAudioContext() {
  if (audioCtx && audioCtx.state === "closed") discardAudioContext("closed");
  if (!audioCtx) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtx = ctx;
    sampleRate = ctx.sampleRate;
    ctx.addEventListener("error", (e) => {
      if (audioCtx === ctx) discardAudioContext(e.error || e);
    });
    ctx.addEventListener("statechange", () => {
      if (audioCtx === ctx && ctx.state === "closed") discardAudioContext("closed");
    });
  }
  if (audioCtx.state === "suspended" || audioCtx.state === "interrupted") {
    audioCtx.resume().catch(() => {});
  }
  if (!synthMasterGain) {
    synthMasterGain = audioCtx.createGain();
    synthMasterGain.gain.value = 0.85;

    synthCompressor = audioCtx.createDynamicsCompressor();
    synthCompressor.threshold.value = -12;
    synthCompressor.knee.value = 12;
    synthCompressor.ratio.value = 4;
    synthCompressor.attack.value = 0.003;
    synthCompressor.release.value = 0.15;

    synthFilter = audioCtx.createBiquadFilter();
    synthFilter.type = "lowpass";
    synthFilter.frequency.value = synthState.cutoff;
    synthFilter.Q.value = synthState.filterQ;

    synthMasterGain.connect(synthCompressor);
    synthCompressor.connect(audioCtx.destination);
    synthFilter.connect(synthMasterGain);
  }
  return audioCtx;
} 

  async function startMic() {
    try {
      ensureAudioContext();
      sampleRate = audioCtx.sampleRate;

      // use the input chosen in the Audio Input panel (was always the default device)
      let savedDevice = "";
      try { savedDevice = localStorage.getItem("waw.inputDevice") || ""; } catch (e) {}
      micStream = window.WAWAudio?.getInputStream
        ? await window.WAWAudio.getInputStream(savedDevice)
        : await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
            video: false
          });

      const source = audioCtx.createMediaStreamSource(micStream);

      hpFilterNode = audioCtx.createBiquadFilter();
      hpFilterNode.type = "highpass";
      hpFilterNode.frequency.value = parseFloat(hpSlider.value) || 80;

      lpFilterNode = audioCtx.createBiquadFilter();
      lpFilterNode.type = "lowpass";
      lpFilterNode.frequency.value = parseFloat(lpSlider.value) || 4000;

      analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = 2048;
      const bufferLength = analyserNode.frequencyBinCount;
      eqDataArray = new Uint8Array(bufferLength);

      processorNode = audioCtx.createScriptProcessor(bufferSize, 1, 1);
      processorNode.onaudioprocess = onAudioProcess;

      inputMonitorGain = audioCtx.createGain();
      inputMonitorGain.gain.value = 0;

      source.connect(hpFilterNode);
      hpFilterNode.connect(lpFilterNode);
      lpFilterNode.connect(processorNode);
      lpFilterNode.connect(analyserNode);
      lpFilterNode.connect(inputMonitorGain);
      inputMonitorGain.connect(audioCtx.destination);

      processorNode.connect(audioCtx.destination);

      startEqLoop();

      statusEl.textContent = "Mic ready. Hit Record and hum/sing, or play MIDI.";
      startMicBtn.textContent = "🎙 Stop Mic";
    } catch (err) {
      console.error(err);
      statusEl.textContent = "Error accessing microphone: " + err.message;
    }
  }

  function stopMic() {
    try {
      if (processorNode) {
        processorNode.disconnect();
        processorNode.onaudioprocess = null;
        processorNode = null;
      }
      if (hpFilterNode) { hpFilterNode.disconnect(); hpFilterNode = null; }
      if (lpFilterNode) { lpFilterNode.disconnect(); lpFilterNode = null; }
      if (analyserNode) { analyserNode.disconnect(); analyserNode = null; }
      if (inputMonitorGain) { inputMonitorGain.disconnect(); inputMonitorGain = null; }

      if (micStream) {
        micStream.getTracks().forEach(t => t.stop());
        micStream = null;
      }
    } catch (e) {
      console.warn("Error stopping mic:", e);
    }

    statusEl.textContent = "Mic disabled. You can still record MIDI.";
    startMicBtn.textContent = "🎙 Start Mic";
  }

  function startEqLoop() {
    if (!analyserNode) return;
    function drawEq() {
      if (!analyserNode || !eqCtx) return;
      analyserNode.getByteFrequencyData(eqDataArray);

      eqCtx.clearRect(0, 0, eqWidth, eqHeight);
      eqCtx.fillStyle = "#05060a";
      eqCtx.fillRect(0, 0, eqWidth, eqHeight);

      const bufferLength = eqDataArray.length;
      if (!bufferLength) {
        requestAnimationFrame(drawEq);
        return;
      }

      const barWidth = (eqWidth / bufferLength) * 1.8;
      let x = 0;
      for (let i = 0; i < bufferLength && x < eqWidth; i++) {
        const v = eqDataArray[i] / 255;
        const barHeight = v * eqHeight;
        eqCtx.fillStyle = "#22c55e";
        eqCtx.fillRect(x, eqHeight - barHeight, barWidth, barHeight);
        x += barWidth + 1;
      }
      requestAnimationFrame(drawEq);
    }
    drawEq();
  }

  function updateTuner(smoothedF0) {
    if (!smoothedF0) {
      drawTuner(null, 0, null);
      return;
    }
    const mFloat = hzToMidi(smoothedF0);
    const nearest = Math.round(mFloat);
    const nearestFreq = midiToHz(nearest);
    const cents = 1200 * Math.log2(smoothedF0 / nearestFreq);
    drawTuner(midiToNoteName(nearest), cents, smoothedF0);
  }

  function onAudioProcess(event) {
    const input = event.inputBuffer.getChannelData(0);

    const f0 = detectPitch(input, sampleRate);
    if (f0) {
      lastPitches.push(f0);
      if (lastPitches.length > pitchSmoothingFrames) lastPitches.shift();
    } else {
      lastPitches.push(null);
      if (lastPitches.length > pitchSmoothingFrames) lastPitches.shift();
    }

    let smoothedF0 = null;
    const valid = lastPitches.filter(v => v !== null);
    if (valid.length > 0) {
      smoothedF0 = valid.reduce((a, b) => a + b, 0) / valid.length;
    }

    updateTuner(smoothedF0);

    let newNote = null;
        if (smoothedF0) {
      const rawMidiFloat = hzToMidi(smoothedF0);
      newNote = decideStableNote(rawMidiFloat);
    }

    if (isRecording && audioCtx) {
      const now = audioCtx.currentTime;
      let t = now - recordingStartTime;       // elapsed since record start
      let songSec = recordingBaseSec + t;

      if (recordingLoopLen > 0) {
        songSec = recordingBaseSec + (t % recordingLoopLen);
      }

      processNoteState(newNote, songSec);
    }
  }

  function startRecording() {
  ensureAudioContext();
  if (!audioCtx) {
    statusEl.textContent = "Audio context not available.";
    return;
  }
  if (isRecording) return;

  // Always halt active playback before precount/recording so clocks stay 100% locked
  const wasPlaying = isPlaying;
  if (isPlaying) {
    stopPlayback();
  }

  const bpm = parseFloat(bpmInput.value) || 120;
  lastMetroBeatIndex = null;

  if (metronomeEnabled && metronomePreBars > 0) {
    const secPerBeat = 60 / bpm;
    const beatsTotal = metronomePreBars * 4;
    const totalPreSec = beatsTotal * secPerBeat;

    statusEl.textContent =
      `Precount (${metronomePreBars} bar${metronomePreBars > 1 ? "s" : ""})...`;

    const originalRecText = startRecBtn ? startRecBtn.textContent : "⏺ Record";
    if (startRecBtn) startRecBtn.disabled = true;

    const preStart = audioCtx.currentTime;
    let lastBeatsLeft = null;

    function precountLoop() {
      const now = audioCtx.currentTime;
      const elapsed = now - preStart;

      metronomeTickIfNeeded(elapsed, bpm, true);

      const beatsLeft = Math.max(
        0,
        Math.ceil((totalPreSec - elapsed) / secPerBeat)
      );

      if (startRecBtn && beatsLeft !== lastBeatsLeft) {
        startRecBtn.textContent = `⏳ ${beatsLeft}`;
        lastBeatsLeft = beatsLeft;
      }

      if (elapsed < totalPreSec) {
        requestAnimationFrame(precountLoop);
      } else {
        lastMetroBeatIndex = null;
        if (startRecBtn) startRecBtn.textContent = originalRecText;
        startRecordingCore(wasPlaying);
      }
    }
    precountLoop();
  } else {
    startRecordingCore(wasPlaying);
  }
}

 function startRecordingCore(wasPlaying = false) {
  if (isRecording) return;

  ensureTracks();
  const activeTrack = getActiveTrack();
  const trackType = activeTrack?.type || "midi"; // "midi" | "audio"

  // Snapshot BEFORE the take (overwrite + live clip modify state right away),
  // so a single undo removes the whole recording.
  pushHistory();

  isRecording = true;
  currentNote = null;
  midiActiveNotes.clear();
  recordingStartTime = audioCtx.currentTime;

  const hasLoop = (loopEndSec > loopStartSec + 0.05);
  const hasActiveLoop = loopEnabled && hasLoop;

  if (hasActiveLoop) {
    recordingBaseSec = loopStartSec;
    recordingLoopLen = loopEndSec - loopStartSec;
  } else {
    recordingBaseSec =
      (playheadWasManuallySet && Number.isFinite(lastPlayheadSec))
        ? Math.max(0, lastPlayheadSec)
        : 0;
    recordingLoopLen = 0;
  }

  if (hasActiveLoop && overwriteEnabled) {
    setActiveTrackNotes(
      notes.filter(n => n.endSec <= loopStartSec || n.startSec >= loopEndSec)
    );
  }

  // Track recording span & target track for automatic clip creation
  clipRecordTrackIndex = activeTrackIndex;
  clipRecordStartSec = recordingBaseSec;
  clipRecordStartNoteCount = activeTrack?.notes?.length || 0;

  liveRecordingClip = null;
  liveRecordingClipEl = null;

  if (trackType === "midi" && activeTrack && !(currentView === "editor" && activeClipId != null)) {
    const newClip = new Clip({
      startSec: clipRecordStartSec,
      endSec: clipRecordStartSec + 0.1,
      notesSnapshot: []
    });
    newClip.name = `Clip ${(activeTrack.clips?.length || 0) + 1}`;
    newClip.isRecordingLive = true;

    activeTrack.clips = activeTrack.clips || [];
    activeTrack.clips.push(newClip);
    liveRecordingClip = newClip;

    setSelectedClip(activeTrackIndex, newClip.id);
    renderSequencer();
    liveRecordingClipEl = document.querySelector(`.seq-clip[data-clip-id="${newClip.id}"]`);
  }

  // Audio tracks: capture the input on the armed audio track(s) (or the active audio track)
  const audioTargets = window.WAWAudio?.recordTargets() || [];
  if (audioTargets.length) {
    window.WAWAudio.beginTrackRecording({ recordingStartTime, recordingBaseSec, recordingLoopLen });
  }

  // Background playback while recording: always play the existing arrangement so
  // the performer hears what they record against (standard DAW behaviour).
  void wasPlaying;
  {
    isBackgroundPlayback = true;
    isPlaying = true;
    playheadWasManuallySet = false;
    startPlaybackCycle(getAllNotesMixdown(), recordingBaseSec, false);
  }

  lastMetroBeatIndex = null;
  recordAnimId = requestAnimationFrame(animateRecordingTransport);

  statusEl.textContent = trackType === "audio"
    ? "Recording audio..."
    : "Recording MIDI... play your MIDI keyboard or hum/sing.";
  if (startRecBtn) startRecBtn.disabled = true;
  if (stopBtn) stopBtn.disabled = false;

  selectedNotes.clear();
  lastSelectedNoteIndex = -1;

  updateTimeView();
  drawPianoRoll(lastPlayheadSec);
  drawVelocityLane();
  if (loopBarCanvas) drawAllLoopBars(lastPlayheadSec);
}

function updateLiveRecordingClip(songPos) {
  if (!liveRecordingClip) return;

  const targetTrack = tracks[clipRecordTrackIndex];
  if (!targetTrack) return;

  // Grow clip right edge with the playhead
  liveRecordingClip.endSec = Math.max(liveRecordingClip.startSec + 0.1, songPos);
  const clipLen = liveRecordingClip.endSec - liveRecordingClip.startSec;

  // Completed notes from this take
  const completed = (targetTrack.notes || [])
    .slice(clipRecordStartNoteCount)
    .filter(n => n.endSec > liveRecordingClip.startSec)
    .map(n => ({
      ...n,
      startSec: Math.max(0, n.startSec - liveRecordingClip.startSec),
      endSec: Math.min(clipLen, n.endSec - liveRecordingClip.startSec)
    }));

  // Notes currently held down on MIDI keyboard
  const heldMidi = [];
  midiActiveNotes.forEach((info, midiNote) => {
    if (info.trackIndex !== clipRecordTrackIndex) return;
    const end = Math.max(songPos, info.startSec + 0.05);
    heldMidi.push({
      midiNote,
      velocity: info.velocity || 100,
      startSec: Math.max(0, info.startSec - liveRecordingClip.startSec),
      endSec: Math.min(clipLen, end - liveRecordingClip.startSec)
    });
  });

  // Note currently sung via mic
  if (currentNote !== null && clipRecordTrackIndex === activeTrackIndex) {
    const end = Math.max(songPos, currentNoteStart + 0.05);
    heldMidi.push({
      midiNote: currentNote,
      velocity: 100,
      startSec: Math.max(0, currentNoteStart - liveRecordingClip.startSec),
      endSec: Math.min(clipLen, end - liveRecordingClip.startSec)
    });
  }

  liveRecordingClip.notesSnapshot = [...completed, ...heldMidi].filter(
    n => n.endSec > n.startSec
  );

  // Fast DOM update (width + thumbnail only, no full grid rebuild)
  if (!liveRecordingClipEl || !liveRecordingClipEl.isConnected) {
    liveRecordingClipEl = document.querySelector(
      `.seq-clip[data-clip-id="${liveRecordingClip.id}"]`
    );
  }
  if (liveRecordingClipEl) {
    const pxPerSec = getSeqPxPerSec();
    liveRecordingClipEl.style.width = Math.max(8, clipLen * pxPerSec) + "px";
    const thumb = liveRecordingClipEl.querySelector(".clip-thumb");
    if (thumb) drawClipPreview(thumb, liveRecordingClip);
  }
}

function stopRecording() {
  if (!isRecording) return;

  isRecording = false;
  if (recordAnimId) {
    cancelAnimationFrame(recordAnimId);
    recordAnimId = null;
  }

  if (startRecBtn) startRecBtn.disabled = false;
  if (stopBtn) stopBtn.disabled = true;

  if (!audioCtx) return;

  const now = audioCtx.currentTime;
  const tElapsed = now - recordingStartTime;

  // Convert elapsed to song position (respects loop if active)
  const songEndSec = recordingLoopLen > 0
    ? recordingBaseSec + (tElapsed % recordingLoopLen)
    : recordingBaseSec + tElapsed;

  // Flush last mic-note
  if (currentNote !== null) {
    const degObj = getScaleDegreeInfo(currentNote, tonicSemitone, scalePattern);
    notes.push(new NoteEvent(
      currentNoteStart,
      songEndSec,
      currentNote,
      100,
      degObj.degree,
      degObj.octave
    ));
    currentNote = null;
  }

  // Flush any held MIDI notes
  if (midiActiveNotes.size) {
    midiActiveNotes.forEach((info, midiNote) => {
      const end = Math.max(songEndSec, info.startSec + 0.05);
      const degObj = getScaleDegreeInfo(midiNote, tonicSemitone, scalePattern);
      const targetTrack = tracks[info.trackIndex] || getActiveTrack();
      const targetNotes = targetTrack?.notes || notes;
      targetNotes.push(new NoteEvent(
        info.startSec,
        end,
        midiNote,
        info.velocity || 100,
        degObj.degree,
        degObj.octave
      ));
      if (targetTrack === tracks[activeTrackIndex]) notes = targetNotes;
    });
    midiActiveNotes.clear();
  }

  mergeAdjacentNotesInPlace(notes);  

  const trackIndex = Math.min(Math.max(0, clipRecordTrackIndex), tracks.length - 1);
  const targetTrack = tracks[trackIndex];
  const trackType = targetTrack?.type || "midi";

if (trackType === "midi" && targetTrack) {
    if (currentView === "editor" && activeClipId != null) {
      saveEditorNotesToActiveClip();
      renderSequencer();
    } else if (liveRecordingClip) {
      const recordedNotes = (targetTrack.notes || [])
        .slice(clipRecordStartNoteCount)
        .filter(n => n.endSec > clipRecordStartSec);

      if (recordedNotes.length === 0) {
        // Nothing was played — remove the empty live clip
        targetTrack.clips = (targetTrack.clips || []).filter(c => c.id !== liveRecordingClip.id);
        setSelectedClip(null, null);
      } else {
        const clipStart = liveRecordingClip.startSec;
        const rawEnd = Math.max(clipStart + 0.25, ...recordedNotes.map(n => n.endSec));
        const bpmVal = parseFloat(bpmInput?.value) || timelineBpm || 120;
        const secPerBar = (60 / bpmVal) * 4;
        const clipEnd = Math.max(
          clipStart + secPerBar,
          Math.ceil((rawEnd - clipStart) / secPerBar) * secPerBar + clipStart
        );
        const clipLen = Math.max(0.0001, clipEnd - clipStart);

        liveRecordingClip.endSec = clipEnd;
        liveRecordingClip.isRecordingLive = false;
        liveRecordingClip.notesSnapshot = recordedNotes
          .map(n => ({
            ...n,
            startSec: Math.max(0, n.startSec - clipStart),
            endSec: Math.min(clipLen, n.endSec - clipStart)
          }))
          .filter(n => n.endSec > n.startSec);

        setSelectedClip(trackIndex, liveRecordingClip.id);
      }
      liveRecordingClip = null;
      liveRecordingClipEl = null;
      renderSequencer();
    }
  }

  const hadLoopAlready = loopEndSec > loopStartSec + 0.05;
  const isOverdubTake = hadLoopAlready && (recordingLoopLen > 0);

  // Auto-set loop only on FIRST take / non-overdub
  if (!isOverdubTake) {
    const totalDur = Math.max(getBaseDuration(), songEndSec);
    const bpm = parseFloat(bpmInput.value) || timelineBpm || 120;
    const snappedEnd = snapEndToCommonBars(totalDur, bpm, 4);

    loopStartSec = 0;
    loopEndSec   = snappedEnd > 0 ? snappedEnd : totalDur;
  }

  statusEl.textContent = `Recording stopped. Captured ${notes.length} note(s).`;

  selectedNotes.clear();
  lastSelectedNoteIndex = -1;

  fitViewToNotes(notes);
  updateTimeView();
  drawPianoRoll(lastPlayheadSec);
  drawVelocityLane();
  if (loopBarCanvas) drawAllLoopBars(lastPlayheadSec);

  if (window.WAWAudio?.isRecordingAudio()) {
    window.WAWAudio.endTrackRecording().catch(err => {
      console.error(err);
      statusEl.textContent = "Audio take could not be saved: " + err.message;
    });
  }

  if (isBackgroundPlayback) {
    isBackgroundPlayback = false;
    stopPlayback();
  }

  recordingLoopLen = 0;
  recordingBaseSec = 0;
}

  function getScaleDegreeInfo(midiNote, tonic, pattern) {
    const semitone = (midiNote - tonic + 120) % 12;
    let degreeIndex = pattern.indexOf(semitone);
    if (degreeIndex < 0) degreeIndex = 0;
    const octave = Math.floor((midiNote - tonic) / 12);
    return { degree: degreeIndex, octave };
  }

    function metronomeTickIfNeeded(songSec, bpm, isPrecount = false) {
    if (!metronomeEnabled) return;
    const secPerBeat = 60 / bpm;
    if (secPerBeat <= 0) return;

    if (!isPrecount && window.WAWTempo) {
      const p = window.WAWTempo.position(Math.max(0, songSec) + 1e-6);
      const key = p.bar * 100 + p.beat;
      if (key === lastMetroBeatIndex) return;
      lastMetroBeatIndex = key;
      playMetronomeTick(p.beat === 1, isPrecount);
      return;
    }
    const beatIndex = Math.floor(songSec / secPerBeat + 1e-6);
    if (beatIndex === lastMetroBeatIndex) return;
    lastMetroBeatIndex = beatIndex;

    const isAccent = (beatIndex % 4 === 0);
    playMetronomeTick(isAccent, isPrecount);
  }

  function playMetronomeTick(isAccent, isPrecount) {
    const ctx = ensureAudioContext();
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const g = ctx.createGain();

    let baseFreq = 1000;
    let accentFreq = 1500;
    let type = "sine";

    switch (metronomeSound) {
      case "click":
        baseFreq = 3000;
        accentFreq = 3800;
        type = "square";
        break;
      case "wood":
        baseFreq = 800;
        accentFreq = 1000;
        type = "square";
        break;
      case "beep":
      default:
        baseFreq = 1000;
        accentFreq = 1500;
        type = "sine";
        break;
    }

    osc.type = type;
    osc.frequency.value = isAccent ? accentFreq : baseFreq;

    const dur = 0.07;
    const amp = metronomeVolume * (isAccent ? 1.0 : 0.8);

    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(amp, now + 0.005);
    g.gain.linearRampToValueAtTime(0, now + dur);

    osc.connect(g);
    g.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + dur + 0.02);
  }


  // ---------- PITCH + SCALE LOGIC ----------
  function detectPitch(buffer, sampleRate) {
    const size = buffer.length;
    let sumSquares = 0;
    for (let i = 0; i < size; i++) {
      const v = buffer[i];
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / size);
    currentInputLevel = 0.9 * currentInputLevel + 0.1 * Math.min(rms * 10, 1);

    if (calibratingNoise) {
      noiseCalibRmsSum += rms;
      noiseCalibCount++;
      return null;
    }

    if (!isRecording) {
      noiseFloorRms = 0.98 * noiseFloorRms + 0.02 * rms;
    }

    if (gateSensitivity > 0) {
      const gateThreshold = Math.max(noiseFloorRms * gateSensitivity, 0.005);
      if (rms < gateThreshold) {
        return null;
      }
    }

    const maxPitch = 400;
    const minPitch = 50;
    const maxLag = Math.floor(sampleRate / minPitch);
    const minLag = Math.floor(sampleRate / maxPitch);

    let bestLag = -1;
    let bestCorr = 0;

    for (let lag = minLag; lag <= maxLag; lag++) {
      let corr = 0;
      for (let i = 0; i < size - lag; i++) {
        corr += buffer[i] * buffer[i + lag];
      }
      if (corr > bestCorr) {
        bestCorr = corr;
        bestLag = lag;
      }
    }

    if (bestLag <= 0) return null;

    const norm = bestCorr / sumSquares;
    if (!isFinite(norm) || norm < 0.01) {
      return null;
    }

    const freq = sampleRate / bestLag;
    if (freq < minPitch || freq > maxPitch) return null;
    return freq;
  }

  function hzToMidi(f) {
    return 69 + 12 * Math.log2(f / 440);
  }

  function quantizeMidiToScale(rawMidi, tonic, pattern) {
    const rounded = Math.round(rawMidi);
    const degree = (rounded - tonic + 120) % 12;

    let bestOffset = pattern[0];
    let bestDist = 999;
    for (const p of pattern) {
      const dist = Math.min(Math.abs(p - degree), 12 - Math.abs(p - degree));
      if (dist < bestDist) {
        bestDist = dist;
        bestOffset = p;
      }
    }
    const base = rounded - degree;
    return base + bestOffset;
  }

  function processNoteState(newNote, t) {
    // If we're overdubbing and time wrapped while holding a note, split it
    if (recordingLoopLen > 0 && currentNote !== null && t < currentNoteStart) {
      const degObj = getScaleDegreeInfo(currentNote, tonicSemitone, scalePattern);
      notes.push(new NoteEvent(
        currentNoteStart,
        loopEndSec,
        currentNote,
        100,
        degObj.degree,
        degObj.octave
      ));
      currentNoteStart = loopStartSec; // continue note in new loop cycle
    }

    const noteChanged = newNote !== currentNote;

    if (currentNote === null && newNote !== null) {
      currentNote = newNote;
      currentNoteStart = t;
      return;
    }

    if (currentNote !== null && noteChanged) {
      const dur = t - currentNoteStart;

      if (newNote !== null &&
          dur < MIN_NOTE_DURATION &&
          Math.abs(newNote - currentNote) <= JITTER_SEMITONES) {
        return;
      }

      if (dur >= MIN_NOTE_DURATION) {
        const degObj = getScaleDegreeInfo(currentNote, tonicSemitone, scalePattern);
        notes.push(new NoteEvent(
          currentNoteStart,
          t,
          currentNote,
          100,
          degObj.degree,
          degObj.octave
        ));
      }

      if (newNote !== null) {
        currentNote = newNote;
        currentNoteStart = t;
      } else {
        currentNote = null;
      }

      updateTimeView();
      drawPianoRoll();
      drawVelocityLane();
    }
  }

  function mergeAdjacentNotesInPlace(noteArray) {
    if (!noteArray.length) return;

    noteArray.sort((a, b) => a.startSec - b.startSec);

    const merged = [];
    let current = noteArray[0];

    for (let i = 1; i < noteArray.length; i++) {
      const n = noteArray[i];
      if (n.midiNote === current.midiNote) {
        const gap = n.startSec - current.endSec;
        if (gap >= 0 && gap <= MERGE_GAP_SECONDS) {
          current.endSec = Math.max(current.endSec, n.endSec);
          continue;
        }
      }
      merged.push(current);
      current = n;
    }
    merged.push(current);

    noteArray.length = 0;
    merged.forEach(n => noteArray.push(n));
  }

  // ---------- EDIT MODE BUTTONS ----------
  //let currentEditMode = localStorage.getItem("editMode") || "select";
  function setEditMode(mode) {
    currentEditMode = mode;
    localStorage.setItem("editMode", mode);
    updateEditModeButtons();
    drawPianoRoll(lastPlayheadSec);
    drawVelocityLane();
  }

  function updateEditModeButtons() {
    if (!selectModeBtn || !drawModeBtn) return;
    selectModeBtn.classList.toggle("active", currentEditMode === "select");
    drawModeBtn.classList.toggle("active", currentEditMode === "draw");
  }

  if (selectModeBtn) {
    selectModeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setEditMode("select");
    });
  }

  if (drawModeBtn) {
    drawModeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setEditMode("draw");
    });
  }

  // initial UI state
  updateEditModeButtons();

    // ---------- CANVAS RESIZE ----------
    function resizeCanvases() {
      const dpr = window.devicePixelRatio || 1;

      function sizeCanvas(c, ctx) {
        if (!c || !ctx) return;           // ✅ guard null
        const w = c.clientWidth;
        const h = c.clientHeight;
        if (w < 2 || h < 2) return;       // ✅ hidden guard
        c.width  = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }

      sizeCanvas(circleCanvas, circleCtx);
      if (loopBarCanvas && loopCtx) sizeCanvas(loopBarCanvas, loopCtx);
      loopWidth  = loopBarCanvas?.clientWidth  || 0;
      loopHeight = loopBarCanvas?.clientHeight || 0;
      if (seqLoopBarCanvas && seqLoopCtx) sizeCanvas(seqLoopBarCanvas, seqLoopCtx);
      seqLoopWidth  = seqLoopBarCanvas?.clientWidth  || 0;
      seqLoopHeight = seqLoopBarCanvas?.clientHeight || 0;
      sizeCanvas(pianoRollCanvas, prCtx);
      sizeCanvas(velocityCanvas, velCtx);
      sizeCanvas(tunerCanvas, tunerCtx);
      sizeCanvas(eqCanvas, eqCtx);

      prWidth = pianoRollCanvas?.clientWidth || 0;
      prHeight = pianoRollCanvas?.clientHeight || 0;
      velWidth = velocityCanvas?.clientWidth || 0;
      velHeight = velocityCanvas?.clientHeight || 0;
      tunerWidth = tunerCanvas?.clientWidth || 0;
      tunerHeight = tunerCanvas?.clientHeight || 0;
      eqWidth = eqCanvas?.clientWidth || 0;
      eqHeight = eqCanvas?.clientHeight || 0;
    }

  // ---------- CIRCLE OF FIFTHS ----------
  function drawCircleOfFifths() {
    const canvas = document.getElementById("circleCanvas"); 
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    // Use CSS pixels: resizeCanvases() already applies a devicePixelRatio
    // transform, so using canvas.width here drew the circle 2x too large
    // (and clipped) on HiDPI screens.
    const w = canvas.clientWidth  || 0;
    const h = canvas.clientHeight || 0;
    if (w < 30 || h < 30) return;

    const padding = 20;
    const base = Math.min(w, h) / 2;
    const radius = Math.max(10, base - padding);

    const cx = w / 2;
    const cy = h / 2;

    ctx.clearRect(0, 0, w, h);

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    const innerR = Math.max(5, radius * 0.65);
    const outerR = Math.max(innerR + 1, radius);

    ctx.save();
    ctx.translate(cx, cy);

    ctx.beginPath();
    ctx.arc(0, 0, outerR, 0, Math.PI * 2);
    ctx.fillStyle = "#050716";
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#202640";
    ctx.stroke();

    const tonicLabel = tonicName;

    for (let i = 0; i < FIFTHS_ORDER.length; i++) {
      const angle = (Math.PI * 2 * i) / 12 - Math.PI / 2;
      const nextAngle = (Math.PI * 2 * (i + 1)) / 12 - Math.PI / 2;
      const midAngle = (angle + nextAngle) / 2;

      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, outerR, angle, nextAngle);
      ctx.closePath();
      const key = FIFTHS_ORDER[i];
      ctx.fillStyle = (key === tonicLabel) ? "#2563eb" : "#101424";
      ctx.fill();
      ctx.strokeStyle = "#202640";
      ctx.stroke();

      const labelR = (innerR + outerR) / 2;
      const lx = Math.cos(midAngle) * labelR;
      const ly = Math.sin(midAngle) * labelR + 3;

      ctx.fillStyle = key === tonicLabel ? "#ffffff" : "#c7cbe7";
      ctx.font = key === tonicLabel ? "bold 14px system-ui" : "12px system-ui";
      ctx.textAlign = "center";
      ctx.fillText(key, lx, ly);
    }

    ctx.beginPath();
    ctx.arc(0, 0, innerR, 0, Math.PI * 2);
    ctx.fillStyle = "#05060e";
    ctx.fill();

    ctx.restore();
  }

  function attachCircleEvents() {
  if (!circleCanvas) return; // guard

  circleCanvas.addEventListener("click", (e) => {
    const rect = circleCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const dx = x - cx;
    const dy = y - cy;
    const r = Math.sqrt(dx * dx + dy * dy);
    const maxR = Math.min(rect.width, rect.height) / 2;
    const innerR = maxR * 0.4;

    if (r < innerR || r > maxR) return;

    let angle = Math.atan2(dy, dx);
    angle += Math.PI / 2;
    if (angle < 0) angle += Math.PI * 2;

    const sectorSize = (Math.PI * 2) / 12;
    let sector = Math.floor(angle / sectorSize);
    sector = Math.max(0, Math.min(11, sector));

    tonicName = FIFTHS_ORDER[sector];
    updateScaleSettings();
    drawCircleOfFifths();
  });
}

  // ---------- TUNER DRAWING ----------
  function drawTuner(noteName, cents, freqHz) {
    const ctx = tunerCtx;
    const w = tunerWidth;
    const h = tunerHeight;
    if (!ctx || !w || !h) return;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#05060a";
    ctx.fillRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h * 1.05;
    const radius = h * 1.1;

    const minCents = -50;
    const maxCents = 50;
    const startAngle = Math.PI;
    const endAngle = 2 * Math.PI;

    ctx.beginPath();
    ctx.arc(cx, cy, radius, startAngle, endAngle);
    ctx.strokeStyle = "#1f2937";
    ctx.lineWidth = 6;
    ctx.stroke();

    for (let c = minCents; c <= maxCents; c += 10) {
      const t = (c - minCents) / (maxCents - minCents);
      const angle = startAngle + t * (endAngle - startAngle);
      const major = (c % 50 === 0);
      const tickLen = major ? 18 : 10;

      const xOuter = cx + Math.cos(angle) * radius;
      const yOuter = cy + Math.sin(angle) * radius;
      const xInner = cx + Math.cos(angle) * (radius - tickLen);
      const yInner = cy + Math.sin(angle) * (radius - tickLen);

      ctx.beginPath();
      ctx.moveTo(xInner, yInner);
      ctx.lineTo(xOuter, yOuter);
      ctx.strokeStyle = major ? "#9ca3c7" : "#4b5563";
      ctx.lineWidth = major ? 2 : 1;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, 2 * Math.PI);
    ctx.fillStyle = "#e5e7eb";
    ctx.fill();

    const displayNote = noteName || "--";
    const displayFreq = freqHz ? `${freqHz.toFixed(1)} Hz` : "-- Hz";

    // Highlight "in tune" region (±5 cents)
    const inTuneMin = -5;
    const inTuneMax = 5;
    const tMin = (inTuneMin - minCents) / (maxCents - minCents);
    const tMax = (inTuneMax - minCents) / (maxCents - minCents);
    const aMin = startAngle + tMin * (endAngle - startAngle);
    const aMax = startAngle + tMax * (endAngle - startAngle);

    ctx.beginPath();
    ctx.arc(cx, cy, radius - 6, aMin, aMax);
    ctx.lineWidth = 6;
    ctx.strokeStyle = "#22c55e";
    ctx.stroke();


    ctx.fillStyle = "#e5e7eb";
    ctx.font = "20px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(displayNote, cx, h * 0.45);

    ctx.fillStyle = "#9ca3c7";
    ctx.font = "12px system-ui";
    ctx.fillText(displayFreq, cx, h * 0.65);
  }

  // ---------- PIANO ROLL DRAWING & INTERACTION ---------- 
  function drawPianoRoll(playheadSec = null) {
    // remember playhead ONLY if a real value is given
    if (playheadSec != null) {
      lastPlayheadSec = playheadSec;
    }
    const ctx = prCtx;
    const w = prWidth;
    const h = prHeight;

    if (!ctx || w < 2 || h < 2) return; // guard

    ctx.clearRect(0, 0, w, h);

    const keyLabelWidth = KEY_LABEL_WIDTH;
    const gridX0 = keyLabelWidth;
    const gridWidth = w - keyLabelWidth;

    if (viewDuration <= 0) viewDuration = 4;
    pixelsPerSec = gridWidth / viewDuration;
    const noteCount = (viewMaxNote - viewMinNote + 1) || 1;
    pixelsPerNote = h / noteCount;

    ctx.fillStyle = "#05060a";
    ctx.fillRect(0, 0, w, h);

    const usedNotes = new Set();
    for (const n of notes) {
      if (n.midiNote >= viewMinNote && n.midiNote <= viewMaxNote && n.endSec > n.startSec) {
        usedNotes.add(n.midiNote);
      }
    }

    for (let midi = viewMinNote; midi <= viewMaxNote; midi++) {
      const isBlack = [1, 3, 6, 8, 10].includes(midi % 12);
      const y = h - (midi - viewMinNote + 1) * pixelsPerNote;
      const semitone = (midi - tonicSemitone + 120) % 12;
      const inScale = scalePattern.includes(semitone);
      const isUsed = usedNotes.has(midi);
      const isActiveMidi = activeMidiKeys.has(midi);

      // Left piano key
      if (isBlack) {
        ctx.fillStyle = isActiveMidi ? "#374151" : (isUsed ? "#2a2d36" : "#1a1c24");
        ctx.fillRect(0, y, keyLabelWidth, pixelsPerNote);
        if (isUsed || isActiveMidi) {
          ctx.fillStyle = "#ffffff";
          ctx.font = "10px system-ui";
          ctx.textAlign = "right";
          ctx.textBaseline = "middle";
          ctx.fillText(midiToNoteName(midi), keyLabelWidth - 4, y + pixelsPerNote / 2);
        }
      } else {
        ctx.fillStyle = isActiveMidi ? "#fefce8" : (isUsed ? "#f3f5ff" : "#e5e7f0");
        ctx.fillRect(0, y, keyLabelWidth, pixelsPerNote);
        if (isUsed || isActiveMidi) {
          ctx.fillStyle = "#111827";
          ctx.font = "10px system-ui";
          ctx.textAlign = "right";
          ctx.textBaseline = "middle";
          ctx.fillText(midiToNoteName(midi), keyLabelWidth - 4, y + pixelsPerNote / 2);
        }
      }

      ctx.fillStyle = inScale ? "#0b1020" : "#070812";
      ctx.fillRect(gridX0, y, gridWidth, pixelsPerNote);
    }

    // Beat grid (tempo map aware)
    const bpm = parseFloat(bpmInput.value) || 120;
    const secPerBeat = 60 / bpm;
    const viewEndSec = viewStartSec + viewDuration;
    window.WAWTempo.gridLines(viewStartSec, viewEndSec, pixelsPerSec, 6).forEach(l => {
      if (l.kind === "sub") return;
      const x = gridX0 + (l.sec - viewStartSec) * pixelsPerSec;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.strokeStyle = l.kind === "bar" ? "#27304c" : "#171c30";
      ctx.lineWidth = l.kind === "bar" ? 1.2 : 0.7;
      ctx.stroke();
    });

    ctx.strokeStyle = "#111425";
    ctx.lineWidth = 0.7;
    for (let midi = viewMinNote; midi <= viewMaxNote; midi++) {
      const y = h - (midi - viewMinNote + 1) * pixelsPerNote;
      ctx.beginPath();
      ctx.moveTo(gridX0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // --- Preview note in draw mode ---    
    if (currentEditMode === "draw" && drawPreview) {
      const n = drawPreview;

      const noteStartInView = Math.max(n.startSec, viewStartSec);
      const noteEndInView   = Math.min(n.endSec, viewStartSec + viewDuration);
      if (noteEndInView > noteStartInView &&
          n.midiNote >= viewMinNote && n.midiNote <= viewMaxNote) {

        const x1 = gridX0 + (noteStartInView - viewStartSec) * pixelsPerSec;
        const x2 = gridX0 + (noteEndInView   - viewStartSec) * pixelsPerSec;
        const y1 = h - (n.midiNote - viewMinNote + 1) * pixelsPerNote;

        ctx.save();
        ctx.fillStyle   = "rgba(96,165,250,0.25)";
        ctx.strokeStyle = "rgba(96,165,250,0.8)";
        ctx.lineWidth = 1;
        ctx.fillRect(x1, y1, x2 - x1, pixelsPerNote);
        ctx.strokeRect(x1, y1, x2 - x1, pixelsPerNote);
        ctx.restore();
      }
    }

    // Notes
    notes.forEach((n, idx) => {
      if (n.endSec <= n.startSec) return;

      const noteStartInView = Math.max(n.startSec, viewStartSec);
      const noteEndInView = Math.min(n.endSec, viewStartSec + viewDuration);
      if (noteEndInView <= noteStartInView) return;

      const x = gridX0 + (noteStartInView - viewStartSec) * pixelsPerSec;
      const width = Math.max((noteEndInView - noteStartInView) * pixelsPerSec, 3);
      if (n.midiNote < viewMinNote || n.midiNote > viewMaxNote) return;
      const y = h - (n.midiNote - viewMinNote + 1) * pixelsPerNote;

      const velNorm = Math.min(Math.max(n.velocity / 127, 0), 1.0);
      const isSelected = selectedNotes.has(idx);

      // Higher velocity => darker note
      // Lightness range: low vel ~82%, high vel ~45%
      const lightness = isSelected
        ? 55
        : (82 - velNorm * 37);

      ctx.fillStyle = `hsl(215, 90%, ${lightness}%)`;

      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(x + 0.5, y + 2, width - 1, pixelsPerNote - 4, 4);
      } else {
        ctx.rect(x + 0.5, y + 2, width - 1, pixelsPerNote - 4);
      }
      ctx.fill();

      ctx.strokeStyle = isSelected ? "#ffffff" : "#0c0f1e";
      ctx.lineWidth = isSelected ? 1.5 : 1;
      ctx.stroke();

      ctx.fillStyle = "#0f1122";
      ctx.fillRect(x + width - 4, y + 4, 3, pixelsPerNote - 8);
    });

    // Selection rectangle overlay
    if (selectionState.active && !selectionState.isClick) {
      const x1 = selectionState.startX;
      const y1 = selectionState.startY;
      const x2 = selectionState.currentX;
      const y2 = selectionState.currentY;
      const left = Math.min(x1, x2);
      const top = Math.min(y1, y2);
      const width = Math.abs(x2 - x1);
      const height = Math.abs(y2 - y1);
      ctx.save();
      ctx.strokeStyle = "#60a5fa";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(left, top, width, height);
      ctx.fillStyle = "rgba(96,165,250,0.15)";
      ctx.fillRect(left, top, width, height);
      ctx.restore();
    }

    if (playheadSec !== null) {
      if (playheadSec >= viewStartSec && playheadSec <= viewStartSec + viewDuration) {
        const pos = gridX0 + (playheadSec - viewStartSec) * pixelsPerSec;
        ctx.beginPath();
        ctx.moveTo(pos, 0);
        ctx.lineTo(pos, h);
        ctx.strokeStyle = "#f97316";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
    drawAllLoopBars(playheadSec);
  }
  // End drawPianoRoll

  // Draw loop bar to given context
  function drawLoopBarTo(
  ctx, w, h,
  playheadSec = null,
  loopObj,                 // {enabled, start, end}
  viewStart, viewDuration, // which time window to display
  leftGutterPx = 0         // KEY_LABEL_WIDTH for editor, track label width for sequencer
) {
  if (!ctx || !w || !h) return;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#05060a";
  ctx.fillRect(0, 0, w, h);

  const gridX0 = leftGutterPx;
  const gridWidth = Math.max(10, w - leftGutterPx);

  // left gutter background (editor only)
  if (leftGutterPx > 0) {
    ctx.fillStyle = "#0b0e18";
    ctx.fillRect(0, 0, leftGutterPx, h);
  }

  const viewEndSec = viewStart + viewDuration;
  const rulerPxPerSec = gridWidth / viewDuration;

  // beat / bar lines from the tempo map (tempo + meter changes)
  window.WAWTempo.gridLines(viewStart, viewEndSec, rulerPxPerSec, 7).forEach(l => {
    if (l.kind === "sub") return;
    const x = gridX0 + (l.sec - viewStart) * rulerPxPerSec;
    const isBar = l.kind === "bar";
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.strokeStyle = isBar ? "#27304c" : "#171c30";
    ctx.lineWidth   = isBar ? 1.2 : 0.7;
    ctx.stroke();
    if (isBar && (l.bar - 1) % Math.max(1, l.labelEvery * (rulerPxPerSec * (window.WAWTempo.barToSec(l.bar + 1) - l.sec) < 22 ? 2 : 1)) === 0) {
      ctx.fillStyle = "#7780aa";
      ctx.font = "9px system-ui";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(l.bar, x + 2, 2);
    }
  });

  // loop region
  if (loopObj?.enabled && loopObj.end > loopObj.start) {
    const x1 = gridX0 + (loopObj.start - viewStart) * (gridWidth / viewDuration);
    const x2 = gridX0 + (loopObj.end   - viewStart) * (gridWidth / viewDuration);
    const lx1 = Math.max(gridX0, Math.min(x1, x2));
    const lx2 = Math.min(gridX0 + gridWidth, Math.max(x1, x2));

    if (lx2 > lx1) {
      ctx.save();
      ctx.fillStyle = "rgba(96,165,250,0.20)";
      ctx.fillRect(lx1, 0, lx2 - lx1, h);

      ctx.strokeStyle = "#60a5fa";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(lx1, 0); ctx.lineTo(lx1, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(lx2, 0); ctx.lineTo(lx2, h); ctx.stroke();
      ctx.restore();
    }
  }

  // playhead
  if (playheadSec != null) {
    const px = gridX0 + (playheadSec - viewStart) * (gridWidth / viewDuration);
    if (px >= gridX0 && px <= gridX0 + gridWidth) {
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.strokeStyle = "#f97316";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

 // End drawLoopBarTo


// Get the active loop for the given view

function getActiveLoopForView(viewName) {
  if (viewName === "editor") {
    return {
      enabled: clipLoopEnabled,
      start: clipLoopStartSec,
      end: clipLoopEndSec
    };
  }
  // sequencer/mixer
  return {
    enabled: loopEnabled,
    start: loopStartSec,
    end: loopEndSec
  };
} 

// Draw loop bar for both views 

function drawAllLoopBars(playheadSec = null) {
  // editor bar uses local clip loop + KEY_LABEL_WIDTH
  const editorLoop = getActiveLoopForView("editor");
  drawLoopBarTo(
    loopCtx, loopWidth, loopHeight,
    playheadSec,
    editorLoop,
    viewStartSec, viewDuration,
    KEY_LABEL_WIDTH
  );

  // sequencer bar uses the same left gutter as the track labels,
  // so bar 1 starts exactly where clips start.
  drawSequencerRuler(playheadSec);
}

// Set playhead position (in seconds)
function setPlayhead(sec) {
  // called without an argument at startup: Math.max(0, undefined) made the
  // playhead NaN, so every recording without a loop was placed at NaN
  if (!Number.isFinite(sec)) {
    lastPlayheadSec = Number.isFinite(lastPlayheadSec) ? lastPlayheadSec : 0;
    playheadWasManuallySet = false;
  } else {
    lastPlayheadSec = Math.max(0, sec);
    playheadWasManuallySet = true;
  }

  // redraw views safely
  drawSequencerRuler(lastPlayheadSec);
  drawPianoRoll(lastPlayheadSec);
  drawVelocityLane();
  drawAllLoopBars(lastPlayheadSec);

  // if sequencer playhead element exists, move it
  if (seqPlayheadEl) {
    const pxPerSec = getSeqPxPerSec();
    const x = getSeqLabelWidth() + (lastPlayheadSec * pxPerSec) - (sequencerGrid?.scrollLeft || 0);
    seqPlayheadEl.style.left = x + "px";
  }
}

function makeLoopInteractor(canvas, getView) {
  if (!canvas) return;

  let down = false;
  let dragMode = null;   // "new" | "resizeStart" | "resizeEnd"
  let anchorSec = 0;
  let downSec = 0;
  let downX = 0;
  let dragged = false;

  const THRESH_PX = 4;

  function timeFromX(x) {
    const rect = canvas.getBoundingClientRect();
    const view = getView();
    const leftGutterPx = view.leftGutterPx || 0;
    const gridWidth = Math.max(10, rect.width - leftGutterPx);
    const clampedX = Math.min(Math.max(x, leftGutterPx), leftGutterPx + gridWidth);
    const tNorm = (clampedX - leftGutterPx) / gridWidth;
    return view.startSec + tNorm * view.durationSec;
  }

  function nearestEdge(sec, view) {
    if (!loopEnabled || loopEndSec <= loopStartSec) return null;
    const usableWidth = Math.max(10, canvas.clientWidth - (view.leftGutterPx || 0));
    const eps = (view.durationSec / usableWidth) * 6; // ~6px
    if (Math.abs(sec - loopStartSec) <= eps) return "start";
    if (Math.abs(sec - loopEndSec)   <= eps) return "end";
    return null;
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const view = getView();
    const sec = timeFromX(x);

    down = true;
    dragged = false;
    dragMode = null;
    downSec = sec;
    downX = x;

    const edge = nearestEdge(sec, view);
    if (edge === "start") { dragMode = "resizeStart"; anchorSec = loopEndSec; }
    else if (edge === "end") { dragMode = "resizeEnd"; anchorSec = loopStartSec; }
    else { dragMode = "new"; anchorSec = sec; }

    // single click sets playhead (tentatively)
    setPlayhead(sec);
    drawAllLoopBars(lastPlayheadSec);
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!down) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const sec = timeFromX(x);

    // Threshold is measured from the press position. It used to compare the
    // per-event movementX, so slow drags (a few px per event) never created a loop.
    if (!dragged && dragMode === "new" && Math.abs(x - downX) < THRESH_PX) return;
    if (!dragged) beginHistoryGesture();
    dragged = true;

    loopEnabled = true;
    loopBtn?.classList.toggle("active", true);

    if (dragMode === "new") {
      // allow left OR right drag
      loopStartSec = Math.min(anchorSec, sec);
      loopEndSec   = Math.max(anchorSec, sec);
    } else if (dragMode === "resizeStart") {
      loopStartSec = Math.min(sec, anchorSec - 0.1);
    } else if (dragMode === "resizeEnd") {
      loopEndSec = Math.max(sec, anchorSec + 0.1);
    }

    // snap loop edges (never let them collapse onto each other)
    loopStartSec = Math.max(0, snapSec(loopStartSec));
    loopEndSec   = snapSec(loopEndSec);
    if (loopEndSec <= loopStartSec) {
      const bpm = parseFloat(bpmInput?.value) || 120;
      loopEndSec = loopStartSec + getGridSeconds(60 / bpm);
    }

    // Cheap redraw only; the full lane rebuild happens once on release.
    drawAllLoopBars(lastPlayheadSec);
  });

  function endLoopPointer() {
    if (!down) return;
    down = false;
    if (dragged) {
      commitHistoryGesture();
      renderSequencer();
    } else if (isPlaying) {
      // plain click while playing: jump playback to the clicked position
      restartPlaybackFromCurrentPosition();
    }
    dragged = false;
  }

  canvas.addEventListener("pointerup", endLoopPointer);
  canvas.addEventListener("pointercancel", endLoopPointer);
}

makeLoopInteractor(loopBarCanvas, () => ({
  startSec: viewStartSec,
  durationSec: viewDuration,
  leftGutterPx: KEY_LABEL_WIDTH
}));

makeLoopInteractor(seqLoopBarCanvas, () => ({
  startSec: seqViewStartSec,
  durationSec: seqViewDuration,
  leftGutterPx: getSeqLabelWidth()
}));


  // Mouse interactions for piano roll
  let isMouseDown = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragLastX = 0;
  let selectingRect = null;
  let drawingCandidate = false; 
  const DRAG_THRESHOLD = 4;  

  function attachPianoRollMouseEvents() {
    if (!pianoRollCanvas) return;  // safeguard

    pianoRollCanvas.addEventListener("mousedown", (e) => {
      if (e.button === 2) return;

      const rect = pianoRollCanvas.getBoundingClientRect();
      const x = (e.clientX - rect.left);
      const y = (e.clientY - rect.top);

      isMouseDown = true;
      dragStartX = dragLastX = x;
      dragStartY = y;
      selectingRect = null;
      drawingCandidate = false; 

      const keyLabelWidth = KEY_LABEL_WIDTH;
      const hitIndex = hitTestNote(x, y);

      // DRAW MODE
      if (currentEditMode === "draw") {
        if (hitIndex !== -1) {
          selectedNotes.clear();
          selectedNotes.add(hitIndex);
          lastSelectedNoteIndex = hitIndex;
          beginDrag(hitIndex, x, y);
        } else if (x >= keyLabelWidth) {
          drawingCandidate = true;
        }

        drawPianoRoll(lastPlayheadSec);
        drawVelocityLane();
        return;
      }

      // SELECT MODE
      if (hitIndex !== -1) {
        if (e.ctrlKey || e.metaKey || e.shiftKey) {
          if (selectedNotes.has(hitIndex)) selectedNotes.delete(hitIndex);
          else selectedNotes.add(hitIndex);
        } else {
          if (!selectedNotes.has(hitIndex)) {
            selectedNotes.clear();
            selectedNotes.add(hitIndex);
          }
        }

        lastSelectedNoteIndex = hitIndex;
        beginDrag(hitIndex, x, y);

        drawPianoRoll(lastPlayheadSec);
        drawVelocityLane();
        return;
      }

      // empty: marquee
      selectedNotes.clear();
      lastSelectedNoteIndex = -1;
      selectingRect = { xStart: x, yStart: y, xEnd: x, yEnd: y };
      selectionState.active = true;
      selectionState.isClick = true;
      selectionState.startX = x;
      selectionState.startY = y;
      selectionState.currentX = x;
      selectionState.currentY = y;
    });

    pianoRollCanvas.addEventListener("mousemove", (e) => {
      const rect = pianoRollCanvas.getBoundingClientRect();
      const x = (e.clientX - rect.left);
      const y = (e.clientY - rect.top);

      // DRAW MODE
      if (currentEditMode === "draw") {
        if (dragState.active) {
          handleNoteDragMove(x, y);
          return;
        }
        if (!isMouseDown) {
          updateDrawPreview(x, y);
        }
        return;
      }

      if (!isMouseDown) return;

      const dx = x - dragStartX;
      const dy = y - dragStartY;
      dragLastX = x;

      if (dragState.active && !selectingRect) {
        handleNoteDragMove(x, y);
        return;
      }

      if (!selectingRect) {
        const moved = Math.hypot(dx, dy);
        if (moved > DRAG_THRESHOLD) {
          selectingRect = {
            xStart: dragStartX,
            yStart: dragStartY,
            xEnd: x,
            yEnd: y
          };
        } else {
          return;
        }
      } else {
        selectingRect.xEnd = x;
        selectingRect.yEnd = y;
      }

      updateSelectionFromRect(selectingRect);

      selectionState.active = true;
      selectionState.isClick = false;
      selectionState.startX = selectingRect.xStart;
      selectionState.startY = selectingRect.yStart;
      selectionState.currentX = selectingRect.xEnd;
      selectionState.currentY = selectingRect.yEnd;

      drawPianoRoll(lastPlayheadSec);
      drawVelocityLane();
    });

    pianoRollCanvas.addEventListener("mouseup", () => {
      if (dragState.active) {
        if (dragState.moved) commitHistoryGesture();
        else cancelHistoryGesture();
      }

      if (currentEditMode === "draw" && drawingCandidate && !dragState.active) {
        createNoteAtClick(dragStartX, dragStartY);
      }

      isMouseDown = false;
      drawingCandidate = false;
      selectingRect = null;

      dragState.active = false;
      dragState.mode = null;
      dragState.noteIndex = -1;
      dragState.indices = [];
      dragState.originalsByIndex = {};

      selectionState.active = false;
      selectionState.isClick = true;

      drawPianoRoll(lastPlayheadSec);
      drawVelocityLane();
    });

    pianoRollCanvas.addEventListener("mouseleave", () => {
      // Edits made during the drag stay applied, so keep them undoable
      if (dragState.active) {
        if (dragState.moved) commitHistoryGesture();
        else cancelHistoryGesture();
      }
      isMouseDown = false;
      drawingCandidate = false;
      selectingRect = null;
      drawPreview = null;

      dragState.active = false;
      dragState.mode = null;
      dragState.noteIndex = -1;
      dragState.indices = [];
      dragState.originalsByIndex = {};

      selectionState.active = false;
      selectionState.isClick = true;

      drawPianoRoll(lastPlayheadSec);
      drawVelocityLane();
    });
  }

// ---------- Piano Roll Interaction Helpers ----------

  function dragSelectedNotes(dx, dy) {
    if (!selectedNotes.size) return;

    const keyLabelWidth = KEY_LABEL_WIDTH;
    const gridWidth = prWidth - keyLabelWidth;
    if (gridWidth <= 0) return;

    const noteCount = (viewMaxNote - viewMinNote + 1) || 1;
    const localPixelsPerSec = gridWidth / viewDuration;
    const localPixelsPerNote = prHeight / noteCount;

    const dSec = dx / localPixelsPerSec;
    const dMidi = -dy / localPixelsPerNote;

    selectedNotes.forEach(idx => {
      const n = notes[idx];
      if (!n) return;

      const dur = n.endSec - n.startSec;
      let newStart = n.startSec + dSec;
      let newEnd   = n.endSec + dSec;

      // Keep notes on or after 0
      if (newStart < 0) {
        newStart = 0;
        newEnd   = dur;
      }

      n.startSec = newStart;
      n.endSec   = newEnd;

      // Vertical pitch move
      let midiRaw = n.midiNote + dMidi;
      midiRaw = Math.round(
        Math.min(Math.max(midiRaw, GLOBAL_MIN_NOTE), GLOBAL_MAX_NOTE)
      );

      const midiQuant = quantizeMidiToScale(midiRaw, tonicSemitone, scalePattern);
      const degObj = getScaleDegreeInfo(midiQuant, tonicSemitone, scalePattern);

      n.midiNote    = midiQuant;
      n.scaleDegree = degObj.degree;
      n.octave      = degObj.octave;
    });

    updateTimeView();
  }

  function updateSelectionFromRect(rect) {
    if (!rect) return;

    const x1 = rect.xStart;
    const y1 = rect.yStart;
    const x2 = rect.xEnd;
    const y2 = rect.yEnd;

    const left   = Math.min(x1, x2);
    const right  = Math.max(x1, x2);
    const top    = Math.min(y1, y2);
    const bottom = Math.max(y1, y2);

    const keyLabelWidth = KEY_LABEL_WIDTH;
    const gridX0 = keyLabelWidth;
    const gridWidth = prWidth - keyLabelWidth;
    const noteCount = (viewMaxNote - viewMinNote + 1) || 1;
    const localPixelsPerSec = gridWidth / viewDuration;
    const localPixelsPerNote = prHeight / noteCount;

    selectedNotes.clear();

    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (n.endSec <= n.startSec) continue;
      if (n.midiNote < viewMinNote || n.midiNote > viewMaxNote) continue;

      const noteStartInView = Math.max(n.startSec, viewStartSec);
      const noteEndInView   = Math.min(n.endSec, viewStartSec + viewDuration);
      if (noteEndInView <= noteStartInView) continue;

      const xN1 = gridX0 + (noteStartInView - viewStartSec) * localPixelsPerSec;
      const xN2 = gridX0 + (noteEndInView - viewStartSec) * localPixelsPerSec;
      const yN1 = prHeight - (n.midiNote - viewMinNote + 1) * localPixelsPerNote;
      const yN2 = yN1 + localPixelsPerNote;

      if (xN2 >= left && xN1 <= right && yN2 >= top && yN1 <= bottom) {
        selectedNotes.add(i);
        lastSelectedNoteIndex = i;
      }
    }
  }

  const dragState = {
    active: false,
    mode: null, // "move" | "resizeStart" | "resizeEnd"
    noteIndex: -1,
    indices: [],
    startX: 0,
    startY: 0,
    originalsByIndex: {}
  };

  function beginDrag(hitIndex, x, y) {
    const keyLabelWidth = KEY_LABEL_WIDTH;
    const gridX0 = keyLabelWidth;
    const gridWidth = prWidth - keyLabelWidth;
    const noteCount = (viewMaxNote - viewMinNote + 1) || 1;
    const localPxPerSec = gridWidth / viewDuration;

    const note = notes[hitIndex];
    if (!note) return;

    beginHistoryGesture();
    dragState.active = true;
    dragState.moved = false;
    dragState.noteIndex = hitIndex;
    dragState.indices = selectedNotes.size ? Array.from(selectedNotes) : [hitIndex];
    dragState.startX = x;
    dragState.startY = y;
    dragState.originalsByIndex = {};
    dragState.indices.forEach(i => {
      dragState.originalsByIndex[i] = { ...notes[i] };
    });

    dragState.mode = edgeHitTest(note, x, gridX0, localPxPerSec, 7);
  }


  function edgeHitTest(note, xPix, gridX0, pxPerSec, thresholdPx=6) {
    const x1 = gridX0 + (note.startSec - viewStartSec) * pxPerSec;
    const x2 = gridX0 + (note.endSec   - viewStartSec) * pxPerSec;
    if (Math.abs(xPix - x1) <= thresholdPx) return "resizeStart";
    if (Math.abs(xPix - x2) <= thresholdPx) return "resizeEnd";
    return "move";
  }

  function handleNoteDragMove(x, y) {
    const keyLabelWidth = KEY_LABEL_WIDTH;
    const gridWidth = prWidth - keyLabelWidth;
    const noteCount = (viewMaxNote - viewMinNote + 1) || 1;
    const localPixelsPerSec = gridWidth / viewDuration;
    const localPixelsPerNote = prHeight / noteCount;

    const dx = x - dragState.startX;
    const dy = y - dragState.startY;
    const dSec = dx / localPixelsPerSec;
    const dNotes = -dy / localPixelsPerNote;
    if (dx !== 0 || dy !== 0) dragState.moved = true;

    const indices = dragState.indices && dragState.indices.length
      ? dragState.indices
      : [dragState.noteIndex];

    if (dragState.mode === "move") {
      indices.forEach(i => {
        const orig = dragState.originalsByIndex[i];
        if (!orig) return;
        const n = notes[i];
        let newStart = orig.startSec + dSec;
        let newEnd = orig.endSec + dSec;
        const dur = newEnd - newStart;
        if (dur < 0.05) newEnd = newStart + 0.05;
        if (newStart < 0) {
          newEnd -= newStart;
          newStart = 0;
        }
        n.startSec = newStart;
        n.endSec = newEnd;

        // vertical move / pitch
        let newMidiRaw = Math.round(orig.midiNote + dNotes);
        newMidiRaw = Math.min(Math.max(newMidiRaw, GLOBAL_MIN_NOTE), GLOBAL_MAX_NOTE);
        const newMidi = quantizeMidiToScale(newMidiRaw, tonicSemitone, scalePattern);
        const degObj = getScaleDegreeInfo(newMidi, tonicSemitone, scalePattern);
        n.midiNote = newMidi;
        n.scaleDegree = degObj.degree;
        n.octave = degObj.octave;
      });

    } else if (dragState.mode === "resizeEnd") {
      indices.forEach(i => {
        const orig = dragState.originalsByIndex[i];
        if (!orig) return;
        const n = notes[i];
        let newEnd = orig.endSec + dSec;
        if (newEnd <= orig.startSec + 0.05) newEnd = orig.startSec + 0.05;
        n.endSec = newEnd;
      });

    } else if (dragState.mode === "resizeStart") {
      indices.forEach(i => {
        const orig = dragState.originalsByIndex[i];
        if (!orig) return;
        const n = notes[i];
        let newStart = orig.startSec + dSec;
        newStart = Math.max(newStart, 0);
        if (orig.endSec - newStart < 0.05) {
          newStart = orig.endSec - 0.05;
        }
        n.startSec = newStart;
      });
    }

    updateTimeView();
    drawPianoRoll();
    drawVelocityLane();
  }

  function deleteSelectedNotes() {
    if (!selectedNotes.size) return;
    pushHistory();
    if (!selectedNotes.size) return;
    const keep = [];
    notes.forEach((n, idx) => {
      if (!selectedNotes.has(idx)) keep.push(n);
    });
    setActiveTrackNotes(keep);
    selectedNotes.clear();
    lastSelectedNoteIndex = -1;
    drawPianoRoll();
    drawVelocityLane();
  }

  function copySelectedNotes() {
    if (!selectedNotes.size) return;

    const indices = Array.from(selectedNotes).sort((a,b)=>a-b);
    const sel = indices.map(i => notes[i]).filter(Boolean);
    if (!sel.length) return;

    const minStart = Math.min(...sel.map(n => n.startSec));
    const maxEnd   = Math.max(...sel.map(n => n.endSec));

    clipboardSpanSec = Math.max(0.05, maxEnd - minStart);

    clipboardNotes = sel.map(n => {
      const c = cloneNote(n);
      c.startSec -= minStart;
      c.endSec   -= minStart;
      return c;
    });

    statusEl.textContent = `Copied ${clipboardNotes.length} note(s).`;
  }

  function pasteClipboard(atSec = null) {
    if (!clipboardNotes.length) return;

    const bpm = parseFloat(bpmInput.value) || timelineBpm || 120;
    const secPerBeat = 60 / bpm;
    const gridSec = getGridSeconds(secPerBeat);

    let targetStart = (atSec != null && isFinite(atSec))
      ? atSec
      : (lastPlayheadSec != null ? lastPlayheadSec : viewStartSec);

    targetStart = quantizeTime(targetStart, gridSec, swingAmount, true);

    pushHistory();
    const created = [];

    clipboardNotes.forEach(rel => {
      const n = cloneNote(rel);

      n.startSec += targetStart;
      n.endSec   += targetStart;

      // re-quantize pitch to scale (important!)
      const midiQ = quantizeMidiToScale(n.midiNote, tonicSemitone, scalePattern);
      const degObj = getScaleDegreeInfo(midiQ, tonicSemitone, scalePattern);

      n.midiNote    = midiQ;
      n.scaleDegree = degObj.degree;
      n.octave      = degObj.octave;

      notes.push(n);
      created.push(notes.length - 1);
    });

    selectedNotes.clear();
    created.forEach(i => selectedNotes.add(i));
    lastSelectedNoteIndex = created[0] ?? -1;

    updateTimeView();
    drawPianoRoll(lastPlayheadSec);
    drawVelocityLane();

    statusEl.textContent = `Pasted ${created.length} note(s).`;
  }

  function duplicateSelectedNotes() {
  if (!selectedNotes.size) return;

  const indices = Array.from(selectedNotes).sort((a,b)=>a-b);
  const sel = indices.map(i => notes[i]).filter(Boolean);
  if (!sel.length) return;

  // copy into clipboard
  copySelectedNotes();

  // paste right after maxEnd
  const maxEnd = Math.max(...sel.map(n => n.endSec));
  pasteClipboard(maxEnd);
  } 

  function showContextMenu(xScreen, yScreen, target) {
    if (!contextMenuEl) return;

    // show only when selection exists
    const selOnly = ["quantizeSel", "humanizeSel", "copySel", "duplicateSel", "deleteSel"];
    selOnly.forEach(id => {
      const btn = contextMenuEl.querySelector(`button[data-action="${id}"]`);
      if (btn) btn.style.display = (target === "selection") ? "block" : "none";
    });

    const clipOnly = [
      "clipQuantize",
      "clipHumanize",
      "clipCopy",
      "clipCut",
      "clipPaste",
      "clipDuplicate",
      "clipRename",
      "clipOpen",
      "clipSetLoop",
      "clipClear",
      "clipSplit",
      "clipMute",
      "deleteClip"
    ];
    // audio-clip actions (warp, audio quantize, take lanes, comp)
    const ctxClip = target === "clip" && seqContextTarget ? tracks[seqContextTarget.trackIndex]?.clips?.find(c => c.id === seqContextTarget.clipId) : null;
    const audioOnly = { audioWarp: !!ctxClip?.audio, audioQuantize: !!ctxClip?.audio, clipTakes: !!ctxClip?.takes?.length, clipFlatten: !!ctxClip?.takes?.length };
    Object.entries(audioOnly).forEach(([id, show]) => {
      const btn = contextMenuEl.querySelector(`button[data-action="${id}"]`);
      if (!btn) return;
      btn.style.display = show ? "block" : "none";
      if (id === "audioWarp") btn.textContent = ctxClip?.audio?.warp?.on ? `Warp: on (${ctxClip.audio.warp.srcBpm} BPM source) — turn off` : "Warp to song tempo…";
      if (id === "clipTakes") btn.textContent = ctxClip?.showTakes ? "Hide take lanes" : `Show take lanes (${ctxClip?.takes?.length || 0})`;
    });
    // MIDI-only clip actions make no sense on audio clips
    ["clipQuantize", "clipHumanize", "clipClear"].forEach(id => {
      const btn = contextMenuEl.querySelector(`button[data-action="${id}"]`);
      if (btn && ctxClip?.audio) btn.style.display = "none";
    });
    clipOnly.forEach(id => {
      const btn = contextMenuEl.querySelector(`button[data-action="${id}"]`);
      if (!btn) return;
      const canPasteClip = id !== "clipPaste" || Boolean(clipClipboard);
      btn.style.display = (target === "clip" && canPasteClip) ? "block" : "none";
    });

    // always show paste, quantizeAll, humanizeAll on note editor grids
    const always = ["paste", "quantizeAll", "humanizeAll"];
    always.forEach(id => {
      const btn = contextMenuEl.querySelector(`button[data-action="${id}"]`);
      if (btn) btn.style.display = (target === "clip") ? "none" : "block";
    });

    contextMenuEl.style.left = xScreen + "px";
    contextMenuEl.style.top  = yScreen + "px";
    contextMenuEl.style.display = "block";
  }

  function hideContextMenu() {
    if (contextMenuEl) contextMenuEl.style.display = "none";
  }

  function attachContextMenuEvents() {
    if (pianoRollCanvas) {
      pianoRollCanvas.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        seqContextTarget = null;
        const rect = pianoRollCanvas.getBoundingClientRect();
        const x = (e.clientX - rect.left);
        const y = (e.clientY - rect.top);
        const hitIndex = hitTestNote(x, y);

        if (hitIndex !== -1) {
          if (!selectedNotes.has(hitIndex)) {
            selectedNotes.clear();
            selectedNotes.add(hitIndex);
            lastSelectedNoteIndex = hitIndex;
            drawPianoRoll();
            drawVelocityLane();
          }
          showContextMenu(e.clientX, e.clientY, "selection");
        } else {
          showContextMenu(e.clientX, e.clientY, "grid");
        }
      });
    }

    if (velocityCanvas) {
      velocityCanvas.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        seqContextTarget = null;
        showContextMenu(
          e.clientX,
          e.clientY,
          selectedNotes.size ? "selection" : "grid"
        );
      });
    }
  }


  // hide on any left click elsewhere
  document.addEventListener("click", () => hideContextMenu());

  function hitTestNote(x, y) {
    const keyLabelWidth = KEY_LABEL_WIDTH;
    const gridX0 = keyLabelWidth;

    const noteCount = (viewMaxNote - viewMinNote + 1) || 1;
    const gridWidth = prWidth - keyLabelWidth;
    const localPixelsPerSec = gridWidth / viewDuration;
    const localPixelsPerNote = prHeight / noteCount;

    if (x < gridX0) return -1;

    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      if (n.endSec <= n.startSec) continue;

      const noteStartInView = Math.max(n.startSec, viewStartSec);
      const noteEndInView = Math.min(n.endSec, viewStartSec + viewDuration);
      if (noteEndInView <= noteStartInView) continue;

      const x1 = gridX0 + (noteStartInView - viewStartSec) * localPixelsPerSec;
      const x2 = gridX0 + (noteEndInView - viewStartSec) * localPixelsPerSec;
      if (n.midiNote < viewMinNote || n.midiNote > viewMaxNote) continue;
      const y1 = prHeight - (n.midiNote - viewMinNote + 1) * localPixelsPerNote;
      const y2 = y1 + localPixelsPerNote;

      if (x >= x1 && x <= x2 && y >= y1 && y <= y2) return i;
    }
    return -1;
  }

  function createNoteAtClick(x, y) {
    const keyLabelWidth = KEY_LABEL_WIDTH;
    const gridX0 = keyLabelWidth;
    const gridWidth = prWidth - keyLabelWidth;

    if (x < gridX0 || gridWidth <= 0) return;
    pushHistory();

    const bpm = parseFloat(bpmInput.value) || 120;
    const secPerBeat = 60 / bpm;
    const gridSec = getGridSeconds(secPerBeat);

    const tRaw = viewStartSec + ((x - gridX0) / gridWidth) * viewDuration;
    const tStart = quantizeTime(tRaw, gridSec, swingAmount, true);

    const noteCount = (viewMaxNote - viewMinNote + 1) || 1;
    const relY = prHeight - y;
    let steps = Math.floor(relY / pixelsPerNote);
    let midiRaw = viewMinNote + steps;
    midiRaw = Math.min(Math.max(midiRaw, GLOBAL_MIN_NOTE), GLOBAL_MAX_NOTE);
    const midiQuant = quantizeMidiToScale(midiRaw, tonicSemitone, scalePattern);
    const rootDeg = getScaleDegreeInfo(midiQuant, tonicSemitone, scalePattern);

    const createdIndices = [];

    // Base note
    const baseNote = new NoteEvent(
      tStart,
      tStart + gridSec,
      midiQuant,
      100,
      rootDeg.degree,
      rootDeg.octave
    );
    notes.push(baseNote);
    createdIndices.push(notes.length - 1);

    // If a chord preset is active, add chord tones above the root
    if (currentChordPreset && currentChordPreset.intervals && currentChordPreset.intervals.length > 1) {
      for (let i = 1; i < currentChordPreset.intervals.length; i++) {
        const stepOffset = currentChordPreset.intervals[i];
        const scaleLen = scalePattern.length;
        const targetDeg = (rootDeg.degree + stepOffset) % scaleLen;
        const octaveOffset = Math.floor((rootDeg.degree + stepOffset) / scaleLen);
        const semitoneOffset = scalePattern[targetDeg] - scalePattern[rootDeg.degree] + 12 * octaveOffset;
        const chordMidi = midiQuant + semitoneOffset;
        const chordDeg = getScaleDegreeInfo(chordMidi, tonicSemitone, scalePattern);

        const chordNote = new NoteEvent(
          tStart,
          tStart + gridSec,
          chordMidi,
          95,
          chordDeg.degree,
          chordDeg.octave
        );
        notes.push(chordNote);
        createdIndices.push(notes.length - 1);
      }
    }

    // chord voicing (inversion / per-tone octave) from the Key & Scale panel
    if (createdIndices.length > 1) window.WAWWorkspace?.applyVoicing(createdIndices.map(i => notes[i]));

    selectedNotes.clear();
    createdIndices.forEach(i => selectedNotes.add(i));
    lastSelectedNoteIndex = createdIndices[0];

    updateTimeView();
    drawPianoRoll();
    drawVelocityLane();
  }

  function updateDrawPreview(x, y) {
    const keyLabelWidth = KEY_LABEL_WIDTH;
    const gridX0 = keyLabelWidth;
    const gridWidth = prWidth - keyLabelWidth;
    if (x < gridX0 || gridWidth <= 0) {
      if (drawPreview) {
        drawPreview = null;
        drawPianoRoll(lastPlayheadSec);
      }
      return;
    }

    const bpm = parseFloat(bpmInput.value) || 120;
    const secPerBeat = 60 / bpm;
    const gridSec = getGridSeconds(secPerBeat);

    const tRaw = viewStartSec + ((x - gridX0) / gridWidth) * viewDuration;
    const tStart = quantizeTime(tRaw, gridSec, swingAmount, true);

    const relY = prHeight - y;
    let steps = Math.floor(relY / pixelsPerNote);
    let midiRaw = viewMinNote + steps;
    midiRaw = Math.min(Math.max(midiRaw, GLOBAL_MIN_NOTE), GLOBAL_MAX_NOTE);
    const midiQuant = quantizeMidiToScale(midiRaw, tonicSemitone, scalePattern);

    drawPreview = {
      startSec: tStart,
      endSec: tStart + gridSec,
      midiNote: midiQuant
    };

    drawPianoRoll(lastPlayheadSec);
  }

  function applySelectionRectangle() {
    if (!selectionState.active || selectionState.isClick) return;
    updateSelectionFromRect({
      xStart: selectionState.startX,
      yStart: selectionState.startY,
      xEnd: selectionState.currentX,
      yEnd: selectionState.currentY
    });
  }

  // Spacebar: play / stop / stop recording
    window.addEventListener("keydown", (e) => {
    if (e.code !== "Space") return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || e.target.isContentEditable) return;

    e.preventDefault();

    if (isRecordingClip) stopClipRecording();  // <-- important
    else if (isRecording) stopRecording();
    else if (isPlaying) stopPlayback();
    else playNotes(getAllNotesMixdown());
  });

  // Delete / Backspace: delete selected notes or the selected sequencer clip
  window.addEventListener("keydown", (e) => {
    if (e.code !== "Delete" && e.code !== "Backspace") return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || e.target.isContentEditable) return;

    e.preventDefault();
    if (currentView === "sequencer" && deleteSelectedClip()) return;
    deleteSelectedNotes();
  });

 window.addEventListener("DOMContentLoaded", () => {
  ensureTracks();
  initCanvases();

  attachPianoRollEvents();
  attachPianoRollMouseEvents();
  attachVelocityEvents();
  attachCircleEvents();
  attachContextMenuEvents();

  setView("sequencer", { silent: true });

  renderSidebarTracks();
  attachSequencerInteractions();

  renderSequencer();       // builds lanes + sets seqLoopBarCanvas CSS width
  resizeCanvases();        // now picks up the long width correctly
  updateSeqViewFromScroll(); // sync seqViewStart/duration from scroll + width
  drawSequencerRuler(lastPlayheadSec);

  ensureSeqPlayhead();
  setPlayhead();

  // optional but nice:
  renderMixer();

  updateScaleSettings();
  updateTimeView();
  drawCircleOfFifths();

  drawPianoRoll();
  drawVelocityLane();

  drawTuner(null, 0, null);
  loadSynthPatchToUI(getActiveTrack()?.synthPatch || synthState);
  initMIDI();
});


  // ---------- VELOCITY LANE ----------
  function drawVelocityLane() {
    const ctx = velCtx;
    const w = velWidth;
    const h = velHeight;

    if (!ctx || w < 2 || h < 2) return; // safeguard

    ctx.clearRect(0, 0, w, h);

    const keyLabelWidth = KEY_LABEL_WIDTH;
    const gridX0 = keyLabelWidth;
    const gridWidth = w - keyLabelWidth;

    ctx.fillStyle = "#05060a";
    ctx.fillRect(0, 0, w, h);

    if (viewDuration <= 0) viewDuration = 4;
    const localPixelsPerSec = gridWidth / viewDuration;
    const viewEndSec = viewStartSec + viewDuration;

    // Left strip background under piano
    ctx.fillStyle = "#0b0e18";
    ctx.fillRect(0, 0, keyLabelWidth, h);

    window.WAWTempo.gridLines(viewStartSec, viewEndSec, localPixelsPerSec, 6).forEach(l => {
      if (l.kind === "sub") return;
      const x = gridX0 + (l.sec - viewStartSec) * localPixelsPerSec;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.strokeStyle = l.kind === "bar" ? "#27304c" : "#171c30";
      ctx.lineWidth = l.kind === "bar" ? 1.2 : 0.7;
      ctx.stroke();
    });

    ctx.beginPath();
    ctx.moveTo(0, h - 2);
    ctx.lineTo(w, h - 2);
    ctx.strokeStyle = "#1c2235";
    ctx.lineWidth = 1;
    ctx.stroke();

    // --- Draw velocity bars in layers: unselected first, selected last ---
    const normalIdx = [];
    const selectedIdx = [];
    for (let i = 0; i < notes.length; i++) {
      (selectedNotes.has(i) ? selectedIdx : normalIdx).push(i);
    }

    function drawVelBar(idx) {
      const n = notes[idx];
      if (!n || n.endSec <= n.startSec) return;

      const noteStartInView = Math.max(n.startSec, viewStartSec);
      const noteEndInView   = Math.min(n.endSec, viewStartSec + viewDuration);
      if (noteEndInView <= noteStartInView) return;

      const xStart = gridX0 + (noteStartInView - viewStartSec) * localPixelsPerSec;
      const xEnd   = gridX0 + (noteEndInView   - viewStartSec) * localPixelsPerSec;
      const barWidth = Math.max(xEnd - xStart - 4, 4);
      const x = xStart + 2;

      const velNorm = Math.min(Math.max(n.velocity / 127, 0.05), 1.0);
      const barHeight = velNorm * (h - 10);
      const y = h - barHeight;

      const isSelected = selectedNotes.has(idx);
      const alt = (idx % 2 === 0);
      const baseColor = isSelected
        ? "#60a5fa"
        : (alt ? "#3b82f6" : "#2563eb");

      ctx.fillStyle = baseColor;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, barWidth, barHeight - 2, 3);
      else ctx.rect(x, y, barWidth, barHeight - 2);
      ctx.fill();

      if (isSelected) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    }

    // unselected behind
    normalIdx.forEach(drawVelBar);
    // selected on top
    selectedIdx.forEach(drawVelBar);
    // --- End draw velocity bars ---

    // Static "Velocity" label in the left strip
    ctx.fillStyle = "#9ca3c7";
    ctx.font = "10px system-ui";
    ctx.textAlign = "left";   

    // Current note/chord name in the dead space under the piano roll
    // Chord / current note name at the beginning of the lane (no label)
    ctx.fillStyle = "#7b83af";
    ctx.textAlign = "left";
    if (currentChordLabel) {
      ctx.fillText(currentChordLabel, keyLabelWidth + 6, 11);
    } 
    
    const gridSec = getGridSeconds(secPerBeat);
    const stripeAlpha = 0.06;

    const startCell = Math.floor(viewStartSec / gridSec);
    const endCell   = Math.ceil((viewStartSec + viewDuration) / gridSec);

    for (let c = startCell; c <= endCell; c++) {
      if (c % 2 !== 0) continue;

      const cellSec = c * gridSec;
      const nextCellSec = (c + 1) * gridSec;

      const x1 = gridX0 + (cellSec - viewStartSec) * localPixelsPerSec;
      const x2 = gridX0 + (nextCellSec - viewStartSec) * localPixelsPerSec;

      const sx1 = Math.max(gridX0, x1);
      const sx2 = Math.min(gridX0 + gridWidth, x2);

      if (sx2 > sx1) {
        ctx.fillStyle = `rgba(255,255,255,${stripeAlpha})`;
        ctx.fillRect(sx1, 0, sx2 - sx1, h);
      }
    }
  }

  function buildScaleNotes(tonicName, pattern) {
    const order = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
    const tonicSem = TONICS[tonicName] ?? 0;
    return pattern.map(offset => order[(tonicSem + offset + 120) % 12]);
  }

  function buildChordPresetsForScale(scaleType) {
    // Triads as scale-degree intervals (0 = root, 2 = third, 4 = fifth in scale)
    const commonTriad = { intervals: [0, 2, 4] };
    // For now we mostly expose roman numerals; progressions can be added later
    if (scaleType === "pent") {
      return [
        { id: "I",   label: "I",   intervals: [0, 2, 3] },
        { id: "IV",  label: "IV",  intervals: [1, 3, 4] },
        { id: "V",   label: "V",   intervals: [2, 3, 4] }
      ];
    }
    return [
      { id: "I",   label: "I",   intervals: commonTriad.intervals },
      { id: "ii",  label: "ii",  intervals: commonTriad.intervals },
      { id: "iii", label: "iii", intervals: commonTriad.intervals },
      { id: "IV",  label: "IV",  intervals: commonTriad.intervals },
      { id: "V",   label: "V",   intervals: commonTriad.intervals },
      { id: "vi",  label: "vi",  intervals: commonTriad.intervals }
    ];
  }

  function refreshScaleUI() {
    if (!scaleNotesEl || !scaleChordsEl) return;
    const scaleType = scaleSelect.value;
    const pattern = scalePattern;
    const notesInScale = buildScaleNotes(tonicName, pattern);

    scaleNotesEl.innerHTML = "";
    notesInScale.forEach(n => {
      const pill = document.createElement("div");
      pill.className = "scale-pill";
      pill.textContent = n;
      scaleNotesEl.appendChild(pill);
    });

    scaleChordsEl.innerHTML = "";
    const presets = buildChordPresetsForScale(scaleType);
    presets.forEach(p => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chord-pill";
      btn.textContent = p.label;
      btn.dataset.chordId = p.id;
      btn.addEventListener("click", () => {
        currentChordPreset = p;
        // highlight active
        Array.from(scaleChordsEl.querySelectorAll(".chord-pill")).forEach(el => {
          el.classList.toggle("active", el === btn);
        });
      });
      scaleChordsEl.appendChild(btn);
    });
  }

  function hitTestNoteByX(x) {
    const keyLabelWidth = KEY_LABEL_WIDTH;
    const gridX0 = keyLabelWidth;
    const gridWidth = velWidth - keyLabelWidth;
    const localPixelsPerSec = gridWidth / viewDuration;
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      if (n.endSec <= n.startSec) continue;
      const noteStartInView = Math.max(n.startSec, viewStartSec);
      const noteEndInView = Math.min(n.endSec, viewStartSec + viewDuration);
      if (noteEndInView <= noteStartInView) continue;
      const x1 = gridX0 + (noteStartInView - viewStartSec) * localPixelsPerSec;
      const x2 = gridX0 + (noteEndInView - viewStartSec) * localPixelsPerSec;
      if (x >= x1 && x <= x2) return i;
    }
    return -1;
  }

// --- VELOCITY DRAG ON MOUSEUP / LEAVE ---
  let velDragActive = false;
  let velDragNoteIndex = -1;

  function attachVelocityEvents() {
    if (!velocityCanvas) return;  // SAFETY
    // NOTE: velDragActive / velDragNoteIndex are the module-level variables above.
    // They used to be re-declared here, which shadowed them so updateVelocityFromY()
    // always saw index -1 and velocity editing silently did nothing.
    let velStartValue = null;

    function endVelDrag() {
      if (!velDragActive) return;
      const n = notes[velDragNoteIndex];
      if (n && n.velocity !== velStartValue) commitHistoryGesture();
      else cancelHistoryGesture();
      velDragActive = false;
      velDragNoteIndex = -1;
      velStartValue = null;
    }

    velocityCanvas.addEventListener("mousedown", (e) => {
      const rect = velocityCanvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const idx = hitTestNoteByX(x);
      if (idx === -1) {
        velDragActive = false;
        velDragNoteIndex = -1;
        return;
      }

      beginHistoryGesture();
      velDragActive = true;
      velDragNoteIndex = idx;
      velStartValue = notes[idx].velocity;

      selectedNotes.clear();
      selectedNotes.add(idx);
      lastSelectedNoteIndex = idx;

      updateVelocityFromY(y);
      drawPianoRoll(lastPlayheadSec);
      drawVelocityLane();
    });

    velocityCanvas.addEventListener("mousemove", (e) => {
      if (!velDragActive || velDragNoteIndex < 0) return;

      const rect = velocityCanvas.getBoundingClientRect();
      const y = e.clientY - rect.top;

      updateVelocityFromY(y);
      drawPianoRoll(lastPlayheadSec);
      drawVelocityLane();
    });

    window.addEventListener("mouseup", endVelDrag);
    velocityCanvas.addEventListener("mouseleave", endVelDrag);
  }

  function updateVelocityFromY(y) {
    if (velDragNoteIndex < 0 || !notes[velDragNoteIndex]) return;

    const n = notes[velDragNoteIndex];
    const clampedY = Math.min(Math.max(y, 0), velHeight);
    const vel = Math.round((velHeight - clampedY) / velHeight * 127);
    n.velocity = Math.min(Math.max(vel, 1), 127);
  }

  // ---------- PLAYBACK / SYNTH ----------
  function midiToHz(m) {
    return 440 * Math.pow(2, (m - 69) / 12);
  }


  function get808VoiceForNote(midiNote) {
    return DRUM_808_BY_NOTE.get(midiNote) || DRUM_808_BY_NOTE.get(36);
  }

  function play808Hit(midiNote, velocity = 100, track = getActiveTrack(), when = 0) {
    const ctx = ensureAudioContext();
    triggerSynthetic808(
      ctx,
      window.WAWMixer?.getTrackInput(track) || synthMasterGain,
      midiNote,
      velocity,
      track?.drum808Patch || drum808State,
      when
    );
  }

  function schedule808Hit(startSec, midiNote, velocity, noteMeta = {}) {
    const ctx = ensureAudioContext();
    const sources = triggerSynthetic808(
      ctx,
      window.WAWMixer?.getTrackInput(noteMeta.trackId) || synthMasterGain,
      midiNote,
      velocity,
      noteMeta.drum808Patch || drum808State,
      startSec
    );
    trackScheduledSources(sources);
  }

  // Drum voices are synthesized in js/drums.js (no samples). Volume and pan are
  // applied by the track's channel strip, so they are not baked in here.
  // `when` is relative to ctx.currentTime.
  function triggerSynthetic808(ctx, destination, midiNote, velocity = 100, patch = createDefault808Patch(), when = 0) {
    const voice = get808VoiceForNote(midiNote);
    const kit = { ...createDefault808Patch(), ...(patch || {}) };
    return window.WAWDrums.trigger(ctx, destination, voice.id, velocity, kit, ctx.currentTime + Math.max(0, when));
  }

  // White noise is generated once per AudioContext and reused. It used to be
  // regenerated (sample by sample) for every drum hit / noisy synth note, which
  // was a significant main-thread cost during playback and WAV export.
  // Callers always stop their source explicitly, so a longer buffer is fine.
  const noiseBufferCache = new WeakMap();
  function createNoiseBuffer(ctx, duration = 2) {
    const needed = Math.max(1, Math.floor(ctx.sampleRate * Math.max(2, duration)));
    const cached = noiseBufferCache.get(ctx);
    if (cached && cached.length >= needed) return cached;
    const buffer = ctx.createBuffer(1, needed, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noiseBufferCache.set(ctx, buffer);
    return buffer;
  }

  function makeDriveCurve(amount = 0) {
    const n = 256;
    const curve = new Float32Array(n);
    const k = amount * 80;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    return curve;
  }

  function connectSynthOutput(ctx, input, destination, patch, panValue = 0) {
    let node = input;
    if ((patch.drive ?? 0) > 0.001) {
      const shaper = ctx.createWaveShaper();
      shaper.curve = makeDriveCurve(patch.drive);
      shaper.oversample = "2x";
      node.connect(shaper);
      node = shaper;
    }

    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) {
      pan.pan.value = Math.max(-1, Math.min(1, panValue + (patch.pan ?? 0)));
      node.connect(pan);
      node = pan;
    }

    node.connect(destination);

    if ((patch.chorus ?? 0) > 0.001) {
      const delay = ctx.createDelay(0.05);
      const wet = ctx.createGain();
      delay.delayTime.value = 0.018;
      wet.gain.value = patch.chorus * 0.35;
      node.connect(delay);
      delay.connect(wet);
      wet.connect(destination);
    }

    if ((patch.delaySend ?? 0) > 0.001) {
      const delay = ctx.createDelay(1);
      const feedback = ctx.createGain();
      const wet = ctx.createGain();
      delay.delayTime.value = 0.28;
      feedback.gain.value = 0.32;
      wet.gain.value = patch.delaySend * 0.45;
      node.connect(delay);
      delay.connect(feedback);
      feedback.connect(delay);
      delay.connect(wet);
      wet.connect(destination);
    }

    if ((patch.reverbSend ?? 0) > 0.001) {
      const space = ctx.createDelay(0.2);
      const wet = ctx.createGain();
      space.delayTime.value = 0.075;
      wet.gain.value = patch.reverbSend * 0.35;
      node.connect(space);
      space.connect(wet);
      wet.connect(destination);
    }
  }

  function scheduleSynthNote(startSec, endSec, midiNote, velocity, noteMeta = {}) {
    if (noteMeta.instrument === "808") {
      schedule808Hit(startSec, midiNote, velocity, noteMeta);
      return;
    }
    if (noteMeta.instrument === "sampler") {
      const ctx = ensureAudioContext();
      const track = tracks.find(t => t.id === noteMeta.trackId);
      const srcs = window.WAWSampler?.scheduleNote(ctx, window.WAWMixer.getTrackInput(noteMeta.trackId), track, midiNote, velocity,
        ctx.currentTime + startSec, ctx.currentTime + endSec) || [];
      trackScheduledSources(srcs);
      return;
    }

    const ctx = ensureAudioContext();
    const now = ctx.currentTime;
    const dest = window.WAWMixer?.getTrackInput(noteMeta.trackId) || synthMasterGain;
    const patch = noteMeta.synthPatch || synthState;
    const voice = window.WAWSynth.buildSynthVoice(ctx, dest, midiNote, velocity, patch, now + startSec, now + endSec);
    trackScheduledSources(voice.sources);
  }

  function getActivePlaybackLoop() {
    if (currentView === "editor") {
      const bounds = getEditorClipBounds();
      if (bounds) {
        return {
          enabled: true,
          start: bounds.start,
          end: bounds.end
        };
      }
      if (clipLoopEnabled && clipLoopEndSec > clipLoopStartSec + 0.05) {
        return {
          enabled: true,
          start: clipLoopStartSec,
          end: clipLoopEndSec
        };
      }
    }

    return {
      enabled: loopEnabled,
      start: loopStartSec,
      end: loopEndSec
    };
  }

  function playNotes(noteArray) {
  const hasAudio = (window.WAWAudio?.collectAudioEvents(0, Infinity) || []).length > 0;
  if (!noteArray.length && !hasAudio) {
    statusEl.textContent = "No notes to play.";
    return;
  }
  ensureAudioContext();
  stopPlayback();

  isPlaying = true;
  if (stopBtn) stopBtn.disabled = false;

  const activeLoop = getActivePlaybackLoop();
  const hasLoop = activeLoop.enabled && (activeLoop.end > activeLoop.start + 0.05);

  // --- FIX A: if in sequencer and user did NOT manually set playhead,
  // start from loopStart if loop active, else from 0 ---
  if (!playheadWasManuallySet) {
    lastPlayheadSec = hasLoop ? activeLoop.start : 0;
  }

  // --- FIX B: manual start should be respected once ---
  const manualStart =
    playheadWasManuallySet && lastPlayheadSec != null
      ? lastPlayheadSec
      : null;

  playheadWasManuallySet = false;

  startPlaybackCycle(noteArray, manualStart);

  // --- FIX C: loopbar disappearing on play ---
  requestAnimationFrame(() => {
    const pos = lastPlayheadSec || 0;
    resizeCanvases();
    updateSeqViewFromScroll();
    drawSequencerRuler(pos);
    drawAllLoopBars(pos);
  });
} // End playNotes()


function clearScheduledNodes() {
  scheduledOscs.forEach(node => {
    try { node.stop(0); } catch (e) {}
    try { node.disconnect(); } catch (e) {}
  });
  scheduledOscs.clear();
}

// ---------- LOOKAHEAD SCHEDULER ----------
// Notes used to be turned into Web Audio nodes for the WHOLE range at once when
// playback started (thousands of nodes for a long song), and loop restarts were
// driven by requestAnimationFrame, which added up to a frame of jitter at every
// loop boundary and stopped looping when the tab was in the background.
// Now notes are scheduled ~200 ms ahead from a timer, consecutive loop cycles are
// placed sample-accurately back to back, and mute/solo/volume/pan/patch are read
// from the live track state when each note is scheduled, so mixer changes are
// heard almost immediately instead of on the next loop.
const SCHED_LOOKAHEAD_SEC = 0.2;
const SCHED_INTERVAL_MS = 25;
let schedTimerId = null;
let schedCycle = null;    // cycle currently being scheduled (may start in the future)
let displayCycle = null;  // cycle the playhead is currently in

function isTrackAudible(track) {
  if (!track || track.mute) return false;
  const anySolo = tracks.some(t => t.solo);
  return !anySolo || !!track.solo;
}

function buildPlaybackCycle(noteArray, rangeStart, rangeEnd, startTime) {
  const noteEvents = noteArray
    .filter(n => n.endSec > n.startSec && n.endSec > rangeStart && n.startSec < rangeEnd)
    .map(n => ({ note: n, ns: Math.max(n.startSec, rangeStart), ne: Math.min(n.endSec, rangeEnd) }))
    .filter(e => e.ne > e.ns);
  // audio-track clips are scheduled by the same clock
  const audioEvents = (window.WAWAudio?.collectAudioEvents(rangeStart, rangeEnd) || [])
    .map(ev => ({ audio: ev, ns: ev.start, ne: ev.end }));
  const queue = [...noteEvents, ...audioEvents].sort((a, b) => a.ns - b.ns);
  return { startTime, rangeStart, rangeEnd, queue, index: 0 };
}

function getLiveMixdownForScheduling() {
  // include muted / non-soloed tracks: audibility is decided per note at schedule time
  return getAllNotesMixdown({ includeMuted: true, ignoreSolo: true });
}

function schedulerTick() {
  if (!isPlaying || !audioCtx || !schedCycle) return;
  const now = audioCtx.currentTime;
  const horizon = now + SCHED_LOOKAHEAD_SEC;
  const trackById = new Map(tracks.map(t => [t.id, t]));

  // guard against pathological loops (e.g. a tiny loop range)
  for (let guard = 0; guard < 64; guard++) {
    const c = schedCycle;
    while (c.index < c.queue.length) {
      const e = c.queue[c.index];
      const absStart = c.startTime + (e.ns - c.rangeStart);
      if (absStart > horizon) break;
      c.index++;
      const absEnd = c.startTime + (e.ne - c.rangeStart);
      if (absEnd <= now) continue; // too late (e.g. after a long stall)
      if (e.audio) {
        const track = trackById.get(e.audio.trackId);
        if (!isTrackAudible(track)) continue;
        // started late (e.g. playback began mid-clip): skip into the audio
        const late = Math.max(0, now - absStart);
        trackScheduledSources(window.WAWAudio.scheduleAudioEvent(audioCtx, window.WAWMixer.getTrackInput(track), e.audio, absStart, late));
        continue;
      }
      const track = trackById.get(e.note.trackId);
      if (track && !isTrackAudible(track)) continue;
      const meta = track ? normalizePlaybackNote(e.note, track) : e.note;
      scheduleSynthNote(absStart - now, absEnd - now, meta.midiNote, meta.velocity, meta);
    }
    if (c.index < c.queue.length) break;

    // current cycle fully scheduled -> queue the next loop cycle when it gets close
    const cycleEnd = c.startTime + Math.max(0.05, c.rangeEnd - c.rangeStart);
    if (cycleEnd > horizon) break;
    const loop = getActivePlaybackLoop();
    const hasLoop = loop.enabled && loop.end > loop.start + 0.05;
    if (!hasLoop) break;
    schedCycle = buildPlaybackCycle(getLiveMixdownForScheduling(), loop.start, loop.end, cycleEnd);
  }

  // automation (read + write) at control rate
  window.WAWAutomation?.tick(currentSongPos(), now);

  // Non-looping playback ended (also works while the tab is in the background,
  // where requestAnimationFrame does not run)
  const dc = displayCycle;
  if (dc && schedCycle === dc && dc.index >= dc.queue.length) {
    const end = dc.startTime + Math.max(0.05, dc.rangeEnd - dc.rangeStart);
    const loop = getActivePlaybackLoop();
    const hasLoop = loop.enabled && loop.end > loop.start + 0.05;
    if (!hasLoop && now >= end && !isRecording) stopPlayback();
  }
}

/** song position (s) being heard right now, or null when stopped */
function currentSongPos() {
  if (!isPlaying || !audioCtx) return null;
  const now = audioCtx.currentTime;
  let c = displayCycle;
  if (schedCycle && schedCycle !== c && now >= schedCycle.startTime) c = schedCycle;
  if (!c) return null;
  return c.rangeStart + Math.max(0, now - c.startTime);
}

function startPlaybackCycle(noteArray, startAtSec = null, isLoopRestart = false) {
  if (!audioCtx) return;

  // Always clean up prior cycle nodes so overlapping cycles never stack
  clearScheduledNodes();
  if (playbackLoopTimerId) {
    clearTimeout(playbackLoopTimerId);
    playbackLoopTimerId = null;
  }

  const totalDur = getBaseDuration();
  const activeLoop = getActivePlaybackLoop();
  const hasActiveLoop = activeLoop.enabled && (activeLoop.end > activeLoop.start + 0.05);

  let rangeStart = hasActiveLoop ? activeLoop.start : 0;
  let rangeEnd   = hasActiveLoop ? activeLoop.end   : totalDur;

  // (also while recording: background playback must start where the take starts)
  if (startAtSec != null && !isLoopRestart) {
    rangeStart = startAtSec;
    if (hasActiveLoop) {
      if (rangeStart < activeLoop.start || rangeStart >= activeLoop.end) {
        rangeStart = activeLoop.start;
      }
      rangeEnd = activeLoop.end;
    } else {
      rangeEnd = totalDur;
    }
  }

  playbackRangeStartSec = rangeStart;
  playbackRangeEndSec   = rangeEnd;

  playbackStartTime = audioCtx.currentTime;
  lastMetroBeatIndex = null;

  // noteArray is kept for API compatibility; live track state is used so that
  // mute/solo changes made during playback take effect.
  void noteArray;
  schedCycle = buildPlaybackCycle(getLiveMixdownForScheduling(), rangeStart, rangeEnd, playbackStartTime);
  displayCycle = schedCycle;

  if (schedTimerId) clearInterval(schedTimerId);
  schedTimerId = setInterval(schedulerTick, SCHED_INTERVAL_MS);
  schedulerTick();

  if (!isLoopRestart) {
    requestAnimationFrame(animatePlayhead);
  }
}

function updateSequencerPlayhead(sec) {
  if (!seqPlayheadEl || currentView !== "sequencer") return;

  const pxPerSec = getSeqPxPerSec();
  const xPx = sec * pxPerSec;

  // align with lanes, compensating for label column + scroll
  const leftPx = (seqGridLabelW || 0) + xPx - (sequencerGrid?.scrollLeft || 0);

  seqPlayheadEl.style.left = leftPx + "px";
}

// Redraw only what is visible: the piano roll / velocity lane are skipped
// unless the editor is open (they used to be repainted every frame regardless,
// along with the loop bars up to three times per frame).
function drawTransportFrame(songPos) {
  if (songPos != null) lastPlayheadSec = songPos;
  if (currentView === "editor") {
    drawPianoRoll(songPos);   // also draws both loop bars
    drawVelocityLane();
  } else {
    drawAllLoopBars(songPos);
  }
  if (songPos != null) updateSequencerPlayhead(songPos);
}

function animatePlayhead() {
  if (!isPlaying || !audioCtx) {
    drawTransportFrame(null);
    return;
  }

  const now = audioCtx.currentTime;

  // move on to the next (already scheduled) loop cycle once it has started
  if (schedCycle && schedCycle !== displayCycle && now >= schedCycle.startTime) {
    displayCycle = schedCycle;
    playbackStartTime = displayCycle.startTime;
    playbackRangeStartSec = displayCycle.rangeStart;
    playbackRangeEndSec = displayCycle.rangeEnd;
    lastMetroBeatIndex = null;
  }

  const elapsed = Math.max(0, now - playbackStartTime);
  const rangeDur = Math.max(playbackRangeEndSec - playbackRangeStartSec, 0.05);

  const bpm = parseFloat(bpmInput.value) || timelineBpm || 120;
  if (!isRecording) {
    metronomeTickIfNeeded(elapsed, bpm, false);
  }

  const songPos = playbackRangeStartSec + Math.min(elapsed, rangeDur);
  drawTransportFrame(songPos);
  requestAnimationFrame(animatePlayhead);
}


function animateRecordingTransport() {
  if (!isRecording || !audioCtx) {
    recordAnimId = null;
    drawTransportFrame(null);
    return;
  }

  const elapsed = audioCtx.currentTime - recordingStartTime;
  const bpm = parseFloat(bpmInput.value) || 120;

  // compute actual song position during record
  let songPos = recordingBaseSec + elapsed;
  if (recordingLoopLen > 0) {
    songPos = recordingBaseSec + (elapsed % recordingLoopLen);
  }

  metronomeTickIfNeeded(songPos - recordingBaseSec, bpm, false);

  followRecordingPlayhead(songPos);

  drawTransportFrame(songPos);
  updateLiveRecordingClip(songPos);

  recordAnimId = requestAnimationFrame(animateRecordingTransport);
}


  function stopPlayback() {
    if (playbackLoopTimerId) {
      clearTimeout(playbackLoopTimerId);
      playbackLoopTimerId = null;
    }
    if (schedTimerId) {
      clearInterval(schedTimerId);
      schedTimerId = null;
    }
    schedCycle = null;
    displayCycle = null;
    if (!isPlaying && !scheduledOscs.size) {
      drawTransportFrame(null);
      return;
    }
    isPlaying = false;
    if (stopBtn) stopBtn.disabled = true;
    clearScheduledNodes();
    window.WAWAutomation?.onStop();
    drawTransportFrame(null);
  }

  // ---------- QUANTIZE / HUMANIZE ----------
  function getGridSeconds(secPerBeat) {
    // gridValue is bars: "1" (1 bar), "0.5" (half bar), "0.25" (quarter bar = 1 beat in 4/4), etc.
    const v = parseFloat(gridValue);
    const beatsPerBar = 4; // assuming 4/4
    if (!isNaN(v) && v > 0) {
      return v * beatsPerBar * secPerBeat;
    }
    // fallback: 1/8 note = half beat
    return secPerBeat / 2;
  }

  function quantizeTime(t, gridSec, swing, isStart, originSec = 0) {
    if (gridSec <= 0) return t;
    if (window.WAWTempo && !window.WAWTempo.isSimple()) {
      // grid as a note value (whole-note fraction), snapped relative to bar starts
      const whole = gridSec / (4 * 60 / (parseFloat(bpmInput?.value) || timelineBpm || 120));
      return window.WAWTempo.snapSec(originSec + t, whole, swing, isStart) - originSec;
    }
    const baseIndex = t / gridSec;
    let idx = Math.round(baseIndex);

    let q = idx * gridSec;

    // Simple 8th-style swing: move odd subdivisions forward
    if (swing > 0 && isStart) {
      if (idx % 2 === 1) {
        const offset = swing * 0.5 * gridSec;
        q += offset;
      }
    }
    return q;
  }

  function getTargetIndices(selectionOnly) {
    if (selectionOnly && selectedNotes.size) {
      return Array.from(selectedNotes);
    }
    return notes.map((_, idx) => idx);
  }

  function quantizeNotes(selectionOnly) {
    pushHistory();
    const bpm = parseFloat(bpmInput.value) || 120;
    const secPerBeat = 60 / bpm;
    const gridSec = getGridSeconds(secPerBeat);
    const indices = getTargetIndices(selectionOnly);
    indices.forEach(i => {
      const n = notes[i];
      if (!n || n.endSec <= n.startSec) return;
      const dur = n.endSec - n.startSec;
      const newStart = quantizeTime(n.startSec, gridSec, swingAmount, true);
      n.startSec = Math.max(0, newStart);
      n.endSec = n.startSec + dur;
    });
    updateTimeView();
    drawPianoRoll();
    drawVelocityLane();
  }

  function humanizeNotes(selectionOnly) {
    pushHistory();
    const indices = getTargetIndices(selectionOnly);
    const maxTime = 0.02; // ~20ms
    const maxVel = 10;
    indices.forEach(i => {
      const n = notes[i];
      if (!n || n.endSec <= n.startSec) return;
      const offset = (Math.random() * 2 - 1) * maxTime;
      let ns = n.startSec + offset;
      let ne = n.endSec + offset;
      if (ns < 0) {
        ne -= ns;
        ns = 0;
      }
      n.startSec = ns;
      n.endSec = ne;
      const deltaVel = Math.round((Math.random() * 2 - 1) * maxVel);
      n.velocity = Math.min(127, Math.max(1, n.velocity + deltaVel));
    });
    updateTimeView();
    drawPianoRoll();
    drawVelocityLane();
  }

  // ---------- MIDI FILE CREATION ----------
  function buildMidiFile(notes, bpm) {
    const sorted = [...notes].filter(n => n.endSec > n.startSec)
      .sort((a, b) => a.startSec - b.startSec);

    const PPQ = 480;

    function secToTicks(sec) {
      const beats = window.WAWTempo ? window.WAWTempo.secToBeat(sec) : sec * (bpm / 60);
      return Math.round(beats * PPQ);
    }

    const timedEvents = [];
    // tempo + time-signature map (the first tempo is written below)
    if (window.WAWTempo) {
      const tm = window.WAWTempo.state;
      tm.tempos.slice(1).forEach(t => {
        const us = Math.round(60000000 / t.bpm);
        timedEvents.push({ tick: Math.round(t.beat * PPQ), order: -1, bytes: [0xFF, 0x51, 0x03, (us >> 16) & 0xFF, (us >> 8) & 0xFF, us & 0xFF] });
      });
      tm.sigs.forEach(g => {
        timedEvents.push({ tick: Math.round(window.WAWTempo.barStartBeat(g.bar) * PPQ), order: -1, bytes: [0xFF, 0x58, 0x04, g.num, Math.round(Math.log2(g.den)), 24, 8] });
      });
      bpm = tm.tempos[0].bpm;
    }
    sorted.forEach(n => {
      timedEvents.push({
        tick: secToTicks(n.startSec),
        order: 1,
        bytes: [0x90, n.midiNote, n.velocity]
      });
      timedEvents.push({
        tick: secToTicks(n.endSec),
        order: 0,
        bytes: [0x80, n.midiNote, 0x40]
      });
    });

    timedEvents.sort((a, b) => a.tick - b.tick || a.order - b.order);

    let lastTick = 0;
    const events = timedEvents.map(ev => {
      const delta = Math.max(0, ev.tick - lastTick);
      lastTick = ev.tick;
      return { delta, bytes: ev.bytes };
    });

    events.push({ delta: 0, bytes: [0xFF, 0x2F, 0x00] });

    const trackData = [];

    const microsecPerQuarter = Math.round(60000000 / bpm);
    const tempoBytes = [
      0x00, 0xFF, 0x51, 0x03,
      (microsecPerQuarter >> 16) & 0xFF,
      (microsecPerQuarter >> 8) & 0xFF,
      microsecPerQuarter & 0xFF
    ];
    trackData.push(...tempoBytes);

    events.forEach(ev => {
      writeVarLen(trackData, ev.delta);
      trackData.push(...ev.bytes);
    });

    const trackChunk = buildChunk("MTrk", new Uint8Array(trackData));
    const headerData = new Uint8Array([
      0x00, 0x00,
      0x00, 0x01,
      (PPQ >> 8) & 0xFF, PPQ & 0xFF
    ]);
    const headerChunk = buildChunk("MThd", headerData);

    const full = new Uint8Array(headerChunk.length + trackChunk.length);
    full.set(headerChunk, 0);
    full.set(trackChunk, headerChunk.length);

    return new Blob([full], { type: "audio/midi" });
  }

  function buildChunk(type, data) {
    const header = new Uint8Array(8);
    header[0] = type.charCodeAt(0);
    header[1] = type.charCodeAt(1);
    header[2] = type.charCodeAt(2);
    header[3] = type.charCodeAt(3);
    const len = data.length;
    header[4] = (len >> 24) & 0xFF;
    header[5] = (len >> 16) & 0xFF;
    header[6] = (len >> 8) & 0xFF;
    header[7] = len & 0xFF;

    const chunk = new Uint8Array(8 + len);
    chunk.set(header, 0);
    chunk.set(data, 8);
    return chunk;
  }

  function writeVarLen(arr, value) {
    let buffer = value & 0x7F;
    while ((value >>= 7)) {
      buffer <<= 8;
      buffer |= ((value & 0x7F) | 0x80);
    }
    while (true) {
      arr.push(buffer & 0xFF);
      if (buffer & 0x80) buffer >>= 8;
      else break;
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 0);
  }

  const PROJECT_LIBRARY_KEY = "easyDawProjectLibrary_v1";
  const PROJECT_AUTO_SAVE_INTERVAL_MS = 30000;
  let activeProjectId = null;
  let activeProjectName = null;
  let lastProjectSaveSignature = "";

  function readProjectLibrary() {
    try {
      const raw = localStorage.getItem(PROJECT_LIBRARY_KEY);
      const data = raw ? JSON.parse(raw) : [];
      return Array.isArray(data) ? data : [];
    } catch (e) {
      console.warn("Project library read failed:", e);
      return [];
    }
  }

  function writeProjectLibrary(projects) {
    localStorage.setItem(PROJECT_LIBRARY_KEY, JSON.stringify(projects));
  }

  function projectDisplayName(payload) {
    const firstTrack = payload?.project?.tracks?.[0]?.name || payload?.project?.tracks?.[0]?.id;
    return payload?.name || firstTrack || "Untitled Project";
  }

  function getProjectSaveSignature(payload) {
    const stablePayload = {
      ...payload,
      savedAt: null,
      autoSavedAt: null
    };
    return JSON.stringify(stablePayload);
  }

  function setActiveProject(item) {
    activeProjectId = item?.id || null;
    activeProjectName = item?.name || null;
    lastProjectSaveSignature = item?.payload ? getProjectSaveSignature(item.payload) : "";
  }

  function saveProjectToLibrary(name = null, options = {}) {
    const { silent = false, forcePrompt = false, autoSave = false } = options;
    const payload = getProjectPayload();
    const projects = readProjectLibrary();
    const now = new Date().toISOString();
    const existingIndex = !options.newProject && activeProjectId
      ? projects.findIndex(project => project.id === activeProjectId)
      : -1;
    const existingItem = existingIndex >= 0 ? projects[existingIndex] : null;
    const projectName = (
      name ||
      (!forcePrompt && existingItem?.name) ||
      (!forcePrompt && activeProjectName) ||
      prompt("Project name:", projectDisplayName(existingItem?.payload || payload)) ||
      "Untitled Project"
    ).trim() || "Untitled Project";
    const item = {
      id: existingItem?.id || "proj_" + Math.random().toString(36).slice(2, 10),
      name: projectName,
      savedAt: now,
      autoSavedAt: autoSave ? now : existingItem?.autoSavedAt,
      bpm: payload.bpm,
      trackCount: payload.project?.tracks?.length || 0,
      payload: {
        ...payload,
        id: existingItem?.id || activeProjectId || undefined,
        name: projectName,
        savedAt: now,
        autoSavedAt: autoSave ? now : undefined
      }
    };
    item.payload.id = item.id;
    if (existingIndex >= 0) {
      projects.splice(existingIndex, 1, item);
    } else {
      projects.unshift(item);
    }
    try {
      writeProjectLibrary(projects);
    } catch (e) {
      // e.g. QuotaExceededError — don't pretend the save worked
      console.error("Project library write failed:", e);
      statusEl.textContent = "Could not save to the project library (browser storage full?). Use Save to export a JSON file.";
      return null;
    }
    setActiveProject(item);
    renderProjectsLibrary();
    window.WAWStatusBar?.markSaved();
    if (!silent) {
      statusEl.textContent = existingItem
        ? `Saved "${projectName}".`
        : `Saved project "${projectName}" to library.`;
    }
    return item;
  }

  function autoSaveActiveProject() {
    if (!activeProjectId) return;
    const projects = readProjectLibrary();
    if (!projects.some(project => project.id === activeProjectId)) {
      setActiveProject(null);
      return;
    }
    const payload = getProjectPayload();
    const signature = getProjectSaveSignature(payload);
    if (signature === lastProjectSaveSignature) return;
    if (saveProjectToLibrary(null, { silent: true, autoSave: true })) {
      statusEl.textContent = `Auto-saved "${activeProjectName || "project"}".`;
    }
  }

  setInterval(autoSaveActiveProject, PROJECT_AUTO_SAVE_INTERVAL_MS);

  function renderProjectsLibrary() {
    if (!projectsList) return;
    const projects = readProjectLibrary();
    if (!projects.length) {
      projectsList.innerHTML = `
        <div class="project-empty">
          <h3>No saved projects yet</h3>
          <p>Use Save Current to store this session in the local project library, or import a JSON project file.</p>
        </div>
      `;
      return;
    }

    projectsList.innerHTML = projects.map(item => {
      const date = item.savedAt ? new Date(item.savedAt).toLocaleString() : "Unknown date";
      return `
        <article class="project-card" data-project-id="${escapeHtml(item.id)}">
          <div class="project-card-main">
            <h3>${escapeHtml(item.name || "Untitled Project")}</h3>
            <span>${date}</span>
          </div>
          <div class="project-meta">
            <span>${Number(item.bpm) || 120} BPM</span>
            <span>${Number(item.trackCount) || 0} tracks</span>
          </div>
          <div class="project-card-actions">
            <button type="button" data-action="load">Load</button>
            <button type="button" data-action="export">Export</button>
            <button type="button" data-action="delete">Delete</button>
          </div>
        </article>
      `;
    }).join("");
  }

  projectsList?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const card = btn.closest(".project-card");
    const id = card?.dataset.projectId;
    const projects = readProjectLibrary();
    const item = projects.find(p => p.id === id);
    if (!item) return;

    const action = btn.dataset.action;
    if (action === "load") {
      loadProjectPayload(item.payload);
      setActiveProject(item);
      setView("sequencer", { silent: true });
      renderSequencer();
      statusEl.textContent = `Loaded "${item.name}".`;
    } else if (action === "export") {
      exportPayloadWithSamples(item.payload).then(full => {
        const blob = new Blob([JSON.stringify(full)], { type: "application/json" });
        const safeName = (item.name || "waw-project").replace(/[^a-zA-Z0-9._-]+/g, "_");
        downloadBlob(blob, `${safeName}.json`);
      });
    } else if (action === "delete") {
      if (!confirm(`Delete "${item.name}" from the local project library?`)) return;
      writeProjectLibrary(projects.filter(p => p.id !== id));
      if (activeProjectId === id) setActiveProject(null);
      renderProjectsLibrary();
    }
  });

  function getProjectPayload() {
    return {
      app: "WAW",
      version: 1,
      id: activeProjectId || undefined,
      name: activeProjectName || undefined,
      savedAt: new Date().toISOString(),
      bpm: parseFloat(bpmInput?.value) || timelineBpm || 120,
      project: makeSnapshot(),
      loopEnabled,
      overwriteEnabled,
      gridValue,
      swingAmount,
    };
  }

  // Embed every referenced sample (base64 WAV) so the JSON file is self-contained
  async function exportPayloadWithSamples(payload) {
    const projTracks = payload?.project?.tracks || [];
    const ids = window.WAWSampler ? [...window.WAWSampler.sampleIdsInUse(projTracks)] : [];
    if (!ids.length) return payload;
    statusEl.textContent = `Packing ${ids.length} audio sample(s)…`;
    return { ...payload, samples: await window.WAWSamples.exportSamples(ids) };
  }

  async function saveProjectFile() {
    saveProjectToLibrary();
    const payload = await exportPayloadWithSamples(getProjectPayload());
    const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
    const safeName = (activeProjectName || "waw-project").replace(/[^a-zA-Z0-9._-]+/g, "_");
    downloadBlob(blob, `${safeName}_${payload.bpm}bpm.json`);
    statusEl.textContent = "Project saved to library and exported as JSON (including audio).";
  }

  function loadProjectPayload(payload) {
    const project = payload.project || payload;
    stopPlayback();
    restoreSnapshot(project);
    // Undo steps from the previous project must not be applied to this one
    undoStack = [];
    redoStack = [];
    activeClipId = null;
    selectedClipRef = null;
    updateUndoRedoButtons();
    window.WAWStatusBar?.markSaved();
    if (payload.bpm && bpmInput) bpmInput.value = payload.bpm;
    if (payload.synthState && !tracks.some(t => t.synthPatch)) {
      const activeTrack = getActiveTrack();
      if (activeTrack) activeTrack.synthPatch = { ...createDefaultSynthPatch(), ...payload.synthState };
    }
    if (payload.synthState) {
      loadSynthPatchToUI(payload.synthState);
      updateSynthFromUI();
    }
    loopEnabled = payload.loopEnabled ?? loopEnabled;
    overwriteEnabled = payload.overwriteEnabled ?? overwriteEnabled;
    gridValue = payload.gridValue ?? gridValue;
    swingAmount = payload.swingAmount ?? swingAmount;
    if (loopBtn) loopBtn.classList.toggle("active", loopEnabled);
    syncOverwriteBtnUI();
    renderSidebarTracks();
    renderSequencer();
    renderMixer();
    window.WAWSampler?.preloadForTracks(tracks).then(() => renderSequencer());
    statusEl.textContent = "Project loaded.";
  }

  function renderNoteOffline(ctx, destination, note) {
    if (note.instrument === "808") {
      render808NoteOffline(ctx, destination, note);
      return;
    }
    if (note.instrument === "sampler") {
      const track = tracks.find(t => t.id === note.trackId);
      window.WAWSampler?.scheduleNote(ctx, destination, track, note.midiNote, note.velocity ?? 100,
        Math.max(0, note.startSec), Math.max(note.startSec + 0.02, note.endSec));
      return;
    }
    const t0 = Math.max(0, note.startSec);
    const t1 = Math.max(t0 + 0.02, note.endSec);
    window.WAWSynth.buildSynthVoice(ctx, destination, note.midiNote, note.velocity ?? 100, note.synthPatch || synthState, t0, t1);
  }

  function render808NoteOffline(ctx, destination, note) {
    triggerSynthetic808(
      ctx,
      destination,
      note.midiNote,
      note.velocity ?? 100,
      note.drum808Patch || drum808State,
      Math.max(0, note.startSec)
    );
  }

  async function exportWavMixdown() {
    const mixNotes = getAllNotesMixdown();
    const audioEvents = window.WAWAudio?.collectAudioEvents(0, Infinity, { audibleOnly: true }) || [];
    if (!mixNotes.length && !audioEvents.length) {
      statusEl.textContent = "Nothing to export yet.";
      return;
    }
    statusEl.textContent = "Rendering WAV...";
    const sampleRateOut = 44100;
    const tailSec = 2.5;
    const lastEnd = Math.max(0, ...mixNotes.map(n => n.endSec), ...audioEvents.map(e => e.end));
    const duration = lastEnd + tailSec;
    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OfflineCtx) {
      statusEl.textContent = "Offline WAV export is not supported in this browser.";
      return;
    }
    const offline = new OfflineCtx(2, Math.ceil(duration * sampleRateOut), sampleRateOut);
    // Same channel strips, inserts, sends and master chain as realtime playback
    const graph = await window.WAWMixer.createOfflineGraph(offline);
    window.WAWAutomation?.applyOffline(offline, graph, duration);
    await window.WAWWarp?.prepareAll(); // warped clips render their stretched audio
    await window.WAWSampler?.preloadForTracks(tracks);
    mixNotes.forEach(n => renderNoteOffline(offline, graph.inputFor(n.trackId), n));
    for (const ev of audioEvents) {
      window.WAWAudio.scheduleAudioEvent(offline, graph.inputFor(ev.trackId), ev, ev.start, 0);
    }
    const buffer = await offline.startRendering();
    const wav = audioBufferToWav(buffer);
    const bpm = parseFloat(bpmInput.value) || 120;
    downloadBlob(new Blob([wav], { type: "audio/wav" }), `waw-mix_${bpm}bpm.wav`);
    statusEl.textContent = `Exported WAV mixdown (${duration.toFixed(1)} s).`;
  }

  function audioBufferToWav(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRateOut = buffer.sampleRate;
    const length = buffer.length * numChannels * 2 + 44;
    const arrayBuffer = new ArrayBuffer(length);
    const view = new DataView(arrayBuffer);
    let offset = 0;
    const writeString = (s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(offset++, s.charCodeAt(i));
    };
    const writeUint32 = (v) => { view.setUint32(offset, v, true); offset += 4; };
    const writeUint16 = (v) => { view.setUint16(offset, v, true); offset += 2; };

    writeString("RIFF");
    writeUint32(length - 8);
    writeString("WAVE");
    writeString("fmt ");
    writeUint32(16);
    writeUint16(1);
    writeUint16(numChannels);
    writeUint32(sampleRateOut);
    writeUint32(sampleRateOut * numChannels * 2);
    writeUint16(numChannels * 2);
    writeUint16(16);
    writeString("data");
    writeUint32(length - 44);

    for (let i = 0; i < buffer.length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const sample = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
    }
    return arrayBuffer;
  }

  // ---------- MIDI INPUT ----------
  function initMIDI() {
    if (!navigator.requestMIDIAccess) {
      console.log("Web MIDI not supported.");
      return;
    }
    navigator.requestMIDIAccess().then(onMIDISuccess, onMIDIFailure);
  }

  function onMIDISuccess(midi) {
    midiAccess = midi;
    for (const input of midiAccess.inputs.values()) {
      input.onmidimessage = handleMIDIMessage;
    }
    midiAccess.onstatechange = (e) => {
      if (e.port.type === "input") {
        e.port.onmidimessage = handleMIDIMessage;
      }
    };
    console.log("MIDI ready.");
  }

  function onMIDIFailure(err) {
    console.warn("MIDI failed:", err);
  }

  function handleMIDIMessage(event) {
    if (window.WAWWorkspace && !window.WAWWorkspace.acceptMidi(event)) return;
    window.WAWStatusBar?.midiActivity();
    const [status, data1, data2] = event.data;
    const cmd = status & 0xf0;
    const note = data1;
    const vel = data2;

    const PM = window.WAWPadMap;
    if (cmd === 0x90 && vel > 0) {
      if (PM?.handleMidiLearn(note)) return;           // pad MIDI Learn
      midiNoteOn(PM ? PM.translate(note) : note, vel); // controller pad -> pad note
    } else if (cmd === 0x80 || (cmd === 0x90 && vel === 0)) {
      midiNoteOff(PM ? PM.translate(note) : note);
    }
  }

  function trigger808PadNote(note, velocity = 110) {
    midiNoteOn(note, velocity);
    setTimeout(() => midiNoteOff(note), 90);
  }

  function flash808Pad(note) {
    document.querySelectorAll(`.drum808-pad[data-note="${note}"]`).forEach(pad => {
      pad.classList.add("active");
      setTimeout(() => pad.classList.remove("active"), 120);
    });
  }

  const COMPUTER_KEYBOARD_MAP = {
    KeyA: 0,
    KeyW: 1,
    KeyS: 2,
    KeyE: 3,
    KeyD: 4,
    KeyF: 5,
    KeyT: 6,
    KeyG: 7,
    KeyY: 8,
    KeyH: 9,
    KeyU: 10,
    KeyJ: 11,
    KeyK: 12,
    KeyO: 13,
    KeyL: 14,
    KeyP: 15,
    Semicolon: 16,
    Quote: 17
  };
  const COMPUTER_808_KEY_MAP = Object.fromEntries(PAD_KEY_CODES.map((code, i) => [code, DRUM_808_VOICES[i].note]));
  // sampler pads respond to MIDI notes 36..51 (MPC bank A)
  const COMPUTER_SAMPLER_KEY_MAP = Object.fromEntries(PAD_KEY_CODES.map((code, i) => [code, 36 + i]));

  function isTypingTarget(target) {
    const tag = (target?.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable;
  }

  function computerKeyToMidi(code) {
    const offset = COMPUTER_KEYBOARD_MAP[code];
    if (offset == null) return null;
    return (computerKeyboardOctave + 1) * 12 + offset;
  }

  function stopAllComputerKeyboardNotes() {
    activeComputerKeys.forEach(entry => midiNoteOff(entry.note, entry.trackId));
    activeComputerKeys.clear();
  }

  window.addEventListener("keydown", (e) => {
    if (isTypingTarget(e.target)) return;
    if (window.WAWPadMap?.handleKeyLearn(e)) return; // pad Key Learn
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector(".modal-backdrop.visible:not(#synthModal):not(#drum808Modal):not(#samplerModal)")) return;

    const activeInst = getActiveTrack()?.type === "audio" ? null : getActiveTrack()?.instrument;
    // pads can be played from every view (arrange, editor, mixer)
    if (currentView !== "editor" && currentView !== "sequencer" && activeInst !== "808" && activeInst !== "sampler") return;
    if (activeInst === "808" || activeInst === "sampler") {
      const padNote = window.WAWPadMap ? window.WAWPadMap.keyNote(e.code)
        : (activeInst === "808" ? COMPUTER_808_KEY_MAP : COMPUTER_SAMPLER_KEY_MAP)[e.code];
      if (padNote == null || e.repeat) return;
      e.preventDefault();
      if (activeInst === "808") { trigger808PadNote(padNote, e.shiftKey ? 127 : 112); return; }
      // sampler: hold the key for gate / loop pads
      if (activeComputerKeys.has(e.code)) return;
      activeComputerKeys.set(e.code, { note: padNote, trackId: getActiveTrack()?.id || null });
      midiNoteOn(padNote, e.shiftKey ? 127 : 110);
      return;
    }
    if (getActiveTrack()?.type === "audio") return;

    if (e.code === "KeyZ") {
      e.preventDefault();
      computerKeyboardOctave = Math.max(0, computerKeyboardOctave - 1);
      statusEl.textContent = `Keyboard octave: C${computerKeyboardOctave}`;
      return;
    }

    if (e.code === "KeyX") {
      e.preventDefault();
      computerKeyboardOctave = Math.min(8, computerKeyboardOctave + 1);
      statusEl.textContent = `Keyboard octave: C${computerKeyboardOctave}`;
      return;
    }

    const note = computerKeyToMidi(e.code);
    if (note == null || e.repeat || activeComputerKeys.has(e.code)) return;

    e.preventDefault();
    activeComputerKeys.set(e.code, {
      note,
      trackId: getActiveTrack()?.id || null
    });
    midiNoteOn(note, 105);
  });

  window.addEventListener("keyup", (e) => {
    const entry = activeComputerKeys.get(e.code);
    if (!entry) return;
    e.preventDefault();
    activeComputerKeys.delete(e.code);
    midiNoteOff(entry.note, entry.trackId);
  });

  window.addEventListener("blur", stopAllComputerKeyboardNotes);

  function midiNoteOn(note, velocity) {
    const track = getActiveTrack();
    const trackId = track?.id || null;
    activeMidiKeys.add(note);
    activePreviewNotes.set(note, trackId);
    updateChordFromActiveKeys();

    // Preview sound
    previewNoteOn(note, velocity, track);

    // If we are recording, add / update a MIDI note in the piano roll.
    if (isRecording && audioCtx) {
      const now = audioCtx.currentTime;
      let t = Math.max(0, now - recordingStartTime);
      let songSec = recordingBaseSec + t;
      if (recordingLoopLen > 0) {
        songSec = recordingBaseSec + (t % recordingLoopLen);
      }
      const tSong = songSec;

      if (!midiActiveNotes.has(note)) {
        midiActiveNotes.set(note, {
          startSec: tSong,
          velocity: velocity || 100,
          trackIndex: activeTrackIndex
        });
      }
    }

    drawPianoRoll();
    drawVelocityLane();
  }

  function midiNoteOff(note, trackId = activePreviewNotes.get(note)) {
  activeMidiKeys.delete(note);
  activePreviewNotes.delete(note);
  updateChordFromActiveKeys();
  previewNoteOff(note, trackId);

  // If recording, finalize this MIDI note into the piano roll
  if (isRecording && audioCtx) {
    const info = midiActiveNotes.get(note);
    if (info) {
      const now = audioCtx.currentTime;
      let t = now - recordingStartTime;      // elapsed since record start
      let songSec = recordingBaseSec + t;

      if (recordingLoopLen > 0) {
        songSec = recordingBaseSec + (t % recordingLoopLen);
      }

      const tSong = songSec;
      const end = Math.max(tSong, info.startSec + 0.05);

      const midiNote = note;
      const degObj = getScaleDegreeInfo(midiNote, tonicSemitone, scalePattern);
      const targetTrack = tracks[info.trackIndex] || getActiveTrack();
      const targetNotes = targetTrack?.notes || notes;

      targetNotes.push(new NoteEvent(
        info.startSec,
        end,
        midiNote,
        info.velocity || 100,
        degObj.degree,
        degObj.octave
      ));
      if (targetTrack === tracks[activeTrackIndex]) notes = targetNotes;

      midiActiveNotes.delete(note);
      updateTimeView();
    }
  }

  drawPianoRoll();
  drawVelocityLane();
}


  function updateChordFromActiveKeys() {
    if (!activeMidiKeys.size) {
      currentChordLabel = "Velocity";
      return;
    }
    const notesArr = Array.from(activeMidiKeys).sort((a, b) => a - b);
    const names = notesArr.map(midiToNoteName);
    if (notesArr.length === 1) {
      currentChordLabel = "Note: " + names[0];
    } else {
      const pcs = notesArr.map(n => {
        const nm = midiToNoteName(n);
        return nm.replace(/\d+$/, "");
      });
      currentChordLabel = "Chord: " + pcs.join("–");
    }
  }

  function synthVoiceOn(midiNote, velocity, track = getActiveTrack()) {
    const ctx = ensureAudioContext();
    const trackId = track?.id || "active";
    const voiceKey = `${trackId}:${midiNote}`;
    synthVoiceOff(midiNote, trackId);
    const patch = window.WAWSynth.fullPatch(track?.synthPatch || synthState);
    // mono mode: one voice per track, gliding from the previous note
    if (patch.polyMode === "mono") {
      [...synthVoices.keys()].filter(k => k.startsWith(trackId + ":")).forEach(k => {
        synthVoiceOff(Number(k.split(":")[1]), trackId);
      });
    }
    const previousNote = synthLastNoteByTrack.get(trackId);
    const dest = window.WAWMixer?.getTrackInput(track) || synthMasterGain;
    const voice = window.WAWSynth.buildSynthVoice(ctx, dest, midiNote, velocity, patch, ctx.currentTime, null, {
      glideFrom: Number.isFinite(previousNote) ? previousNote : undefined
    });
    synthLastNoteByTrack.set(trackId, midiNote);
    synthVoices.set(voiceKey, voice);
  }

  function synthVoiceOff(midiNote, trackId = getActiveTrack()?.id || "active") {
    const ctx = ensureAudioContext();
    const voiceKey = `${trackId || "active"}:${midiNote}`;
    const voice = synthVoices.get(voiceKey);
    if (!voice) return;
    voice.stop(ctx.currentTime);
    synthVoices.delete(voiceKey);
  }
  
  if (contextMenu) {
    contextMenu.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;

      const action = btn.dataset.action;

      if (action === "quantizeSel") quantizeNotes(true);
      else if (action === "quantizeAll") quantizeNotes(false);
      else if (action === "humanizeSel") humanizeNotes(true);
      else if (action === "humanizeAll") humanizeNotes(false);

      // NEW: edit actions
      else if (action === "copySel") copySelectedNotes();
      else if (action === "paste") pasteClipboard(lastPlayheadSec);
      else if (action === "duplicateSel") duplicateSelectedNotes();
      else if (action === "deleteSel") deleteSelectedNotes();
      else if (seqContextTarget?.type === "clip") {
        const { trackIndex, clipId } = seqContextTarget;
        if (action === "clipQuantize") quantizeClip(trackIndex, clipId);
        else if (action === "clipHumanize") humanizeClip(trackIndex, clipId);
        else if (action === "clipCopy") copyClip(trackIndex, clipId);
        else if (action === "clipCut") cutClip(trackIndex, clipId);
        else if (action === "clipPaste") {
          const track = tracks[trackIndex];
          const clip = (track?.clips || []).find(c => c.id === clipId);
          pasteClip(trackIndex, clip?.endSec ?? lastPlayheadSec);
        }
        else if (action === "clipDuplicate") duplicateClip(trackIndex, clipId);
        else if (action === "clipRename") renameClip(trackIndex, clipId);
        else if (action === "clipOpen") {
          setActiveTrack(trackIndex, { silent: true });
          if (tracks[trackIndex]?.clips?.find(c => c.id === clipId)?.audio) window.WAWAudio.openClipEditor(trackIndex, clipId);
          else openClipInEditor(clipId);
        }
        else if (action === "clipSplit") window.WAWWorkspace?.splitClipAt(trackIndex, clipId, lastPlayheadSec);
        else if (action === "clipMute") window.WAWWorkspace?.toggleClipMute(trackIndex, clipId);
        else if (action === "audioWarp") window.WAWWarp?.setWarp(trackIndex, clipId);
        else if (action === "audioQuantize") window.WAWWarp?.quantizeAudio(trackIndex, clipId);
        else if (action === "clipTakes") window.WAWComp?.toggleTakes(trackIndex, clipId);
        else if (action === "clipFlatten") window.WAWComp?.flatten(trackIndex, clipId);
        else if (action === "clipSetLoop") setLoopToClip(trackIndex, clipId);
        else if (action === "clipClear") clearClipNotes(trackIndex, clipId);
        else if (action === "deleteClip") deleteClip(trackIndex, clipId);
      }

      seqContextTarget = null;
      hideContextMenu();
    });
  }

  // Multitrack hotkeys (the only handler for these): Alt+N = new track, Alt+1..9 = select track
  document.addEventListener("keydown", (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat) return;
    if (isTypingTarget(e.target)) return;

    // Alt+N = new track
    if (e.code === "KeyN") {
      e.preventDefault();
      addTrack();
      return;
    }

    // Alt+1..9 = select track 1..9
    if (e.code.startsWith("Digit")) {
      const n = Number(e.code.replace("Digit", ""));
      if (!Number.isFinite(n)) return;

      const idx = n - 1;
      if (tracks[idx]) {
        e.preventDefault();
        setActiveTrack(idx, { silent: true });
        renderSequencer();
        renderMixer();
      }
    }
  });

  document.addEventListener("contextmenu", (e) => {
  // Only override on our canvas area; let text inputs keep their context menu
  const target = e.target;
  if (target === pianoRollCanvas || target === velocityCanvas) {
    e.preventDefault();
  }
}, { capture: true });
