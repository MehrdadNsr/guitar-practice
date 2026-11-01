# 🎸 Guitar Practice — تمرین گیتار

A chord-sheet practice app that runs straight from the folder: plain HTML, CSS
and JavaScript, **no frameworks, no build step, no dependencies, no CDN**.
The UI is in Persian (RTL); code and comments are in English.

**Features**

- Chords sit **directly above the exact character** where they change (monospace,
  pixel-aligned, verified in tests). They also stay on their word when long lines wrap on a phone.
- **Chord-synced scroll** (🎤 «تشخیص آکورد» starts practice mode): the page follows the chords you actually play, not a clock.
- **Auto-scroll** (timer) with play/pause, restart and an exponential speed slider
  (4 px/s very slow to 240 px/s fast). Manual scrolling while playing just moves the playhead.
- The **line at the centre of the screen is highlighted** (with a reading guide while scrolling).
- **Metronome** with a drift-free Web Audio scheduler, BPM input, ± buttons, tap tempo, accented downbeat and beat lights.
- **Transpose** the whole song with key-aware spelling (Em +1 → `Bbm Db Fm Eb`, not `A#m C# Fm D#`),
  plus a capo hint.
- **Zoom** (60–240 %), **dark mode**, fullscreen, keep-screen-awake while scrolling or listening.
- **Live chord detection** from the microphone (or from an audio file): Web Audio FFT chroma plus
  autocorrelation (YIN) for the bass note, onset detection, stability voting. The detected chord
  lights up in the current line and in the chord diagrams.
- **Chord diagrams** for every chord of the song in every key (tap any chord for a big diagram).
- **Song library as data**: one entry per song. Songs can also be added in the app (stored in
  the browser) and exported as a ready-to-paste library entry.
- Responsive (desktop and mobile), keyboard shortcuts, settings saved in `localStorage`.

## Run locally

Open `index.html` by double-clicking it. Everything works from `file://`. In Chromium-based
browsers (Chrome, Edge, Brave) the microphone works there too, because they treat local files
as a secure context (verified).

Other browsers (notably Safari) and phones may need the page served over `https://` or
`http://localhost` for the microphone. Serve the folder with any static server:

```bash
python3 -m http.server 8000      # then open http://localhost:8000
# or: npx serve .   /   php -S localhost:8000
```

To use it on your **phone**, host it with HTTPS. Since there is no build step, GitHub
Pages works as-is: *Settings → Pages → Deploy from branch → `main` / root*. The mic needs
HTTPS, so plain `http://192.168.x.x` from your laptop will block it.

## Add a new song

Open `songs/library.js` and append **one object** to the `SONG_LIBRARY` array. No other file changes.

```js
  {
    id: 'my-song',               // unique, used in the URL: index.html#song=my-song
    title: 'My Song',
    artist: 'Someone',
    key: 'G',                    // original key (enables sharps/flats spelling when transposing)
    bpm: 96,
    timeSignature: '4/4',
    capo: 0,                     // optional
    scrollSpeed: 40,             // optional default slider position, 0–100
    notes: 'Strum: D DU UDU',    // optional, shown under the title
    // lang: 'fa', dir: 'rtl',   // optional, for Persian lyrics
    // youtubeId: 'xxxxxxxxxxx', // optional play-along video (loaded only when clicked)
    // shapes: { Cmaj7: 'x32000' }, // optional custom fingerings
    body: `
[Verse 1]
[G]First line of [D]lyrics
[Em]Second [C]line

[Chorus]
 G          D
Chords-over-lyrics also works
`,
  },
```

**Body format.** Both common formats work and can be mixed:

| Format | Example |
| --- | --- |
| ChordPro inline (preferred) | `[Am]Lyin' in [C]bed` |
| Chords over lyrics | a chord line directly above a lyric line, merged by column |
| Section header | `[Verse 1]`, `[Chorus]`, or `{c: Bridge}`, `{soc}` |
| Chord-only line | `[Am] [C] [Em] [D]` or `Am  C  Em  D  x2` |
| Comment | a line starting with `#` |

A chord in the middle of a word (`a[D]way`) is supported. Run `node --test` afterwards. The
library test checks that every chord parses and has a diagram in every key.

**Without editing files:** press **＋** in the app, paste the song, then **ذخیره** (it is saved in
this browser). Use **کپی ورودی کتابخانه** to copy a ready-made entry for `library.js`.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | start / stop auto-scroll |
| `R` | back to the top |
| `↑` / `↓` | faster / slower (while scrolling) |
| `[` / `]` | transpose down / up |
| `+` / `−` | zoom |
| `M` | metronome · `T` tap tempo |
| `L` | chord detection on/off |
| `←` / `→` | previous / next chord (practice mode) |
| `D` | dark mode · `F` fullscreen |

Shortcuts use physical key positions, so they also work with a Persian keyboard layout.

## How chord detection works

`js/chord-detector.js` is pure computation (no DOM), so the browser and the Node tests run the same code.

