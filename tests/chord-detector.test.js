'use strict';
// End-to-end tests of the chord detector on synthetic guitar audio
// (Karplus-Strong strings strummed with the app's own chord shapes, run
// through an AnalyserNode emulator). Thresholds are deliberately below the
// measured results so the suite is stable.
const test = require('node:test');
const assert = require('node:assert/strict');
const MT = require('../js/music-theory.js');
const CD = require('../js/chord-detector.js');
const S = require('./helpers/audio-sim.js');

const SR = 48000;

function track(signal, vocab, opts) {
  const tr = new CD.ChordTracker(opts);
  tr.setVocabulary(vocab || null, null, false);
  return S.runTracker(tr, signal, SR, { hopMs: 40 });
}

/** Fraction of frames from 400 ms after each strum where the shown chord is right. */
function accuracy(frames, chords, per, lead) {
  let ok = 0;
  let total = 0;
  chords.forEach((c, i) => {
    const t0 = (lead + i * per) * 1000;
    frames.forEach((f) => {
      if (f.t >= t0 + 400 && f.t < t0 + per * 1000) {
        total++;
        if (MT.sameChord(f.result.chord || '', c)) ok++;
      }
    });
  });
  return ok / total;
}

function latencies(frames, chords, per, lead) {
  return chords.map((c, i) => {
    const t0 = (lead + i * per) * 1000;
    const hit = frames.find((f) => f.t >= t0 && f.t < t0 + per * 1000 && MT.sameChord(f.result.chord || '', c));
    return hit ? hit.t - t0 : Infinity;
  });
}

const SONG = ['Am', 'C', 'Em', 'D', 'Am', 'C', 'Em', 'D'];

test('song mode recognises the Haunted progression quickly', () => {
  const sig = S.renderProgression(SR, S.mulberry32(1), SONG, { per: 1.6, pluckPos: 0.2 });
  const frames = track(sig, ['Am', 'C', 'Em', 'D']);
  assert.ok(accuracy(frames, SONG, 1.6, 0.3) >= 0.97);
  const lat = latencies(frames, SONG, 1.6, 0.3).sort((a, b) => a - b);
  assert.ok(lat[Math.floor(lat.length / 2)] <= 400, 'median latency ' + lat);
});

test('open mode (all roots x 9 qualities) recognises common chords', () => {
  const chords = ['C', 'G', 'D', 'A', 'E', 'Am', 'Em', 'Dm', 'F', 'Bm', 'G7', 'Cmaj7', 'F#m', 'Bb', 'C#m', 'Gm'];
  const sig = S.renderProgression(SR, S.mulberry32(2), chords, { per: 1.4, pluckPos: 0.2 });
  const frames = track(sig, null);
  assert.ok(accuracy(frames, chords, 1.4, 0.3) >= 0.85);
});

test('a guitar tuned 30 cents flat is still recognised', () => {
  const sig = S.renderProgression(SR, S.mulberry32(3), SONG, { per: 1.6, pluckPos: 0.2, cents: -30 });
  assert.ok(accuracy(track(sig, null), SONG, 1.6, 0.3) >= 0.9);
});

test('noise and mains hum never produce a chord', () => {
  const rand = S.mulberry32(4);
  const noise = new Float64Array(SR * 3);
  S.addNoise(noise, 0.02, rand);
  assert.equal(track(noise, null).filter((f) => f.result.chord).length, 0);
  const hum = new Float64Array(SR * 3);
  S.addHum(hum, SR, 50, 0.02);
  assert.equal(track(hum, null).filter((f) => f.result.chord).length, 0);
});

test('repeated strums of the same chord do not flicker', () => {
  const chords = ['Am', 'C', 'Em', 'D'];
  const sig = S.renderProgression(SR, S.mulberry32(5), chords, { per: 2.4, strumsPerChord: 8, pluckPos: 0.2 });
  [['Am', 'C', 'Em', 'D'], null].forEach((vocab) => {
    let changes = 0;
    let prev = null;
    track(sig, vocab).forEach((f) => {
      if (f.result.chord !== prev) { changes++; prev = f.result.chord; }
    });
    assert.equal(changes, 4, 'display changes with vocab ' + vocab);
  });
});

