'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ChordFollower } = require('../js/chord-follower.js');

// Two lines of Am C / Em D, then a line with G
const EVENTS = [
  { line: 0, chord: 'Am' }, { line: 0, chord: 'C' },
  { line: 1, chord: 'Em' }, { line: 1, chord: 'D' },
  { line: 3, chord: 'G' },
];

test('advances only on the expected chord and waits otherwise', () => {
  const f = new ChordFollower(EVENTS);
  assert.equal(f.expected().chord, 'Am');
  assert.equal(f.update('Am'), 0);
  assert.equal(f.update('Am'), -1, 'a ringing chord is not a change');
  assert.equal(f.update('F'), -1, 'wrong chord: wait');
  assert.equal(f.expected().chord, 'C');
  assert.equal(f.update('C'), 1);
  assert.equal(f.expected().chord, 'Em');
});

test('tolerance window covers the next two chord lines', () => {
  const f = new ChordFollower(EVENTS);
  assert.deepEqual(f.window(), [0, 1, 2, 3]);
  assert.equal(f.update('D'), 3, 'skipped ahead within the window');
  assert.equal(f.expected().chord, 'G');
  const g = new ChordFollower(EVENTS);
  assert.equal(g.update('G'), -1, 'G is three lines away: outside the window');
});

test('enharmonic spellings match and the end is reported', () => {
  const f = new ChordFollower([{ line: 0, chord: 'Bb' }, { line: 0, chord: 'Ebm' }]);
  assert.equal(f.update('A#'), 0);
  assert.equal(f.update('D#m'), 1);
  assert.ok(f.done);
  assert.equal(f.update('A#'), -1);
});

test('free (unrestricted) mode follows any new chord one step', () => {
  const f = new ChordFollower(EVENTS);
  assert.equal(f.update('F#', true), 0, 'unknown chord still moves one step');
  assert.equal(f.update('F#', true), -1, 'same chord again does not');
  assert.equal(f.update('Em', true), 2, 'a chord in the window jumps there');
});

test('resetToLine waits for the first chord at or after that line', () => {
  const f = new ChordFollower(EVENTS);
  f.resetToLine(2);
  assert.equal(f.expected().chord, 'G');
});
