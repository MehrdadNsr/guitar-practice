'use strict';
// Tests of the voice (prosody) engine on synthetic speech-like audio:
// harmonic tones with a controlled pitch contour, run through the same
// frame builder the browser uses (full-band + low-passed time frames and
// AnalyserNode dB bins, 20 ms hop).
const test = require('node:test');
const assert = require('node:assert/strict');
const VE = require('../js/voice-engine.js');
const S = require('./helpers/audio-sim.js');

const SR = 48000;
const AMP = 0.12; // about -24 dBFS: a laptop mic at speaking distance

function signal(seconds) { return new Float64Array(Math.floor(seconds * SR)); }

function run(sig, opts) {
  const tr = new VE.VoiceTracker(Object.assign({ sessionId: 'test-session' }, opts || {}));
  const frames = S.runVoiceTracker(tr, sig, SR);
  const utterances = frames.map((f) => f.result.utterance).filter(Boolean);
  const tail = tr.flush();
  if (tail) utterances.push(tail);
  return { tr, frames, utterances };
}

test('a gliding tone 100 -> 150 Hz gives rising end trend and continuous raw pitch', () => {
  const sig = signal(3.5);
  // 0.8 s of room, then 1.5 s glide, then silence so the sentence closes.
  S.addVoice(sig, SR, 0.8, 1.5, (s) => 100 + (50 * s) / 1.5, AMP);
  S.addNoise(sig, 0.0005, S.mulberry32(7));
  const { frames, utterances } = run(sig);

  assert.equal(utterances.length, 1, 'exactly one sentence');
  const u = utterances[0];
  assert.equal(u.kind, 'utterance');
  assert.equal(u.session_id, 'test-session');
  assert.equal(u.pitch_end_trend, 'rising');
  assert.ok(u.duration_ms > 1300 && u.duration_ms < 1700, 'duration ' + u.duration_ms);
  assert.ok(u.pitch_median_hz > 115 && u.pitch_median_hz < 135, 'median ' + u.pitch_median_hz);
  assert.ok(u.pitch_p10_hz < u.pitch_median_hz && u.pitch_median_hz < u.pitch_p90_hz);
  assert.ok(u.voiced_ratio > 0.9, 'voiced ratio ' + u.voiced_ratio);
  assert.ok(u.loudness_mean_dbfs > -32 && u.loudness_mean_dbfs < -16, 'loudness ' + u.loudness_mean_dbfs);
  assert.ok(u.loudness_peak_dbfs >= u.loudness_mean_dbfs);
  assert.ok(Math.abs(u.pause_before_ms - 800) < 100, 'pause before ' + u.pause_before_ms);
  assert.equal(u.started_at, new Date(1700000000000 + 800).toISOString().slice(0, 19) + u.started_at.slice(19));

  // Raw pitch: every voiced frame tracks the instantaneous frequency within
  // 3 %, values are not snapped to notes (almost all distinct) and climb.
  const voiced = frames.filter((f) => f.result.voiced && f.t > 900 && f.t < 2250);
  assert.ok(voiced.length > 55, 'voiced frames ' + voiced.length);
  voiced.forEach((f) => {
    const expected = 100 + (50 * ((f.t - 800) / 1000 - 0.02)) / 1.5;
    assert.ok(Math.abs(f.result.hz - expected) / expected < 0.03, 't=' + f.t + ' hz=' + f.result.hz + ' expected ' + expected);
  });
  const distinct = new Set(voiced.map((f) => f.result.hz.toFixed(2))).size;
  assert.ok(distinct > voiced.length * 0.9, 'distinct values ' + distinct + '/' + voiced.length);
  assert.ok(voiced[voiced.length - 1].result.hz > voiced[0].result.hz + 35);

  // Contour: a point every 100 ms with Hz and dBFS.
  assert.ok(u.contour.length >= 13 && u.contour.length <= 16, 'contour points ' + u.contour.length);
  assert.equal(u.contour[0].t_ms, 0);
  assert.equal(u.contour[1].t_ms, 100);
  assert.ok(u.contour.every((c) => typeof c.dbfs === 'number'));
  assert.ok(u.contour.filter((c) => c.hz !== null).length >= u.contour.length - 1);
});

test('a falling glide gives falling end trend; a steady tone is flat', () => {
  const sig = signal(3.0);
  S.addVoice(sig, SR, 0.8, 1.2, (s) => 180 - (60 * s) / 1.2, AMP);
  assert.equal(run(sig).utterances[0].pitch_end_trend, 'falling');

  const flat = signal(3.0);
  S.addVoice(flat, SR, 0.8, 1.2, () => 140, AMP);
  const u = run(flat).utterances[0];
  assert.equal(u.pitch_end_trend, 'flat');
  assert.ok(Math.abs(u.pitch_median_hz - 140) < 3, 'median ' + u.pitch_median_hz);
});

