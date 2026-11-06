/*
 * voice-engine.js
 * Live prosody analysis of a speaking voice: pitch, loudness, syllable
 * onsets and sentence (utterance) segmentation, reduced to a small summary
 * per sentence.
 *
 * Pure computation, no DOM and no Web Audio calls: the browser feeds frames
 * from AnalyserNodes every 20 ms, the Node tests feed frames from synthetic
 * audio. Reuses the chord detector's YIN pitch estimator, its noise-floor
 * warm-up and its level-rise / spectral-flux onset idea with speech
 * thresholds.
 *
 * Frame = {
 *   time:     Float32Array, full-band time-domain samples (loudness, flux)
 *   lowTime:  Float32Array, low-passed time-domain samples (YIN pitch)
 *   db:       Float32Array, optional AnalyserNode dB bins (spectral flux)
 *   fftSize:  number, optional (with db)
 *   sampleRate: number
 *   t:        ms, monotonic clock (performance.now())
 *   wall:     ms since epoch, optional (Date.now()); defaults to clockOffset + t
 * }
 */
(function (global) {
  'use strict';

  const CD = typeof module !== 'undefined' && module.exports
    ? require('./chord-detector.js')
    : global.GP.ChordDetector;

  const DEFAULTS = {
    hopMs: 20,
    minHz: 60,
    maxHz: 500,
    yinThreshold: 0.2,
    yinTargetRate: 12000,       // decimate the low-passed frame to about this rate
    voicedMaxAperiodicity: 0.3,
    warmupMs: 500,              // learn the room noise floor
    noiseMarginDb: 10,          // speech must clear the noise floor by this
    gateDbfs: -62,              // ...and this absolute level
    silenceMs: 600,             // this much silence ends a sentence
    minUtteranceMs: 250,        // shorter segments are ignored
    maxUtteranceMs: 30000,      // safety: force a split
    onsetRiseDb: 4,             // level rise over the recent minimum
    onsetLookbackMs: 120,       // ...measured against the minimum in this window
    onsetRearmDb: 3,            // level must dip this far below its peak before the next onset
    onsetFluxFactor: 2.5,
    refractoryMs: 80,
    fluxLowHz: 150,
    fluxHighHz: 4000,
    contourStepMs: 100,
    endTrendFraction: 0.3,      // slope over the last 30 % of the sentence
    endTrendSemitonesPerSec: 2, // |slope| above this is rising / falling
  };

  // ------------------------------------------------------------ helpers

  function rmsDbfs(samples) {
    let s = 0;
    for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i];
    if (!samples.length || s <= 0) return -Infinity;
    return 10 * Math.log10(s / samples.length);
  }

  function median(sorted) {
    const n = sorted.length;
    if (!n) return null;
    return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  }

  function percentile(sorted, p) {
    const n = sorted.length;
    if (!n) return null;
    const pos = (n - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.min(n - 1, lo + 1);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  function round(x, d) {
    if (x === null || x === undefined || !isFinite(x)) return null;
    const f = Math.pow(10, d || 0);
    return Math.round(x * f) / f;
  }

  function semitones(hz) { return 12 * Math.log2(hz); }

  /** Least-squares slope of semitones over seconds for voiced points. */
  function pitchSlope(points) {
    const n = points.length;
    if (n < 3) return null;
    let sx = 0, sy = 0;
    for (const p of points) { sx += p.t; sy += p.st; }
    const mx = sx / n;
    const my = sy / n;
    let num = 0, den = 0;
    for (const p of points) {
      num += (p.t - mx) * (p.st - my);
      den += (p.t - mx) * (p.t - mx);
    }
    if (den <= 0) return null;
    return (num / den) * 1000; // semitones per second (t is in ms)
  }

  function randomId() {
    const c = global.crypto;
    if (c && c.randomUUID) return c.randomUUID();
    let s = '';
    for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  }

  // ----------------------------------------------------------- pitch

  /**
   * Raw speech pitch of one low-passed frame: { hz, aperiodicity } or null.
   * No note snapping, no smoothing: the continuous Hz value as YIN finds it.
   */
  function framePitch(lowTime, sampleRate, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const decim = Math.max(1, Math.round(sampleRate / o.yinTargetRate));
    const y = CD.yin(lowTime, sampleRate, o.minHz, o.maxHz, o.yinThreshold, decim);
    if (!y || !isFinite(y.freq) || y.freq < o.minHz || y.freq > o.maxHz) return null;
    return { hz: y.freq, aperiodicity: y.aperiodicity };
  }

  // -------------------------------------------------------- summaries

  /**
   * Reduces the frames of one segment to the summary row sent to Supabase.
   * frames: [{ t, wall, dbfs, hz|null, voiced, onset, gateOpen }]
   */
  function summarize(frames, meta, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const m = meta || {};
    if (!frames.length) return null;
    const first = frames[0];
    const last = frames[frames.length - 1];
    const t0 = first.t;
    const durationMs = Math.max(o.hopMs, last.t - t0 + o.hopMs);

    const voiced = frames.filter((f) => f.voiced && f.hz !== null);
    const hzSorted = voiced.map((f) => f.hz).sort((a, b) => a - b);

    // End trend: slope of voiced pitch over the last 30 % of the sentence.
    const tailStart = t0 + durationMs * (1 - o.endTrendFraction);
    const tail = voiced.filter((f) => f.t >= tailStart).map((f) => ({ t: f.t, st: semitones(f.hz) }));
    const slope = pitchSlope(tail);
    let trend = 'flat';
    if (slope !== null) {
      if (slope > o.endTrendSemitonesPerSec) trend = 'rising';
      else if (slope < -o.endTrendSemitonesPerSec) trend = 'falling';
    }

    // Loudness over frames where the gate was open (speech, not the pauses).
    const loud = frames.filter((f) => f.gateOpen && isFinite(f.dbfs));
    let powerSum = 0;
    let peak = -Infinity;
    for (const f of loud) {
      powerSum += Math.pow(10, f.dbfs / 10);
      if (f.dbfs > peak) peak = f.dbfs;
    }
    const loudMean = loud.length ? 10 * Math.log10(powerSum / loud.length) : null;

    const onsets = frames.reduce((n, f) => n + (f.onset ? 1 : 0), 0);
    const voicedSec = (voiced.length * o.hopMs) / 1000;
    const rateBase = voicedSec >= 0.1 ? voicedSec : durationMs / 1000;

    const contour = [];
    let nextTick = 0;
    for (const f of frames) {
      const rel = f.t - t0;
      if (rel + 1e-6 >= nextTick) {
        contour.push({ t_ms: Math.round(rel), hz: f.voiced && f.hz !== null ? round(f.hz, 1) : null, dbfs: round(f.dbfs, 1) });
        nextTick += o.contourStepMs;
      }
    }

    const startWall = first.wall;
    const endWall = startWall + durationMs;
    return {
      kind: m.kind || 'utterance',
      session_id: m.sessionId || null,
      started_at: new Date(startWall).toISOString(),
      ended_at: new Date(endWall).toISOString(),
      duration_ms: Math.round(durationMs),
      pause_before_ms: m.pauseBeforeMs === undefined || m.pauseBeforeMs === null ? null : Math.round(m.pauseBeforeMs),
      pitch_median_hz: round(median(hzSorted), 1),
      pitch_p10_hz: round(percentile(hzSorted, 0.1), 1),
      pitch_p90_hz: round(percentile(hzSorted, 0.9), 1),
      pitch_end_trend: trend,
      loudness_mean_dbfs: round(loudMean, 1),
      loudness_peak_dbfs: round(isFinite(peak) ? peak : null, 1),
      syllable_rate: round(onsets / rateBase, 2),
      voiced_ratio: round(voiced.length / frames.length, 3),
      contour,
    };
  }

  // ------------------------------------------------------------ tracker

  class VoiceTracker {
    constructor(opts) {
      this.opts = Object.assign({}, DEFAULTS, opts || {});
      this.sessionId = this.opts.sessionId || randomId();
      this.clockOffset = this.opts.clockOffset || 0; // wall = clockOffset + t
      this.reset();
    }

    reset() {
      this.startedAt = null;
      this.warmFrames = 0;
      this.noiseFloor = -Infinity;
      this.gateOpen = false;
      this.lastOnsetAt = -Infinity;
      this.onsetArmed = true;
      this.peakSinceOnset = -Infinity;
      this.levelHistory = [];     // [{ t, dbfs }] for the level-rise detector
      this.prevDb = null;
      this.fluxAvg = 0;
      this.current = null;        // frames of the sentence being spoken
      this.lastOpenAt = -Infinity;
      this.lastUtteranceEnd = null;
      this.baseline = null;       // frames collected for a calibration row
    }

    /** Positive spectral flux in the speech band (dB per bin). */
    _flux(db, sampleRate, fftSize) {
      if (!db || !fftSize) return 0;
      const binHz = sampleRate / fftSize;
      const lo = Math.max(1, Math.floor(this.opts.fluxLowHz / binHz));
      const hi = Math.min(db.length - 1, Math.ceil(this.opts.fluxHighHz / binHz));
      let flux = 0;
      let n = 0;
      if (this.prevDb && this.prevDb.length === db.length) {
        let maxDb = -Infinity;
        for (let k = lo; k <= hi; k++) if (db[k] > maxDb) maxDb = db[k];
        const floor = maxDb - 50;
        for (let k = lo; k <= hi; k++) {
          const cur = Math.max(db[k], floor);
          const prev = Math.max(this.prevDb[k], floor);
          const d = cur - prev;
          if (d > 0) flux += d;
          n++;
        }
      }
      if (!this.prevDb || this.prevDb.length !== db.length) this.prevDb = new Float32Array(db.length);
      this.prevDb.set(db);
      return n ? flux / n : 0;
    }

    /** Starts collecting frames for a 'baseline' (calibration) row. */
    startBaseline() { this.baseline = []; }

    /** Ends calibration; returns the baseline summary (or null if empty). */
    stopBaseline() {
      const frames = this.baseline;
      this.baseline = null;
      if (!frames || !frames.length) return null;
      return summarize(frames, { kind: 'baseline', sessionId: this.sessionId, pauseBeforeMs: 0 }, this.opts);
    }

    /** Forces the current sentence to end (e.g. when the user presses stop). */
    flush() {
      if (!this.current) return null;
      const out = this._closeUtterance();
      this.current = null;
      return out;
    }

    _closeUtterance() {
      const frames = this.current;
      const o = this.opts;
      const span = frames[frames.length - 1].t - frames[0].t + o.hopMs;
      if (span < o.minUtteranceMs) return null;
      const pauseBefore = this.lastUtteranceEnd === null
        ? frames[0].t - this.startedAt
        : frames[0].t - this.lastUtteranceEnd;
      const summary = summarize(frames, { kind: 'utterance', sessionId: this.sessionId, pauseBeforeMs: pauseBefore }, o);
      this.lastUtteranceEnd = frames[frames.length - 1].t + o.hopMs;
      return summary;
    }

    /** Analyses one frame; returns the live state and, when one ends, a sentence summary. */
    process(frame) {
      const o = this.opts;
      const t = frame.t;
      const wall = frame.wall !== undefined ? frame.wall : this.clockOffset + t;
      if (this.startedAt === null) this.startedAt = t;
      const warmup = t - this.startedAt < o.warmupMs;

      const dbfs = rmsDbfs(frame.time);

      // Noise floor: minimum level during warm-up, then it follows the room
      // down quickly and up slowly, but only while nobody is speaking.
      if (isFinite(dbfs)) {
        if (warmup) this.noiseFloor = this.warmFrames++ === 0 ? dbfs : Math.min(this.noiseFloor, dbfs);
        else if (!isFinite(this.noiseFloor)) this.noiseFloor = Math.min(dbfs, o.gateDbfs - o.noiseMarginDb); // digital silence so far
        else if (dbfs < this.noiseFloor) this.noiseFloor += 0.3 * (dbfs - this.noiseFloor);
        else if (!this.gateOpen) this.noiseFloor += 0.02 * (dbfs - this.noiseFloor);
      }
      const threshold = Math.max(o.gateDbfs, this.noiseFloor + o.noiseMarginDb);
      const gateOpen = !warmup && dbfs >= threshold;
      this.gateOpen = gateOpen;

      // Pitch (raw, per frame) and voicing from YIN aperiodicity.
      const p = gateOpen ? framePitch(frame.lowTime, frame.sampleRate, o) : null;
      const voiced = !!(p && p.aperiodicity < o.voicedMaxAperiodicity);
      const hz = p ? p.hz : null;

      // Onset = syllable start: level rise over the recent minimum, or a
      // spectral-flux jump, with a short refractory period.
      this.levelHistory.push({ t, dbfs });
      while (this.levelHistory.length && this.levelHistory[0].t < t - o.onsetLookbackMs) this.levelHistory.shift();
      let recentMin = Infinity;
      for (let i = 0; i < this.levelHistory.length - 1; i++) {
        const v = this.levelHistory[i].dbfs;
        if (v < recentMin) recentMin = v;
      }
      const rise = isFinite(recentMin) ? dbfs - recentMin : (isFinite(dbfs) ? Infinity : 0);
      const flux = this._flux(frame.db, frame.sampleRate, frame.fftSize);
      const fluxThr = this.fluxAvg * o.onsetFluxFactor + 0.5;
      // Hysteresis: after an onset the level must dip before the next one,
      // so one syllable's attack is not counted twice.
      if (dbfs > this.peakSinceOnset) this.peakSinceOnset = dbfs;
      if (!this.onsetArmed && dbfs <= this.peakSinceOnset - o.onsetRearmDb) this.onsetArmed = true;
      let onset = false;
      if (gateOpen && this.onsetArmed && t - this.lastOnsetAt >= o.refractoryMs
        && (rise >= o.onsetRiseDb || (flux > fluxThr && this.fluxAvg > 0))) {
        onset = true;
        this.lastOnsetAt = t;
        this.onsetArmed = false;
        this.peakSinceOnset = dbfs;
      }
      if (gateOpen) this.fluxAvg += 0.05 * (flux - this.fluxAvg);

      const rec = { t, wall, dbfs, hz, aperiodicity: p ? p.aperiodicity : null, voiced, onset, gateOpen };
      if (this.baseline) this.baseline.push(rec);

      // Sentence segmentation.
      let utterance = null;
      if (gateOpen) {
        if (!this.current) this.current = [];
        this.lastOpenAt = t;
      }
      if (this.current) {
        this.current.push(rec);
        const silent = t - this.lastOpenAt;
        const span = t - this.current[0].t;
        if (silent >= o.silenceMs || span >= o.maxUtteranceMs) {
          // Drop the trailing silence frames from the sentence itself.
          while (this.current.length && !this.current[this.current.length - 1].gateOpen) this.current.pop();
          if (this.current.length) utterance = this._closeUtterance();
          this.current = null;
        }
      }

      return {
        t,
        dbfs,
        hz,
        voiced,
        aperiodicity: rec.aperiodicity,
        onset,
        gateOpen,
        warmup,
        noiseFloor: this.noiseFloor,
        threshold,
        speaking: !!this.current,
        utterance,
      };
    }
  }

  const api = { DEFAULTS, rmsDbfs, framePitch, summarize, pitchSlope, VoiceTracker, randomId };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (global.GP = global.GP || {}).VoiceEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