1. **Capture:** `getUserMedia` with echo-cancellation, noise-suppression and auto-gain **off**.
   The signal goes through a 60 Hz high-pass into an `AnalyserNode` (FFT 8192), and through a
   320 Hz low-pass into a second analyser for the bass. Frames are processed every 40 ms.
2. **Peaks → chroma:** spectral peaks in 60–1200 Hz, parabolic interpolation for sub-bin
   frequency, **iterative harmonic subtraction** (a peak that is a harmonic of a lower note is
   explained away), magnitude compression, and a triangular kernel into 12 pitch classes.
3. **Tuning:** a running circular mean of the peaks' cent offsets, so a guitar that is 30 ¢ flat still works.
4. **Bass:** YIN autocorrelation on the low-passed, decimated signal (FFT bins are ~6 Hz wide,
   too coarse for E2 vs F2), cross-checked with the lowest strong peak. A matching root gets a bonus.
5. **Matching:** mean-centred cosine (Pearson) similarity against chord templates, plus a margin
   test against the best chord with a *different root*.
6. **Timing:** onsets come from spectral flux with an adaptive threshold or a sudden level rise.
   After a strum, ~130 ms of loudness-weighted frames are averaged and decide immediately.
   Between strums, per-frame "sustain" votes need a 2/3 majority over 0.5 s to change the chord.
7. **Noise:** an adaptive noise floor that only rises on noise-like frames (spectral flatness),
   on long attack-free drones (hum, fans), or while the gate is closed. Gate hysteresis and a
   warm-up phase that learns the room's minimum level.

### Restricted vs unrestricted mode

- **Restricted (song) mode** is the default. Only the chords of the current song, in the current
  key, are considered. This is the most accurate setting for practice.
- **Unrestricted mode**: tick «حالت آزاد — همهٔ آکوردهای ماژور و مینور» in the detector panel.
  The song filter is removed and all **24 major and minor chords** compete. The panel shows the
  **top 4 candidates side by side** with confidence bars, so you can watch detection move between
  chords as you play or sing.
  - Confidence is the match score scaled by a *tonal stability* factor. Held notes and chords
    stay near 100 %; speech, whose pitch glides constantly, drops sharply.
  - If the best candidate is below **0.3** (30 %) the panel shows **unknown** instead of guessing.
  - Ranking stays live even without a fresh strum, so a sustained or sung note keeps moving the display.
- The toggle is saved in `localStorage` (`gp:settings` → `unrestricted`) and survives a reload.

## Chord-synced scroll (practice mode)

Press **🎤 تشخیص آکورد** (or `L`). The microphone starts, the timer scroll stops, and the sheet
waits for you:

1. The chord you must play next is **highlighted and pulses** (orange badge with ▼), and the
   practice bar shows it together with the following chord. Chords inside the tolerance window
   are dotted-underlined.
2. When you play that chord, the app moves to the next chord. When the next chord is on a new
   line, the page scrolls so that line sits on the centre line. **A wrong chord does nothing: the
   page waits.**
3. Two paths can advance:
   - *Strict evaluator (SongFollower):* compares every strum directly against the expected chord.
     How strict it is comes from «دقت تطابق» (strict / normal / loose).
   - *Tolerance window:* when the detector's displayed chord **changes** to a chord found
     anywhere from the expected chord through the chords of the **next chord line**, the
     progress jumps there. A slightly early change or a missed strum doesn't break sync.
   A chord that keeps ringing never counts twice, and a chord already sounding when practice
   starts is ignored.
4. **Unrestricted mode:** a change into the window still jumps there. Any *other* new confident
   chord (not "unknown") moves one chord forward, so the sheet follows a player who improvises or
   uses chords outside the sheet.
5. `←` / `→` or the practice-bar buttons step back or forward by hand. ↺ restarts from the first chord.

## Project structure

```
index.html            markup (Persian UI)
css/style.css         themes, layout, responsive rules
js/music-theory.js    note names, chord parsing, transposition, key spelling
js/song-parser.js     ChordPro / chords-over-lyrics → line model + word layout
js/chord-shapes.js    fingerings (open shapes + movable E/A barre shapes) and SVG diagrams
js/chord-detector.js  DSP + recognition + stability voting (pure, testable)
js/audio-engine.js    AudioContext, look-ahead metronome, tap tempo, mic/file listener
js/app.js             UI controller (rendering, auto-scroll, highlight, panels, dialog)
songs/library.js      the song library — one entry per song
tests/*.test.js       unit + synthetic-audio tests (node --test, zero dependencies)
tests/browser-e2e.js  optional Chromium end-to-end check (needs Playwright)
tests/helpers/        Karplus-Strong synth, AnalyserNode emulator, WAV writer
```

All scripts are classic `<script>` files sharing a `window.GP` namespace (each also exports
via `module.exports` for Node). ES modules would break when opening `index.html` from disk
(`file://` blocks module loading in Chrome).

## Tests

```bash
node --test                  # Node 18+; ~3 s; no npm install
node tests/browser-e2e.js    # optional; needs Playwright + Chromium installed
```

