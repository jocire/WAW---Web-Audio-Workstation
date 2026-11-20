// WAW audio tracks: input devices, monitoring, recording, audio clips.
//
// Audio clip model (lives in track.clips like MIDI clips):
//   { id, name, startSec, endSec, notesSnapshot: [], audio: { sampleId, offset, gain, fadeIn, fadeOut } }
//   offset = where in the sample the clip starts (s), gain in dB, fades in s.
(function () {
  "use strict";
  const S = () => window.WAWSamples;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const LS_DEVICE = "waw.inputDevice";
  const LS_CHANNELS = "waw.inputChannels";
  const LS_LATENCY = "waw.latencyOffsetMs";

  // ---------------------------------------------------------------------------
  // Input manager
  // ---------------------------------------------------------------------------
  const input = {
    stream: null, deviceId: null, source: null, gain: null, splitter: null, merger: null,
    analyser: null, monitorTaps: new Map(), ctx: null
  };

  function settings() {
    let deviceId = "", channels = "stereo", latency = 0;
    try {
      deviceId = localStorage.getItem(LS_DEVICE) || "";
      channels = localStorage.getItem(LS_CHANNELS) || "stereo";
      latency = parseFloat(localStorage.getItem(LS_LATENCY)) || 0;
    } catch (e) {}
    return { deviceId, channels, latency };
  }
  function saveSetting(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  async function listInputs() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter(d => d.kind === "audioinput");
  }

  async function openInput() {
    const ctx = ensureAudioContext();
    const { deviceId, channels } = settings();
    if (input.stream && input.deviceId === deviceId && input.ctx === ctx) return input;
    closeInput();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        channelCount: { ideal: 2 }, latency: { ideal: 0 }
      }, video: false
    });
    input.ctx = ctx;
    input.stream = stream;
    input.deviceId = deviceId;
    input.source = ctx.createMediaStreamSource(stream);
    input.gain = ctx.createGain();
    input.gain.gain.value = parseFloat(document.getElementById("inputGainSlider")?.value ?? 1) || 1;
    // channel routing: stereo, or mono from left/right (sent to both sides)
    input.splitter = ctx.createChannelSplitter(2);
    input.merger = ctx.createChannelMerger(2);
    input.source.connect(input.splitter);
    if (channels === "left" || channels === "right") {
      const ch = channels === "left" ? 0 : 1;
      input.splitter.connect(input.merger, ch, 0);
      input.splitter.connect(input.merger, ch, 1);
    } else {
      input.splitter.connect(input.merger, 0, 0);
      input.splitter.connect(input.merger, 1, 1);
    }
    input.merger.connect(input.gain);
    input.analyser = ctx.createAnalyser();
    input.analyser.fftSize = 1024;
    input.gain.connect(input.analyser);
    syncMonitoring();
    startInputMeter();
    return input;
  }

  function closeInput() {
    input.monitorTaps.forEach(g => { try { g.disconnect(); } catch (e) {} });
    input.monitorTaps.clear();
    try { input.source?.disconnect(); input.gain?.disconnect(); } catch (e) {}
    input.stream?.getTracks().forEach(t => t.stop());
    input.stream = null; input.source = null;
  }

  /** route live input into the channel strip of every monitoring audio track */
  function syncMonitoring() {
    if (!input.gain) return;
    const want = new Set(tracks.filter(t => t.type === "audio" && t.monitor).map(t => t.id));
    input.monitorTaps.forEach((g, id) => { if (!want.has(id)) { try { g.disconnect(); } catch (e) {} input.monitorTaps.delete(id); } });
    want.forEach(id => {
      if (input.monitorTaps.has(id)) return;
      const g = input.ctx.createGain();
      input.gain.connect(g);
      g.connect(window.WAWMixer.getTrackInput(id));
      input.monitorTaps.set(id, g);
    });
  }

  async function setMonitor(track, on) {
    track.monitor = on;
    if (on) { try { await openInput(); } catch (e) { statusEl.textContent = "Input unavailable: " + e.message; track.monitor = false; } }
    syncMonitoring();
  }

  let meterRaf = null;
  function startInputMeter() {
    if (meterRaf) return;
    const buf = new Float32Array(1024);
    const tick = () => {
      meterRaf = null;
      const el = document.getElementById("inputMeterBar");
      if (input.analyser && el) {
        input.analyser.getFloatTimeDomainData(buf);
        let peak = 0; for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
        const db = peak > 0 ? 20 * Math.log10(peak) : -100;
        el.style.width = clamp((db + 60) / 60, 0, 1) * 100 + "%";
        el.classList.toggle("hot", db > -3);
      }
      if (input.stream) meterRaf = requestAnimationFrame(tick);
    };
    meterRaf = requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------------------
  // Capture (AudioWorklet recorder; used by audio tracks and the sampler)
  // ---------------------------------------------------------------------------
  async function startCapture() {
    const ctx = ensureAudioContext();
    await window.WAWFX.ensureWorklets(ctx);
    await openInput();
    const node = window.WAWFX.makeWorklet(ctx, "waw-recorder", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: "explicit" });
    if (!node) throw new Error("AudioWorklet recording is not supported in this browser");
    const chunks = [[], []];
    let startedAt = null;
    let resolveStop = null;
    node.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "started") startedAt = m.time;
      else if (m.type === "data") m.channels.forEach((c, i) => { if (i < 2) chunks[i].push(c); });
      else if (m.type === "stopped") resolveStop?.();
    };
    input.gain.connect(node);
    // keep the worklet pulled by the graph without making it audible
    const sink = ctx.createGain(); sink.gain.value = 0;
    node.connect(sink); sink.connect(ctx.destination);
    node.port.postMessage({ cmd: "start" });
    const cleanup = () => { try { input.gain.disconnect(node); } catch (e) {} try { node.disconnect(); sink.disconnect(); } catch (e) {} };
    return {
      get startedAt() { return startedAt; },
      async stop() {
        await new Promise(res => { resolveStop = res; node.port.postMessage({ cmd: "stop" }); setTimeout(res, 500); });
        cleanup();
        const len = chunks[0].reduce((a, c) => a + c.length, 0);
        if (!len) return null;
        const buf = new AudioBuffer({ numberOfChannels: 2, length: len, sampleRate: ctx.sampleRate });
        for (let ch = 0; ch < 2; ch++) {
          const d = new Float32Array(len); let o = 0;
          (chunks[ch].length ? chunks[ch] : chunks[0]).forEach(c => { d.set(c, o); o += c.length; });
          buf.copyToChannel(d, ch);
        }
        return buf;
      },
      cancel() { node.port.postMessage({ cmd: "stop" }); cleanup(); }
    };
  }

  // ---------------------------------------------------------------------------
  // Recording into audio tracks (driven by the transport in app.js)
  // ---------------------------------------------------------------------------
  let takes = null; // { tracks:[...], capture, songStart, loopLen }

  function recordTargets() {
    const armed = tracks.filter(t => t.type === "audio" && t.armed);
    if (armed.length) return armed;
    const active = getActiveTrack();
    return active?.type === "audio" ? [active] : [];
  }

  async function beginTrackRecording({ recordingStartTime, recordingBaseSec, recordingLoopLen }) {
    const targets = recordTargets();
    if (!targets.length) return false;
    try {
      const capture = await startCapture();
      takes = { tracks: targets, capture, recordingStartTime, recordingBaseSec, recordingLoopLen };
      statusEl.textContent = `Recording audio on ${targets.map(t => t.name).join(", ")}…`;
      return true;
    } catch (err) {
      statusEl.textContent = "Audio recording failed: " + err.message;
      takes = null;
      return false;
    }
  }

  function isRecordingAudio() { return !!takes; }

  async function endTrackRecording() {
    if (!takes) return;
    const t = takes; takes = null;
    const startedAt = t.capture.startedAt ?? t.recordingStartTime;
    let buf = await t.capture.stop();
    if (!buf || buf.length < 256) { statusEl.textContent = "No audio captured."; return; }
    const ctx = ensureAudioContext();
    // latency compensation: input + output latency reported by the browser + user offset
    const autoLatency = (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
    const latency = autoLatency + settings().latency / 1000;
    let songStart = t.recordingBaseSec + (startedAt - t.recordingStartTime) - latency;
    let offset = 0;
    if (songStart < 0) { offset = -songStart; songStart = 0; }
    let clipLen = buf.duration - offset;
    if (t.recordingLoopLen > 0) {
      // cycle recording: keep the last complete pass through the loop
      const passes = Math.floor((buf.duration - offset) / t.recordingLoopLen);
      if (passes >= 1) {
        offset += (passes - 1) * t.recordingLoopLen;
        clipLen = t.recordingLoopLen;
        songStart = t.recordingBaseSec;
      }
    }
    pushHistory();
    const id = await S().put(buf, `Audio ${new Date().toLocaleTimeString()}`);
    t.tracks.forEach(track => {
      addAudioClip(track, id, songStart, clipLen, offset, `Take ${(track.clips?.length || 0) + 1}`);
    });
    renderSequencer();
    window.WAWCollab?.notifyChange?.();
    statusEl.textContent = `Recorded ${clipLen.toFixed(2)} s of audio.`;
  }

  function addAudioClip(track, sampleId, startSec, lengthSec, offset = 0, name = null) {
    const clip = new Clip({ startSec, endSec: startSec + lengthSec, notesSnapshot: [] });
    clip.name = name || S().name(sampleId);
    clip.audio = { sampleId, offset, gain: 0, fadeIn: 0.005, fadeOut: 0.01 };
    track.clips = track.clips || [];
    track.clips.push(clip);
    return clip;
  }

  // ---------------------------------------------------------------------------
  // Playback
  // ---------------------------------------------------------------------------
  function isAudible(track) {
    if (!track || track.mute) return false;
    const anySolo = tracks.some(t => t.solo);
    return !anySolo || !!track.solo;
  }

  /** audio playback events overlapping [rangeStart, rangeEnd) */
  function collectAudioEvents(rangeStart, rangeEnd, { audibleOnly = false } = {}) {
    const out = [];
    tracks.forEach(t => {
      if (t.type !== "audio") return;
      if (audibleOnly && !isAudible(t)) return;
      (t.clips || []).forEach(c => {
        if (!c.audio?.sampleId || c.muted) return;
        if (c.endSec <= rangeStart || c.startSec >= rangeEnd) return;
        const start = Math.max(c.startSec, rangeStart);
        const end = Math.min(c.endSec, rangeEnd);
        out.push({
          kind: "audio", trackId: t.id, clipId: c.id, sampleId: c.audio.sampleId,
          start, end, offset: (c.audio.offset || 0) + (start - c.startSec),
          clipStart: c.startSec, clipEnd: c.endSec,
          gain: c.audio.gain || 0, fadeIn: c.audio.fadeIn || 0, fadeOut: c.audio.fadeOut || 0
        });
      });
    });
    return out;
  }

  /**
   * Schedule one audio event at absolute context time `when`
   * (for offline rendering, `when` equals the song position).
   */
  function scheduleAudioEvent(ctx, destination, ev, when, lateBy = 0) {
    const buf = S().get(ev.sampleId);
    if (!buf) { S().load(ev.sampleId); return []; }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    const level = Math.pow(10, (ev.gain || 0) / 20);
    const startT = when + lateBy;
    const songStart = ev.start + lateBy;
    const dur = ev.end - songStart;
    if (dur <= 0.001) return [];
    const offset = ev.offset + lateBy;
    if (offset >= buf.duration) return [];
    // fades are defined relative to the clip edges
    const fadeInEnd = ev.clipStart + ev.fadeIn;
    const fadeOutStart = ev.clipEnd - ev.fadeOut;
    const levelAt = (songT) => {
      let l = level;
      if (ev.fadeIn > 0 && songT < fadeInEnd) l *= clamp((songT - ev.clipStart) / ev.fadeIn, 0, 1);
      if (ev.fadeOut > 0 && songT > fadeOutStart) l *= clamp((ev.clipEnd - songT) / ev.fadeOut, 0, 1);
      return l;
    };
    g.gain.setValueAtTime(levelAt(songStart), startT);
    if (ev.fadeIn > 0 && songStart < fadeInEnd) g.gain.linearRampToValueAtTime(level, startT + (fadeInEnd - songStart));
    if (ev.fadeOut > 0 && ev.end > fadeOutStart) {
      const fs = Math.max(songStart, fadeOutStart);
      g.gain.setValueAtTime(levelAt(fs), startT + (fs - songStart));
      g.gain.linearRampToValueAtTime(levelAt(ev.end), startT + dur);
    }
    src.connect(g); g.connect(destination);
    src.start(startT, offset, Math.min(dur, buf.duration - offset));
    return [src];
  }

  // ---------------------------------------------------------------------------
  // Clip helpers used by the sequencer (app.js)
  // ---------------------------------------------------------------------------
  function sampleDuration(clip) { return S().get(clip.audio?.sampleId)?.duration ?? Infinity; }

  /** keep audio content anchored in time while trimming either edge */
  function trimAudioClip(clip, origStart, origEnd, origOffset) {
    if (!clip.audio) return;
    const dur = sampleDuration(clip);
    // left edge: content stays put, so the offset moves with the edge
    let newOffset = origOffset + (clip.startSec - origStart);
    if (newOffset < 0) { clip.startSec -= newOffset; newOffset = 0; }
    clip.audio.offset = newOffset;
    // right edge cannot extend past the end of the sample
    const maxEnd = clip.startSec + (dur - newOffset);
    if (clip.endSec > maxEnd) clip.endSec = maxEnd;
    if (clip.endSec <= clip.startSec + 0.01) clip.endSec = clip.startSec + 0.01;
  }

  function drawClipWave(canvas, clip, color) {
    const a = clip.audio;
    if (!a?.sampleId) return;
    if (!S().has(a.sampleId)) { S().load(a.sampleId).then(b => b && canvas.isConnected && drawClipWave(canvas, clip, color)); return; }
    S().drawWaveform(canvas, a.sampleId, { start: a.offset, end: a.offset + (clip.endSec - clip.startSec), color: color || "rgba(255,255,255,0.8)", gain: Math.pow(10, (a.gain || 0) / 20) });
  }

  async function importFilesToTrack(files, trackIndex, atSec) {
    let track = tracks[trackIndex];
    if (!track || track.type !== "audio") {
      track = createTrack(null, { type: "audio" });
      track.name = `Audio ${tracks.filter(t => t.type === "audio").length + 1}`;
      tracks.push(track);
    }
    pushHistory();
    let pos = Math.max(0, atSec);
    for (const f of files) {
      try {
        const id = await S().importFile(f);
        const buf = S().get(id);
        addAudioClip(track, id, pos, buf.duration, 0, S().name(id));
        pos += buf.duration;
      } catch (err) {
        statusEl.textContent = `Could not import ${f.name}: ${err.message}`;
      }
    }
    setActiveTrack(tracks.indexOf(track), { silent: true });
    renderSidebarTracks(); renderSequencer(); renderMixer();
    window.WAWCollab?.notifyChange?.();
  }

  // ---------------------------------------------------------------------------
  // Audio clip editor (gain, fades, destructive tools)
  // ---------------------------------------------------------------------------
  let editorModal = null;
  function openClipEditor(trackIndex, clipId) {
    const track = tracks[trackIndex];
    const clip = track?.clips?.find(c => c.id === clipId);
    if (!clip?.audio) return;
    if (!editorModal) {
      editorModal = document.createElement("div");
      editorModal.className = "modal-backdrop";
      editorModal.id = "audioClipModal";
      editorModal.innerHTML = `<div class="modal-dialog audio-clip-dialog"><div class="modal-header"><span class="acm-title">Audio Clip</span><button type="button" class="acm-close">×</button></div><div class="acm-body"></div></div>`;
      document.body.appendChild(editorModal);
      editorModal.addEventListener("click", e => { if (e.target === editorModal) editorModal.classList.remove("visible"); });
      editorModal.querySelector(".acm-close").addEventListener("click", () => editorModal.classList.remove("visible"));
    }
    const body = editorModal.querySelector(".acm-body");
    editorModal.querySelector(".acm-title").textContent = `Audio Clip · ${clip.name || ""}`;
    const render = () => {
      body.innerHTML = `
        <div class="acm-wave"><canvas></canvas></div>
        <div class="acm-info">${(clip.endSec - clip.startSec).toFixed(2)} s · source "${escapeHtml(S().name(clip.audio.sampleId))}" · offset ${clip.audio.offset.toFixed(3)} s</div>
        <div class="acm-knobs"></div>
        <div class="smp-tools">
          <button type="button" data-op="normalize">Normalize</button>
          <button type="button" data-op="reverse">Reverse</button>
          <button type="button" data-op="silence">Silence</button>
          <button type="button" data-op="toPad">Send to Sampler Pad…</button>
          <button type="button" data-op="export">Export WAV</button>
        </div>`;
      requestAnimationFrame(() => drawClipWave(body.querySelector("canvas"), clip, "rgba(96,165,250,0.9)"));
      const knobs = body.querySelector(".acm-knobs");
      const K = (key, label, min, max, step, fmt, log = false) => knobs.appendChild(window.WAWMixer.createKnob({
        label, min, max, step, log, size: "lg", value: clip.audio[key], default: key === "gain" ? 0 : 0.005, format: fmt,
        onChange: v => { clip.audio[key] = v; renderSequencer(); }
      }));
      K("gain", "Clip Gain", -36, 18, 0.1, v => (v > 0 ? "+" : "") + v.toFixed(1) + " dB");
      K("fadeIn", "Fade In", 0, Math.max(0.01, (clip.endSec - clip.startSec) / 2), 0.001, v => (v * 1000).toFixed(0) + " ms");
      K("fadeOut", "Fade Out", 0, Math.max(0.01, (clip.endSec - clip.startSec) / 2), 0.001, v => (v * 1000).toFixed(0) + " ms");
      body.querySelectorAll("[data-op]").forEach(b => b.addEventListener("click", async () => {
        const op = b.dataset.op;
        const region = { start: clip.audio.offset, end: clip.audio.offset + (clip.endSec - clip.startSec) };
        if (op === "export") {
          const raw = await S().getRaw(clip.audio.sampleId);
          if (raw) downloadBlob(new Blob([raw.wav], { type: "audio/wav" }), `${(clip.name || "clip").replace(/[^a-z0-9._-]+/gi, "_")}.wav`);
          return;
        }
        if (op === "toPad") {
          const samplers = tracks.filter(t => t.instrument === "sampler" && t.type !== "audio");
          let target = samplers[0];
          if (!target) {
            target = createTrack("Sampler", { instrument: "sampler" });
            tracks.push(target);
          }
          const padNo = parseInt(prompt(`Pad number (1-16) on "${target.name}":`, String((target.samplerPatch.selected || 0) + 1)), 10);
          if (!(padNo >= 1 && padNo <= 16)) return;
          pushHistory();
          const id = await S().edit(clip.audio.sampleId, "crop", region);
          target.samplerPatch.pads[padNo - 1] = { ...window.WAWSampler.defaultPad(padNo - 1), sampleId: id, name: clip.name || "Clip" };
          renderSidebarTracks(); renderMixer(); renderSequencer();
          statusEl.textContent = `Sent clip to pad ${padNo} of "${target.name}".`;
          window.WAWCollab?.notifyChange?.();
          return;
        }
        pushHistory();
        const id = await S().edit(clip.audio.sampleId, op, region);
        if (id) clip.audio.sampleId = id;
        renderSequencer(); render();
        window.WAWCollab?.notifyChange?.();
      }));
    };
    render();
    editorModal.classList.add("visible");
  }

  // ---------------------------------------------------------------------------
  // Input panel UI (device / channels / latency / meter)
  // ---------------------------------------------------------------------------
  async function buildInputPanel() {
    const host = document.getElementById("audioInputSettings");
    if (!host) return;
    const s = settings();
    host.innerHTML = `
      <div class="subsection-title">Audio Input</div>
      <label class="stack">Device<select id="inputDeviceSelect"><option value="">Default input</option></select></label>
      <label class="stack">Channels<select id="inputChannelSelect">
        <option value="stereo">Stereo (1+2)</option><option value="left">Mono — input 1</option><option value="right">Mono — input 2</option></select></label>
      <label class="stack">Latency offset <span id="latencyVal">${s.latency} ms</span><input type="range" id="latencySlider" min="-200" max="200" step="1" value="${s.latency}"></label>
      <div class="input-meter"><div id="inputMeterBar"></div></div>
      <button type="button" id="inputEnableBtn">Enable input</button>`;
    const devSel = host.querySelector("#inputDeviceSelect");
    const fill = async () => {
      const list = await listInputs();
      devSel.innerHTML = `<option value="">Default input</option>` + list.map((d, i) => `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(d.label || `Input ${i + 1}`)}</option>`).join("");
      devSel.value = settings().deviceId;
    };
    fill();
    navigator.mediaDevices?.addEventListener?.("devicechange", fill);
    devSel.addEventListener("change", async () => { saveSetting(LS_DEVICE, devSel.value); if (input.stream) { closeInput(); await openInput().catch(() => {}); } });
    const chSel = host.querySelector("#inputChannelSelect");
    chSel.value = s.channels;
    chSel.addEventListener("change", async () => { saveSetting(LS_CHANNELS, chSel.value); if (input.stream) { closeInput(); await openInput().catch(() => {}); } });
    const lat = host.querySelector("#latencySlider");
    lat.addEventListener("input", () => { saveSetting(LS_LATENCY, lat.value); host.querySelector("#latencyVal").textContent = lat.value + " ms"; });
    host.querySelector("#inputEnableBtn").addEventListener("click", async () => {
      try { await openInput(); await fill(); statusEl.textContent = "Audio input enabled."; }
      catch (e) { statusEl.textContent = "Input unavailable: " + e.message; }
    });
    document.getElementById("inputGainSlider")?.addEventListener("input", (e) => {
      if (input.gain) input.gain.gain.value = parseFloat(e.target.value) || 0;
    });
  }

  document.addEventListener("DOMContentLoaded", buildInputPanel);

  window.WAWAudio = {
    listInputs, openInput, closeInput, setMonitor, syncMonitoring, startCapture,
    beginTrackRecording, endTrackRecording, isRecordingAudio, recordTargets,
    addAudioClip, collectAudioEvents, scheduleAudioEvent, trimAudioClip, drawClipWave,
    importFilesToTrack, openClipEditor, sampleDuration
  };
})();