test('YIN finds the fundamental of a low string', () => {
  const sig = new Float64Array(4096);
  S.pluck(sig, SR, 0, 110, 0.5, S.mulberry32(6), { pluckPos: 0.2 });
  const low = S.lowpass(sig, SR, 320, 0.707);
  const y = CD.yin(low.subarray(0, 4096), SR, 65, 340, 0.2, 6);
  assert.ok(y && Math.abs(y.freq - 110) < 2, 'freq ' + (y && y.freq));
});

test('harmonic subtraction removes a 3rd harmonic that is not a chord tone', () => {
  // B2 with a strong 3rd harmonic (F#4) and nothing else.
  const f0 = 123.47;
  const peaks = [
    { freq: f0, mag: 1, db: 0 },
    { freq: f0 * 2, mag: 0.6, db: 0 },
    { freq: f0 * 3, mag: 0.35, db: 0 },
  ];
  const notes = CD.extractNotes(peaks, CD.DEFAULTS);
  assert.equal(notes.length, 1);
  assert.ok(Math.abs(notes[0].freq - f0) < 0.01);
});

// ------------------------------------------------ unrestricted (24 triads)

function trackFree(signal) {
  const tr = new CD.ChordTracker({ unknownBelow: 0.3, sustainActiveMs: Infinity });
  tr.setVocabulary(CD.allTriadNames(false));
  return S.runTracker(tr, signal, SR, { hopMs: 40 });
}

test('allTriadNames lists the 24 major and minor chords', () => {
  const names = CD.allTriadNames(false);
  assert.equal(names.length, 24);
  assert.ok(names.includes('F#m') && names.includes('C') && names.includes('A#'));
  assert.ok(CD.allTriadNames(true).includes('Bbm'));
});

test('unrestricted mode names chords outside the song and rarely says unknown', () => {
  const chords = ['Am', 'C', 'Em', 'D', 'G', 'Bm', 'F', 'C#m'];
  const sig = S.renderProgression(SR, S.mulberry32(11), chords, { per: 1.6, pluckPos: 0.2 });
  const frames = trackFree(sig);
  assert.ok(accuracy(frames, chords, 1.6, 0.3) >= 0.9);
  const open = frames.filter((f) => f.result.gateOpen);
  assert.ok(open.filter((f) => f.result.unknown).length / open.length < 0.05);
  const top = open[open.length - 1].result.candidates;
  assert.ok(top.length >= 3 && top.every((c) => c.confidence >= 0 && c.confidence <= 1));
});

test('unrestricted mode reports speech-like sound mostly as unknown', () => {
  // Gliding harmonic "voice" with formants and syllable envelope.
  const rand = S.mulberry32(12);
  const sp = new Float64Array(SR * 4);
  let ph = 0;
  for (let i = 0; i < sp.length; i++) {
    const t = i / SR;
    const syl = Math.max(0, Math.sin(Math.PI * ((t * 4) % 1)));
    const f0 = 120 + 30 * Math.sin(2 * Math.PI * 0.7 * t) + 15 * Math.sin(2 * Math.PI * 3.1 * t);
    ph += (2 * Math.PI * f0) / SR;
    let v = 0;
    for (let h = 1; h < 25; h++) {
      const f = h * f0;
      v += (Math.sin(h * ph) * (Math.exp(-(((f - 700) / 250) ** 2)) + 0.6 * Math.exp(-(((f - 1200) / 300) ** 2)) + 0.3)) / h;
    }
    sp[i] = 0.05 * v * syl + 0.002 * (rand() * 2 - 1);
  }
  const open = trackFree(sp).filter((f) => f.result.gateOpen);
  assert.ok(open.filter((f) => f.result.unknown).length / open.length >= 0.5);
});
