/*
 * song-parser.js
 * Turns a song's text body into a render-ready model.
 *
 * Two input styles are accepted, so songs can be pasted from most sources:
 *
 *   1. ChordPro inline (preferred):    [Am]Lyin' in [C]bed
 *   2. Chords-over-lyrics (2 lines):   Am           C
 *                                      Lyin' in bed
 *      Chord columns are merged into the lyric line below, so each chord
 *      lands on the exact character it was written above.
 *
 * Section headers: a line holding only "[Verse 1]" (not a chord), or a
 * ChordPro directive such as {c: Chorus}, {soc}, {start_of_verse: Verse 2}.
 * Lines starting with "#" are comments and are skipped.
 */
(function (global) {
  'use strict';

  const MT = typeof module !== 'undefined' && module.exports
    ? require('./music-theory.js')
    : global.GP.MusicTheory;

  // Tokens that may appear on a chord line besides chords: bar lines,
  // repeat marks, rests, arrows.
  const CHORD_LINE_EXTRAS = /^(\|+|:?\|\|?:?|-+|\/+|%|\.+|x\d+|\(x?\d+x?\)|\d+x|N\.?C\.?|→|\(|\)|\*+)$/i;

  const SECTION_DIRECTIVES = {
    soc: 'Chorus', start_of_chorus: 'Chorus',
    sov: 'Verse', start_of_verse: 'Verse',
    sob: 'Bridge', start_of_bridge: 'Bridge',
    start_of_intro: 'Intro', start_of_outro: 'Outro',
    c: null, comment: null, ci: null, comment_italic: null, cb: null, comment_box: null,
    section: null, label: null,
  };
  const META_DIRECTIVES = {
    t: 'title', title: 'title', st: 'artist', subtitle: 'artist', artist: 'artist',
    key: 'key', tempo: 'bpm', time: 'timeSignature', capo: 'capo',
  };

  function isChordLine(line) {
    const tokens = line.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return false;
    let chords = 0;
    for (const tok of tokens) {
      if (MT.isChord(tok)) chords++;
      else if (!CHORD_LINE_EXTRAS.test(tok)) return false;
    }
    return chords > 0;
  }

  /** Chord tokens of a chords-over-lyrics line with their column positions. */
  function chordColumns(line) {
    const out = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(line))) {
      out.push({ col: m.index, text: m[0], isChord: MT.isChord(m[0]) });
    }
    return out;
  }

  /** Merges a chord line into the lyric line below it, column by column. */
  function mergeChordAndLyric(chordLine, lyricLine) {
    const anchors = chordColumns(chordLine).filter((t) => t.isChord);
    let text = lyricLine;
    const lastCol = anchors.length ? anchors[anchors.length - 1].col : 0;
    if (text.length <= lastCol) text = text.padEnd(lastCol + 1, ' ');
    return {
      text,
      anchors: anchors.map((a) => ({ pos: a.col, chord: a.text })),
    };
  }

  /** Parses one ChordPro inline line into plain text + chord anchors. */
  function parseInline(line) {
    let text = '';
    const anchors = [];
    const re = /\[([^\]]*)\]/g;
    let last = 0;
    let m;
    while ((m = re.exec(line))) {
      text += line.slice(last, m.index);
      const inner = m[1].trim();
      if (MT.isChord(inner)) {
        anchors.push({ pos: text.length, chord: inner });
      } else if (inner) {
        // Non-chord bracket inside a line, e.g. [x2]: keep it as text.
        text += '(' + inner + ')';
      }
      last = m.index + m[0].length;
    }
    text += line.slice(last);
    return { text, anchors };
  }

  /**
   * Builds the final line model. Every anchor gets a real character to sit
   * on: a chord at (or past) the end of the lyric pads the text with spaces.
   */
  function makeLine(text, anchors) {
    const trimmedRight = text.replace(/\s+$/, '');
    const hasLyrics = trimmedRight.trim().length > 0;
    let full = trimmedRight;
    const maxPos = anchors.reduce((mx, a) => Math.max(mx, a.pos), -1);
    if (maxPos >= full.length) full = full.padEnd(maxPos + 1, ' ');
    return {
      type: 'line',
      text: full,
      anchors: anchors.slice().sort((a, b) => a.pos - b.pos),
      hasChords: anchors.length > 0,
      hasLyrics,
    };
  }

  function chordsOnlyLine(line) {
    // Keep chord order; ignore column spacing (rendered with a fixed gap).
    const tokens = chordColumns(line);
    const anchors = [];
    let text = '';
    tokens.forEach((t) => {
      if (t.isChord) {
        anchors.push({ pos: text.length, chord: t.text });
        text += ' ';
      } else {
        text += t.text + ' ';
      }
    });
    return { type: 'line', text, anchors, hasChords: true, hasLyrics: false, chordsOnly: true };
  }

  function parseDirective(line) {
    const m = /^\{\s*([a-zA-Z_]+)\s*(?::\s*(.*?))?\s*\}$/.exec(line.trim());
    if (!m) return null;
    return { name: m[1].toLowerCase(), value: (m[2] || '').trim() };
  }

  /**
   * Parses a song body into { items, chords, meta }.
   * items: [{type:'section', label} | {type:'line', ...} | {type:'blank'}]
   * chords: unique chord symbols in order of first appearance.
   */
  function parseSong(body) {
    const rawLines = String(body || '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
    const items = [];
    const meta = {};
    let i = 0;

    const pushBlank = () => {
      if (items.length && items[items.length - 1].type !== 'blank' && items[items.length - 1].type !== 'section') {
        items.push({ type: 'blank' });
      }
    };

    while (i < rawLines.length) {
      const line = rawLines[i].replace(/\s+$/, '');
      const trimmed = line.trim();
      i++;

      if (!trimmed) { pushBlank(); continue; }
      if (trimmed.startsWith('#')) continue;

      const dir = parseDirective(trimmed);
      if (dir) {
        if (Object.prototype.hasOwnProperty.call(SECTION_DIRECTIVES, dir.name)) {
          const label = dir.value || SECTION_DIRECTIVES[dir.name];
          if (label) items.push({ type: 'section', label });
        } else if (META_DIRECTIVES[dir.name]) {
          meta[META_DIRECTIVES[dir.name]] = dir.value;
        }
        continue; // end_of_* and unknown directives are ignored
      }

      // "[Verse 1]" alone on a line, and not a chord -> section header.
      const sec = /^\[([^\]]+)\]$/.exec(trimmed);
      if (sec && !MT.isChord(sec[1].trim())) {
        items.push({ type: 'section', label: sec[1].trim() });
        continue;
      }

      if (/\[[^\]]*\]/.test(line)) {
        const parsed = parseInline(line);
        const model = makeLine(parsed.text, parsed.anchors);
        if (model.hasChords && !model.hasLyrics) model.chordsOnly = true;
        items.push(model);
        continue;
      }

      if (isChordLine(line)) {
        const next = i < rawLines.length ? rawLines[i].replace(/\s+$/, '') : '';
        const nextIsLyric = next.trim() && !next.trim().startsWith('#') && !parseDirective(next.trim()) &&
          !/^\[[^\]]+\]$/.test(next.trim()) && !isChordLine(next) && !/\[[^\]]*\]/.test(next);
        if (nextIsLyric) {
          const merged = mergeChordAndLyric(line, next);
          items.push(makeLine(merged.text, merged.anchors));
          i++;
        } else {
          items.push(chordsOnlyLine(line));
        }
        continue;
      }

      items.push(makeLine(line, []));
    }

    while (items.length && items[items.length - 1].type === 'blank') items.pop();

    const chords = [];
    const seen = new Set();
    items.forEach((it) => {
      if (it.type !== 'line') return;
      it.anchors.forEach((a) => {
        if (!seen.has(a.chord)) { seen.add(a.chord); chords.push(a.chord); }
      });
    });
    return { items, chords, meta };
  }

  /**
   * Splits a line into word groups for rendering. A word group is a run of
   * non-space characters plus its trailing spaces; the browser may wrap only
   * between groups, so a chord never detaches from its word. Inside a group,
   * chunks start at every chord anchor.
   *
   * Returns [{ chunks: [{ chord, text, midWord }] }].
   */
  function layoutLine(line) {
    const groups = [];
    const text = line.text;
    const anchors = line.anchors;

    if (line.chordsOnly) {
      // One group per chord so long chord rows can wrap; extra tokens such
      // as "|" or "x2" ride along as annotation text.
      const lead = text.slice(0, anchors.length ? anchors[0].pos : text.length).trim();
      if (lead) groups.push({ chunks: [{ chord: null, text: lead, midWord: false }] });
      anchors.forEach((a, idx) => {
        const next = idx + 1 < anchors.length ? anchors[idx + 1].pos : text.length;
        groups.push({ chunks: [{ chord: a.chord, text: text.slice(a.pos, next).trim(), midWord: false }] });
      });
      return groups;
    }

    const re = /\S+\s*|\s+/g;
    let m;
    let ai = 0;
    while ((m = re.exec(text))) {
      const start = m.index;
      const end = start + m[0].length;
      const cuts = [];
      while (ai < anchors.length && anchors[ai].pos < end) {
        if (anchors[ai].pos >= start) cuts.push(anchors[ai]);
        ai++;
      }
      const chunks = [];
      let cursor = start;
      if (!cuts.length || cuts[0].pos > start) {
        chunks.push({ chord: null, text: text.slice(start, cuts.length ? cuts[0].pos : end) });
        cursor = cuts.length ? cuts[0].pos : end;
      }
      cuts.forEach((cut, idx) => {
        const stop = idx + 1 < cuts.length ? cuts[idx + 1].pos : end;
        chunks.push({ chord: cut.chord, text: text.slice(cut.pos, stop) });
        cursor = stop;
      });
      // A chunk is "mid-word" when the word continues into the next chunk.
      chunks.forEach((c, idx) => {
        c.midWord = idx < chunks.length - 1 && /\S$/.test(c.text);
      });
      groups.push({ chunks });
    }

    // Chord names overflow to the right of their anchor (they do not widen
    // the lyric). Where a chord would run into the next chord (or past the
    // end of the line), pad its chunk so there is at least one column gap.
    const flat = [];
    groups.forEach((g) => g.chunks.forEach((c) => { c.padCh = 0; flat.push(c); }));
    flat.forEach((c, idx) => {
      if (!c.chord) return;
      let distance = 0;
      let nextChord = false;
      for (let j = idx; j < flat.length; j++) {
        if (j > idx && flat[j].chord) { nextChord = true; break; }
        distance += flat[j].text.length;
      }
      const need = c.chord.length + (nextChord ? 1 : 0) - distance;
      if (need > 0) c.padCh = need;
    });
    return groups;
  }

  const api = { parseSong, layoutLine, isChordLine, parseInline, mergeChordAndLyric };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (global.GP = global.GP || {}).SongParser = api;
})(typeof window !== 'undefined' ? window : globalThis);
