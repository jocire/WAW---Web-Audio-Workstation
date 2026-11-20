// WAW audio warping: time-stretch audio clips so they follow the song tempo,
// tempo detection, and transient-based audio quantize.
//
// clip.audio.warp = { on: true, srcBpm }  — the tempo the audio was played at.
// Stretch factor k = srcBpm / (song tempo at the clip start): song seconds per
// source second. Offsets (clip.audio.offset, take offsets) stay in SOURCE
// seconds; clip start/end are song seconds.
// Stretched audio is rendered with WSOLA (pitch is preserved) and cached per
// sample + factor; until a render is ready the clip plays varispeed (pitch
// follows), so playback never waits.
(function () {
  "use strict";
  const S = () => window.WAWSamples;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function factor(clip) {
    const w = clip?.audio?.warp;
    if (!w?.on || !(w.srcBpm > 0)) return 1;
    const bpm = window.WAWTempo ? window.WAWTempo.bpmAt(clip.startSec) : (timelineBpm || 120);
    return w.srcBpm / bpm;
  }
  const keyOf = (id, k) => `${id}|${k.toFixed(4)}`;

  // ---------------------------------------------------------------------------
  // WSOLA time-stretch (time-scale modification, pitch preserved)
  // ---------------------------------------------------------------------------
  const cache = new Map();   // key -> AudioBuffer
  const jobs = new Map();    // key -> Promise<AudioBuffer>

  async function stretch(buf, k, onProgress) {
    const N = 2048, Hs = N / 2, delta = 512;
    const Ha = Hs / k;
    const chs = buf.numberOfChannels, len = buf.length;
    const outLen = Math.max(1, Math.round(len * k));
    const ins = []; for (let c = 0; c < chs; c++) ins.push(buf.getChannelData(c));
    const mono = new Float32Array(len);
    for (let c = 0; c < chs; c++) { const d = ins[c]; for (let i = 0; i < len; i++) mono[i] += d[i] / chs; }
    const outs = []; for (let c = 0; c < chs; c++) outs.push(new Float32Array(outLen + N));
    const norm = new Float32Array(outLen + N);
    const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    const frames = Math.ceil(outLen / Hs) + 1;
    let prevIn = 0;
    const corr = (a, b, n, stride) => { let s = 0; for (let i = 0; i < n; i += stride) s += mono[a + i] * mono[b + i]; return s; };
    for (let m = 0; m < frames; m++) {
      const outPos = m * Hs;
      let inPos = Math.round(m * Ha);
      if (m > 0) {
        // pick the input position near the ideal one whose start best continues the previous frame
        const natural = prevIn + Hs;
        const lo = Math.max(0, inPos - delta), hi = Math.min(len - N - 1, inPos + delta);
        if (hi > lo && natural + Hs < len) {
          let best = inPos, bestC = -Infinity;
          for (let p = lo; p <= hi; p += 8) { const c = corr(natural, p, Hs, 8); if (c > bestC) { bestC = c; best = p; } }
          const lo2 = Math.max(lo, best - 8), hi2 = Math.min(hi, best + 8);
          for (let p = lo2; p <= hi2; p++) { const c = corr(natural, p, Hs, 4); if (c > bestC) { bestC = c; best = p; } }
          inPos = best;
        }
      }
      inPos = clamp(inPos, 0, Math.max(0, len - 1));
      for (let c = 0; c < chs; c++) {
        const src = ins[c], dst = outs[c];
        for (let i = 0; i < N; i++) { const j = inPos + i; if (j >= len) break; dst[outPos + i] += src[j] * win[i]; }
      }
      for (let i = 0; i < N; i++) norm[outPos + i] += win[i];
      prevIn = inPos;
      if (m % 400 === 399) { onProgress?.(m / frames); await new Promise(r => setTimeout(r, 0)); }
    }
    const out = new AudioBuffer({ numberOfChannels: chs, length: outLen, sampleRate: buf.sampleRate });
    for (let c = 0; c < chs; c++) {
      const d = outs[c];
      for (let i = 0; i < outLen; i++) d[i] = norm[i] > 1e-3 ? d[i] / norm[i] : d[i];
      out.copyToChannel(d.subarray(0, outLen), c);
    }
    return out;
  }

  /** stretched buffer if ready (null otherwise; starts rendering in the background) */
  function getStretched(sampleId, k) {
    if (Math.abs(k - 1) < 1e-3) return S().get(sampleId);
    const key = keyOf(sampleId, k);
    if (cache.has(key)) return cache.get(key);
    prepare(sampleId, k);
    return null;
  }
  function prepare(sampleId, k) {
    if (Math.abs(k - 1) < 1e-3) return Promise.resolve(S().get(sampleId));
    const key = keyOf(sampleId, k);
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    if (jobs.has(key)) return jobs.get(key);
    const p = (async () => {
      const src = S().get(sampleId) || await S().load(sampleId);
      if (!src) return null;
      const out = await stretch(src, k);
      // keep the cache bounded (old tempo renders are not needed)
      if (cache.size > 24) cache.delete(cache.keys().next().value);
      cache.set(key, out);
      return out;
    })().finally(() => jobs.delete(key));
    jobs.set(key, p);
    return p;
  }
  /** render every warped clip's audio for the current tempo (before export / after tempo edits) */
  async function prepareAll() {
    const work = [];
    tracks.forEach(t => (t.clips || []).forEach(c => {
      const k = factor(c);
      if (Math.abs(k - 1) < 1e-3) return;
      const ids = new Set([c.audio.sampleId, ...(c.takes || []).map(x => x.sampleId)]);
      ids.forEach(id => id && work.push(prepare(id, k)));
    }));
    if (work.length) statusEl.textContent = `Warping ${work.length} audio clip(s)…`;
    await Promise.all(work);
  }
  let prepTimer = null;
  function onClipRemapped(clip) {
    if (!clip.audio?.warp?.on) return;
    clearTimeout(prepTimer);
    prepTimer = setTimeout(() => prepareAll().then(() => { statusEl.textContent = "Warped audio ready."; }), 50);
  }

  // ---------------------------------------------------------------------------
  // tempo detection (onset envelope autocorrelation, 70-180 BPM)
  // ---------------------------------------------------------------------------
  function detectTempo(sampleId, start = 0, end = null) {
    const buf = S().get(sampleId);
    if (!buf) return null;
    const rate = buf.sampleRate, d = buf.getChannelData(0);
    const s0 = Math.floor(start * rate), s1 = Math.min(d.length, Math.floor((end ?? buf.duration) * rate));
    const hop = 512, frameRate = rate / hop;
    const env = [];
    let prev = 0;
    for (let i = s0; i + hop < s1; i += hop) {
      let e = 0; for (let j = 0; j < hop; j++) e += d[i + j] * d[i + j];
      e = Math.sqrt(e / hop);
      env.push(Math.max(0, e - prev)); // onset strength = rising energy
      prev = e;
    }
    if (env.length < frameRate * 2) return null;
    const mean = env.reduce((a, b) => a + b, 0) / env.length;
    const x = env.map(v => v - mean);
    let best = null, bestScore = -Infinity;
    for (let bpm = 70; bpm <= 180; bpm += 0.5) {
      const lag = frameRate * 60 / bpm;
      let s = 0;
      for (const mult of [1, 2, 4]) {
        const L = lag * mult, Li = Math.floor(L), fr = L - Li;
        for (let i = 0; i + Li + 1 < x.length; i++) s += x[i] * (x[i + Li] * (1 - fr) + x[i + Li + 1] * fr) / mult;
      }
      if (s > bestScore) { bestScore = s; best = bpm; }
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // clip actions
  // ---------------------------------------------------------------------------
  function sourceLen(clip) { return (clip.endSec - clip.startSec) / factor(clip); }

  function setWarp(trackIndex, clipId) {
    const clip = tracks[trackIndex]?.clips?.find(c => c.id === clipId);
    if (!clip?.audio) return;
    const songBpm = window.WAWTempo.bpmAt(clip.startSec);
    if (clip.audio.warp?.on) {
      if (!confirm("Turn warping off? The clip plays at its original speed again.")) return;
      pushHistory();
      const srcLen = sourceLen(clip);
      clip.audio.warp = { ...clip.audio.warp, on: false };
      clip.endSec = clip.startSec + srcLen;
      afterEdit("Warp off.");
      return;
    }
    const guess = detectTempo(clip.audio.sampleId, clip.audio.offset, clip.audio.offset + (clip.endSec - clip.startSec));
    const v = prompt(`Tempo the audio was played at (BPM).\nDetected: ${guess ? guess.toFixed(1) : "unknown"}. Song tempo here: ${songBpm}.\nThe clip will be stretched to follow the song tempo.`, String(guess ? Math.round(guess * 10) / 10 : songBpm));
    const srcBpm = parseFloat(v);
    if (!(srcBpm >= 20 && srcBpm <= 400)) return;
    pushHistory();
    const srcLen = clip.endSec - clip.startSec; // currently unwarped: song length == source length
    clip.audio.warp = { on: true, srcBpm };
    clip.endSec = clip.startSec + srcLen * factor(clip);
    afterEdit(`Warp on: ${srcBpm} → ${songBpm} BPM.`);
    prepareAll().then(() => { statusEl.textContent = "Warped audio ready."; });
  }

  /**
   * Quantize audio: slice the clip at its transients and move each slice so
   * its transient lands on the grid (the previous slice is extended to fill).
   */
  function quantizeAudio(trackIndex, clipId, strength = 1) {
    const t = tracks[trackIndex];
    const clip = t?.clips?.find(c => c.id === clipId);
    if (!clip?.audio) return;
    if (clip.takes?.length > 1 && clip.comp?.length) { toast("Flatten the comp first"); return; }
    const buf = S().get(clip.audio.sampleId);
    if (!buf) { toast("Audio is still loading"); return; }
    const k = factor(clip);
    const off = clip.audio.offset;
    const srcEnd = off + sourceLen(clip);
    const hits = S().detectTransients(clip.audio.sampleId, 512, 1.5)
      .map(x => refineOnset(buf, x))
      .filter(x => x > off + 0.02 && x < srcEnd - 0.03);
    if (!hits.length) { toast("No transients found in this clip"); return; }
    pushHistory();
    const cuts = [off, ...hits];
    const slices = cuts.map((src, i) => {
      const song = clip.startSec + (src - off) * k;
      const target = i === 0 ? song : song + (snapSec(song) - song) * strength;
      return { src, song, target };
    });
    // enforce order (two transients snapping to the same line keep the first)
    const kept = slices.filter((s, i) => i === 0 || s.target > slices[i - 1].target + 0.01);
    const base = { ...clip, id: undefined };
    const out = kept.map((s, i) => {
      const next = kept[i + 1];
      // a slice ends at the next slice's new start, but never plays into the next
      // transient's audio (a slice moved earlier leaves a short gap instead)
      const endSong = next ? Math.min(next.target, s.target + (next.src - s.src) * k) : clip.endSec;
      const c = structuredClone(base);
      c.id = "clip_" + Math.random().toString(36).slice(2, 9);
      c.name = `${clip.name || "Audio"} ·${i + 1}`;
      c.startSec = s.target;
      c.endSec = Math.max(s.target + 0.005, endSong);
      // slice content starts at its transient; moved earlier/later in time
      c.audio = { ...clip.audio, offset: s.src - (i === 0 ? 0 : 0), fadeIn: i === 0 ? clip.audio.fadeIn : 0.002, fadeOut: next ? 0.004 : clip.audio.fadeOut };
      delete c.takes; delete c.comp;
      // never read past the end of the source
      const maxSong = c.startSec + (buf.duration - c.audio.offset) * k;
      if (c.endSec > maxSong) c.endSec = maxSong;
      return c;
    });
    t.clips = t.clips.filter(c => c !== clip).concat(out);
    afterEdit(`Audio quantized: ${out.length} slice(s) on the grid.`);
  }

  /** the detector reports the start of its analysis window; find the actual attack */
  function refineOnset(buf, t) {
    const rate = buf.sampleRate, d = buf.getChannelData(0);
    const i0 = Math.max(0, Math.floor(t * rate)), i1 = Math.min(d.length, i0 + Math.floor(0.05 * rate));
    let peak = 0;
    for (let i = i0; i < i1; i++) peak = Math.max(peak, Math.abs(d[i]));
    if (peak <= 0) return t;
    for (let i = i0; i < i1; i++) if (Math.abs(d[i]) >= peak * 0.2) return Math.max(0, i / rate - 0.001); // 1 ms pre-roll
    return t;
  }

  function afterEdit(msg) {
    renderSequencer();
    restartPlaybackFromCurrentPosition();
    statusEl.textContent = msg;
    window.WAWCollab?.notifyChange?.();
  }

  window.WAWWarp = { factor, getStretched, prepare, prepareAll, onClipRemapped, detectTempo, setWarp, quantizeAudio, stretch, sourceLen };
})();
