/*
 * chord-follower.js
 * Chord-synced scrolling: tracks where the player is in the song's chord
 * sequence and decides when to advance, based only on detected chords.
 *
 * The song is a flat list of chord events in reading order:
 *   [{ line: <rendered line index>, chord: 'Am' }, ...]
 * `next` is the index of the chord we are waiting for.
 *
 * update(detected) rules:
 *  - Ignore the chord we already matched last (a ringing chord is not news).
 *  - Look ahead from `next` through the chords of the next `lookaheadLines`
 *    chord lines (tolerance for a late/early change or a skipped chord).
 *    The first event with the same chord wins: jump there, wait for the one after.
 *  - No match: wait (song mode). In free mode (unrestricted detection) any
 *    new confident chord moves one chord forward, so the sheet follows a
 *    player who is improvising or using chords outside the sheet.
 */
(function (global) {
  'use strict';

  const MT = typeof module !== 'undefined' && module.exports
    ? require('./music-theory.js')
    : global.GP.MusicTheory;

  class ChordFollower {
    constructor(events, options) {
      this.opts = Object.assign({ lookaheadLines: 2, maxLookahead: 12 }, options || {});
      this.setEvents(events || []);
    }

    setEvents(events) {
      this.events = events;
      this.next = Math.min(this.next || 0, events.length);
      this.lastChord = null;
    }

    /** Wait for the first chord at or after rendered line `line`. */
    resetToLine(line) {
      const i = this.events.findIndex((e) => e.line >= line);
      this.next = i < 0 ? this.events.length : i;
      this.lastChord = null;
    }

    get done() { return this.next >= this.events.length; }

    /** The event we are waiting for, or null at the end of the song. */
    expected() { return this.done ? null : this.events[this.next]; }

    /** Indices that would currently be accepted (the tolerance window). */
    window() {
      if (this.done) return [];
      const firstLine = this.events[this.next].line;
      const lines = [];
      const out = [];
      for (let i = this.next; i < this.events.length && out.length < this.opts.maxLookahead; i++) {
        const ln = this.events[i].line;
        if (!lines.includes(ln)) {
          if (lines.length >= this.opts.lookaheadLines) break;
          lines.push(ln);
        }
        if (ln >= firstLine) out.push(i);
      }
      return out;
    }

    /**
     * Feeds a detected chord (or null). Returns the index of the event that
     * was matched/advanced to, or -1 when the follower keeps waiting.
     */
    update(chord, free) {
      if (!chord || this.done) return -1;
      if (this.lastChord && MT.sameChord(chord, this.lastChord)) return -1;
      const hit = this.window().find((i) => MT.sameChord(this.events[i].chord, chord));
      let idx = hit === undefined ? -1 : hit;
      if (idx < 0 && free) idx = this.next;
      if (idx < 0) return -1;
      this.lastChord = chord;
      this.next = idx + 1;
      return idx;
    }
  }

  const api = { ChordFollower };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (global.GP = global.GP || {}).ChordFollower = api;
})(typeof window !== 'undefined' ? window : globalThis);
