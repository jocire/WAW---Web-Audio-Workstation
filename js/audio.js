// WAW audio tracks: input devices, monitoring, recording, audio clips.
//
// Audio clip model (lives in track.clips like MIDI clips):
//   { id, name, startSec, endSec, notesSnapshot: [], audio: { sampleId, offset, gain, fadeIn, fadeOut } }
//   offset = where in the sample the clip starts (s), gain in dB, fades in s.
(function () {
  "use strict";
  const S = () => window.WAWSamples;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const dbToGain = db => Math.pow(10, db / 20);
  const LS_DEVICE = "waw.inputDevice";
  const LS_CHANNELS = "waw.inputChannels";
  const LS_LATENCY = "waw.latencyOffsetMs";

  // ---------------------------------------------------------------------------
  // Input engine
  //
  // Every audio track has its own input routing (track.input):
  //   { deviceId: "" = default input, channel: "auto" | "stereo" | "1".."8",
  //     gainDb: input gain (-24..+40), processing: browser auto-gain/noise
  //     suppression on/off }
  // Physical devices are opened once and shared by all tracks that use them;
  // each track gets its own channel routing, gain, meter, monitor tap and
  // recorder. A device is closed when no armed/monitoring track needs it.
  // ---------------------------------------------------------------------------
  const devices = new Map();      // key -> { key, deviceId, processing, ctx, stream, source, splitter, channels, label }
  const trackInputs = new Map();  // owner id -> { owner, dev, cfgSig, merger, gain, analyser, tap }
  const knownChannels = new Map(); // deviceId -> channel count (for the UI)

  function settings() {
    let deviceId = "", channels = "auto", latency = 0;
    try {
      deviceId = localStorage.getItem(LS_DEVICE) || "";
      channels = localStorage.getItem(LS_CHANNELS) || "auto";
      latency = parseFloat(localStorage.getItem(LS_LATENCY)) || 0;
    } catch (e) {}
    return { deviceId, channels, latency };
  }
  function saveSetting(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  /** default routing for a new audio track: the device chosen in the Audio Input panel */
  function defaultInputCfg() {
    const s = settings();
    return { deviceId: s.deviceId, channel: s.channels === "left" ? "1" : s.channels === "right" ? "2" : (s.channels || "auto"), gainDb: 0, processing: false };
  }
  function inputCfg(track) {
    if (!track.input || typeof track.input !== "object") track.input = defaultInputCfg();
    const i = track.input;
    if (typeof i.deviceId !== "string") i.deviceId = "";
    if (!i.channel) i.channel = "auto";
    if (!Number.isFinite(i.gainDb)) i.gainDb = 0;
    i.processing = !!i.processing;
    return i;
  }

  async function listInputs() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter(d => d.kind === "audioinput" && d.deviceId !== "communications");
  }

  /**
   * Raw input stream. Falls back to the default device when the saved id is
   * stale (ids change after permission resets / replugging).
   * Note: no `latency` / `channelCount` *requirements* — some USB devices
   * were opened in a bad configuration with them.
   */
  async function getInputStream(deviceId, processing = false) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("this browser has no microphone access (needs HTTPS or localhost)");
    const constraints = (id) => ({
      audio: {
        deviceId: id ? { exact: id } : undefined,
        echoCancellation: processing, noiseSuppression: processing, autoGainControl: processing,
        channelCount: { ideal: 2 }
      }, video: false
    });
    try {
      return await navigator.mediaDevices.getUserMedia(constraints(deviceId));
    } catch (err) {
      if (deviceId && (err.name === "OverconstrainedError" || err.name === "NotFoundError" || err.name === "NotReadableError")) {
        console.warn("input device unavailable, using the default input", err);
        statusEl.textContent = "Selected input not found, using the default input.";
        return navigator.mediaDevices.getUserMedia(constraints(""));
      }
      throw err;
    }
  }

  function deviceKey(deviceId, processing) { return (deviceId || "default") + (processing ? "|proc" : ""); }

  async function openDevice(deviceId, processing) {
    const ctx = ensureAudioContext();
    if (ctx.state !== "running") { try { await ctx.resume(); } catch (e) {} }
    const key = deviceKey(deviceId, processing);
    let d = devices.get(key);
    if (d && d.ctx === ctx && d.stream.active) return d.ready || d;
    if (d) closeDevice(d);
    d = { key, deviceId, processing, ctx };
    devices.set(key, d);
    d.ready = (async () => {
      const stream = await getInputStream(deviceId, processing);
      const tr = stream.getAudioTracks()[0];
      const source = ctx.createMediaStreamSource(stream);
      const channels = clamp(tr?.getSettings?.().channelCount || source.channelCount || 2, 1, 32);
      const splitter = ctx.createChannelSplitter(Math.max(2, channels));
      source.connect(splitter);
      Object.assign(d, { stream, source, splitter, channels, label: tr?.label || "Input" });
      knownChannels.set(deviceId || "", channels);
      // device names/ids are only exposed after permission: refresh the menus
      if (!deviceList.some(x => x.label)) refreshDeviceList().then(refreshInputUi);
      // a device that disappears (unplugged) ends its track
      tr?.addEventListener("ended", () => { if (devices.get(key) === d) { closeDevice(d); statusEl.textContent = `Input "${d.label}" disconnected.`; } });
      delete d.ready;
      return d;
    })();
    try { return await d.ready; }
    catch (err) { if (devices.get(key) === d) devices.delete(key); throw err; }
  }

  function closeDevice(d) {
    trackInputs.forEach((ti, id) => { if (ti.dev === d) releaseInput(id); });
    try { d.source?.disconnect(); d.splitter?.disconnect(); } catch (e) {}
    d.stream?.getTracks().forEach(t => t.stop());
    if (devices.get(d.key) === d) devices.delete(d.key);
  }

  function routeSig(cfg) { return [deviceKey(cfg.deviceId, cfg.processing), cfg.channel].join("#"); }

  /** per-track (or per-owner) input chain: device channel(s) -> merger -> gain -> meter/recorder/monitor */
  async function acquireInput(ownerId, cfg) {
    const ctx = ensureAudioContext();
    const sig = routeSig(cfg);
    let ti = trackInputs.get(ownerId);
    if (ti && ti.cfgSig === sig && ti.dev.ctx === ctx && devices.get(ti.dev.key) === ti.dev) {
      ti.gain.gain.setTargetAtTime(dbToGain(cfg.gainDb), ctx.currentTime, 0.01);
      return ti;
    }
    if (ti) releaseInput(ownerId);
    const dev = await openDevice(cfg.deviceId, cfg.processing);
    // another call may have won the race while the device was opening
    const again = trackInputs.get(ownerId);
    if (again && again.cfgSig === sig && again.dev === dev) return again;
    if (again) releaseInput(ownerId);
    const merger = ctx.createChannelMerger(2);
    const ch = cfg.channel;
    const n = dev.channels;
    if (ch === "stereo" || (ch === "auto" && n >= 2)) {
      dev.splitter.connect(merger, 0, 0);
      dev.splitter.connect(merger, n >= 2 ? 1 : 0, 1);
    } else {
      // mono: one physical channel to both sides (auto + mono device = channel 1)
      const idx = ch === "auto" ? 0 : clamp((parseInt(ch, 10) || 1) - 1, 0, Math.max(0, n - 1));
      dev.splitter.connect(merger, idx, 0);
      dev.splitter.connect(merger, idx, 1);
    }
    const gain = ctx.createGain();
    gain.gain.value = dbToGain(cfg.gainDb);
    merger.connect(gain);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    gain.connect(analyser);
    ti = { owner: ownerId, dev, cfgSig: sig, merger, gain, analyser, tap: null, peakHold: -100, createdAt: performance.now() };
    trackInputs.set(ownerId, ti);
    startMeters();
    return ti;
  }

  function releaseInput(ownerId) {
    const ti = trackInputs.get(ownerId);
    if (!ti) return;
    trackInputs.delete(ownerId);
    try { ti.tap?.disconnect(); } catch (e) {}
    try { ti.gain.disconnect(); ti.merger.disconnect(); } catch (e) {}
    try { ti.dev.splitter.disconnect(ti.merger); } catch (e) {}
  }

  function closeUnusedDevices() {
    const used = new Set([...trackInputs.values()].map(ti => ti.dev));
    devices.forEach(d => { if (!used.has(d) && !d.ready) closeDevice(d); });
  }

  /** which tracks need a live input: armed or monitoring audio tracks */
  function needsInput(t) { return t.type === "audio" && (t.armed || t.monitor); }

  let syncing = Promise.resolve();
  /** open/close inputs and monitor taps so they match the tracks' arm/monitor/routing state */
  function syncInputs() {
    syncing = syncing.then(async () => {
      const want = tracks.filter(needsInput);
      const wantIds = new Set(want.map(t => t.id));
      [...trackInputs.keys()].forEach(id => { if (!id.startsWith("__") && !wantIds.has(id) && !captures.has(id)) releaseInput(id); });
      for (const t of want) {
        try {
          const ti = await acquireInput(t.id, inputCfg(t));
          setTap(ti, t);
        } catch (err) {
          statusEl.textContent = `Input for "${t.name}" unavailable: ${err.message}`;
          if (t.monitor) t.monitor = false;
        }
      }
      closeUnusedDevices();
      refreshInputUi();
    }).catch(e => console.warn(e));
    return syncing;
  }

  function setTap(ti, track) {
    const on = !!track.monitor;
    if (on && !ti.tap) {
      ti.tap = ti.gain.context.createGain();
      ti.gain.connect(ti.tap);
      ti.tap.connect(window.WAWMixer.getTrackInput(track.id));
    } else if (!on && ti.tap) {
      try { ti.tap.disconnect(); } catch (e) {}
      try { ti.gain.disconnect(ti.tap); } catch (e) {}
      ti.tap = null;
    }
  }

  /** the mixer rebuilt its graph: reconnect monitor taps to the new channel strips */
  function resetMonitoring() {
    trackInputs.forEach(ti => { try { ti.tap?.disconnect(); } catch (e) {} try { if (ti.tap) ti.gain.disconnect(ti.tap); } catch (e) {} ti.tap = null; });
    syncInputs();
  }
  const syncMonitoring = () => syncInputs();

  async function setMonitor(track, on) {
    track.monitor = on;
    await syncInputs();
  }

  function setTrackInput(track, patch) {
    Object.assign(inputCfg(track), patch);
    const ti = trackInputs.get(track.id);
    if (ti && Object.keys(patch).length === 1 && "gainDb" in patch) {
      ti.gain.gain.setTargetAtTime(dbToGain(track.input.gainDb), ti.gain.context.currentTime, 0.01);
      return;
    }
    if (needsInput(track)) syncInputs();
  }

  // ---- metering -------------------------------------------------------------
  const meterBuf = new Float32Array(2048);
  function readLevel(ti) {
    ti.analyser.getFloatTimeDomainData(meterBuf);
    let peak = 0;
    for (let i = 0; i < meterBuf.length; i++) { const v = Math.abs(meterBuf[i]); if (v > peak) peak = v; }
    const db = peak > 0 ? 20 * Math.log10(peak) : -100;
    const now = performance.now();
    if (db > ti.peakHold || now - (ti.peakAt || 0) > 1500) { ti.peakHold = db; ti.peakAt = now; }
    if (db > -60) ti.lastSignalAt = now;
    return db;
  }
  let meterRaf = null;
  function startMeters() {
    if (meterRaf) return;
    const tick = () => {
      meterRaf = null;
      document.querySelectorAll("[data-input-meter]").forEach(el => {
        const ti = trackInputs.get(el.dataset.inputMeter);
        const bar = el.querySelector(".im-bar"), txt = el.querySelector(".im-db");
        const panel = el.closest(".audio-track-panel");
        if (!ti) { if (bar) bar.style.width = "0%"; if (txt) txt.textContent = "off"; el.classList.remove("low", "hot"); panel?.classList.remove("no-signal"); return; }
        const db = readLevel(ti);
        if (bar) bar.style.width = clamp((db + 60) / 60, 0, 1) * 100 + "%";
        if (txt) txt.textContent = ti.peakHold <= -99 ? "-∞ dB" : ti.peakHold.toFixed(0) + " dB";
        el.classList.toggle("hot", ti.peakHold > -3);
        // nothing above -50 dBFS for a while: the input is (nearly) silent
        const low = performance.now() - (ti.lastSignalAt || ti.createdAt || 0) > 3000 && ti.peakHold < -50;
        el.classList.toggle("low", low);
        panel?.classList.toggle("no-signal", low);
      });
      if (trackInputs.size) meterRaf = requestAnimationFrame(tick);
    };
    meterRaf = requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------------------
  // Capture (AudioWorklet recorder) from any input chain
  // ---------------------------------------------------------------------------
  const captures = new Map(); // owner id -> capture (keeps its input alive)

  /**
   * Record from an input chain. Prefer AudioWorklet, but keep a ScriptProcessor
   * fallback for browser/device combinations where the Worklet does not deliver
   * input. Both paths overlap only during a short startup probe; the unused path
   * is disconnected before the take continues.
  async function captureFrom(ti) {
    const ctx = ti.gain.context;
    const diag = {
      device: ti.dev.label, deviceSettings: (() => { try { const s = ti.dev.stream.getAudioTracks()[0].getSettings(); return { sampleRate: s.sampleRate, channelCount: s.channelCount, autoGainControl: s.autoGainControl, echoCancellation: s.echoCancellation }; } catch (e) { return null; } })(),
      trackState: ti.dev.stream.getAudioTracks()[0]?.readyState, trackMuted: ti.dev.stream.getAudioTracks()[0]?.muted,
      ctxRate: ctx.sampleRate, ctxState: ctx.state, baseLatency: ctx.baseLatency, outputLatency: ctx.outputLatency,
      worklet: false, workletFrames: 0, workletPeak: 0, backupFrames: 0, backupPeak: 0, used: null,
      recorderProbeMs: 0
    };
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);

    const PEAK_BLOCK = 256;
    const PROBE_TIMEOUT_MS = 400;
    const wChunks = [[], []], bChunks = [[], []];
    const livePeaks = { worklet: [], backup: [] };
    let node = null, sp = null, bRecording = true;
    let wStartedAt = null, bStartedAt = null, resolveStop = null;
    let selected = null, resolveProbe = null, probeTimer = null;
    const probeStarted = performance.now();

    const addPeaks = (arr, d) => {
      for (let i = 0; i < d.length; i += PEAK_BLOCK) {
        let mn = 0, mx = 0;
        const end = Math.min(d.length, i + PEAK_BLOCK);
        for (let j = i; j < end; j++) { const v = d[j]; if (v < mn) mn = v; if (v > mx) mx = v; }
        arr.push(mn, mx);
      }
    };
    const stopBackup = (discardProbeData = true) => {
      bRecording = false;
      if (sp) {
        try { ti.gain.disconnect(sp); sp.disconnect(); } catch (e) {}
        sp.onaudioprocess = null;
        sp = null;
      }
      // The backup is needed only during the short compatibility probe.
      if (discardProbeData) {
        bChunks[0].length = 0; bChunks[1].length = 0;
        livePeaks.backup.length = 0;
      }
    };
    const stopWorklet = () => {
      if (!node) return;
      try { node.port.postMessage({ cmd: "stop" }); } catch (e) {}
      try { ti.gain.disconnect(node); node.disconnect(); } catch (e) {}
      node.port.onmessage = null;
      node = null;
    };

    try {
      const available = await window.WAWFX.ensureWorklets(ctx);
      if (available) node = window.WAWFX.makeWorklet(ctx, "waw-recorder", {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        channelCount: 2, channelCountMode: "explicit"
      });
    } catch (e) {
      console.warn("WAW recorder Worklet setup failed; using ScriptProcessor fallback.", e);
    }

    // Keep the legacy path alive only during the short data probe. Worklet
    // module loading is complete before this overlap begins.
    try {
      sp = ctx.createScriptProcessor ? ctx.createScriptProcessor(4096, 2, 2) : null;
    } catch (e) { sp = null; }
    if (sp) {
      sp.onaudioprocess = (e) => {
        if (!bRecording || selected === "worklet") return;
        const ib = e.inputBuffer;
        if (bStartedAt == null) bStartedAt = e.playbackTime - 3 * 4096 / ctx.sampleRate;
        for (let ch = 0; ch < 2; ch++) {
          const d = new Float32Array(ib.getChannelData(Math.min(ch, ib.numberOfChannels - 1)));
          bChunks[ch].push(d);
          if (ch === 0) {
            diag.backupFrames += d.length;
            addPeaks(livePeaks.backup, d);
            for (let k = 0; k < d.length; k += 16) { const v = Math.abs(d[k]); if (v > diag.backupPeak) diag.backupPeak = v; }
          }
        }
      };
      ti.gain.connect(sp);
      sp.connect(sink);
    }

    if (node) {
      diag.worklet = true;
      node.port.onmessage = (e) => {
        const m = e.data;
        if (m.type === "started") wStartedAt = m.time;
        else if (m.type === "data") {
          // The first complete batch is the compatibility probe. After it
          // arrives, only the Worklet records and the backup buffers are freed.
          if (selected === "backup") return;
          if (!selected) {
            selected = "worklet";
            diag.recorderProbeMs = Math.round(performance.now() - probeStarted);
            stopBackup();
            resolveProbe?.();
          }
          m.channels.forEach((c, i) => {
            if (i >= 2) return;
            wChunks[i].push(c);
            if (i === 0) {
              diag.workletFrames += c.length;
              addPeaks(livePeaks.worklet, c);
            }
            for (let k = 0; k < c.length; k += 16) {
              const v = Math.abs(c[k]);
              if (v > diag.workletPeak) diag.workletPeak = v;
            }
          });
        } else if (m.type === "stopped") resolveStop?.();
      };
      ti.gain.connect(node);
      node.connect(sink);
      node.port.postMessage({ cmd: "start" });
      await new Promise(resolve => {
        resolveProbe = resolve;
        probeTimer = setTimeout(() => {
          if (!selected) {
            selected = sp ? "backup" : null;
            diag.recorderProbeMs = Math.round(performance.now() - probeStarted);
            stopWorklet();
          }
          resolve();
        }, PROBE_TIMEOUT_MS);
        // A data message may arrive before the timer is assigned.
        if (selected) { clearTimeout(probeTimer); resolve(); }
      });
      clearTimeout(probeTimer);
      resolveProbe = null;
    } else {
      selected = sp ? "backup" : null;
    }

    if (!selected) {
      stopBackup();
      sink.disconnect();
      throw new Error("this browser cannot record audio (no working AudioWorklet / ScriptProcessor)");
    }
    if (selected === "backup") {
      // Worklet did not deliver its first batch in time. Keep the backup as the
      // sole recorder for this take; do not retain a second full recording.
      stopWorklet();
      diag.used = "backup";
    } else {
      diag.used = "worklet";
    }

    const cleanup = () => {
      stopBackup(false);
      stopWorklet();
      try { sink.disconnect(); } catch (e) {}
    };
    const toBuffer = (chunks) => {
      const len = chunks[0].reduce((a, c) => a + c.length, 0);
      if (!len) return null;
      const buf = new AudioBuffer({ numberOfChannels: 2, length: len, sampleRate: ctx.sampleRate });
      for (let ch = 0; ch < 2; ch++) {
        const d = new Float32Array(len);
        let o = 0;
        (chunks[ch].length ? chunks[ch] : chunks[0]).forEach(c => { d.set(c, o); o += c.length; });
        buf.copyToChannel(d, ch);
      }
      return buf;
    };
    const activeChunks = () => selected === "backup" ? bChunks : wChunks;
    const activePeaks = () => selected === "backup" ? livePeaks.backup : livePeaks.worklet;
    return {
      diag,
      live() { return { peaks: activePeaks(), block: PEAK_BLOCK, rate: ctx.sampleRate }; },
      get startedAt() { return selected === "backup" ? bStartedAt : wStartedAt; },
      get peak() { return selected === "backup" ? diag.backupPeak : diag.workletPeak; },
      async stop() {
        if (selected === "worklet" && node) {
          await new Promise(res => {
            resolveStop = res;
            node.port.postMessage({ cmd: "stop" });
            setTimeout(res, 500);
          });
        }
        const chunks = activeChunks();
        const buffer = toBuffer(chunks);
        chunks[0].length = 0; chunks[1].length = 0;
        cleanup();
        diag.used = selected;
        lastDiagnostics = { ...diag, at: new Date().toISOString() };
        return buffer;
      },
      cancel() {
        cleanup();
        wChunks[0].length = 0; wChunks[1].length = 0;
        bChunks[0].length = 0; bChunks[1].length = 0;
      }
    };
  }
  let lastDiagnostics = null;

  /** capture from the default input (used by the sampler's pad recording) */
  async function startCapture(ownerId = "__sampler") {
    const ti = await acquireInput(ownerId, defaultInputCfg());
    const cap = await captureFrom(ti);
    const stop = cap.stop.bind(cap), cancel = cap.cancel.bind(cap);
    cap.stop = async () => { try { return await stop(); } finally { releaseInput(ownerId); closeUnusedDevices(); } };
    cap.cancel = () => { cancel(); releaseInput(ownerId); closeUnusedDevices(); };
    return cap;
  }

  // ---------------------------------------------------------------------------
  // Recording into audio tracks (driven by the transport in app.js)
  // Each armed track records its own input.
  // ---------------------------------------------------------------------------
  let takes = null;        // { items:[{track, capture}], recordingStartTime, recordingBaseSec, recordingLoopLen }
  let pendingBegin = null; // inputs still opening (permission prompt, worklet load)

  function recordTargets() {
    const armed = tracks.filter(t => t.type === "audio" && t.armed);
    if (armed.length) return armed;
    // the selected audio track only records when nothing at all is armed
    // (arming MIDI tracks must not also open a microphone)
    if (tracks.some(t => t.armed)) return [];
    const active = getActiveTrack();
    return active?.type === "audio" ? [active] : [];
  }

  async function beginTrackRecording({ recordingStartTime, recordingBaseSec, recordingLoopLen }) {
    const targets = recordTargets();
    if (!targets.length) return false;
    const p = (async () => {
      const items = [];
      for (const track of targets) {
        try {
          const ti = await acquireInput(track.id, inputCfg(track));
          const capture = await captureFrom(ti);
          captures.set(track.id, capture);
          items.push({ track, capture });
        } catch (err) {
          statusEl.textContent = `Audio recording on "${track.name}" failed: ${err.message}`;
        }
      }
      if (!items.length) { takes = null; return false; }
      takes = { items, recordingStartTime, recordingBaseSec, recordingLoopLen };
      startLivePaint();
      statusEl.textContent = `Recording audio on ${items.map(i => i.track.name).join(", ")}…`;
      return true;
    })();
    pendingBegin = p;
    try { return await p; } finally { if (pendingBegin === p) pendingBegin = null; }
  }

  function isRecordingAudio() { return !!takes || !!pendingBegin; }

  // ---------------------------------------------------------------------------
  // Live recording clip: a growing clip with the waveform painted while recording
  // ---------------------------------------------------------------------------
  let liveTimer = null;
  function startLivePaint() {
    stopLivePaint();
    liveTimer = setInterval(paintLive, 80);
  }
  function stopLivePaint() {
    clearInterval(liveTimer); liveTimer = null;
    document.querySelectorAll(".seq-clip.rec-live").forEach(el => el.remove());
  }
  function paintLive() {
    const t = takes;
    if (!t) return;
    const ctx = ensureAudioContext();
    const pxPerSec = typeof getSeqPxPerSec === "function" ? getSeqPxPerSec() : 100;
    const latency = (ctx.baseLatency || 0) + (ctx.outputLatency || 0) + settings().latency / 1000;
    const base = Number.isFinite(t.recordingBaseSec) ? t.recordingBaseSec : 0;
    t.items.forEach(({ track, capture }) => {
      const ti = tracks.indexOf(track);
      // the track's own row (not its automation / take lanes)
      const lane = document.querySelector(`.seq-track-row:not(.seq-extra-row)[data-track-index="${ti}"] .seq-row-lane`);
      if (!lane) return;
      const { peaks, block, rate } = capture.live();
      const frames = (peaks.length / 2) * block;
      const startedAt = Number.isFinite(capture.startedAt) ? capture.startedAt : t.recordingStartTime;
      let songStart = base + (startedAt - t.recordingStartTime) - latency;
      let dur = frames / rate;
      let fromPeak = 0;
      if (songStart < 0) { fromPeak = Math.floor((-songStart * rate) / block); dur += songStart; songStart = 0; }
      const L = t.recordingLoopLen;
      if (L > 0) {
        // cycle recording: show the pass being recorded now
        const into = Math.max(0, songStart + dur - base);
        const pass = Math.floor(into / L);
        const passStartSong = base + pass * L;
        const startSong = Math.max(songStart, pass === 0 ? songStart : base);
        fromPeak += Math.max(0, Math.floor(((passStartSong - songStart) * rate) / block));
        dur = into - pass * L - (startSong - base);
        songStart = startSong;
      }
      if (dur <= 0) return;
      let el = lane.querySelector(".seq-clip.rec-live");
      if (!el) {
        el = document.createElement("div");
        el.className = "seq-clip audio rec-live";
        el.innerHTML = `<canvas class="clip-thumb"></canvas><div class="clip-title">● Recording ${escapeHtml(track.name)}</div>`;
        lane.appendChild(el);
      }
      el.style.left = songStart * pxPerSec + "px";
      el.style.width = Math.max(2, dur * pxPerSec) + "px";
      const canvas = el.querySelector("canvas");
      const w = Math.max(1, Math.floor(el.clientWidth)), h = Math.max(1, Math.floor(el.clientHeight));
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) { canvas.width = Math.floor(w * dpr); canvas.height = Math.floor(h * dpr); }
      const g = canvas.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      g.fillStyle = "rgba(255,255,255,0.85)";
      const nBlocks = Math.max(1, Math.floor((dur * rate) / block));
      const mid = h / 2;
      // display zoom for quiet inputs (like the clip waveforms)
      let maxAbs = 0;
      for (let b = fromPeak; b < fromPeak + nBlocks && b * 2 + 1 < peaks.length; b++) maxAbs = Math.max(maxAbs, -peaks[b * 2], peaks[b * 2 + 1]);
      const zoom = maxAbs > 1e-5 ? Math.min(16, Math.max(1, 0.9 / maxAbs)) : 1;
      for (let x = 0; x < w; x++) {
        const b0 = fromPeak + Math.floor((x / w) * nBlocks), b1 = fromPeak + Math.max(Math.floor(((x + 1) / w) * nBlocks), Math.floor((x / w) * nBlocks) + 1);
        let mn = 0, mx = 0;
        for (let b = b0; b < b1 && b * 2 + 1 < peaks.length; b++) { if (peaks[b * 2] < mn) mn = peaks[b * 2]; if (peaks[b * 2 + 1] > mx) mx = peaks[b * 2 + 1]; }
        const y1 = mid - Math.min(1, mx * zoom) * mid, y2 = mid - Math.max(-1, mn * zoom) * mid;
        g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
      }
    });
  }

  /** song placement of a take; cycle recordings return every complete pass */
  function placeTake(buf, startedAt, t) {
    const ctx = ensureAudioContext();
    // latency compensation: input + output latency reported by the browser + user offset
    const autoLatency = (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
    const latency = autoLatency + settings().latency / 1000;
    const base = Number.isFinite(t.recordingBaseSec) ? t.recordingBaseSec : 0;
    const startDelay = Number.isFinite(startedAt) && Number.isFinite(t.recordingStartTime) ? startedAt - t.recordingStartTime : 0;
    t = { ...t, recordingBaseSec: base };
    const songStart0 = base + startDelay - (Number.isFinite(latency) ? latency : 0);
    const L = t.recordingLoopLen;
    if (L > 0) {
      // pass k starts at buffer time first + k*L (first = loop start of pass 0)
      const first = t.recordingBaseSec - songStart0;
      const kMin = Math.ceil(-first / L - 1e-9);
      const kMax = Math.floor((buf.duration - first) / L + 1e-9) - 1;
      if (kMax >= kMin) {
        const passes = [];
        for (let k = kMin; k <= kMax; k++) passes.push(first + k * L);
        return { songStart: t.recordingBaseSec, len: L, passes };
      }
    }
    let songStart = songStart0, offset = 0;
    if (songStart < 0) { offset = -songStart; songStart = 0; }
    let len = buf.duration - offset;
    // an incomplete cycle pass must not run past the loop end
    if (L > 0) len = Math.min(len, Math.max(0.01, t.recordingBaseSec + L - songStart));
    return { songStart, len, passes: [offset] };
  }

  async function endTrackRecording() {
    // the transport may stop before the inputs finished opening: wait, so the
    // captures are stopped instead of running on forever
    if (pendingBegin) await pendingBegin;
    if (!takes) return;
    const t = takes; takes = null;
    stopLivePaint();
    const results = [];
    for (const { track, capture } of t.items) {
      const startedAt = capture.startedAt ?? t.recordingStartTime;
      const buf = await capture.stop();
      captures.delete(track.id);
      results.push({ track, buf, startedAt, peak: capture.peak, diag: capture.diag });
    }
    syncInputs();
    let made = 0, quiet = [];
    for (const r of results) {
      if (!r.buf || r.buf.length < 256) continue;
      const place = placeTake(r.buf, r.startedAt, t);
      if (place.len <= 0.005) continue;
      if (r.peak < 0.003) quiet.push(r.track.name); // below about -50 dBFS
      const id = await S().put(r.buf, `${r.track.name} ${new Date().toLocaleTimeString()}`);
      const clip = addAudioClip(r.track, id, place.songStart, place.len, place.passes[place.passes.length - 1], `Take ${(r.track.clips?.length || 0) + 1}`);
      if (place.passes.length > 1) {
        // cycle recording: every complete pass is kept as a take lane (comping)
        clip.takes = place.passes.map((off, i) => ({ sampleId: id, offset: off, name: `Pass ${i + 1}` }));
        clip.activeTake = clip.takes.length - 1;
        clip.showTakes = true;
      }
      made++;
    }
    // the undo snapshot was taken when recording started, so one undo removes the whole take
    renderSequencer();
    window.WAWCollab?.notifyChange?.();
    const report = results.map(r => {
      const d = r.diag || {};
      const db = r.peak > 0 ? (20 * Math.log10(r.peak)).toFixed(0) + " dB" : "silence";
      return `${r.track.name}: ${r.buf ? r.buf.duration.toFixed(1) + " s" : "no audio"} from "${d.device || "input"}", peak ${db}`;
    }).join(" · ");
    console.info("[WAW] recording diagnostics", results.map(r => r.diag));
    if (!made) statusEl.textContent = `No audio captured (${report}). Use "Copy recording diagnostics" in the Recording panel and send it to support.`;
    else if (quiet.length) statusEl.textContent = `Recorded, but almost silent (${report}). Raise Input gain or turn on Auto gain, and check the mic level in your OS sound settings.`;
    else statusEl.textContent = `Recorded: ${report}.`;
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
  function collectAudioEvents(rangeStart, rangeEnd, { audibleOnly = false, clip = null } = {}) {
    const out = [];
    const addClip = (t, c) => {
      if (!c.audio?.sampleId || (c.muted && !clip)) return;
      if (c.endSec <= rangeStart || c.startSec >= rangeEnd) return;
      // warped clips: k song seconds per source second; comps: one event per segment
      const k = window.WAWWarp ? window.WAWWarp.factor(c) : 1;
      const segs = window.WAWComp ? window.WAWComp.segments(c) : [{ src: c.audio, start: 0, end: c.endSec - c.startSec, fadeIn: c.audio.fadeIn || 0, fadeOut: c.audio.fadeOut || 0 }];
      segs.forEach(sg => {
        const segStart = c.startSec + sg.start, segEnd = c.startSec + sg.end;
        if (segEnd <= rangeStart || segStart >= rangeEnd || !sg.src?.sampleId) return;
        const start = Math.max(segStart, rangeStart);
        const end = Math.min(segEnd, rangeEnd);
        out.push({
          kind: "audio", trackId: t?.id, clipId: c.id, sampleId: sg.src.sampleId, k,
          start, end, offset: (sg.src.offset || 0) + (start - c.startSec) / k,
          clipStart: segStart, clipEnd: segEnd,
          gain: c.audio.gain || 0, fadeIn: sg.fadeIn, fadeOut: sg.fadeOut
        });
      });
    };
    if (clip) { addClip(tracks.find(t => (t.clips || []).includes(clip)), clip); return out; }
    tracks.forEach(t => {
      if (t.type !== "audio") return;
      if (audibleOnly && !isAudible(t)) return;
      (t.clips || []).forEach(c => addClip(t, c));
    });
    return out;
  }

  /**
   * Schedule one audio event at absolute context time `when`
   * (for offline rendering, `when` equals the song position).
   */
  function scheduleAudioEvent(ctx, destination, ev, when, lateBy = 0) {
    if (![ev.start, ev.end, ev.offset, ev.clipStart, ev.clipEnd, when].every(Number.isFinite)) return [];
    const k = ev.k || 1;
    // warped: pitch-preserving stretched render when ready, varispeed until then
    let buf = null, stretched = false;
    if (Math.abs(k - 1) >= 1e-3 && window.WAWWarp) { buf = window.WAWWarp.getStretched(ev.sampleId, k); stretched = !!buf; }
    if (!buf) buf = S().get(ev.sampleId);
    if (!buf) { S().load(ev.sampleId); return []; }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const rate = Math.abs(k - 1) >= 1e-3 && !stretched ? 1 / k : 1;
    if (rate !== 1) src.playbackRate.value = rate;
    // buffer time per song second: 1 (plain/stretched) or 1/k (varispeed)
    const toBuf = (srcSec) => stretched ? srcSec * k : srcSec;
    const g = ctx.createGain();
    const level = Math.pow(10, (ev.gain || 0) / 20);
    const startT = when + lateBy;
    const songStart = ev.start + lateBy;
    const dur = ev.end - songStart;
    if (dur <= 0.001) return [];
    const offset = toBuf(ev.offset + lateBy / k);
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
    src.start(startT, offset, Math.min(stretched || rate === 1 ? dur : dur * rate, buf.duration - offset));
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
    const k = window.WAWWarp ? window.WAWWarp.factor(clip) : 1;
    // left edge: content stays put, so the offset moves with the edge
    let newOffset = origOffset + (clip.startSec - origStart) / k;
    if (newOffset < 0) { clip.startSec -= newOffset * k; newOffset = 0; }
    const dSrc = newOffset - (clip.audio.offset || 0);
    clip.audio.offset = newOffset;
    if (Math.abs(dSrc) > 1e-9) window.WAWComp?.onTrim(clip, dSrc); // takes + comp follow the edge
    // right edge cannot extend past the end of the sample
    const maxEnd = clip.startSec + (dur - newOffset) * k;
    if (clip.endSec > maxEnd) clip.endSec = maxEnd;
    if (clip.endSec <= clip.startSec + 0.01) clip.endSec = clip.startSec + 0.01;
  }

  function drawClipWave(canvas, clip, color) {
    const a = clip.audio;
    if (!a?.sampleId) return;
    if (!S().has(a.sampleId)) { S().load(a.sampleId).then(b => b && canvas.isConnected && drawClipWave(canvas, clip, color)); return; }
    const k = window.WAWWarp ? window.WAWWarp.factor(clip) : 1;
    const len = clip.endSec - clip.startSec;
    const opts = { color: color || "rgba(255,255,255,0.8)", gain: Math.pow(10, (a.gain || 0) / 20), autoZoom: true };
    const segs = window.WAWComp?.hasTakes(clip) && clip.comp?.length ? window.WAWComp.segments(clip) : null;
    if (!segs) { S().drawWaveform(canvas, a.sampleId, { ...opts, start: a.offset, end: a.offset + len / k }); return; }
    // comp: draw each segment from its take
    S().drawWaveform(canvas, a.sampleId, { ...opts, start: 0, end: 0, color: "transparent" });
    segs.forEach((sg, i) => {
      if (!S().has(sg.src.sampleId)) return;
      S().drawWaveform(canvas, sg.src.sampleId, { ...opts, keep: true, region: [sg.start / len, sg.end / len], start: sg.src.offset + sg.start / k, end: sg.src.offset + sg.end / k, color: i % 2 ? "rgba(255,255,255,0.8)" : "rgba(191,219,254,0.9)" });
    });
  }

  async function importFilesToTrack(files, trackIndex, atSec) {
    let track = tracks[trackIndex];
    if (!track || track.type !== "audio") {
      track = createTrack(null, { type: "audio" });
      track.name = `Audio ${tracks.filter(t => t.type === "audio").length + 1}`;
      pushHistory();
      tracks.push(track);
    } else pushHistory();
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
  let editorRef = null; // { trackId, clipId, clip }
  /** after undo/redo or a collaborator's change the clip object is replaced: re-bind or close */
  function refreshEditor() {
    if (!editorRef || !editorModal?.classList.contains("visible")) return;
    const ti = tracks.findIndex(t => t.id === editorRef.trackId);
    const clip = tracks[ti]?.clips?.find(c => c.id === editorRef.clipId);
    if (!clip?.audio) { editorModal.classList.remove("visible"); editorRef = null; return; }
    if (clip !== editorRef.clip) openClipEditor(ti, editorRef.clipId);
  }
  function openClipEditor(trackIndex, clipId) {
    const track = tracks[trackIndex];
    const clip = track?.clips?.find(c => c.id === clipId);
    if (!clip?.audio) return;
    editorRef = { trackId: track.id, clipId, clip };
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
  // UI: per-track input routing (sidebar) + global Audio Input panel
  // ---------------------------------------------------------------------------
  let deviceList = [];
  async function refreshDeviceList() {
    try { deviceList = await listInputs(); } catch (e) { deviceList = []; }
    return deviceList;
  }

  function deviceOptions(selected) {
    const opts = [`<option value="">Default input</option>`].concat(deviceList.filter(d => d.deviceId && d.deviceId !== "default").map((d, i) =>
      `<option value="${escapeHtml(d.deviceId)}" ${d.deviceId === selected ? "selected" : ""}>${escapeHtml(d.label || `Input ${i + 1}`)}</option>`));
    if (selected && !deviceList.some(d => d.deviceId === selected)) opts.push(`<option value="${escapeHtml(selected)}" selected>(saved device)</option>`);
    return opts.join("");
  }

  function channelOptions(deviceId, selected) {
    const n = Math.max(2, knownChannels.get(deviceId || "") || 2);
    const list = [["auto", "Auto (mono mic → both sides)"], ["stereo", "Stereo 1+2"]];
    for (let i = 1; i <= n; i++) list.push([String(i), `Mono — input ${i}`]);
    return list.map(([v, l]) => `<option value="${v}" ${v === selected ? "selected" : ""}>${l}</option>`).join("");
  }

  function meterHtml(ownerId) {
    return `<div class="input-meter" data-input-meter="${escapeHtml(ownerId)}" title="Input level (peak dBFS)"><div class="im-bar"></div><span class="im-db">off</span></div>`;
  }

  /** sidebar block for an audio track */
  function trackPanelHtml(t) {
    const c = inputCfg(t);
    return `<div class="audio-track-panel">
      <div class="at-btns">
        <button type="button" class="edit-synth-btn at-arm ${t.armed ? "on" : ""}">● Arm</button>
        <button type="button" class="edit-synth-btn at-mon ${t.monitor ? "on" : ""}">Monitor</button>
      </div>
      <label class="stack">Input<select class="at-dev">${deviceOptions(c.deviceId)}</select></label>
      <label class="stack">Channels<select class="at-ch">${channelOptions(c.deviceId, c.channel)}</select></label>
      <label class="stack">Input gain <span class="at-gain-val">${c.gainDb > 0 ? "+" : ""}${c.gainDb.toFixed(0)} dB</span>
        <input type="range" class="at-gain" min="-24" max="40" step="1" value="${c.gainDb}"></label>
      <label class="cp-check"><input type="checkbox" class="at-proc" ${c.processing ? "checked" : ""}> Auto gain + noise suppression</label>
      ${meterHtml(t.id)}
      <p class="at-low-hint">No signal from this input. Speak or play into it; if the meter stays empty, raise Input gain, turn on Auto gain, or check the mic level in your OS sound settings.</p>
      <button type="button" class="edit-synth-btn at-import">Import Audio…</button>
    </div>`;
  }

  function attachTrackPanel(root, t, trackIndex) {
    const stop = e => e.stopPropagation();
    root.querySelectorAll("select, input, button").forEach(el => el.addEventListener("click", stop));
    root.querySelector(".at-arm").addEventListener("click", () => window.WAWWorkspace?.trackButton(t, "arm"));
    root.querySelector(".at-mon").addEventListener("click", () => window.WAWWorkspace?.trackButton(t, "monitor"));
    root.querySelector(".at-import").addEventListener("click", () => window.WAWWorkspace?.importAudioDialog(trackIndex));
    root.querySelector(".at-dev").addEventListener("change", (e) => {
      pushHistory();
      setTrackInput(t, { deviceId: e.target.value });
      saveSetting(LS_DEVICE, e.target.value); // new tracks default to the last choice
      root.querySelector(".at-ch").innerHTML = channelOptions(t.input.deviceId, t.input.channel);
      window.WAWCollab?.notifyChange?.();
    });
    root.querySelector(".at-ch").addEventListener("change", (e) => { pushHistory(); setTrackInput(t, { channel: e.target.value }); window.WAWCollab?.notifyChange?.(); });
    root.querySelector(".at-proc").addEventListener("change", (e) => { pushHistory(); setTrackInput(t, { processing: e.target.checked }); window.WAWCollab?.notifyChange?.(); });
    const g = root.querySelector(".at-gain");
    g.addEventListener("pointerdown", () => beginHistoryGesture());
    g.addEventListener("input", () => {
      setTrackInput(t, { gainDb: parseFloat(g.value) || 0 });
      root.querySelector(".at-gain-val").textContent = `${t.input.gainDb > 0 ? "+" : ""}${t.input.gainDb} dB`;
    });
    g.addEventListener("change", () => { commitHistoryGesture(); window.WAWCollab?.notifyChange?.(); });
    if (!deviceList.length) refreshDeviceList().then(() => { const sel = root.querySelector(".at-dev"); if (sel) sel.innerHTML = deviceOptions(t.input.deviceId); });
    startMeters();
  }

  function refreshInputUi() {
    // channel lists depend on the opened device's channel count
    document.querySelectorAll(".audio-track-panel .at-ch").forEach(sel => {
      const row = sel.closest("[data-track-id]") || sel.closest(".track-row");
      const t = tracks.find(x => x.id === row?.dataset?.trackId) || getActiveTrack();
      if (t?.type === "audio" && document.activeElement !== sel) sel.innerHTML = channelOptions(inputCfg(t).deviceId, t.input.channel);
      const dev = sel.closest(".audio-track-panel")?.querySelector(".at-dev");
      if (t?.type === "audio" && dev && document.activeElement !== dev) dev.innerHTML = deviceOptions(t.input.deviceId);
    });
    const test = document.getElementById("aiTestDevice");
    if (test && document.activeElement !== test) test.innerHTML = deviceOptions(settings().deviceId);
    startMeters();
  }

  function buildInputPanel() {
    const host = document.getElementById("audioInputSettings");
    if (!host) return;
    const s = settings();
    // inputs are chosen per audio track (track panel); only global recording settings live here
    host.innerHTML = `
      <div class="subsection-title">Recording</div>
      <p class="ai-note">Inputs are set per audio track: select an audio track to choose its device, channels and gain. Arm a track and press Record.</p>
      <label class="stack">Latency offset <span id="latencyVal">${s.latency} ms</span><input type="range" id="latencySlider" min="-200" max="200" step="1" value="${s.latency}"></label>
      <button type="button" id="recDiagBtn">Copy recording diagnostics</button>`;
    const lat = host.querySelector("#latencySlider");
    lat.addEventListener("input", () => { saveSetting(LS_LATENCY, lat.value); host.querySelector("#latencyVal").textContent = lat.value + " ms"; });
    host.querySelector("#recDiagBtn").addEventListener("click", async () => {
      const info = {
        lastRecording: lastDiagnostics,
        openInputs: [...trackInputs.values()].map(ti => ({ owner: ti.owner, device: ti.dev.label, channels: ti.dev.channels, route: ti.cfgSig, gain: ti.gain.gain.value })),
        tracks: tracks.filter(t => t.type === "audio").map(t => ({ name: t.name, armed: !!t.armed, monitor: !!t.monitor, input: t.input })),
        audioContext: (() => { try { const c = ensureAudioContext(); return { state: c.state, sampleRate: c.sampleRate, worklets: !!c.__wawWorklets }; } catch (e) { return String(e); } })(),
        userAgent: navigator.userAgent
      };
      const text = JSON.stringify(info, null, 2);
      try { await navigator.clipboard.writeText(text); statusEl.textContent = "Recording diagnostics copied to the clipboard."; }
      catch (e) { console.info(text); statusEl.textContent = "Could not access the clipboard; diagnostics were written to the browser console."; }
    });
    navigator.mediaDevices?.addEventListener?.("devicechange", async () => { await refreshDeviceList(); renderSidebarTracks(); });
  }

  document.addEventListener("DOMContentLoaded", buildInputPanel);

  window.WAWAudio = {
    listInputs, getInputStream, setMonitor, syncMonitoring, syncInputs, startCapture, setTrackInput, inputCfg,
    beginTrackRecording, endTrackRecording, isRecordingAudio, recordTargets,
    addAudioClip, collectAudioEvents, scheduleAudioEvent, trimAudioClip, drawClipWave,
    importFilesToTrack, openClipEditor, sampleDuration, resetMonitoring, refreshEditor,
    trackPanelHtml, attachTrackPanel, get lastDiagnostics() { return lastDiagnostics; },
    // legacy names
    openInput: () => syncInputs(), closeInput: () => {}
  };
})();
