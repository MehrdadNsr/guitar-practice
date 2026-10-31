/*
 * audio-engine.js
 * Web Audio plumbing: one shared AudioContext, a drift-free metronome and
 * the live chord listener (microphone or audio file).
 *
 * The metronome uses the look-ahead scheduler from Chris Wilson's "A Tale of
 * Two Clocks", as Guitar-Scale-Tool's Metronome does: setInterval only wakes
 * the scheduler, clicks are placed on the sample-accurate audio clock.
 */
(function (global) {
  'use strict';

  const GP = global.GP || (global.GP = {});

  // ------------------------------------------------------------- context

  let ctx = null;

  /** Returns the shared AudioContext, creating/resuming it (needs a user gesture). */
  async function getContext() {
    const AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) throw Object.assign(new Error('Web Audio not supported'), { code: 'unsupported' });
    if (!ctx) ctx = new AC({ latencyHint: 'interactive' });
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch (e) { /* resumed later by a gesture */ }
    }
    return ctx;
  }

  // ----------------------------------------------------------- metronome

  const LOOKAHEAD_S = 0.12;
  const TICK_MS = 25;
  // Click pitches sit above the chord detector's analysis band (<= 1.2 kHz)
  // so the metronome does not pollute chord recognition.
  const CLICK = { accent: { freq: 2000, gain: 0.55 }, beat: { freq: 1500, gain: 0.35 } };

  class Metronome {
    constructor() {
      this.bpm = 90;
      this.beatsPerBar = 4;
      this.accent = true;
      this.volume = 0.8;
      this.running = false;
      this.onBeat = null; // (beatIndex, isAccent) => void
      this._timer = null;
      this._nextTime = 0;
      this._beat = 0;
      this._pending = new Set();
      this._uiTimers = new Set();
    }

    setBpm(bpm) { this.bpm = Math.max(20, Math.min(300, Number(bpm) || 90)); }

    setBeatsPerBar(n) { this.beatsPerBar = Math.max(1, Math.min(16, n | 0 || 4)); }

    async start() {
      const c = await getContext();
      this.stop();
      this.running = true;
      this._beat = 0;
      this._nextTime = c.currentTime + 0.06;
      this._timer = setInterval(() => this._schedule(), TICK_MS);
      this._schedule();
    }

    stop() {
      this.running = false;
      if (this._timer) clearInterval(this._timer);
      this._timer = null;
      this._pending.forEach((o) => { try { o.stop(); } catch (e) { /* already stopped */ } });
      this._pending.clear();
      this._uiTimers.forEach((t) => clearTimeout(t));
      this._uiTimers.clear();
    }

    _schedule() {
      if (!ctx || !this.running) return;
      // If the tab was asleep, skip missed beats instead of machine-gunning them.
      if (this._nextTime < ctx.currentTime - 0.2) this._nextTime = ctx.currentTime + 0.05;
      while (this._nextTime < ctx.currentTime + LOOKAHEAD_S) {
        const isAccent = this.accent && this._beat === 0;
        this._click(this._nextTime, isAccent);
        const beat = this._beat;
        const delay = Math.max(0, (this._nextTime - ctx.currentTime) * 1000);
        const id = setTimeout(() => {
          this._uiTimers.delete(id);
          if (this.running && this.onBeat) this.onBeat(beat, isAccent);
        }, delay);
        this._uiTimers.add(id);
        this._nextTime += 60 / this.bpm;
        this._beat = (this._beat + 1) % this.beatsPerBar;
      }
    }

    _click(time, accent) {
      const spec = accent ? CLICK.accent : CLICK.beat;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = spec.freq;
      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.exponentialRampToValueAtTime(spec.gain * this.volume, time + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
      osc.connect(gain).connect(ctx.destination);
      osc.start(time);
      osc.stop(time + 0.06);
      this._pending.add(osc);
      osc.onended = () => this._pending.delete(osc);
    }
  }

  // -------------------------------------------------------- tap tempo

  class TapTempo {
    constructor() { this.taps = []; }

    /** Registers a tap; returns the BPM once there are two taps, else null. */
    tap(nowMs) {
      const t = nowMs === undefined ? performance.now() : nowMs;
      if (this.taps.length && t - this.taps[this.taps.length - 1] > 2000) this.taps = [];
      this.taps.push(t);
      if (this.taps.length > 5) this.taps.shift();
      if (this.taps.length < 2) return null;
      const span = this.taps[this.taps.length - 1] - this.taps[0];
      return Math.round((60000 * (this.taps.length - 1)) / span);
    }
  }

  // ------------------------------------------------------ chord listener

  /**
   * Feeds analyser frames to a ChordTracker at a fixed hop.
   * Graph: source -> high-pass 60 Hz -> analyser (FFT 8192)
   *        source -> low-pass 320 Hz -> lowAnalyser (time domain, for YIN)
   */
  class ChordListener {
    constructor(tracker, onResult) {
      this.tracker = tracker;
      this.onResult = onResult;
      this.source = null;
      this.stream = null;
      this.mediaEl = null;
      this.mode = null; // 'mic' | 'file' | null
      this._timer = null;
      this.hopMs = 40;
    }

    get active() { return this.mode !== null; }

    /** Opens the microphone. Throws an Error with .code on failure. */
    async startMic() {
      if (!global.isSecureContext) throw Object.assign(new Error('insecure context'), { code: 'insecure' });
      const md = global.navigator && global.navigator.mediaDevices;
      if (!md || !md.getUserMedia) throw Object.assign(new Error('getUserMedia missing'), { code: 'unsupported' });
      const c = await getContext();
      let stream;
      try {
        // Raw signal: echo cancellation, noise suppression and AGC all
        // distort a guitar's spectrum (guitar-chord-trainer does the same).
        stream = await md.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
      } catch (err) {
        const name = err && err.name;
        const code = name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError'
          ? 'denied'
          : name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError'
            ? 'notfound'
            : name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError'
              ? 'busy'
              : name === 'NotSupportedError' || name === 'TypeError'
                ? 'unsupported'
                : 'unknown';
        throw Object.assign(new Error(err && err.message ? err.message : String(err)), { code });
      }
      this.stop();
      this.stream = stream;
      this.source = c.createMediaStreamSource(stream);
      stream.getAudioTracks().forEach((track) => {
        track.addEventListener('ended', () => {
          if (this.mode === 'mic') {
            this.stop();
            if (this.onResult) this.onResult(null, { code: 'ended' });
          }
        });
      });
      this._wire(c, false);
      this.mode = 'mic';
    }

    /** Plays an audio file through the speakers and analyses it. */
    async startFile(file) {
      const c = await getContext();
      this.stop();
      const el = new Audio();
      el.src = URL.createObjectURL(file);
      el.loop = false;
      el.crossOrigin = 'anonymous';
      this.mediaEl = el;
      this.source = c.createMediaElementSource(el);
      this._wire(c, true);
      this.mode = 'file';
      el.addEventListener('ended', () => {
        if (this.mode === 'file') {
          this.stop();
          if (this.onResult) this.onResult(null, { code: 'file-ended' });
        }
      });
      await el.play();
    }

    _wire(c, monitor) {
      this.hp = c.createBiquadFilter();
      this.hp.type = 'highpass';
      this.hp.frequency.value = 60;
      this.hp.Q.value = 0.707;
      this.analyser = c.createAnalyser();
      this.analyser.fftSize = 8192;
      this.analyser.smoothingTimeConstant = 0;
      this.lp = c.createBiquadFilter();
      this.lp.type = 'lowpass';
      this.lp.frequency.value = 320;
      this.lp.Q.value = 0.707;
      this.lowAnalyser = c.createAnalyser();
      this.lowAnalyser.fftSize = 4096;
      this.lowAnalyser.smoothingTimeConstant = 0;
      this.source.connect(this.hp).connect(this.analyser);
      this.source.connect(this.lp).connect(this.lowAnalyser);
      if (monitor) this.source.connect(c.destination);
      this.db = new Float32Array(this.analyser.frequencyBinCount);
      this.lowTime = new Float32Array(this.lowAnalyser.fftSize);
      this.tracker.reset();
      this._timer = setInterval(() => this._tick(c), this.hopMs);
    }

    _tick(c) {
      if (!this.analyser) return;
      this.analyser.getFloatFrequencyData(this.db);
      if (this.lowAnalyser.getFloatTimeDomainData) this.lowAnalyser.getFloatTimeDomainData(this.lowTime);
      const result = this.tracker.process({
        db: this.db,
        sampleRate: c.sampleRate,
        fftSize: this.analyser.fftSize,
        lowTime: this.lowTime,
        t: performance.now(),
      });
      if (this.onResult) this.onResult(result, null);
    }

    stop() {
      if (this._timer) clearInterval(this._timer);
      this._timer = null;
      [this.source, this.hp, this.lp, this.analyser, this.lowAnalyser].forEach((n) => {
        if (n) { try { n.disconnect(); } catch (e) { /* not connected */ } }
      });
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      if (this.mediaEl) {
        this.mediaEl.pause();
        URL.revokeObjectURL(this.mediaEl.src);
      }
      this.source = this.hp = this.lp = this.analyser = this.lowAnalyser = null;
      this.stream = null;
      this.mediaEl = null;
      this.mode = null;
    }
  }

  /** Current microphone permission: 'granted' | 'denied' | 'prompt' | 'unknown'. */
  async function micPermission() {
    try {
      if (!global.navigator.permissions) return 'unknown';
      const st = await global.navigator.permissions.query({ name: 'microphone' });
      return st.state;
    } catch (e) {
      return 'unknown';
    }
  }

  GP.Audio = { getContext, Metronome, TapTempo, ChordListener, micPermission };
})(typeof window !== 'undefined' ? window : globalThis);
