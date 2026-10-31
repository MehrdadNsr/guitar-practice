/*
 * audio-sim.js — test helpers (Node only, no dependencies).
 *
 * - Karplus-Strong plucked-string synthesis and strummed chords built from
 *   the app's own chord shapes.
 * - An AnalyserNode emulator (Blackman window, FFT, |X|/N in dB) and an RBJ
 *   low-pass biquad, so the detector sees the same kind of frames it gets
 *   from Web Audio in the browser.
 * - A 16-bit PCM WAV writer used to build fake-microphone input for
 *   browser tests.
 */
'use strict';

const Shapes = require('../../js/chord-shapes.js');

const OPEN_STRINGS = [40, 45, 50, 55, 59, 64]; // E2 A2 D3 G3 B3 E4

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Adds one Karplus-Strong plucked string into `out` starting at `start`. */
function pluck(out, sr, start, freq, amp, rand, opts) {
  const o = Object.assign({ decay: 0.9965, brightness: 0.5, seconds: 2.5 }, opts || {});
  if (start >= out.length) return;
  const len = Math.min(out.length - start, Math.floor(o.seconds * sr));
  // y[n] = g * 0.5 * (y[n - D] + y[n - D - 1]); the two-point average adds
  // half a sample, so D = P - 0.5 gives an exact period P = sr / freq.
  // y[n - D] is read with linear interpolation (fractional delay).
  const P = sr / freq;
  const D = P - 0.5;
  const E = Math.ceil(P) + 2;
  const s = new Float64Array(len + E);
  let prev = 0;
  let mean = 0;
  for (let i = 0; i < E; i++) {
    const v = rand() * 2 - 1;
    prev = prev + o.brightness * (v - prev); // low-passed noise burst
    let x = prev;
    if (o.pluckPos) {
      // Triangular string displacement plucked at pluckPos (harmonics fall
      // off ~1/n^2, like a real pick), plus a little noise for the attack.
      const u = i / E;
      const tri = u < o.pluckPos ? u / o.pluckPos : (1 - u) / (1 - o.pluckPos);
      x = tri + (o.pluckNoise || 0.15) * prev;
    }
    s[i] = x;
    mean += x;
  }
  mean /= E;
  for (let i = 0; i < E; i++) s[i] -= mean;
  const at = (pos) => {
    const i0 = Math.floor(pos);
    const fr = pos - i0;
    return s[i0] * (1 - fr) + s[i0 + 1] * fr;
  };
  for (let n = E; n < s.length; n++) {
    s[n] = o.decay * 0.5 * (at(n - D) + at(n - D - 1));
  }
  for (let n = 0; n < len; n++) out[start + n] += amp * s[n];
}

function midiToFreq(m, centsOffset) {
  return 440 * Math.pow(2, (m - 69 + (centsOffset || 0) / 100) / 12);
}


/**
 * A six-string guitar. Plucking a string stops whatever that string was
 * playing (a real string can only sound one pitch), and strings left out of
 * a new chord are damped, as a player's hand does when changing chords.
 */
class Guitar {
  constructor(sr, rand) {
    this.sr = sr;
    this.rand = rand;
    this.events = [];
  }

  /** Queues a strum of `name` at time t (seconds). */
  strum(t, name, opts) {
    const o = Object.assign({ strumMs: 12, amp: 0.25, cents: 0, down: true, brightness: 0.5, decay: 0.9965, pluckPos: 0, pluckNoise: 0.15 }, opts || {});
    const shape = Shapes.getShape(name);
    if (!shape) throw new Error('no shape for ' + name);
    const strings = [0, 1, 2, 3, 4, 5];
    const order = o.down ? strings : strings.slice().reverse();
    let k = 0;
    order.forEach((s) => {
      const f = shape.frets[s];
      if (f === 'x') {
        this.events.push({ t, string: s, mute: true });
        return;
      }
      const at = t + (k++ * o.strumMs) / 1000;
      const amp = o.amp * (0.65 + 0.35 * this.rand());
      const freq = midiToFreq(OPEN_STRINGS[s] + f, o.cents + (this.rand() - 0.5) * 6);
      this.events.push({ t: at, string: s, freq, amp, brightness: o.brightness, decay: o.decay, pluckPos: o.pluckPos, pluckNoise: o.pluckNoise });
    });
  }

