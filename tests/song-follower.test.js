'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const MT = require('../js/music-theory.js');
const CD = require('../js/chord-detector.js');
const S = require('./helpers/audio-sim.js');

const SR = 48000;

function createSimulator(vocab, followerOpts) {
  const tracker = new CD.ChordTracker({ gateDbfs: -52 });
  tracker.setVocabulary(vocab || null, null, false);
  const follower = new CD.SongFollower(tracker, followerOpts || { strictness: 'strict' });
  return { tracker, follower };
}

/**
 * Runs simulation over synthetic audio signal, feeding frames through tracker and follower.
 */
function runSimulation(signal, songChords, followerOpts) {
  const { tracker, follower } = createSimulator(songChords, followerOpts);
  const low = S.lowpass(signal, SR, 320, 0.707);
  const hop = Math.round((40 / 1000) * SR);
  const fftSize = 8192;
  const lowSize = 4096;

  let progressIdx = 0;
  const history = [];
  follower.setTarget(songChords[progressIdx] || null);

  for (let end = hop; end <= signal.length; end += hop) {
    const db = S.analyserFrame(signal, end, fftSize);
    const lowTime = new Float32Array(lowSize);
    for (let i = 0; i < lowSize; i++) {
      const idx = end - lowSize + i;
      lowTime[i] = idx >= 0 ? low[idx] : 0;
    }
    const t = (end / SR) * 1000;
    const r = tracker.process({ db, sampleRate: SR, fftSize, lowTime, t });
    const fRes = follower.process(r, t);

    if (fRes.action === 'advance') {
      const acceptedChord = songChords[progressIdx];
      history.push({ t, chord: acceptedChord, progressIdx });
      progressIdx++;
      follower.setTarget(songChords[progressIdx] || null);
    }
  }

  return { progressIdx, history, log: follower.log };
}

test('single strum left ringing for 2.5s only advances once and does NOT advance to next chord', () => {
  const chords = ['Em', 'C', 'G'];
  const g = new S.Guitar(SR, S.mulberry32(101));
  // Strum Em at 0.3s, leave it ringing for 2.7 seconds (total 3.0s)
  g.strum(0.3, 'Em', { amp: 0.35, decay: 0.997 });
  const sig = g.render(3.2);

  const res = runSimulation(sig, chords, { strictness: 'strict' });

  // Must have advanced Em (index becomes 1, pointing to C)
  assert.equal(res.progressIdx, 1, 'Should advance exactly once for the single strum');
  assert.equal(res.history.length, 1);
  assert.equal(res.history[0].chord, 'Em');
  // It must NOT have advanced to C even though Em's harmonics were ringing for >2.5s
});

test('sequence of 4 chords (Am -> C -> Em -> D) advances exactly 1 step per strum', () => {
  const song = ['Am', 'C', 'Em', 'D'];
  const sig = S.renderProgression(SR, S.mulberry32(202), song, { per: 1.5, lead: 0.3, pluckPos: 0.2 });

  const res = runSimulation(sig, song, { strictness: 'strict' });

  assert.equal(res.progressIdx, 4, 'Should advance through all 4 chords');
  assert.equal(res.history.length, 4);
  assert.deepEqual(res.history.map((h) => h.chord), ['Am', 'C', 'Em', 'D']);

  // Verify timestamps correspond to each strum
  assert.ok(res.history[0].t >= 300 && res.history[0].t < 900, 'Am detected on first strum');
  assert.ok(res.history[1].t >= 1800 && res.history[1].t < 2400, 'C detected on second strum');
  assert.ok(res.history[2].t >= 3300 && res.history[2].t < 3900, 'Em detected on third strum');
  assert.ok(res.history[3].t >= 4800 && res.history[3].t < 5400, 'D detected on fourth strum');
});

test('never skips ahead when a future chord is played out of order', () => {
  const song = ['Am', 'C', 'Em', 'D'];
  const g = new S.Guitar(SR, S.mulberry32(303));
  // Player is supposed to play Am, but plays D instead!
  g.strum(0.3, 'D', { amp: 0.35 });
  const sig = g.render(2.0);

  const res = runSimulation(sig, song, { strictness: 'strict' });

  // Progress must remain 0 because D is not Am!
  assert.equal(res.progressIdx, 0, 'Must NOT skip ahead to D when expecting Am');
  assert.equal(res.history.length, 0);
  assert.ok(res.log.some((l) => l.action === 'reject'), 'Logged rejection of wrong chord');
});

