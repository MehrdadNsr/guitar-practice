'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const MT = require('../js/music-theory.js');

test('sameChord matches exact, enharmonic and alias chords', () => {
  assert.ok(MT.sameChord('Am', 'Am'));
  assert.ok(MT.sameChord('A#m', 'Bbm'));
  assert.ok(MT.sameChord('C#', 'Db'));
  assert.ok(MT.sameChord('F#m7', 'Gbm7'));
  assert.ok(!MT.sameChord('Am', 'C'));
  assert.ok(!MT.sameChord('A', 'Am'));
});

test('chord-sync sequential strict advance logic simulation (no lookahead skip)', () => {
  const songChords = ['Am', 'C', 'Em', 'D'];
  let progressIdx = 0;
  let played = [];

  function tryAdvance(detectedName, isOnset) {
    if (progressIdx >= songChords.length) return false;
    const expected = songChords[progressIdx];
    // Strict match against expected only (no lookahead to progressIdx + 1)
    if (!isOnset) return false;
    if (!MT.sameChord(expected, detectedName)) return false;

    played.push(songChords[progressIdx]);
    progressIdx++;
    return true;
  }

  // 1. Play first chord correctly
  assert.equal(tryAdvance('Am', true), true);
  assert.equal(progressIdx, 1);
  assert.deepEqual(played, ['Am']);

  // 2. Play wrong chord -> does not advance
  assert.equal(tryAdvance('G', true), false);
  assert.equal(progressIdx, 1);

  // 3. Play next chord correctly -> advances exactly 1 step
  assert.equal(tryAdvance('C', true), true);
  assert.equal(progressIdx, 2);
  assert.deepEqual(played, ['Am', 'C']);

  // 4. Strictness: user played D instead of Em -> MUST NOT skip Em!
  assert.equal(tryAdvance('D', true), false);
  assert.equal(progressIdx, 2, 'Must remain on Em and not skip ahead');
  assert.deepEqual(played, ['Am', 'C']);

  // 5. Playing Em correctly now advances to 3
  assert.equal(tryAdvance('Em', true), true);
  assert.equal(progressIdx, 3);
  assert.deepEqual(played, ['Am', 'C', 'Em']);

  // 6. Playing D advances to end
  assert.equal(tryAdvance('D', true), true);
  assert.equal(progressIdx, 4);
  assert.deepEqual(played, ['Am', 'C', 'Em', 'D']);
});

test('consecutive identical chords advance on re-strum onset', () => {
  const songChords = ['Am', 'Am', 'G'];
  let progressIdx = 0;
  let lastTime = 0;
  let lastChord = '';

  function advance(chordName, onset, time) {
    if (progressIdx >= songChords.length) return false;
    const expected = songChords[progressIdx];
    if (!MT.sameChord(expected, chordName)) return false;

    const isSame = lastChord && MT.sameChord(lastChord, chordName);
    if (isSame && !onset && (time - lastTime < 350)) {
      return false; // debounced
    }

    lastTime = time;
    lastChord = chordName;
    progressIdx++;
    return true;
  }

  // First Am strum
  assert.equal(advance('Am', true, 1000), true);
  assert.equal(progressIdx, 1);

  // Same frame (no onset, small dt) -> debounced
  assert.equal(advance('Am', false, 1040), false);
  assert.equal(progressIdx, 1);

  // Second Am strum with onset
  assert.equal(advance('Am', true, 1500), true);
  assert.equal(progressIdx, 2);

  // Next chord G
  assert.equal(advance('G', true, 2000), true);
  assert.equal(progressIdx, 3);
});
