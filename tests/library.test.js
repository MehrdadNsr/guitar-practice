'use strict';
// Validates every entry in songs/library.js, so a new song with a typo in
// its chords or a duplicate id fails fast.
const test = require('node:test');
const assert = require('node:assert/strict');
const MT = require('../js/music-theory.js');
const SP = require('../js/song-parser.js');
const CS = require('../js/chord-shapes.js');

global.window = global.window || {};
require('../songs/library.js');
const songs = global.window.SONG_LIBRARY;

test('library exists and Haunted is the first entry', () => {
  assert.ok(Array.isArray(songs) && songs.length > 0);
  assert.equal(songs[0].id, 'haunted');
  assert.equal(songs[0].artist, 'Kukunari');
});

test('every song has a unique id, title and parsable body', () => {
  const ids = new Set();
  songs.forEach((s) => {
    assert.ok(s.id && /^[a-z0-9-]+$/.test(s.id), 'bad id ' + s.id);
    assert.ok(!ids.has(s.id), 'duplicate id ' + s.id);
    ids.add(s.id);
    assert.ok(s.title, s.id + ' needs a title');
    if (s.key) assert.ok(MT.parseChord(s.key), s.id + ' has an invalid key');
    const parsed = SP.parseSong(s.body);
    assert.ok(parsed.items.some((i) => i.type === 'line'), s.id + ' has no lines');
    assert.ok(parsed.chords.length > 0, s.id + ' has no chords');
  });
});

test('every chord in every song has a fingering in every key', () => {
  songs.forEach((s) => {
    SP.parseSong(s.body).chords.forEach((ch) => {
      for (let t = -5; t <= 6; t++) {
        const name = MT.transposeChord(ch, t, t < 0);
        const shape = CS.getShape(name, t === 0 ? s.shapes : null);
        assert.ok(shape && shape.frets.length === 6, `${s.id}: no shape for ${name}`);
      }
    });
  });
});

test('Haunted keeps the Am - C - Em - D progression in key Em', () => {
  const parsed = SP.parseSong(songs[0].body);
  assert.deepEqual(parsed.chords, ['Am', 'C', 'Em', 'D']);
  assert.equal(songs[0].key, 'Em');
});