test('shared notes between Am and C do not cause false acceptance', () => {
  // Am has A, C, E. Target is C (C, E, G).
  // Player strums Am.
  const song = ['C', 'G'];
  const g = new S.Guitar(SR, S.mulberry32(404));
  g.strum(0.3, 'Am', { amp: 0.35 });
  const sig = g.render(2.0);

  const res = runSimulation(sig, song, { strictness: 'strict' });

  assert.equal(res.progressIdx, 0, 'Am strum must not be accepted when target is C');
  assert.equal(res.history.length, 0);
});

test('silence, noise and 50Hz mains hum never advance', () => {
  const song = ['Am', 'C'];

  // Pure silence
  const silence = new Float64Array(SR * 2);
  const resSilence = runSimulation(silence, song);
  assert.equal(resSilence.progressIdx, 0);

  // Background white noise
  const noise = new Float64Array(SR * 2);
  S.addNoise(noise, 0.02, S.mulberry32(505));
  const resNoise = runSimulation(noise, song);
  assert.equal(resNoise.progressIdx, 0);

  // Mains hum
  const hum = new Float64Array(SR * 2);
  S.addHum(hum, SR, 50, 0.03);
  const resHum = runSimulation(hum, song);
  assert.equal(resHum.progressIdx, 0);
});

test('consecutive identical chords (Am -> Am -> G) require a second strum to advance', () => {
  const song = ['Am', 'Am', 'G'];
  const g = new S.Guitar(SR, S.mulberry32(606));
  // Two strums of Am at 0.3s and 1.8s, then G at 3.3s
  g.strum(0.3, 'Am', { amp: 0.35 });
  g.strum(1.8, 'Am', { amp: 0.35 });
  g.strum(3.3, 'G', { amp: 0.35 });
  const sig = g.render(4.8);

  const res = runSimulation(sig, song, { strictness: 'strict' });

  assert.equal(res.progressIdx, 3, 'Must advance through Am, Am, G');
  assert.equal(res.history.length, 3);
  assert.equal(res.history[0].chord, 'Am');
  assert.equal(res.history[1].chord, 'Am');
  assert.equal(res.history[2].chord, 'G');

  // Verify the second Am was only accepted after the second strum (t >= 1800ms)
  assert.ok(res.history[1].t >= 1800, 'Second Am must wait for second strum');
});

test('repeated strums of the current chord do NOT cascade to next chords', () => {
  // If player repeatedly strums Am 6 times, it should only advance Am once, then wait for C
  const song = ['Am', 'C', 'Em'];
  const g = new S.Guitar(SR, S.mulberry32(707));
  for (let k = 0; k < 6; k++) {
    g.strum(0.3 + k * 0.4, 'Am', { amp: 0.3 });
  }
  const sig = g.render(3.0);

  const res = runSimulation(sig, song, { strictness: 'strict' });

  assert.equal(res.progressIdx, 1, 'Should advance Am once, then reject subsequent Am strums for target C');
  assert.equal(res.history.length, 1);
  assert.equal(res.history[0].chord, 'Am');
  assert.ok(res.log.some((l) => l.action === 'reject' && l.target === 'C'), 'Rejections for C logged when Am strummed');
});

test('strictness settings control threshold: strict requires higher confidence than loose', () => {
  const { tracker } = createSimulator(['Am', 'C']);
  const strictFollower = new CD.SongFollower(tracker, { strictness: 'strict' });
  const looseFollower = new CD.SongFollower(tracker, { strictness: 'loose' });

  assert.equal(CD.FOLLOWER_CONFIGS.strict.minScore, 0.60);
  assert.equal(CD.FOLLOWER_CONFIGS.normal.minScore, 0.50);
  assert.equal(CD.FOLLOWER_CONFIGS.loose.minScore, 0.40);

  strictFollower.setStrictness('normal');
  assert.equal(strictFollower.opts.strictness, 'normal');
});

test('rejection log formats human-readable explanations', () => {
  const { tracker, follower } = createSimulator(['Am', 'C']);
  follower.setTarget('Am');

  // Decision logging test
  follower._logDecision({
    t: 1000,
    action: 'reject',
    target: 'Am',
    score: 0.35,
    best: 'G',
    bestScore: 0.78,
    reason: '✗ آکورد اشتباه: صدای G شنیده شد (78٪)، آکورد هدف Am بود (35٪)',
  });

  assert.equal(follower.log.length, 1);
  assert.equal(follower.log[0].action, 'reject');
  assert.ok(follower.log[0].reason.includes('صدای G شنیده شد'));
});
