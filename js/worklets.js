// AudioWorklet processors used by WAW (loaded with audioWorklet.addModule).
// Keep this file free of DOM access: it runs on the audio rendering thread.

// ---------------------------------------------------------------------------
// Noise gate / expander with hysteresis, hold and smooth attack/release.
// ---------------------------------------------------------------------------
class WawGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "threshold", defaultValue: -45, minValue: -90, maxValue: 0, automationRate: "k-rate" },   // dB
      { name: "range", defaultValue: -80, minValue: -90, maxValue: 0, automationRate: "k-rate" },       // dB of attenuation when closed
      { name: "attack", defaultValue: 0.002, minValue: 0.0001, maxValue: 0.2, automationRate: "k-rate" },
      { name: "hold", defaultValue: 0.03, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "release", defaultValue: 0.12, minValue: 0.005, maxValue: 2, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.env = 0;
    this.gain = 1;
    this.holdLeft = 0;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;

    const thrLin = Math.pow(10, params.threshold[0] / 20);
    const closeLin = thrLin * 0.7; // ~3 dB hysteresis
    const floor = Math.pow(10, params.range[0] / 20);
    const atk = Math.exp(-1 / (params.attack[0] * sampleRate));
    const rel = Math.exp(-1 / (params.release[0] * sampleRate));
    const holdSamples = params.hold[0] * sampleRate;
    const envCoef = Math.exp(-1 / (0.005 * sampleRate));
    const frames = input[0].length;

    for (let i = 0; i < frames; i++) {
      let peak = 0;
      for (let ch = 0; ch < input.length; ch++) {
        const v = Math.abs(input[ch][i]);
        if (v > peak) peak = v;
      }
      this.env = peak > this.env ? peak : envCoef * this.env + (1 - envCoef) * peak;

      let target;
      if (this.env >= thrLin) { target = 1; this.holdLeft = holdSamples; }
      else if (this.holdLeft > 0) { target = 1; this.holdLeft--; }
      else if (this.env < closeLin) target = floor;
      else target = this.gain >= 0.5 ? 1 : floor;

      const coef = target > this.gain ? atk : rel;
      this.gain = coef * this.gain + (1 - coef) * target;

      for (let ch = 0; ch < output.length; ch++) {
        const src = input[ch] || input[0];
        output[ch][i] = src[i] * this.gain;
      }
    }
    return true;
  }
}
registerProcessor("waw-gate", WawGateProcessor);

// ---------------------------------------------------------------------------
// Bitcrusher: bit depth reduction + sample-rate reduction (sample & hold).
// ---------------------------------------------------------------------------
class WawBitcrusherProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "bits", defaultValue: 8, minValue: 1, maxValue: 16, automationRate: "k-rate" },
      { name: "downsample", defaultValue: 4, minValue: 1, maxValue: 64, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.hold = [0, 0];
    this.counter = 0;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    const steps = Math.pow(2, Math.round(params.bits[0])) / 2;
    const ds = Math.max(1, Math.round(params.downsample[0]));
    const frames = input[0].length;
    for (let i = 0; i < frames; i++) {
      if (this.counter <= 0) {
        for (let ch = 0; ch < output.length; ch++) {
          const src = input[ch] || input[0];
          this.hold[ch] = Math.round(src[i] * steps) / steps;
        }
        this.counter = ds;
      }
      this.counter--;
      for (let ch = 0; ch < output.length; ch++) output[ch][i] = this.hold[ch] ?? 0;
    }
    return true;
  }
}
registerProcessor("waw-bitcrusher", WawBitcrusherProcessor);

// ---------------------------------------------------------------------------
// Recorder: forwards input blocks to the main thread while "recording".
// Messages in:  { cmd: "start" } | { cmd: "stop" }
// Messages out: { type: "data", channels: Float32Array[] } | { type: "stopped" }
// Blocks are batched (~4096 frames) to keep message traffic low.
// ---------------------------------------------------------------------------
class WawRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.batch = [];
    this.batchFrames = 0;
    this.startFrame = 0;
    this.port.onmessage = (e) => {
      if (e.data?.cmd === "start") {
        this.recording = true;
        this.batch = [];
        this.batchFrames = 0;
        this.port.postMessage({ type: "started", frame: currentFrame, time: currentTime });
      } else if (e.data?.cmd === "stop") {
        this.flush();
        this.recording = false;
        this.port.postMessage({ type: "stopped", frame: currentFrame, time: currentTime });
      }
    };
  }

  flush() {
    if (!this.batch.length) return;
    const chCount = this.batch[0].length;
    const out = [];
    for (let ch = 0; ch < chCount; ch++) {
      const buf = new Float32Array(this.batchFrames);
      let off = 0;
      for (const block of this.batch) { buf.set(block[ch], off); off += block[ch].length; }
      out.push(buf);
    }
    this.port.postMessage({ type: "data", channels: out }, out.map(b => b.buffer));
    this.batch = [];
    this.batchFrames = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    // pass-through so the node can sit inline (output is usually not connected)
    const output = outputs[0];
    if (input && input.length && output) {
      for (let ch = 0; ch < output.length; ch++) output[ch].set(input[ch] || input[0]);
    }
    if (this.recording && input && input.length) {
      this.batch.push(input.map(ch => ch.slice()));
      this.batchFrames += input[0].length;
      if (this.batchFrames >= 4096) this.flush();
    }
    return true;
  }
}
registerProcessor("waw-recorder", WawRecorderProcessor);
