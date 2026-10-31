/*
 * chord-detector.js
 * Real-time guitar chord recognition from Web Audio analyser frames.
 *
 * Pure computation, no DOM and no Web Audio calls: the browser feeds frames
 * from AnalyserNodes, the Node tests feed frames from synthetic audio.
 *
 * Pipeline (each idea credited to the project it came from):
 *
 *  1. Spectrum -> chroma (Guitar-Scale-Tool, guitar-chord-trainer)
 *     AnalyserNode dB bins between 60 and 1500 Hz are reduced to spectral
 *     peaks (parabolic interpolation for sub-bin frequency), compressed and
 *     folded into 12 pitch classes with a triangular kernel that splits a
 *     peak between its two nearest semitones. The 1.5 kHz ceiling keeps
 *     upper harmonics from pulling triads toward maj7/sus2.
 *  2. Tuning compensation: a running circular mean of the peaks' cent
 *     offsets, so a guitar tuned 30 cents flat still folds correctly.
 *  3. Harmonic-leakage compensation (soundview): a note's 3rd harmonic lands
 *     a fifth up; a fraction of each bin is subtracted from the bin a fifth
 *     above before matching.
 *  4. Bass note via autocorrelation: YIN (de Cheveigné & Kawahara) on a
 *     low-passed, decimated time-domain signal, cross-checked with the
 *     lowest strong FFT peak. FFT bins are ~6 Hz wide, too coarse to tell E2
 *     from F2, while autocorrelation resolves low pitches precisely. A bass
 *     that matches a candidate's root earns a bonus (the root/bass weighting
 *     used by basic-pitch based chord pipelines such as earchords).
 *  5. Template matching with mean-centred cosine (Pearson) similarity, which
 *     cancels flat broadband noise, plus a margin test against the
 *     runner-up (guitar-chord-trainer).
 *  6. Onset detection: spectral flux with an adaptive threshold (soundview)
 *     OR a sudden level rise (guitar-chord-trainer's strum detector), with
 *     a refractory period. After an onset, frames are loudness-weighted and
 *     averaged over a short window (Guitar-Scale-Tool, guitar-chord-trainer).
 *  7. Stability voting (react-circle-of-fifths' anti-flicker idea): strum
 *     results and per-frame sustain results vote in a short time window;
 *     the displayed chord changes only when a challenger clearly wins, with
 *     hysteresis for the incumbent.
 */
