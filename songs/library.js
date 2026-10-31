/*
 * Song library.
 *
 * To add a song, append ONE object to the array below. No other file needs
 * to change. Fields:
 *
 *   id            unique, URL-safe (used in the address bar: #song=<id>)
 *   title, artist
 *   key           original key, e.g. "Em" or "G" (enables key-aware spelling)
 *   bpm           tempo for the metronome
 *   timeSignature e.g. "4/4", "3/4" (metronome accent)
 *   capo          optional, fret number (shown as a hint)
 *   scrollSpeed   optional default auto-scroll speed, 0-100 (slider value)
 *   lang / dir    optional, e.g. lang: 'fa', dir: 'rtl' for Persian lyrics
 *   youtubeId     optional YouTube video id for play-along (loaded on demand)
 *   notes         optional short text shown under the title
 *   shapes        optional custom fingerings: { "Cmaj7": "x32000" }
 *   body          the chords + lyrics, in either format (they can be mixed):
 *
 *     ChordPro inline:      [Am]Lyin' in [C]bed
 *     Chords over lyrics:   Am           C
 *                           Lyin' in bed
 *
 *     Section headers: [Verse 1]  [Chorus]  or  {c: Bridge}
 *     Comments: lines starting with #
 *
 * Use a template literal (backticks) for the body; avoid backticks inside it.
 */
window.SONG_LIBRARY = [
  {
    id: 'haunted',
    title: 'Haunted',
    artist: 'Kukunari',
    key: 'Em',
    bpm: 82,
    timeSignature: '4/4',
    capo: 0,
    scrollSpeed: 38,
    notes: 'Am – C – Em – D · half-time feel (~164 BPM)',
    body: `
[Intro]
[Am] [C] [Em] [D]
[Am] [C] [Em] [D]

[Verse 1]
[Am]Lyin' in [C]bed
Tryin' to [Em]sleep but I [D]can't
[Am]Thoughts all [C]over
[Em]Thoughts all [D]over

[Am]In my dreams I [C]can fight
[Em]I've got nothin' to [D]hide
[Am]If I know it's [C]not real
[Em]There's no need to [D]fear

[Chorus]
[Am]What if I [C]had
[Em]What I've been lookin' for [D]all along?

[Verse 2]
[Am]Lyin' in [C]bed
[Em]I don't wanna go [D]back
[Am]'Cause I want it [C]to be
[Em]More than a [D]dream

[Chorus]
[Am]What if I [C]had
[Em]What I've been lookin' for [D]all along?
[Am]What if you're not the [C]one
[Em]I should be countin' on [D]anymore?

[Bridge]
[Am]If I'm not the [C]same
[Em]If I'm not the [D]same
[Am]Why do I feel [C]haunted?
[Em] [D]

[Am]If I'm not the [C]same
[Em]If I got a[D]way
[Am]Why do I keep [C]hiding?
[Em] [D]

[Outro]
[Am] [C] [Em] [D]
[Am] [C] [Em] [D]
[Am] [C] [Em] [D]
[Am] [C] [Em] [D]
`,
  },
  {
    id: 'amazing-grace',
    title: 'Amazing Grace',
    artist: 'Traditional',
    key: 'G',
    bpm: 72,
    timeSignature: '3/4',
    scrollSpeed: 30,
    notes: 'John Newton, 1779 (public domain) · chords-over-lyrics format example',
    body: `
[Verse 1]
 G      G7         C         G
Amazing grace, how sweet the sound
     G                   D
That saved a wretch like me
  G        G7        C      G
I once was lost, but now am found
    Em         D     G
Was blind, but now I see
`,
  },
];
