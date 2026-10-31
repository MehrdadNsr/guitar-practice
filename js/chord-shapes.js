/*
 * chord-shapes.js
 * Guitar fingerings and SVG chord diagrams.
 *
 * Common open chords are hand-written. Every other chord falls back to a
 * movable E-shape (root on string 6) or A-shape (root on string 5) barre,
 * the same strategy guitar-chord-trainer uses so all chords get a diagram.
 *
 * Frets are listed low E -> high E. "x" = muted, 0 = open.
 */
(function (global) {
  'use strict';

  const MT = typeof module !== 'undefined' && module.exports
    ? require('./music-theory.js')
    : global.GP.MusicTheory;

  // Open-position shapes keyed by "<root pc>:<quality>".
  // [frets, fingers]
  const OPEN = {
    'C': ['x32010', '032010'], 'C7': ['x32310', '032410'], 'Cmaj7': ['x32000', '032000'],
    'Cadd9': ['x32033', '021034'], 'Csus2': ['x30013', '030014'], 'Csus4': ['x33011', '034011'],
    'D': ['xx0232', '000132'], 'Dm': ['xx0231', '000231'], 'D7': ['xx0212', '000213'],
    'Dmaj7': ['xx0222', '000111'], 'Dm7': ['xx0211', '000211'], 'Dsus2': ['xx0230', '000130'],
    'Dsus4': ['xx0233', '000134'],
    'E': ['022100', '023100'], 'Em': ['022000', '023000'], 'E7': ['020100', '020100'],
    'Em7': ['022030', '012040'], 'Emaj7': ['021100', '031200'], 'Esus4': ['022200', '023400'],
    'E5': ['022xxx', '012000'],
    'F': ['133211', '134211'], 'Fmaj7': ['xx3210', '003210'],
    'G': ['320003', '210003'], 'G7': ['320001', '320001'], 'Gmaj7': ['320002', '320001'],
    'A': ['x02220', '001230'], 'Am': ['x02210', '002310'], 'A7': ['x02020', '002030'],
    'Am7': ['x02010', '002010'], 'Amaj7': ['x02120', '002130'], 'Asus2': ['x02200', '001200'],
    'Asus4': ['x02230', '001240'], 'A5': ['x022xx', '001200'],
    'B7': ['x21202', '021304'], 'Bm': ['x24432', '013421'],
  };

  // Movable shapes: relative frets from the barre fret.
  const E_SHAPES = {
    maj: [[0, 2, 2, 1, 0, 0], [1, 3, 4, 2, 1, 1]],
    min: [[0, 2, 2, 0, 0, 0], [1, 3, 4, 1, 1, 1]],
    '7': [[0, 2, 0, 1, 0, 0], [1, 3, 1, 2, 1, 1]],
    maj7: [[0, 'x', 1, 1, 0, 'x'], [1, 0, 3, 4, 2, 0]],
    m7: [[0, 2, 0, 0, 0, 0], [1, 3, 1, 1, 1, 1]],
    sus4: [[0, 2, 2, 2, 0, 0], [1, 2, 3, 4, 1, 1]],
    dim: [[0, 1, 2, 0, 'x', 'x'], [1, 2, 3, 1, 0, 0]],
    aug: [[0, 3, 2, 1, 1, 0], [1, 4, 3, 2, 2, 1]],
    '5': [[0, 2, 2, 'x', 'x', 'x'], [1, 3, 4, 0, 0, 0]],
    '6': [[0, 2, 2, 1, 2, 0], [1, 2, 3, 1, 4, 1]],
  };
  const A_SHAPES = {
    maj: [['x', 0, 2, 2, 2, 0], [0, 1, 2, 3, 4, 1]],
    min: [['x', 0, 2, 2, 1, 0], [0, 1, 3, 4, 2, 1]],
    '7': [['x', 0, 2, 0, 2, 0], [0, 1, 3, 1, 4, 1]],
    maj7: [['x', 0, 2, 1, 2, 0], [0, 1, 3, 2, 4, 1]],
    m7: [['x', 0, 2, 0, 1, 0], [0, 1, 3, 1, 2, 1]],
    sus2: [['x', 0, 2, 2, 0, 0], [0, 1, 3, 4, 1, 1]],
    sus4: [['x', 0, 2, 2, 3, 0], [0, 1, 2, 3, 4, 1]],
    dim: [['x', 0, 1, 2, 1, 'x'], [0, 1, 2, 4, 3, 0]],
    aug: [['x', 0, 3, 2, 2, 1], [0, 1, 4, 2, 3, 1]],
    '5': [['x', 0, 2, 2, 'x', 'x'], [0, 1, 3, 4, 0, 0]],
    add9: [['x', 0, 2, 4, 2, 0], [0, 1, 2, 4, 3, 1]],
    dim7: [['x', 0, 1, 2, 1, 2], [0, 1, 2, 4, 3, 4]],
    m7b5: [['x', 0, 1, 0, 1, 'x'], [0, 1, 2, 1, 3, 0]],
    '7sus4': [['x', 0, 2, 0, 3, 0], [0, 1, 3, 1, 4, 1]],
    '6': [['x', 0, 2, 2, 2, 2], [0, 1, 3, 3, 3, 3]],
    m6: [['x', 0, 2, 2, 1, 2], [0, 1, 3, 3, 2, 4]],
    '9': [['x', 0, -1, 0, 0, 0], [0, 2, 1, 3, 3, 3]],
  };

  const OPEN_BY_KEY = new Map();
  Object.keys(OPEN).forEach((name) => {
    const c = MT.parseChord(name);
    OPEN_BY_KEY.set(c.rootPc + ':' + c.quality, { frets: parseFrets(OPEN[name][0]), fingers: parseFrets(OPEN[name][1]) });
  });

  /** "x32010" or "x,10,12,12,11,10" -> ['x',3,2,0,1,0] */
  function parseFrets(str) {
    const parts = /[\s,]/.test(str) ? str.trim().split(/[\s,]+/) : String(str).split('');
    return parts.map((p) => (p === 'x' || p === 'X' ? 'x' : parseInt(p, 36)));
  }

  function movable(shapes, stringPc, chord) {
    const shape = shapes[chord.quality];
    if (!shape) return null;
    let fret = MT.mod12(chord.rootPc - stringPc);
    const minRel = Math.min(...shape[0].filter((f) => f !== 'x'));
    if (fret + minRel < 0) fret += 12;
    const frets = shape[0].map((f) => (f === 'x' ? 'x' : f + fret));
    const fingers = fret === 0 ? frets.map((f) => (f === 'x' || f === 0 ? 0 : null)) : shape[1].slice();
    return { frets, fingers: fingers.some((f) => f === null) ? null : fingers, fret };
  }

  /**
   * Returns { frets, fingers, baseFret, barre } for a chord symbol, or null.
   * `custom` lets a song override shapes: { "Cmaj7": "x32000" }.
   */
  function getShape(name, custom) {
    if (custom && custom[name]) {
      const def = custom[name];
      const frets = parseFrets(typeof def === 'string' ? def : def.frets);
      const fingers = typeof def === 'object' && def.fingers ? parseFrets(def.fingers) : null;
      return finalize(frets, fingers);
    }
    const chord = MT.parseChord(name);
    if (!chord) return null;
    const open = OPEN_BY_KEY.get(chord.rootPc + ':' + chord.quality);
    if (open) return finalize(open.frets, open.fingers);
    const e = movable(E_SHAPES, 4, chord);
    const a = movable(A_SHAPES, 9, chord);
    let pick = e && a ? (a.fret < e.fret ? a : e) : e || a;
    if (!pick) {
      // Unknown quality: fall back to the plain major/minor triad shape.
      const triad = Object.assign({}, chord, { quality: chord.intervals.includes(3) ? 'min' : 'maj' });
      const e2 = movable(E_SHAPES, 4, triad);
      const a2 = movable(A_SHAPES, 9, triad);
      pick = a2.fret < e2.fret ? a2 : e2;
    }
    return finalize(pick.frets, pick.fingers);
  }

  function finalize(frets, fingers) {
    const fretted = frets.filter((f) => f !== 'x' && f > 0);
    const maxFret = fretted.length ? Math.max(...fretted) : 0;
    const minFret = fretted.length ? Math.min(...fretted) : 0;
    const baseFret = maxFret > 4 ? minFret : 1;
    let barre = null;
    if (fingers) {
      // A barre = finger 1 holding the lowest fret on 2+ strings.
      const strings = [];
      frets.forEach((f, s) => { if (fingers[s] === 1 && f === minFret && f > 0) strings.push(s); });
      if (strings.length >= 2) barre = { fret: minFret, from: Math.min(...strings), to: Math.max(...strings) };
    }
    return { frets, fingers, baseFret, barre };
  }

  /** Renders a chord diagram as an SVG string (uses currentColor). */
  function diagramSVG(name, shape, opts) {
    const o = Object.assign({ width: 96, height: 120, rootPc: null }, opts || {});
    const W = o.width;
    const H = o.height;
    const left = 16;
    const right = W - 12;
    const top = 22;
    const bottom = H - 10;
    const frets = 4;
    const sx = (s) => left + (s * (right - left)) / 5;
    const fy = (f) => top + (f * (bottom - top)) / frets;
    const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    let svg = `<svg class="chord-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(name)}">`;
    if (!shape) {
      svg += `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="11" fill="currentColor">?</text></svg>`;
      return svg;
    }
    const base = shape.baseFret;
    // Nut or position label
    if (base === 1) {
      svg += `<line x1="${left}" y1="${top}" x2="${right}" y2="${top}" stroke="currentColor" stroke-width="3.5"/>`;
    } else {
      svg += `<text x="${left - 4}" y="${fy(0.5) + 4}" text-anchor="end" font-size="10" fill="currentColor">${base}</text>`;
    }
    for (let f = base === 1 ? 1 : 0; f <= frets; f++) {
      svg += `<line x1="${left}" y1="${fy(f)}" x2="${right}" y2="${fy(f)}" stroke="currentColor" stroke-opacity=".55" stroke-width="1"/>`;
    }
    for (let s = 0; s < 6; s++) {
      svg += `<line x1="${sx(s)}" y1="${top}" x2="${sx(s)}" y2="${bottom}" stroke="currentColor" stroke-opacity=".75" stroke-width="${1.6 - s * 0.15}"/>`;
    }
    if (shape.barre) {
      const y = fy(shape.barre.fret - base + 0.5);
      svg += `<rect x="${sx(shape.barre.from) - 6}" y="${y - 6}" width="${sx(shape.barre.to) - sx(shape.barre.from) + 12}" height="12" rx="6" fill="currentColor"/>`;
    }
    const tuning = [4, 9, 2, 7, 11, 4];
    shape.frets.forEach((f, s) => {
      const x = sx(s);
      if (f === 'x') {
        svg += `<text x="${x}" y="${top - 7}" text-anchor="middle" font-size="11" fill="currentColor">×</text>`;
        return;
      }
      if (f === 0) {
        svg += `<circle cx="${x}" cy="${top - 11}" r="3.6" fill="none" stroke="currentColor" stroke-width="1.4"/>`;
        return;
      }
      const onBarre = shape.barre && f === shape.barre.fret && s >= shape.barre.from && s <= shape.barre.to;
      const y = fy(f - base + 0.5);
      const isRoot = o.rootPc !== null && MT.mod12(tuning[s] + f) === o.rootPc;
      if (!onBarre) {
        svg += `<circle cx="${x}" cy="${y}" r="6.2" fill="currentColor"${isRoot ? ' class="root-dot"' : ''}/>`;
      }
      const finger = shape.fingers && shape.fingers[s];
      if (finger && !onBarre) {
        svg += `<text x="${x}" y="${y + 3.6}" text-anchor="middle" font-size="9" font-weight="700" class="finger">${finger}</text>`;
      }
    });
    svg += '</svg>';
    return svg;
  }

  const api = { getShape, diagramSVG, parseFrets };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (global.GP = global.GP || {}).ChordShapes = api;
})(typeof window !== 'undefined' ? window : globalThis);
