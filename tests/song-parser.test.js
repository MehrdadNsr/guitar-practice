'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const SP = require('../js/song-parser.js');

const chordAt = (line, word) => {
  const pos = line.text.indexOf(word);
  const a = line.anchors.find((x) => x.pos === pos);
  return a ? a.chord : null;
};

test('ChordPro inline chords anchor to the exact character', () => {
  const { items, chords } = SP.parseSong("[Am]Lyin' in [C]bed\nTryin' to [Em]sleep but I [D]can't");
  const [l1, l2] = items;
  assert.equal(l1.text, "Lyin' in bed");
  assert.equal(chordAt(l1, 'Lyin'), 'Am');
  assert.equal(chordAt(l1, 'bed'), 'C');
  assert.equal(chordAt(l2, 'sleep'), 'Em');
  assert.equal(chordAt(l2, "can't"), 'D');
  assert.deepEqual(chords, ['Am', 'C', 'Em', 'D']);
});

test('chords-over-lyrics lines are merged by column', () => {
  const body = [
    ' G      G7         C         G',
    'Amazing grace, how sweet the sound',
  ].join('\n');
  const [line] = SP.parseSong(body).items;
  assert.equal(line.text, 'Amazing grace, how sweet the sound');
  assert.equal(line.text[line.anchors[0].pos], 'm');
  assert.equal(chordAt(line, 'grace'), 'G7');
  assert.equal(chordAt(line, 'sweet'), 'C');
  assert.equal(chordAt(line, 'sound'), 'G');
});

test('a chord past the end of the lyric gets its own padded column', () => {
  const [line] = SP.parseSong('Am         C\nshort').items;
  assert.equal(line.anchors[1].chord, 'C');
  assert.ok(line.text.length > line.anchors[1].pos);
});

test('sections, directives, comments and blank lines', () => {
  const body = '[Verse 1]\n[Am]one\n\n\n{c: Chorus}\n# a comment\n{soc}\n[C]two\n{eoc}\n{title: Ignored here}';
  const { items, meta } = SP.parseSong(body);
  assert.deepEqual(items.map((i) => i.type), ['section', 'line', 'blank', 'section', 'section', 'line']);
  assert.equal(items[0].label, 'Verse 1');
  assert.equal(items[3].label, 'Chorus');
  assert.equal(meta.title, 'Ignored here');
});

test('chord-only lines are flagged and keep bar/repeat marks', () => {
  const { items } = SP.parseSong('[Am] [C] [Em] [D]\n| G  | D  | x2');
  assert.ok(items[0].chordsOnly);
  assert.deepEqual(items[0].anchors.map((a) => a.chord), ['Am', 'C', 'Em', 'D']);
  assert.ok(items[1].chordsOnly);
  const groups = SP.layoutLine(items[1]);
  assert.equal(groups[0].chunks[0].text, '|');
  assert.equal(groups.length, 3);
});

test('layoutLine keeps chords on their words and pads colliding chords', () => {
  const [line] = SP.parseSong('[Cmaj7]I [D]am here').items;
  const groups = SP.layoutLine(line);
  const chunks = groups.flatMap((g) => g.chunks);
  const first = chunks.find((c) => c.chord === 'Cmaj7');
  // "I " is 2 chars, Cmaj7 + 1 gap needs 6: 4 columns of padding.
  assert.equal(first.padCh, 4);
  const d = chunks.find((c) => c.chord === 'D');
  assert.equal(d.text, 'am ');
  assert.equal(d.padCh, 0);
});

test('mid-word chord changes split the word but not the group', () => {
  const [line] = SP.parseSong('If I got a[D]way').items;
  const groups = SP.layoutLine(line);
  const last = groups[groups.length - 1];
  assert.deepEqual(last.chunks.map((c) => c.text), ['a', 'way']);
  assert.equal(last.chunks[0].midWord, true);
  assert.equal(last.chunks[1].chord, 'D');
});

test('lyric lines that merely contain a chord-like word stay lyrics', () => {
  const { items } = SP.parseSong('A man walked in\nEm');
  assert.equal(items[0].hasChords, false);
  assert.equal(items[0].text, 'A man walked in');
  assert.ok(items[1].chordsOnly);
});
