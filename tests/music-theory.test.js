'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const MT = require('../js/music-theory.js');

test('parseChord reads root, quality, slash bass and tones', () => {
  const c = MT.parseChord('F#m7');
  assert.equal(c.root, 'F#');
  assert.equal(c.rootPc, 6);
  assert.equal(c.quality, 'm7');
  assert.deepEqual(c.pcs, [6, 9, 1, 4]);
  const s = MT.parseChord('Bb/D');
  assert.equal(s.rootPc, 10);
  assert.equal(s.bassPc, 2);
  assert.equal(MT.parseChord('Am').quality, 'min');
  assert.equal(MT.parseChord('Cmaj7').quality, 'maj7');
  assert.equal(MT.parseChord('Dsus').quality, 'sus4');
  assert.equal(MT.parseChord('E♭').root, 'Eb');
});

test('parseChord rejects section names and words', () => {
  ['Chorus', 'Bridge', 'Intro', 'Verse', 'Outro', 'hello', '', 'H', 'Dad'].forEach((w) => {
    assert.equal(MT.parseChord(w), null, w);
  });
  ['A', 'Em', 'C#m7b5', 'Gsus4', 'Dadd9', 'Bm7(b5)', 'E7#9', 'A5'].forEach((w) => {
    assert.ok(MT.parseChord(w), w);
  });
});

test('transposeChord keeps suffixes and uses the requested spelling', () => {
  assert.equal(MT.transposeChord('Am', 1, true), 'Bbm');
  assert.equal(MT.transposeChord('Am', 1, false), 'A#m');
  assert.equal(MT.transposeChord('Cmaj7', 2, false), 'Dmaj7');
  assert.equal(MT.transposeChord('G/B', -2, true), 'F/A');
  assert.equal(MT.transposeChord('Em', 12, false), 'Em');
  assert.equal(MT.transposeChord('not-a-chord', 3), 'not-a-chord');
});

test('transposeKey follows circle-of-fifths spelling', () => {
  assert.equal(MT.transposeKey('Em', 1), 'Fm');
  assert.equal(MT.transposeKey('Em', -1), 'Ebm');
  assert.equal(MT.transposeKey('G', 1), 'Ab');
  assert.equal(MT.transposeKey('G', -1), 'F#');
  assert.equal(MT.transposeKey('C', 10), 'Bb');
  assert.ok(MT.keyPrefersFlats('Fm'));
  assert.ok(MT.keyPrefersFlats('Bb'));
  assert.ok(!MT.keyPrefersFlats('E'));
  assert.ok(!MT.keyPrefersFlats('F#m'));
});

test('sameChord compares enharmonic roots and quality', () => {
  assert.ok(MT.sameChord('A#m', 'Bbm'));
  assert.ok(!MT.sameChord('Am', 'A'));
  assert.ok(MT.sameChord('Gb', 'F#'));
});