(function (global) {
  'use strict';

  const MT = typeof module !== 'undefined' && module.exports
    ? require('./music-theory.js')
    : global.GP.MusicTheory;

  const DEFAULTS = {
    lowHz: 60,
    highHz: 1200,
    binFloorDb: -100,
    peakRangeDb: 45,        // ignore peaks this far below the frame's strongest
    maxPeaks: 28,
    peakFloor: 0.03,        // harmonic subtraction: peaks considered (x strongest)
    acceptFloor: 0.06,      // residual needed to accept a new note (x strongest)
    harmonicTolCents: 35,
    harmonicSubtraction: true,
    compress: 0.5,          // magnitude exponent before folding
    leakage: 0.0,           // 3rd-harmonic leakage subtraction (soundview)
    gateDbfs: -52,          // absolute frame gate (sensitivity control)
    noiseMarginDb: 9,       // gate must also clear the noise floor by this
    noiseFlatnessDb: -6,    // frames flatter than this count as noise
    warmupMs: 250,          // learn the room (minimum level) before listening
    stationaryMs: 5000,     // no attack for this long -> background
    sustainActiveMs: 4000,  // sustain votes need an onset this recent
    hysteresisDb: 5,
    onsetRiseDb: 6,
    onsetFluxFactor: 2.2,
    refractoryMs: 170,
    onsetDelayMs: 20,
    analysisMs: 130,
    minScore: 0.42,
    minMargin: 0.03,
    keepMargin: 0.03,       // re-strum hysteresis
    strumWeight: 4,
    sustainWindowMs: 500,
    switchShare: 0.66,
    minSwitchVotes: 6,
    releaseMs: 1600,
    bassRootBonus: 0.07,
    bassToneBonus: 0.02,
    bassMissPenalty: 0.05,
    complexityPenalty: 0.045,
    preferredBonus: 0.03,
    bassMinHz: 65,
    bassMaxHz: 340,
  };

  // ---------------------------------------------------------------- utils

  function mod12(n) { return ((n % 12) + 12) % 12; }

  function wrapHalf(x) {
    // wrap to [-0.5, 0.5)
    return x - Math.round(x);
  }

  /** In-band level in dBFS from AnalyserNode (Blackman) bin magnitudes. */
  const BLACKMAN_MEAN_SQUARE = 0.42 * 0.42 + (0.5 * 0.5) / 2 + (0.08 * 0.08) / 2;
  function levelFromPower(bandPower) {
    if (bandPower <= 0) return -Infinity;
    return 10 * Math.log10((2 * bandPower) / BLACKMAN_MEAN_SQUARE);
  }

  // ------------------------------------------------------ spectrum analysis

  /**
   * Extracts spectral peaks and band level from one frame of AnalyserNode
   * float frequency data (dB).
   */
  function analyzeSpectrum(db, sampleRate, fftSize, opts) {
    const o = opts || DEFAULTS;
    const binHz = sampleRate / fftSize;
    const iLow = Math.max(1, Math.ceil(o.lowHz / binHz));
    const iHigh = Math.min(db.length - 2, Math.floor(o.highHz / binHz));
    let bandPower = 0;
    let maxDb = -Infinity;
    let sumDb = 0;
    let sumPow = 0;
    for (let i = iLow; i <= iHigh; i++) {
      const v = db[i];
      const vc = Math.max(v, -160);
      const pw = Math.pow(10, vc / 10);
      sumDb += vc;
      sumPow += pw;
      if (v > o.binFloorDb) {
        bandPower += pw;
        if (v > maxDb) maxDb = v;
      }
    }
    // Spectral flatness in dB (geometric / arithmetic mean of bin power):
    // about -2.5 dB for white noise, far lower for strings and voices.
    const nb = iHigh - iLow + 1;
    const flatnessDb = nb > 0 && sumPow > 0 ? sumDb / nb - 10 * Math.log10(sumPow / nb) : 0;
    const peaks = [];
    const floor = Math.max(o.binFloorDb, maxDb - o.peakRangeDb);
    for (let i = iLow; i <= iHigh; i++) {
      const b = db[i];
      if (b <= floor) continue;
      const a = db[i - 1];
      const c = db[i + 1];
      if (!(b > a && b >= c)) continue;
      const denom = a - 2 * b + c;
      const p = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
      const peakDb = b - 0.25 * (a - c) * p;
      peaks.push({ freq: (i + p) * binHz, db: peakDb, mag: Math.pow(10, peakDb / 20) });
    }
    return { peaks, levelDb: levelFromPower(bandPower), maxDb, flatnessDb, iLow, iHigh };
  }

  // Guitar-like harmonic amplitude profile relative to the fundamental
  // (index k-1 = k-th harmonic), from GuitarScope's multi-pitch estimator.
  const HARMONIC_GAINS = [1, 0.6, 0.4, 0.3, 0.2, 0.15, 0.1, 0.08];

  /**
   * Iterative harmonic subtraction (GuitarScope's lightweight matching
   * pursuit). Peaks are visited from low to high; each one is either
   * explained as a harmonic of an already accepted lower note (its
   * predicted amplitude is subtracted) or accepted as a new note with its
   * residual magnitude. This stops a B string's 3rd harmonic (F#) from
   * turning G into Gmaj7.
   */
  function extractNotes(peaks, opts) {
    const o = opts || DEFAULTS;
    if (!peaks.length) return [];
    const byMag = peaks.slice().sort((a, b) => b.mag - a.mag).slice(0, o.maxPeaks);
    const strongest = byMag[0].mag;
    const usable = byMag.filter((p) => p.mag >= strongest * o.peakFloor).sort((a, b) => a.freq - b.freq);
    const notes = [];
    const tol = o.harmonicTolCents / 1200;
    for (const pk of usable) {
      let explained = 0;
      for (const f0 of notes) {
        const k = Math.round(pk.freq / f0.freq);
        if (k < 2 || k > HARMONIC_GAINS.length) continue;
        if (Math.abs(Math.log2(pk.freq / (f0.freq * k))) <= tol) explained += f0.mag * HARMONIC_GAINS[k - 1];
      }
      const residual = pk.mag - explained;
      if (residual >= strongest * o.acceptFloor) notes.push({ freq: pk.freq, mag: residual, db: pk.db });
    }
    return notes;
  }

  /** Folds peaks into a 12-bin chroma (triangular kernel, tuning-corrected). */
  function peaksToChroma(peaks, tuning, opts, out) {
    const o = opts || DEFAULTS;
    const chroma = out || new Float64Array(12);
    chroma.fill(0);
    for (const pk of peaks) {
      const w = Math.pow(pk.mag, o.compress);
      const midi = 12 * Math.log2(pk.freq / 440) + 69 - tuning;
      const lo = Math.floor(midi);
      const frac = midi - lo;
      chroma[mod12(lo)] += w * (1 - frac);
      chroma[mod12(lo + 1)] += w * frac;
    }
    return chroma;
  }

  /** Weighted circular mean of the peaks' offset from equal temperament. */
  function estimateTuning(peaks) {
    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (const pk of peaks) {
      if (pk.freq > 700) continue;
      const midi = 12 * Math.log2(pk.freq / 440) + 69;
      const ang = 2 * Math.PI * (midi - Math.round(midi));
      const w = pk.mag;
      sx += w * Math.cos(ang);
      sy += w * Math.sin(ang);
      sw += w;
    }
    if (sw <= 0) return null;
    const r = Math.hypot(sx, sy) / sw;
    return { offset: Math.atan2(sy, sx) / (2 * Math.PI), strength: r };
  }

  /** Subtracts estimated 3rd-harmonic leakage (bin a fifth below -> here). */
  function compensateLeakage(chroma, amount, out) {
    const res = out || new Float64Array(12);
    for (let i = 0; i < 12; i++) {
      res[i] = Math.max(0, chroma[i] - amount * chroma[mod12(i + 5)]);
    }
    return res;
  }

  // ------------------------------------------------------------ bass (YIN)

  /**
   * YIN pitch estimate. Returns { freq, aperiodicity } or null.
   * `frame` should already be low-passed; `decim` downsamples it first.
   */
  function yin(frame, sampleRate, minHz, maxHz, threshold, decim) {
    const d = Math.max(1, decim | 0);
    const n = Math.floor(frame.length / d);
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = 0; k < d; k++) s += frame[i * d + k];
      x[i] = s / d;
    }
    const sr = sampleRate / d;
    const minP = Math.max(2, Math.floor(sr / maxHz));
    const maxP = Math.min(Math.floor(sr / minHz), Math.floor(n / 2));
    if (maxP <= minP + 2) return null;
    let energy = 0;
    for (let i = 0; i < n; i++) energy += x[i] * x[i];
    if (energy / n < 1e-9) return null;
    const diff = new Float64Array(maxP + 2);
    const W = n - maxP - 1;
    for (let tau = 1; tau <= maxP + 1; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) {
        const v = x[j] - x[j + tau];
        s += v * v;
      }
      diff[tau] = s;
    }
    const cmnd = new Float64Array(maxP + 2);
    cmnd[0] = 1;
    let run = 0;
    for (let tau = 1; tau <= maxP + 1; tau++) {
      run += diff[tau];
      cmnd[tau] = run > 0 ? (diff[tau] * tau) / run : 1;
    }
    let tauEst = -1;
    for (let tau = minP; tau <= maxP; tau++) {
      if (cmnd[tau] < threshold) {
        while (tau + 1 <= maxP && cmnd[tau + 1] < cmnd[tau]) tau++;
        tauEst = tau;
        break;
      }
    }
    if (tauEst < 0) {
      // No dip under the threshold: take the global minimum if it is decent.
      let best = Infinity;
      for (let tau = minP; tau <= maxP; tau++) {
        if (cmnd[tau] < best) { best = cmnd[tau]; tauEst = tau; }
      }
      if (best > threshold * 2) return null;
    }
    let period = tauEst;
    if (tauEst > 1 && tauEst <= maxP) {
      const s0 = cmnd[tauEst - 1];
      const s1 = cmnd[tauEst];
      const s2 = cmnd[tauEst + 1];
      const den = s0 + s2 - 2 * s1;
      if (den !== 0) {
        const sh = (0.5 * (s0 - s2)) / den;
        if (Math.abs(sh) <= 1) period = tauEst + sh;
      }
    }
    return { freq: sr / period, aperiodicity: cmnd[tauEst] };
  }

  /**
   * Bass pitch class from YIN and the lowest strong FFT peak.
   * Returns { pc, freq, confidence } or null.
   */
  function estimateBass(peaks, lowTime, sampleRate, tuning, opts) {
    const o = opts || DEFAULTS;
    let low = null;
    let maxLowMag = 0;
    for (const pk of peaks) if (pk.freq <= o.bassMaxHz * 1.2 && pk.mag > maxLowMag) maxLowMag = pk.mag;
    for (const pk of peaks) {
      if (pk.freq < o.bassMinHz || pk.freq > o.bassMaxHz) continue;
      if (pk.mag >= 0.3 * maxLowMag) { low = pk; break; }
    }
    const pcOf = (f) => mod12(Math.round(12 * Math.log2(f / 440) + 69 - tuning));
    let y = null;
    if (lowTime && lowTime.length >= 256) {
      const decim = Math.max(1, Math.round(sampleRate / 8000));
      y = yin(lowTime, sampleRate, o.bassMinHz, o.bassMaxHz, 0.2, decim);
      // YIN on a chord can lock onto a subharmonic; fold to the FFT peak's octave.
      if (y && low) {
        const ratio = low.freq / y.freq;
        const oct = Math.round(Math.log2(ratio));
        if (oct !== 0 && Math.abs(Math.log2(ratio) - oct) < 0.04) y = { freq: y.freq * Math.pow(2, oct), aperiodicity: y.aperiodicity };
      }
    }
    if (y && low && pcOf(y.freq) === pcOf(low.freq)) {
      return { pc: pcOf(y.freq), freq: y.freq, confidence: Math.min(1, 1.1 - y.aperiodicity) };
    }
    if (y && y.aperiodicity < 0.12) return { pc: pcOf(y.freq), freq: y.freq, confidence: 0.7 };
    if (low && !y) return { pc: pcOf(low.freq), freq: low.freq, confidence: 0.5 };
    if (low) return { pc: pcOf(low.freq), freq: low.freq, confidence: 0.4 };
    return null;
  }

  // ------------------------------------------------------------- matching

  /** Builds 12-d templates for chord names (or all common chords). */
  function buildTemplates(names, preferFlats) {
    const list = [];
    if (names && names.length) {
      const seen = new Set();
      names.forEach((n) => {
        const c = MT.parseChord(n);
        if (!c) return;
        const key = c.rootPc + ':' + c.quality;
        if (seen.has(key)) return;
        seen.add(key);
        list.push(makeTemplate(n, c));
      });
    } else {
      MT.QUALITIES.filter((q) => q.common).forEach((q) => {
        for (let r = 0; r < 12; r++) {
          const name = MT.chordName(r, q.id, preferFlats);
          list.push(makeTemplate(name, MT.parseChord(name)));
        }
      });
    }
    return list;
  }

  function makeTemplate(name, c) {
    const vec = new Float64Array(12);
    c.pcs.forEach((pc) => { vec[pc] = 1; });
    // Mean-centre and normalise once so scoring is a plain dot product.
    const mean = vec.reduce((s, v) => s + v, 0) / 12;
    let norm = 0;
    for (let i = 0; i < 12; i++) { vec[i] -= mean; norm += vec[i] * vec[i]; }
    norm = Math.sqrt(norm);
    for (let i = 0; i < 12; i++) vec[i] /= norm;
    return {
      name,
      rootPc: c.rootPc,
      quality: c.quality,
      pcs: c.pcs,
      vec,
      complex: !(c.quality === 'maj' || c.quality === 'min'),
    };
  }

  /** Pearson similarity of a chroma vector with every template, ranked. */
  function rankTemplates(chroma, templates, ctx, opts) {
    const o = opts || DEFAULTS;
    const c = ctx || {};
    let mean = 0;
    for (let i = 0; i < 12; i++) mean += chroma[i];
    mean /= 12;
    const centred = new Float64Array(12);
    let norm = 0;
    for (let i = 0; i < 12; i++) { centred[i] = chroma[i] - mean; norm += centred[i] * centred[i]; }
    norm = Math.sqrt(norm);
    if (norm === 0) return [];
    const ranked = templates.map((t) => {
      let s = 0;
      for (let i = 0; i < 12; i++) s += centred[i] * t.vec[i];
      let score = s / norm;
      if (c.bass) {
        const w = c.bass.confidence;
        if (t.rootPc === c.bass.pc) score += o.bassRootBonus * w;
        else if (t.pcs.includes(c.bass.pc)) score += o.bassToneBonus * w;
        else score -= o.bassMissPenalty * w;
      }
      if (c.openMode && t.complex) score -= o.complexityPenalty;
      if (c.preferred && c.preferred.has(t.rootPc + ':' + t.quality)) score += o.preferredBonus;
      return { name: t.name, rootPc: t.rootPc, quality: t.quality, score };
    });
    ranked.sort((a, b) => b.score - a.score);
    return ranked;
  }

  // -------------------------------------------------------------- tracker

  class ChordTracker {
    constructor(options) {
      this.opts = Object.assign({}, DEFAULTS, options || {});
      this.templates = buildTemplates(null, false);
      this.openMode = true;
      this.preferred = null;
      this.reset();
    }

    /**
     * Restricts recognition to `names` (e.g. the chords of the current song),
     * or pass null for open mode (every root x common quality). In open mode
     * `preferredNames` get a small prior bonus.
     */
    setVocabulary(names, preferredNames, preferFlats) {
      if (names && names.length) {
        this.templates = buildTemplates(names, preferFlats);
        this.openMode = false;
      } else {
        this.templates = buildTemplates(null, preferFlats);
        this.openMode = true;
      }
      this.preferred = null;
      if (preferredNames && preferredNames.length) {
        this.preferred = new Set();
        preferredNames.forEach((n) => {
          const c = MT.parseChord(n);
          if (c) this.preferred.add(c.rootPc + ':' + c.quality);
        });
      }
      this.history = [];
    }

    setSensitivity(gateDbfs) {
      this.opts.gateDbfs = gateDbfs;
    }

    reset() {
      this.tuning = 0;
      this.startedAt = null;
      this.warmFrames = 0;
      this.noiseFloor = -90;
      this.gateOpen = false;
      this.lastLoudAt = -Infinity;
      this.prevBand = null;
      this.fluxAvg = 0;
      this.levelHistory = [];
      this.lastOnsetAt = -Infinity;
      this.window = null;
      this.sustain = new Float64Array(12);
      this.history = [];
      this.display = { name: null, score: 0, since: 0, active: false };
      this.last = null;
    }

    /**
     * Positive spectral flux over the analysis band, in dB, counting only
     * bins within 50 dB of the frame's strongest bin so noise-floor flicker
     * does not look like an attack.
     */
    _flux(db, a) {
      const n = a.iHigh - a.iLow + 1;
      const floor = Math.max(this.opts.binFloorDb, a.maxDb - 50);
      if (!this.prevBand || this.prevBand.length !== n) {
        this.prevBand = new Float32Array(n);
        for (let i = 0; i < n; i++) this.prevBand[i] = Math.max(floor, db[a.iLow + i]);
        return 0;
      }
      let flux = 0;
      for (let i = 0; i < n; i++) {
        const v = Math.max(floor, db[a.iLow + i]);
        const d = v - this.prevBand[i];
        if (d > 0) flux += d;
        this.prevBand[i] = v;
      }
      return flux / n;
    }

    _evaluate(chroma, bass) {
      const comp = this.opts.leakage > 0 ? compensateLeakage(chroma, this.opts.leakage) : chroma;
      return rankTemplates(comp, this.templates, {
        bass,
        openMode: this.openMode,
        preferred: this.openMode ? this.preferred : null,
      }, this.opts);
    }

    /**
     * Stability voting. A finished strum window decides immediately when it
     * is confident (fast response); sustain frames vote in a sliding time
     * window and must win a clear majority to replace the displayed chord.
     * Margins are measured against the best chord with a *different root*,
     * so close relatives (D vs D7) never make a clear strum "uncertain".
     */
    _decide(t, ranked, strum) {
      const o = this.opts;
      if (!ranked || !ranked.length) return;
      const best = ranked[0];
      const rival = ranked.find((r) => r.rootPc !== best.rootPc);
      const margin = rival ? best.score - rival.score : 1;
      const confident = best.score >= o.minScore && margin >= o.minMargin;
      const cur = this.display.name;

      if (strum) {
        this.history = [];
        if (!confident) return;
        let pick = best;
        if (cur && cur !== best.name) {
          const curEntry = ranked.find((r) => r.name === cur);
          // Hysteresis: a near tie on a re-strum keeps the current chord.
          if (curEntry && best.score - curEntry.score < o.keepMargin) pick = curEntry;
        }
        if (pick.name !== cur) this.display = { name: pick.name, score: pick.score, since: t, active: true };
        else Object.assign(this.display, { score: pick.score, active: true });
        this.history.push({ t, name: pick.name, w: o.strumWeight });
        return;
      }

      this.history.push({ t, name: confident ? best.name : null, w: 1 });
      const cutoff = t - o.sustainWindowMs;
      while (this.history.length && this.history[0].t < cutoff) this.history.shift();
      const tally = new Map();
      let total = 0;
      this.history.forEach((h) => {
        total += h.w;
        if (h.name) tally.set(h.name, (tally.get(h.name) || 0) + h.w);
      });
      let leader = null;
      let lw = 0;
      tally.forEach((w, name) => { if (w > lw) { lw = w; leader = name; } });
      if (!leader) return;
      if (leader === cur) {
        this.display.active = true;
        if (best.name === cur) this.display.score += 0.2 * (best.score - this.display.score);
        return;
      }
      if (lw / total >= o.switchShare && lw >= o.minSwitchVotes) {
        this.display = { name: leader, score: best.name === leader ? best.score : this.display.score, since: t, active: true };
      }
    }

    /**
     * Processes one analyser frame.
     * frame = { db: Float32Array, sampleRate, fftSize, lowTime?: Float32Array, t: ms }
     */
    process(frame) {
      const o = this.opts;
      const t = frame.t;
      const a = analyzeSpectrum(frame.db, frame.sampleRate, frame.fftSize, o);
      const level = a.levelDb;

      // Adaptive noise floor. It falls fast, but only rises on frames that
      // look like noise (gate closed, or a flat, non-tonal spectrum), so a
      // long stretch of continuous playing never lifts it into the music.
      // A steady sound with no attack for several seconds (mains hum, a fan)
      // is treated as background too, and the first moments after start-up
      // are used to learn the room.
      if (this.startedAt === null) this.startedAt = t;
      const warmup = t - this.startedAt < o.warmupMs;
      const stationary = t - Math.max(this.lastOnsetAt, this.startedAt) > o.stationaryMs;
      if (Number.isFinite(level)) {
        if (warmup) this.noiseFloor = this.warmFrames++ === 0 ? level : Math.min(this.noiseFloor, level);
        else if (level < this.noiseFloor) this.noiseFloor += 0.3 * (level - this.noiseFloor);
        else if (!this.gateOpen || a.flatnessDb > o.noiseFlatnessDb || stationary) this.noiseFloor += 0.03 * (level - this.noiseFloor);
      }
      const threshold = Math.max(o.gateDbfs, this.noiseFloor + o.noiseMarginDb);
      if (!this.gateOpen && level >= threshold) this.gateOpen = true;
      else if (this.gateOpen && level < threshold - o.hysteresisDb) this.gateOpen = false;
      if (this.gateOpen) this.lastLoudAt = t;

      // Onset: spectral flux over an adaptive threshold, or a sudden rise.
      const flux = this._flux(frame.db, a);
      this.levelHistory.push({ t, level: Number.isFinite(level) ? level : -120 });
      while (this.levelHistory.length && this.levelHistory[0].t < t - 160) this.levelHistory.shift();
      const minRecent = this.levelHistory.reduce((m, h) => Math.min(m, h.level), Infinity);
      const rise = (Number.isFinite(level) ? level : -120) - minRecent;
      const fluxThr = this.fluxAvg * o.onsetFluxFactor + 0.4;
      let onset = false;
      if (!warmup && this.gateOpen && t - this.lastOnsetAt >= o.refractoryMs && (rise >= o.onsetRiseDb || flux > fluxThr)) {
        onset = true;
        this.lastOnsetAt = t;
      }
      this.fluxAvg += 0.05 * (flux - this.fluxAvg);

      // Tuning (slow, only on clearly tonal frames).
      if (this.gateOpen && a.peaks.length) {
        const tu = estimateTuning(a.peaks);
        if (tu && tu.strength > 0.6) this.tuning += 0.08 * wrapHalf(tu.offset - this.tuning);
      }

      const notes = o.harmonicSubtraction ? extractNotes(a.peaks, o) : a.peaks;
      const raw = peaksToChroma(notes, this.tuning, o);
      const bass = this.gateOpen ? estimateBass(a.peaks, frame.lowTime, frame.sampleRate, this.tuning, o) : null;
      const loud = Number.isFinite(level) ? Math.pow(10, level / 20) : 0;

      // Sustained chroma: fast attack, slow release.
      for (let i = 0; i < 12; i++) {
        const v = this.gateOpen ? raw[i] : 0;
        const alpha = v > this.sustain[i] ? 0.5 : 0.12;
        this.sustain[i] += alpha * (v - this.sustain[i]);
      }

      let status = this.gateOpen ? 'listening' : 'quiet';
      let ranked = null;

      if (onset) {
        if (this.window && this.window.frames >= 2) this._finishWindow(t);
        this.window = { start: t, chroma: new Float64Array(12), weight: 0, frames: 0, bass: new Map() };
      }

      if (this.window) {
        status = 'analyzing';
        const age = t - this.window.start;
        if (age >= o.onsetDelayMs && this.gateOpen) {
          for (let i = 0; i < 12; i++) this.window.chroma[i] += raw[i] * loud;
          this.window.weight += loud;
          this.window.frames++;
          if (bass) this.window.bass.set(bass.pc, (this.window.bass.get(bass.pc) || 0) + bass.confidence * loud);
        }
        if (age >= o.onsetDelayMs + o.analysisMs || !this.gateOpen) {
          ranked = this._finishWindow(t);
        }
      } else if (this.gateOpen && t - this.lastOnsetAt < o.sustainActiveMs) {
        // Sustain voting only follows real playing: a drone with no attack
        // for a few seconds cannot introduce a chord on its own.
        ranked = this._evaluate(this.sustain, bass);
        this._decide(t, ranked, false);
      }

      if (!this.gateOpen && t - this.lastLoudAt > o.releaseMs) this.display.active = false;
      if (ranked && ranked.length) this.last = ranked.slice(0, 4);

      let max = 0;
      for (let i = 0; i < 12; i++) max = Math.max(max, this.sustain[i]);
      const viz = Array.from(this.sustain, (v) => (max > 0 ? v / max : 0));

      return {
        chord: this.display.name,
        score: this.display.score,
        active: this.display.active,
        candidates: this.last || [],
        chroma: viz,
        levelDb: level,
        threshold,
        gateOpen: this.gateOpen,
        bass,
        tuningCents: Math.round(this.tuning * 100),
        onset,
        status: this.display.active && status !== 'analyzing' ? 'detected' : status,
      };
    }

    _finishWindow(t) {
      const w = this.window;
      this.window = null;
      if (!w || w.frames === 0 || w.weight <= 0) return null;
      let bass = null;
      let bw = 0;
      let total = 0;
      w.bass.forEach((v, pc) => { total += v; if (v > bw) { bw = v; bass = pc; } });
      const bassInfo = bass !== null ? { pc: bass, confidence: Math.min(1, bw / (total || 1)) } : null;
      const ranked = this._evaluate(w.chroma, bassInfo);
      this._decide(t, ranked, true);
      // Restart the sustained chroma from the new strum, dropping the tail
      // of the previous chord.
      for (let i = 0; i < 12; i++) this.sustain[i] = w.chroma[i] / w.weight;
      return ranked;
    }
  }

  const api = {
    DEFAULTS,
    analyzeSpectrum,
    peaksToChroma,
    estimateTuning,
    compensateLeakage,
    yin,
    extractNotes,
    estimateBass,
    buildTemplates,
    rankTemplates,
    ChordTracker,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (global.GP = global.GP || {}).ChordDetector = api;
})(typeof window !== 'undefined' ? window : globalThis);