## Design decisions and credits

This app merges ideas from several open-source projects, rewritten in plain JavaScript.

| Source | What was borrowed |
| --- | --- |
| [eddietsai6-code/guitar-chord-trainer](https://github.com/eddietsai6-code/guitar-chord-trainer) (MIT) | Separate pure `chord-core`-style module with tests; raw mic constraints (no AEC/NS/AGC); energy-rise strum onset with refractory period; short post-onset analysis window; candidate ranking with a winner-margin test; restricting recognition to a chosen chord set (here: the song's chords); movable E/A-shape fallback so every chord gets a diagram. |
| [SeanSnaider/Guitar-Scale-Tool](https://github.com/SeanSnaider/Guitar-Scale-Tool) (no license file — ideas re-implemented, no code copied) | FFT chroma with cosine/dot-product template matching (no ML); triangular kernel splitting a bin between neighbouring semitones; `getFloatFrequencyData` in dB with a per-bin floor; loudness-weighted frame aggregation; in-band level from Blackman-window power; the 1.2–1.5 kHz ceiling rationale; look-ahead (“Tale of Two Clocks”) metronome with accent and cancellable pending clicks. |
| [epiccoleman/react-circle-of-fifths](https://github.com/epiccoleman/react-circle-of-fifths) (MIT) | Circle-of-fifths key data → sharp/flat spelling of transposed keys and chords. The repo is a UI widget with no audio code, so the “onset detection + stability voting” idea was implemented here from scratch. |
| [Raj-Jai/GuitarScope](https://github.com/Raj-Jai/GuitarScope) (MIT) | YIN pitch detection and iterative harmonic subtraction with a guitar-like harmonic profile (used for bass detection and chroma cleaning). |
| [pirate/soundview](https://github.com/pirate/soundview) (MIT/ISC) | Spectral-flux onsets with an adaptive threshold; Pearson (mean-centred) matching; asymmetric attack/release chroma smoothing; 3rd-harmonic leakage compensation (available as an option). |

Notes on the requested sources that could not be found:

- **Fretscope** and **earchords**: no public repositories with these names could be located
  (fretscope.com is an unrelated fretboard trainer). I used the closest public equivalents
  above: GuitarScope for live mic/YIN/multi-pitch, and soundview for onsets/stability.
  Fretscope's described "file upload" and "YouTube" features are covered by «فایل صوتی» (analyse
  any audio file while it plays) and the optional per-song `youtubeId`.
- **basic-pitch (Spotify) was deliberately not vendored.** Running it in the browser needs
  TensorFlow.js plus model weights (several MB). It works on ~2 s windows, which is too slow for
  live feedback while strumming, and it outputs notes, not chords. Its pipeline's useful idea
  (notes → pitch classes with a bass/root bonus) is reproduced by the harmonic-subtraction +
  YIN bass stage, and keeps the app dependency-free.

Other decisions:

- Song bodies use ChordPro (an open, widely used format), and chords-over-lyrics text is
  auto-converted, so songs pasted from the web need little or no editing.
- Chord names render with zero width, so they never stretch a lyric. The parser pads a chunk
  only when two chords would collide; inside a word the gap shows a dash. Each word is an
  unbreakable group, so wrapping never separates a chord from its word.
- The highlighted line is the one nearest the centre of the visible reading area (below the
  toolbar, above the docked detector on phones). A top spacer lets even the first line reach the centre.
- Haunted's existing lyrics and its Am–C–Em–D progression were kept as they were. Chord
  positions were placed on the words where each change falls, since the original sheet had
  chords on separate lines with misaligned columns. Tempo 82 BPM (half-time of ~164) and key
  Em also come from the original page. The original page also had JavaScript syntax errors
  that stopped it from running; it is fully replaced.
- The second library entry (*Amazing Grace*, public domain) shows the chords-over-lyrics format.

## Known limitations

- Chord-synced scroll reacts to chord *changes*. Two identical chords in a row (e.g. `Am … Am`)
  count as one change, and the page catches up at the next different chord. Strumming the same
  chord for several lines without a change does not scroll.
- Chord-synced scroll needs a working microphone and accurate detection. In noisy rooms, use
  restricted mode (fewer chords to confuse) or the timer scroll.

- Chord detection is tuned for strummed acoustic/clean guitar. Heavy distortion, a full band in
  the background, or very quiet fingerpicking reduce accuracy. Song mode helps a lot.
- Close variants (C vs Cmaj7, A vs Asus2) and inversions are hard; in open mode the detector
  prefers simple triads unless the extra note is clear.
- Mobile browsers may suspend audio when the screen locks. Keep-awake (Wake Lock) is requested
  while scrolling or listening, but not every browser grants it.
- Some phones force audio processing that the browser cannot switch off, which can reduce accuracy.
- Mic access needs HTTPS or localhost (Safari also blocks `file://`), as described above.
- Songs added in the app live only in that browser's `localStorage` until exported to `library.js`.
