/*
 * music-theory.js
 * Note names, chord parsing, transposition and key-aware spelling.
 *
 * Shared by the song renderer, the chord diagrams and the chord detector.
 * Works as a classic browser script (exposes window.GP.MusicTheory) and as a
 * CommonJS module for the Node test runner. No dependencies.
 *
 * Key spelling (sharps vs flats) follows the circle of fifths, the same data
 * react-circle-of-fifths renders: flat keys are F, Bb, Eb, Ab, Db, Gb and
 * their relative minors.
 */
(function (global) {
  'use strict';

  const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

  const NOTE_TO_PC = {
    C: 0, 'B#': 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, Fb: 4, 'E#': 5,
    F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11,
  };

  // Preferred key names per pitch class (circle-of-fifths spelling).
  const MAJOR_KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const MINOR_KEYS = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'];
  const FLAT_KEYS = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm', 'Abm']);

  /*
   * Chord qualities. `suffixes` lists the spellings we accept (first one is
   * canonical). `intervals` are semitones above the root and drive both the
   * detector templates and chord-tone display. `common` marks qualities the
   * detector uses in open (all-chords) mode.
   */
  const QUALITIES = [
    { id: 'maj', suffixes: ['', 'M', 'maj', 'major'], intervals: [0, 4, 7], common: true },
    { id: 'min', suffixes: ['m', 'min', 'mi', '-', 'minor'], intervals: [0, 3, 7], common: true },
    { id: '7', suffixes: ['7', 'dom7'], intervals: [0, 4, 7, 10], common: true },
    { id: 'maj7', suffixes: ['maj7', 'M7', 'Maj7', 'ma7', 'Δ', 'Δ7'], intervals: [0, 4, 7, 11], common: true },
    { id: 'm7', suffixes: ['m7', 'min7', 'mi7', '-7'], intervals: [0, 3, 7, 10], common: true },
    { id: 'sus2', suffixes: ['sus2'], intervals: [0, 2, 7], common: true },
    { id: 'sus4', suffixes: ['sus4', 'sus'], intervals: [0, 5, 7], common: true },
    { id: 'dim', suffixes: ['dim', '°', 'o'], intervals: [0, 3, 6], common: true },
    { id: 'aug', suffixes: ['aug', '+'], intervals: [0, 4, 8], common: true },
    { id: '5', suffixes: ['5'], intervals: [0, 7], common: false },
    { id: 'add9', suffixes: ['add9', 'add2'], intervals: [0, 2, 4, 7], common: false },
    { id: 'madd9', suffixes: ['madd9', 'madd2', 'm(add9)'], intervals: [0, 2, 3, 7], common: false },
    { id: '6', suffixes: ['6'], intervals: [0, 4, 7, 9], common: false },
    { id: 'm6', suffixes: ['m6', 'min6'], intervals: [0, 3, 7, 9], common: false },
    { id: '9', suffixes: ['9'], intervals: [0, 2, 4, 7, 10], common: false },
    { id: 'm9', suffixes: ['m9', 'min9'], intervals: [0, 2, 3, 7, 10], common: false },
    { id: 'maj9', suffixes: ['maj9', 'M9'], intervals: [0, 2, 4, 7, 11], common: false },
    { id: '7sus4', suffixes: ['7sus4', '7sus'], intervals: [0, 5, 7, 10], common: false },
    { id: 'dim7', suffixes: ['dim7', '°7', 'o7'], intervals: [0, 3, 6, 9], common: false },
    { id: 'm7b5', suffixes: ['m7b5', 'ø', 'ø7', 'min7b5'], intervals: [0, 3, 6, 10], common: false },
    { id: 'mmaj7', suffixes: ['mMaj7', 'mmaj7', 'm(maj7)'], intervals: [0, 3, 7, 11], common: false },
  ];

  const SUFFIX_TO_QUALITY = new Map();
  QUALITIES.forEach((q) => q.suffixes.forEach((s) => SUFFIX_TO_QUALITY.set(s, q)));
  const QUALITY_BY_ID = new Map(QUALITIES.map((q) => [q.id, q]));

  const CHORD_RE = /^([A-G])(#|b|♯|♭)?([^/]*?)(?:\/([A-G])(#|b|♯|♭)?)?$/;
  // Characters allowed in a chord suffix. Keeps words like "Bridge" or
  // "Chorus" from being mistaken for chords.
  const SUFFIX_RE = /^(?:maj|min|mi|ma|m|M|dim|aug|sus|add|dom|no|omit|alt|Δ|ø|°|o|\+|-|\(|\)|#|b|♯|♭|\d|,)*$/;

  function mod12(n) {
    return ((n % 12) + 12) % 12;
  }

  function normalizeAccidental(acc) {
    if (acc === '♯') return '#';
    if (acc === '♭') return 'b';
    return acc || '';
  }

  function noteToPc(name) {
    if (!name) return null;
    const m = /^([A-Ga-g])(#|b|♯|♭)?$/.exec(String(name).trim());
    if (!m) return null;
    const key = m[1].toUpperCase() + normalizeAccidental(m[2]);
    return Object.prototype.hasOwnProperty.call(NOTE_TO_PC, key) ? NOTE_TO_PC[key] : null;
  }

  function pcToName(pc, preferFlats) {
    return (preferFlats ? FLAT_NAMES : SHARP_NAMES)[mod12(pc)];
  }

  /** Best-effort quality lookup for an arbitrary suffix. */
  function qualityForSuffix(suffix) {
    if (SUFFIX_TO_QUALITY.has(suffix)) return SUFFIX_TO_QUALITY.get(suffix);
    const s = suffix.replace(/[()]/g, '');
    if (SUFFIX_TO_QUALITY.has(s)) return SUFFIX_TO_QUALITY.get(s);
    // Heuristics for extended chords: classify by their basic triad.
    if (/^(m|min|mi|-)(?!aj)/.test(s)) {
      if (/7/.test(s)) return QUALITY_BY_ID.get('m7');
      return QUALITY_BY_ID.get('min');
    }
    if (/^(maj|M|Δ)/.test(s)) return QUALITY_BY_ID.get('maj7');
    if (/^sus/.test(s)) return QUALITY_BY_ID.get('sus4');
    if (/^(dim|°|o)/.test(s)) return QUALITY_BY_ID.get('dim');
    if (/^(aug|\+)/.test(s)) return QUALITY_BY_ID.get('aug');
    if (/^(7|9|11|13)/.test(s)) return QUALITY_BY_ID.get('7');
    return QUALITY_BY_ID.get('maj');
  }

  /**
   * Parses a chord symbol such as "F#m7", "Bb/D" or "Cadd9".
   * Returns null for anything that is not a chord (e.g. "Chorus").
   */
  function parseChord(text) {
    if (typeof text !== 'string') return null;
    const raw = text.trim();
    const m = CHORD_RE.exec(raw);
    if (!m) return null;
    const suffix = m[3] || '';
    if (!SUFFIX_RE.test(suffix)) return null;
    const root = m[1] + normalizeAccidental(m[2]);
    const rootPc = NOTE_TO_PC[root];
    if (rootPc === undefined) return null;
    let bass = null;
    let bassPc = null;
    if (m[4]) {
      bass = m[4] + normalizeAccidental(m[5]);
      bassPc = NOTE_TO_PC[bass];
      if (bassPc === undefined) return null;
    }
    const quality = qualityForSuffix(suffix);
    const pcs = quality.intervals.map((i) => mod12(rootPc + i));
    return {
      text: raw,
      root,
      rootPc,
      suffix,
      quality: quality.id,
      intervals: quality.intervals.slice(),
      pcs,
      bass,
      bassPc,
    };
  }

  function isChord(text) {
    return parseChord(text) !== null;
  }

  /** Does this key name prefer flat spellings? */
  function keyPrefersFlats(keyName) {
    if (!keyName) return false;
    const k = String(keyName).trim().replace('♭', 'b').replace('♯', '#');
    if (FLAT_KEYS.has(k)) return true;
    if (/^[A-G]#/.test(k)) return false;
    return /^[A-G]b/.test(k);
  }

  function keyIsMinor(keyName) {
    const c = parseChord(keyName || '');
    return Boolean(c && (c.quality === 'min' || c.quality === 'm7'));
  }

  /** Transposes a key name and spells it the conventional way. */
  function transposeKey(keyName, semitones) {
    const c = parseChord(keyName || '');
    if (!c) return keyName || '';
    const pc = mod12(c.rootPc + semitones);
    return keyIsMinor(keyName) ? MINOR_KEYS[pc] : MAJOR_KEYS[pc];
  }

  /**
   * Transposes one chord symbol. The suffix is kept verbatim, only the root
   * and slash-bass move. `preferFlats` picks the enharmonic spelling.
   */
  function transposeChord(text, semitones, preferFlats) {
    const c = parseChord(text);
    if (!c) return text;
    const flats = typeof preferFlats === 'boolean' ? preferFlats : c.root.includes('b');
    let out = pcToName(c.rootPc + semitones, flats) + c.suffix;
    if (c.bass) out += '/' + pcToName(c.bassPc + semitones, flats);
    return out;
  }

  /** Builds a chord name from root pitch class and quality id. */
  function chordName(rootPc, qualityId, preferFlats) {
    const q = QUALITY_BY_ID.get(qualityId) || QUALITY_BY_ID.get('maj');
    return pcToName(rootPc, preferFlats) + q.suffixes[0];
  }

  /** Two chord symbols sound the same (enharmonic + same quality)? */
  function sameChord(a, b) {
    const ca = typeof a === 'string' ? parseChord(a) : a;
    const cb = typeof b === 'string' ? parseChord(b) : b;
    if (!ca || !cb) return false;
    return ca.rootPc === cb.rootPc && ca.quality === cb.quality;
  }

  /** Semitone distance used for "capo" hints, in the range 0..11. */
  function semitoneDistance(fromKey, toKey) {
    const a = parseChord(fromKey || '');
    const b = parseChord(toKey || '');
    if (!a || !b) return 0;
    return mod12(b.rootPc - a.rootPc);
  }

  /** Frequency (Hz) to fractional MIDI note number. */
  function freqToMidi(freq, a4) {
    return 12 * Math.log2(freq / (a4 || 440)) + 69;
  }

  function midiToFreq(midi, a4) {
    return (a4 || 440) * Math.pow(2, (midi - 69) / 12);
  }

  const api = {
    SHARP_NAMES,
    FLAT_NAMES,
    MAJOR_KEYS,
    MINOR_KEYS,
    QUALITIES,
    QUALITY_BY_ID,
    mod12,
    noteToPc,
    pcToName,
    parseChord,
    isChord,
    keyPrefersFlats,
    keyIsMinor,
    transposeKey,
    transposeChord,
    chordName,
    sameChord,
    semitoneDistance,
    freqToMidi,
    midiToFreq,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (global.GP = global.GP || {}).MusicTheory = api;
})(typeof window !== 'undefined' ? window : globalThis);
