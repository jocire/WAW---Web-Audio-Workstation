// WAW sample store: audio used by audio tracks and the sampler.
// Audio is persisted in IndexedDB (localStorage is far too small) as 32-bit
// float WAV, decoded once and cached as AudioBuffers. Peaks for waveform
// drawing are cached per sample.
(function () {
  "use strict";
  const DB_NAME = "waw-audio";
  const STORE = "samples";
  const buffers = new Map();   // id -> AudioBuffer
  const meta = new Map();      // id -> { name }
  const peaksCache = new Map(); // id:buckets -> Float32Array(min,max pairs)
  const pending = new Map();   // id -> Promise<AudioBuffer|null>
  const listeners = new Set();

  let dbPromise = null;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }).catch(err => { console.warn("IndexedDB unavailable, samples kept in memory only:", err); return null; });
    }
    return dbPromise;
  }
  async function idbPut(id, value) {
    const d = await db(); if (!d) return;
    await new Promise((res, rej) => { const tx = d.transaction(STORE, "readwrite"); tx.objectStore(STORE).put(value, id); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  }
  async function idbGet(id) {
    const d = await db(); if (!d) return null;
    return new Promise((res, rej) => { const tx = d.transaction(STORE, "readonly"); const r = tx.objectStore(STORE).get(id); r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error); });
  }

  // decoding works without a user gesture through an OfflineAudioContext
  let decodeCtx = null;
  function decoder() {
    if (!decodeCtx) decodeCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, 1, 48000);
    return decodeCtx;
  }
  async function decode(arrayBuffer) {
    return decoder().decodeAudioData(arrayBuffer.slice(0));
  }

  function newId() { return "smp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  // ---- WAV (32-bit float) encode ----
  function encodeWav(buffer) {
    const ch = buffer.numberOfChannels, len = buffer.length, rate = buffer.sampleRate;
    const bytes = 44 + len * ch * 4;
    const ab = new ArrayBuffer(bytes);
    const v = new DataView(ab);
    let o = 0;
    const str = s => { for (let i = 0; i < s.length; i++) v.setUint8(o++, s.charCodeAt(i)); };
    const u32 = x => { v.setUint32(o, x, true); o += 4; };
    const u16 = x => { v.setUint16(o, x, true); o += 2; };
    str("RIFF"); u32(bytes - 8); str("WAVE"); str("fmt "); u32(16); u16(3); u16(ch); u32(rate); u32(rate * ch * 4); u16(ch * 4); u16(32);
    str("data"); u32(len * ch * 4);
    const data = []; for (let c = 0; c < ch; c++) data.push(buffer.getChannelData(c));
    for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) { v.setFloat32(o, data[c][i], true); o += 4; }
    return ab;
  }

  function notify(id) { listeners.forEach(fn => { try { fn(id); } catch (e) {} }); }

  /** Store an AudioBuffer; returns its id. */
  async function put(buffer, name = "Sample", id = null) {
    id = id || newId();
    buffers.set(id, buffer);
    meta.set(id, { name });
    [...peaksCache.keys()].filter(k => k.startsWith(id + ":")).forEach(k => peaksCache.delete(k));
    try { await idbPut(id, { name, wav: encodeWav(buffer) }); } catch (e) { console.warn("sample persist failed", e); }
    notify(id);
    return id;
  }

  /** Store raw encoded audio (e.g. received from a collaborator). */
  async function putRaw(id, arrayBuffer, name = "Sample") {
    const buf = await decode(arrayBuffer);
    buffers.set(id, buf);
    meta.set(id, { name });
    try { await idbPut(id, { name, wav: arrayBuffer }); } catch (e) {}
    notify(id);
    return buf;
  }

  async function getRaw(id) {
    const rec = await idbGet(id);
    if (rec?.wav) return { name: rec.name, wav: rec.wav };
    const buf = buffers.get(id);
    return buf ? { name: meta.get(id)?.name || "Sample", wav: encodeWav(buf) } : null;
  }

  function get(id) { return buffers.get(id) || null; }
  function name(id) { return meta.get(id)?.name || "Sample"; }
  function has(id) { return buffers.has(id); }

  function load(id) {
    if (!id) return Promise.resolve(null);
    if (buffers.has(id)) return Promise.resolve(buffers.get(id));
    if (pending.has(id)) return pending.get(id);
    const p = (async () => {
      try {
        const rec = await idbGet(id);
        if (!rec?.wav) return null;
        const buf = await decode(rec.wav);
        buffers.set(id, buf);
        meta.set(id, { name: rec.name });
        notify(id);
        return buf;
      } catch (e) { console.warn("sample load failed", id, e); return null; }
      finally { pending.delete(id); }
    })();
    pending.set(id, p);
    return p;
  }

  async function importFile(file) {
    const ab = await file.arrayBuffer();
    const buf = await decode(ab);
    return put(buf, file.name.replace(/\.[^.]+$/, ""));
  }

  /** min/max pairs for drawing; buckets = number of columns */
  function peaks(id, buckets = 200, start = 0, end = null) {
    const buf = buffers.get(id);
    if (!buf) return null;
    const s0 = Math.max(0, Math.floor(start * buf.sampleRate));
    const s1 = Math.min(buf.length, Math.floor((end ?? buf.duration) * buf.sampleRate));
    const key = `${id}:${buckets}:${s0}:${s1}`;
    if (peaksCache.has(key)) return peaksCache.get(key);
    const out = new Float32Array(buckets * 2);
    const span = Math.max(1, (s1 - s0) / buckets);
    const chans = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
    for (let b = 0; b < buckets; b++) {
      let mn = 1, mx = -1;
      const a = s0 + Math.floor(b * span), z = Math.min(s1, s0 + Math.floor((b + 1) * span));
      const stride = Math.max(1, Math.floor((z - a) / 256)); // sample long spans sparsely
      for (let i = a; i < z; i += stride) {
        for (const d of chans) { const x = d[i]; if (x < mn) mn = x; if (x > mx) mx = x; }
      }
      if (mn > mx) { mn = 0; mx = 0; }
      out[b * 2] = mn; out[b * 2 + 1] = mx;
    }
    if (peaksCache.size > 400) peaksCache.clear();
    peaksCache.set(key, out);
    return out;
  }

  function drawWaveform(canvas, id, { start = 0, end = null, color = "rgba(255,255,255,0.75)", bg = null, gain = 1 } = {}) {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 1;
    const h = canvas.clientHeight || canvas.parentElement?.clientHeight || 1;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h); }
    const pk = peaks(id, Math.max(16, Math.min(4000, Math.floor(w))), start, end);
    if (!pk) return;
    const mid = h / 2;
    ctx.fillStyle = color;
    const cols = pk.length / 2;
    for (let x = 0; x < cols; x++) {
      const mn = Math.max(-1, pk[x * 2] * gain), mx = Math.min(1, pk[x * 2 + 1] * gain);
      const y1 = mid - mx * mid, y2 = mid - mn * mid;
      ctx.fillRect((x / cols) * w, y1, Math.max(1, w / cols), Math.max(1, y2 - y1));
    }
  }

  // ---- destructive edit helpers (return a NEW sample id) ----
  function cloneRegion(buf, s0, s1) {
    const len = Math.max(1, s1 - s0);
    const out = new AudioBuffer({ numberOfChannels: buf.numberOfChannels, length: len, sampleRate: buf.sampleRate });
    for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).subarray(s0, s1), c);
    return out;
  }
  async function edit(id, op, opts = {}) {
    const buf = buffers.get(id) || await load(id);
    if (!buf) return null;
    const rate = buf.sampleRate;
    const s0 = Math.max(0, Math.floor((opts.start ?? 0) * rate));
    const s1 = Math.min(buf.length, Math.ceil((opts.end ?? buf.duration) * rate));
    let out;
    if (op === "crop") out = cloneRegion(buf, s0, s1);
    else {
      out = cloneRegion(buf, 0, buf.length);
      // normalize: one gain for all channels, measured before any channel is
      // scaled (otherwise the stereo balance changes)
      let normGain = 1;
      if (op === "normalize") {
        let peak = 0;
        for (let ch = 0; ch < out.numberOfChannels; ch++) { const dd = out.getChannelData(ch); for (let i = s0; i < s1; i++) peak = Math.max(peak, Math.abs(dd[i])); }
        normGain = peak > 0 ? Math.pow(10, (opts.targetDb ?? -0.3) / 20) / peak : 1;
      }
      for (let c = 0; c < out.numberOfChannels; c++) {
        const d = out.getChannelData(c);
        if (op === "reverse") d.subarray(s0, s1).reverse();
        else if (op === "normalize") { for (let i = s0; i < s1; i++) d[i] *= normGain; } else if (op === "fadeIn") { const n = s1 - s0; for (let i = 0; i < n; i++) d[s0 + i] *= i / n; }
        else if (op === "fadeOut") { const n = s1 - s0; for (let i = 0; i < n; i++) d[s0 + i] *= 1 - i / n; }
        else if (op === "silence") d.fill(0, s0, s1);
        else if (op === "gain") { const g = Math.pow(10, (opts.db ?? 0) / 20); for (let i = s0; i < s1; i++) d[i] *= g; }
      }
    }
    return put(out, name(id) + (op === "crop" ? " (crop)" : ""));
  }

  /** Simple transient detection for chopping: returns times (s) */
  function detectTransients(id, maxSlices = 16, sensitivity = 1.5) {
    const buf = buffers.get(id);
    if (!buf) return [];
    const d = buf.getChannelData(0);
    const hop = 512, win = 1024;
    const energies = [];
    for (let i = 0; i + win < d.length; i += hop) {
      let e = 0; for (let j = 0; j < win; j++) e += d[i + j] * d[i + j];
      energies.push(e / win);
    }
    const onsets = [];
    let avg = 0;
    for (let k = 1; k < energies.length; k++) {
      avg = avg * 0.9 + energies[k - 1] * 0.1;
      const t = (k * hop) / buf.sampleRate;
      if (energies[k] > avg * sensitivity * 3 && energies[k] > 1e-5 && (!onsets.length || t - onsets[onsets.length - 1] > 0.08)) onsets.push(t);
    }
    if (!onsets.length || onsets[0] > 0.02) onsets.unshift(0);
    // first maxSlices onsets in time order
    return onsets.slice(0, maxSlices);
  }

  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  // ---- project export helpers (base64 WAV) ----
  function abToB64(ab) {
    const bytes = new Uint8Array(ab); let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64ToAb(b64) {
    const bin = atob(b64); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  async function exportSamples(ids) {
    const out = {};
    for (const id of ids) { const raw = await getRaw(id); if (raw) out[id] = { name: raw.name, wav: abToB64(raw.wav) }; }
    return out;
  }
  async function importSamples(map) {
    for (const [id, rec] of Object.entries(map || {})) {
      if (!has(id)) { try { await putRaw(id, b64ToAb(rec.wav), rec.name); } catch (e) { console.warn("sample import failed", id, e); } }
    }
  }

  window.WAWSamples = { put, putRaw, getRaw, get, load, has, name, importFile, peaks, drawWaveform, edit, detectTransients, onChange, encodeWav, exportSamples, importSamples };
})();