test('silence gaps split sentences; gaps shorter than 600 ms do not', () => {
  const sig = signal(8);
  const noise = S.mulberry32(3);
  // Sentence 1: two phrases 300 ms apart (same sentence). Sentence 2 after
  // 1 s of silence. Sentence 3 after 700 ms.
  S.addVoice(sig, SR, 0.8, 0.9, () => 120, AMP);
  S.addVoice(sig, SR, 2.0, 0.7, () => 130, AMP);
  S.addVoice(sig, SR, 3.7, 1.0, () => 125, AMP);
  S.addVoice(sig, SR, 5.4, 0.6, () => 135, AMP);
  S.addNoise(sig, 0.0005, noise);
  const { utterances } = run(sig);
  assert.equal(utterances.length, 3, 'sentences: ' + utterances.map((u) => u.duration_ms));
  const [a, b, c] = utterances;
  assert.ok(a.duration_ms > 1800 && a.duration_ms < 2000, 'first spans both phrases: ' + a.duration_ms);
  assert.ok(b.duration_ms > 950 && b.duration_ms < 1100, 'second ' + b.duration_ms);
  assert.ok(c.duration_ms > 550 && c.duration_ms < 700, 'third ' + c.duration_ms);
  assert.ok(Math.abs(b.pause_before_ms - 1000) < 80, 'pause before second ' + b.pause_before_ms);
  assert.ok(Math.abs(c.pause_before_ms - 700) < 80, 'pause before third ' + c.pause_before_ms);
  assert.ok(new Date(b.started_at) > new Date(a.ended_at));
});

test('segments shorter than 250 ms are ignored', () => {
  const sig = signal(4);
  S.addVoice(sig, SR, 0.8, 0.15, () => 120, AMP); // a cough
  S.addVoice(sig, SR, 2.0, 0.5, () => 120, AMP);  // a word
  const { utterances } = run(sig);
  assert.equal(utterances.length, 1);
  assert.ok(utterances[0].duration_ms > 450);
});

test('noise alone produces no sentence and learns the floor', () => {
  const sig = signal(6);
  S.addNoise(sig, 0.004, S.mulberry32(11)); // steady room noise, about -51 dBFS
  S.addHum(sig, SR, 50, 0.001);
  const { tr, utterances, frames } = run(sig);
  assert.equal(utterances.length, 0);
  assert.ok(tr.noiseFloor > -60 && tr.noiseFloor < -45, 'floor ' + tr.noiseFloor);
  assert.ok(frames.every((f) => !f.result.gateOpen));

  // Speech must still be heard over that noise.
  S.addVoice(sig, SR, 2.0, 1.0, () => 110, AMP);
  const second = run(sig);
  assert.equal(second.utterances.length, 1);
  assert.ok(second.utterances[0].voiced_ratio > 0.8);
});

test('syllable onsets are counted at roughly the syllable rate', () => {
  // Five 150 ms "syllables" per second with 50 ms dips, for 2 s.
  const sig = signal(4);
  for (let i = 0; i < 10; i++) S.addVoice(sig, SR, 0.8 + i * 0.2, 0.15, () => 130, AMP);
  const { frames, utterances } = run(sig);
  assert.equal(utterances.length, 1);
  const u = utterances[0];
  const onsets = frames.filter((f) => f.result.onset).map((f) => f.t);
  assert.equal(onsets.length, 10, 'onsets at ' + onsets);
  // 10 onsets over about 1.5 s of voiced time (the dips are unvoiced).
  assert.ok(u.syllable_rate >= 6 && u.syllable_rate <= 8, 'syllable rate ' + u.syllable_rate);
  assert.ok(u.voiced_ratio > 0.6 && u.voiced_ratio < 0.9, 'voiced ratio ' + u.voiced_ratio);
});

test('baseline collects everything between start and stop', () => {
  const sig = signal(5);
  S.addVoice(sig, SR, 0.8, 1.0, () => 120, AMP);
  S.addVoice(sig, SR, 2.6, 1.0, () => 140, AMP);
  const tr = new VE.VoiceTracker({ sessionId: 's' });
  tr.startBaseline();
  S.runVoiceTracker(tr, sig, SR);
  const b = tr.stopBaseline();
  assert.equal(b.kind, 'baseline');
  assert.equal(b.session_id, 's');
  assert.ok(b.duration_ms > 4900 && b.duration_ms <= 5020, 'duration ' + b.duration_ms);
  assert.ok(b.pitch_median_hz > 115 && b.pitch_median_hz < 145, 'median ' + b.pitch_median_hz);
  assert.ok(b.voiced_ratio > 0.3 && b.voiced_ratio < 0.5, 'voiced ratio ' + b.voiced_ratio);
  assert.ok(b.loudness_mean_dbfs > -32 && b.loudness_mean_dbfs < -16, 'loudness ' + b.loudness_mean_dbfs);
  assert.equal(b.pause_before_ms, 0);
  assert.equal(tr.stopBaseline(), null);
});

test('flush closes a sentence that is still being spoken', () => {
  const sig = signal(2);
  S.addVoice(sig, SR, 0.8, 1.2, () => 120, AMP); // runs to the end of the signal
  const tr = new VE.VoiceTracker();
  const frames = S.runVoiceTracker(tr, sig, SR);
  assert.ok(frames.every((f) => !f.result.utterance));
  const u = tr.flush();
  assert.ok(u && u.duration_ms > 1000, 'flushed ' + (u && u.duration_ms));
  assert.ok(/^[0-9a-f-]{32,36}$/.test(u.session_id));
  assert.equal(tr.flush(), null);
});

test('summarize handles unvoiced segments without crashing', () => {
  const frames = [];
  for (let i = 0; i < 20; i++) frames.push({ t: i * 20, wall: 1000 + i * 20, dbfs: -30, hz: null, voiced: false, onset: i % 5 === 0, gateOpen: true });
  const u = VE.summarize(frames, { kind: 'utterance', sessionId: 'x', pauseBeforeMs: 10 });
  assert.equal(u.pitch_median_hz, null);
  assert.equal(u.pitch_end_trend, 'flat');
  assert.equal(u.voiced_ratio, 0);
  assert.equal(u.duration_ms, 400);
  assert.equal(u.syllable_rate, 10);
  assert.equal(u.contour.length, 4);
});