  render(seconds) {
    const sr = this.sr;
    const out = new Float64Array(Math.floor(seconds * sr));
    const ev = this.events.slice().sort((a, b) => a.t - b.t);
    ev.forEach((e, i) => {
      if (e.mute) return;
      // Ends when the same string is plucked again or muted.
      let end = seconds;
      for (let j = i + 1; j < ev.length; j++) {
        if (ev[j].string === e.string && ev[j].t > e.t) { end = ev[j].t; break; }
      }
      const tmp = new Float64Array(Math.max(0, Math.floor((end - e.t + 0.01) * sr)));
      pluck(tmp, sr, 0, e.freq, e.amp, this.rand, { brightness: e.brightness, decay: e.decay, pluckPos: e.pluckPos, pluckNoise: e.pluckNoise, seconds: 30 });
      const start = Math.floor(e.t * sr);
      const fade = Math.floor(0.008 * sr);
      for (let n = 0; n < tmp.length && start + n < out.length; n++) {
        const g = n > tmp.length - fade ? (tmp.length - n) / fade : 1;
        out[start + n] += tmp[n] * g;
      }
    });
    return out;
  }
}

/** Notes (MIDI) of a chord voicing from the app's shape table. */
function chordMidi(name) {
  const shape = Shapes.getShape(name);
  if (!shape) throw new Error('no shape for ' + name);
  const notes = [];
  shape.frets.forEach((f, s) => { if (f !== 'x') notes.push(OPEN_STRINGS[s] + f); });
  return notes;
}

/**
 * Renders a song: [{ chord, t }] -> Float64Array. opts are passed to every
 * strum; `strumsPerChord` repeats each chord (alternating down/up).
 */
function renderProgression(sr, rand, chords, opts) {
  const o = Object.assign({ per: 1.6, lead: 0.3, strumsPerChord: 1, tail: 0.8 }, opts || {});
  const g = new Guitar(sr, rand);
  chords.forEach((c, i) => {
    for (let k = 0; k < o.strumsPerChord; k++) {
      g.strum(o.lead + i * o.per + (k * o.per) / o.strumsPerChord, c, Object.assign({}, o, { down: k % 2 === 0 }));
    }
  });
  return g.render(o.lead + chords.length * o.per + o.tail);
}

function addNoise(out, level, rand) {
  for (let i = 0; i < out.length; i++) out[i] += level * (rand() * 2 - 1);
}

function addHum(out, sr, freq, level) {
  for (let i = 0; i < out.length; i++) {
    const ph = (2 * Math.PI * freq * i) / sr;
    out[i] += level * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.3 * Math.sin(3 * ph) + 0.2 * Math.sin(4 * ph));
  }
}

// ----------------------------------------------------------- analyser emu

function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k];
        const ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br;
        im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br;
        im[i + k + len / 2] = ai - bi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Emulates AnalyserNode.getFloatFrequencyData (smoothingTimeConstant 0). */
function analyserFrame(signal, endSample, fftSize) {
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const start = endSample - fftSize;
  for (let i = 0; i < fftSize; i++) {
    const s = start + i >= 0 && start + i < signal.length ? signal[start + i] : 0;
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / fftSize) + 0.08 * Math.cos((4 * Math.PI * i) / fftSize);
    re[i] = s * w;
  }
  fftInPlace(re, im);
  const db = new Float32Array(fftSize / 2);
  for (let k = 0; k < fftSize / 2; k++) {
    const mag = Math.hypot(re[k], im[k]) / fftSize;
    db[k] = mag > 0 ? 20 * Math.log10(mag) : -200;
  }
  return db;
}

/** RBJ low-pass biquad, applied offline. */
function lowpass(signal, sr, cutoff, q) {
  const w0 = (2 * Math.PI * cutoff) / sr;
  const alpha = Math.sin(w0) / (2 * (q || 0.707));
  const cos = Math.cos(w0);
  const b0 = (1 - cos) / 2;
  const b1 = 1 - cos;
  const b2 = (1 - cos) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  const out = new Float64Array(signal.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < signal.length; i++) {
    const x = signal[i];
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    out[i] = y;
  }
  return out;
}

/**
 * Runs a ChordTracker over a whole signal at `hopMs` steps.
 * Returns [{ t, result }].
 */
function runTracker(tracker, signal, sr, opts) {
  const o = Object.assign({ fftSize: 8192, lowSize: 4096, hopMs: 40 }, opts || {});
  const low = lowpass(signal, sr, 320, 0.707);
  const hop = Math.round((o.hopMs / 1000) * sr);
  const out = [];
  for (let end = hop; end <= signal.length; end += hop) {
    const db = analyserFrame(signal, end, o.fftSize);
    const lowTime = new Float32Array(o.lowSize);
    for (let i = 0; i < o.lowSize; i++) {
      const idx = end - o.lowSize + i;
      lowTime[i] = idx >= 0 ? low[idx] : 0;
    }
    const t = (end / sr) * 1000;
    out.push({ t, result: tracker.process({ db, sampleRate: sr, fftSize: o.fftSize, lowTime, t }) });
  }
  return out;
}

function writeWav(samples, sr) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

module.exports = {
  OPEN_STRINGS,
  mulberry32,
  pluck,
  Guitar,
  renderProgression,
  chordMidi,
  addNoise,
  addHum,
  analyserFrame,
  lowpass,
  runTracker,
  writeWav,
};
