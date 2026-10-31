/*
 * app.js — UI controller.
 * Renders the selected song, runs auto-scroll + centre-line highlighting,
 * transposition, zoom, theme, metronome and the live chord detector panel.
 */
(function () {
  'use strict';

  const GP = window.GP;
  const MT = GP.MusicTheory;
  const SP = GP.SongParser;
  const CS = GP.ChordShapes;
  const CD = GP.ChordDetector;
  const AE = GP.Audio;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"');
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ----------------------------------------------------------- settings

  const SETTINGS_KEY = 'gp:settings';
  const USER_SONGS_KEY = 'gp:userSongs';

  function readJSON(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || 'null');
      return v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  const settings = Object.assign(
    { theme: null, zoom: 1, songId: null, songs: {}, songOnly: true, sensitivity: 55 },
    readJSON(SETTINGS_KEY, {})
  );
  let saveTimer = 0;
  function flushSettings() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* private mode */ }
  }
  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSettings, 150);
  }
  // Never lose the last change when the page is closed or reloaded quickly.
  window.addEventListener('pagehide', () => { if (saveTimer) flushSettings(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && saveTimer) flushSettings(); });
  function songPrefs(id) {
    if (!settings.songs[id]) settings.songs[id] = {};
    return settings.songs[id];
  }

  let userSongs = readJSON(USER_SONGS_KEY, []);
  if (!Array.isArray(userSongs)) userSongs = [];

  function allSongs() {
    const lib = Array.isArray(window.SONG_LIBRARY) ? window.SONG_LIBRARY : [];
    return lib.concat(userSongs.map((s) => Object.assign({ user: true }, s)));
  }

  // -------------------------------------------------------------- state

  const state = {
    song: null,
    parsed: null,
    transpose: 0,
    preferFlats: false,
    chords: [],           // display (transposed) chord names, in order
    lineEls: [],
    lineCenters: [],
    lineChords: [],       // display chords per rendered line
    activeIdx: -1,
    focusY: 0,
    detected: null,
    progressIdx: 0,          // next expected chord index in the full sequence
    playedSet: new Set(),    // chords already successfully played in this session
  };

  const el = {
    appbar: $('appbar'), toolbar: $('toolbar'), songSelect: $('songSelect'),
    playBtn: $('playBtn'), restartBtn: $('restartBtn'), speed: $('speed'), speedOut: $('speedOut'),
    transDown: $('transDown'), transUp: $('transUp'), keyOut: $('keyOut'),
    zoomInBtn: $('zoomInBtn'), zoomOutBtn: $('zoomOutBtn'), zoomOut: $('zoomOut'),
    metroBtn: $('metroBtn'), bpm: $('bpm'), bpmDown: $('bpmDown'), bpmUp: $('bpmUp'), tapBtn: $('tapBtn'), beats: $('beats'),
    micBtn: $('micBtn'), themeBtn: $('themeBtn'), fsBtn: $('fsBtn'), moreBtn: $('moreBtn'), addSongBtn: $('addSongBtn'),
    title: $('songTitle'), meta: $('songMeta'), strip: $('chordStrip'), sheet: $('sheet'), topSpacer: $('topSpacer'),
    focusLine: $('focusLine'), detector: $('detector'), pop: $('chordPop'), toast: $('toast'),
  };

  // -------------------------------------------------------------- toast

  let toastTimer = 0;
  function toast(msg, ms) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms || 2600);
  }

  // -------------------------------------------------------------- theme

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    el.themeBtn.textContent = theme === 'dark' ? '☀️' : '🌙';
  }
  function toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    settings.theme = cur === 'dark' ? 'light' : 'dark';
    applyTheme(settings.theme);
    saveSettings();
  }

  // ------------------------------------------------------- song loading

  function populateSongSelect() {
    const songs = allSongs();
    el.songSelect.innerHTML = songs
      .map((s) => `<option value="${esc(s.id)}">${esc(s.title)}${s.artist ? ' — ' + esc(s.artist) : ''}${s.user ? ' ✎' : ''}</option>`)
      .join('');
    if (state.song) el.songSelect.value = state.song.id;
  }

  function findSong(id) {
    const songs = allSongs();
    return songs.find((s) => s.id === id) || songs[0] || null;
  }

  function songIdFromHash() {
    const m = /(?:^|[#&])song=([^&]+)/.exec(location.hash);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function loadSong(id, opts) {
    const song = findSong(id);
    if (!song) {
      el.sheet.innerHTML = '<p>هیچ آهنگی در کتابخانه نیست. songs/library.js را ببین.</p>';
      return;
    }
    scroller.stop();
    state.progressIdx = 0;
    state.playedSet.clear();
    state.song = song;
    state.parsed = SP.parseSong(song.body);
    const prefs = songPrefs(song.id);
    state.transpose = prefs.transpose || 0;
    settings.songId = song.id;
    el.songSelect.value = song.id;
    const speed = prefs.speed !== undefined ? prefs.speed : (song.scrollSpeed !== undefined ? song.scrollSpeed : 40);
    el.speed.value = speed;
    updateSpeedOut();
    const bpm = prefs.bpm || song.bpm || 90;
    setBpm(bpm, false);
    const beats = parseInt(String(song.timeSignature || '4/4').split('/')[0], 10) || 4;
    metronome.setBeatsPerBar(beats);
    renderBeatDots(beats);
    if (!opts || !opts.keepHash) {
      try { history.replaceState(null, '', '#song=' + encodeURIComponent(song.id)); } catch (e) { /* file:// in some browsers */ }
    }
    document.title = song.title + ' — تمرین گیتار';
    saveSettings();
    render();
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------- rendering

  function currentKey() {
    if (!state.song.key) return null;
    return MT.transposeKey(state.song.key, state.transpose);
  }

  function computeSpelling() {
    const key = currentKey();
    if (key) return MT.keyPrefersFlats(key);
    // No key given: keep the song's own habit (any flat chord -> flats).
    return state.parsed.chords.some((c) => /^[A-G]b/.test(c)) && state.transpose === 0;
  }

  function display(chord) {
    return state.transpose ? MT.transposeChord(chord, state.transpose, state.preferFlats) : chord;
  }

  function render() {
    const song = state.song;
    hidePop();
    state.preferFlats = computeSpelling();
    state.chords = state.parsed.chords.map(display);

    // Title + meta
    el.title.innerHTML = esc(song.title) + (song.artist ? ' <small>— ' + esc(song.artist) + '</small>' : '');
    const key = currentKey();
    const chips = [];
    if (song.key) {
      chips.push(`<span class="chip">کلید: <b dir="ltr">${esc(key)}</b>${state.transpose ? ` <span dir="ltr">(${state.transpose > 0 ? '+' : ''}${state.transpose})</span>` : ''}</span>`);
    }
    if (song.bpm) chips.push(`<span class="chip">تمپو: <b>${esc(song.bpm)}</b></span>`);
    if (song.timeSignature) chips.push(`<span class="chip">میزان: <b>${esc(song.timeSignature)}</b></span>`);
    if (song.capo) chips.push(`<span class="chip">کاپو: <b>${esc(song.capo)}</b></span>`);
    if (state.transpose && song.key) {
      const capo = MT.mod12(state.transpose);
      if (capo > 0 && capo <= 7) chips.push(`<span class="chip note">یا کاپو ${capo} با شکل‌های اصلی</span>`);
    }
    if (song.notes) chips.push(`<span class="chip note" dir="auto">${esc(song.notes)}</span>`);
    if (song.youtubeId) chips.push('<button type="button" class="yt-btn" id="ytBtn">▶ YouTube</button>');
    el.meta.innerHTML = chips.join('');
    const yt = $('ytBtn');
    if (yt) {
      yt.addEventListener('click', () => {
        if (document.querySelector('.yt-frame')) return;
        const f = document.createElement('iframe');
        f.className = 'yt-frame';
        f.src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(song.youtubeId);
        f.allow = 'autoplay; encrypted-media; picture-in-picture';
        f.allowFullscreen = true;
        f.title = 'YouTube';
        el.meta.after(f);
        measureSoon();
      });
    }

    // Key + transpose UI
    el.keyOut.textContent = key || (state.transpose ? (state.transpose > 0 ? '+' : '') + state.transpose : '0');
    el.keyOut.title = state.transpose ? 'بازگشت به کلید اصلی (' + (song.key || '') + ')' : 'کلید اصلی';

    renderStrip();
    renderSheet();
    updateVocabulary();
    measure(); // synchronous: line positions must be fresh before scrolling
    measureSoon(); // and again after styles/fonts settle
  }

  function renderStrip() {
    const custom = state.transpose === 0 ? state.song.shapes : null;
    el.strip.innerHTML = state.chords.map((name) => {
      const shape = CS.getShape(name, custom);
      const c = MT.parseChord(name);
      return `<button type="button" class="diagram" data-c="${esc(name)}" title="${esc(name)}">` +
        CS.diagramSVG(name, shape, { width: 78, height: 98, rootPc: c ? c.rootPc : null }) +
        `<span class="name">${esc(name)}</span></button>`;
    }).join('');
    el.strip.hidden = state.chords.length === 0;
  }

  function chunkHTML(c) {
    const chord = c.chord ? `<b data-c="${esc(c.chord)}">${esc(c.chord)}</b>` : '';
    let fill = '';
    if (c.padCh > 0) fill = `<span class="fill" style="width:${c.padCh}ch">${c.midWord ? '-' : ''}</span>`;
    return `<span class="ck"><span class="cd">${chord}</span><span class="ly">${esc(c.text)}${fill}</span></span>`;
  }

  function renderSheet() {
    const song = state.song;
    const dir = song.dir || (song.lang === 'fa' || song.lang === 'ar' ? 'rtl' : 'ltr');
    el.sheet.setAttribute('dir', dir);
    el.sheet.setAttribute('lang', song.lang || 'en');
    const out = [];
    state.lineChords = [];
    state.parsed.items.forEach((item) => {
      if (item.type === 'section') {
        out.push(`<div class="section-label" dir="auto">${esc(item.label)}</div>`);
        return;
      }
      if (item.type === 'blank') {
        out.push('<div class="blank"></div>');
        return;
      }
      const line = {
        text: item.text,
        chordsOnly: item.chordsOnly,
        anchors: item.anchors.map((a) => ({ pos: a.pos, chord: display(a.chord) })),
      };
      state.lineChords.push(line.anchors.map((a) => a.chord));
      if (!item.hasChords) {
        out.push(`<div class="line lyrics-only"><span class="ly">${esc(item.text)}</span></div>`);
        return;
      }
      const groups = SP.layoutLine(line);
      let html = '';
      if (line.chordsOnly) {
        html = groups.map((g) => g.chunks.map((c) => (c.chord
          ? `<span class="ck"><span class="cd"><b data-c="${esc(c.chord)}">${esc(c.chord)}</b>${c.text ? `<span class="annot">${esc(c.text)}</span>` : ''}</span></span>`
          : `<span class="ck"><span class="cd"><span class="annot">${esc(c.text)}</span></span></span>`)).join('')).join('<wbr>');
        out.push(`<div class="line chords-only">${html}</div>`);
      } else {
        html = groups.map((g) => `<span class="wg">${g.chunks.map(chunkHTML).join('')}</span>`).join('<wbr>');
        out.push(`<div class="line">${html}</div>`);
      }
    });
    el.sheet.innerHTML = out.join('');
    state.lineEls = Array.from(el.sheet.querySelectorAll('.line'));
    state.activeIdx = -1;
    resetChordProgress();
  }

  function resetChordProgress() {
    state.progressIdx = 0;
    state.playedSet.clear();
    const chordEls = Array.from(el.sheet.querySelectorAll('b[data-c]'));
    chordEls.forEach((b, i) => {
      b.classList.remove('done', 'current-chord', 'just-hit', 'match', 'hit');
      if (i === 0 && (listener.active || scroller.playing)) {
        b.classList.add('current-chord');
      }
    });
    updateStripCurrent();
  }

  function updateCurrentChordHighlight() {
    const chordEls = Array.from(el.sheet.querySelectorAll('b[data-c]'));
    chordEls.forEach((b, i) => {
      b.classList.toggle('current-chord', i === state.progressIdx);
    });
    updateStripCurrent();
  }

  function updateStripCurrent() {
    const chordEls = Array.from(el.sheet.querySelectorAll('b[data-c]'));
    const expected = chordEls[state.progressIdx] ? chordEls[state.progressIdx].dataset.c : null;
    el.strip.querySelectorAll('.diagram').forEach((d) => {
      d.classList.toggle('current-chord', !!expected && MT.sameChord(d.dataset.c, expected));
    });
  }

  // ------------------------------------------- layout + centre highlight

  let measureRaf = 0;
  function measureSoon() {
    cancelAnimationFrame(measureRaf);
    measureRaf = requestAnimationFrame(measure);
  }

  function readingArea() {
    const top = el.appbar.getBoundingClientRect().bottom;
    let bottom = window.innerHeight;
    if (!el.detector.hidden && window.innerWidth <= 760) bottom = el.detector.getBoundingClientRect().top;
    return { top, bottom: Math.max(top + 120, bottom) };
  }

  function measure() {
    document.documentElement.style.setProperty('--appbar-h', el.appbar.offsetHeight + 'px');
    const area = readingArea();
    state.focusY = area.top + (area.bottom - area.top) / 2;
    el.focusLine.style.top = state.focusY + 'px';
    if (!state.lineEls.length) return;
    // Top spacer: lets the first line reach the focus height, so the
    // highlighted line is always the one in the middle of the screen.
    const spacerNow = el.topSpacer.offsetHeight;
    const first = state.lineEls[0];
    const firstCenter = first.getBoundingClientRect().top + window.scrollY + first.offsetHeight / 2 - spacerNow;
    const need = Math.max(0, Math.round(state.focusY - firstCenter));
    if (need !== spacerNow) el.topSpacer.style.height = need + 'px';
    const sy = window.scrollY;
    state.lineCenters = state.lineEls.map((l) => {
      const r = l.getBoundingClientRect();
      return r.top + sy + r.height / 2;
    });
    updateActive(true);
  }

  function nearestLine(docY) {
    const c = state.lineCenters;
    if (!c.length) return -1;
    let lo = 0;
    let hi = c.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (c[mid] < docY) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(c[lo - 1] - docY) < Math.abs(c[lo] - docY)) lo--;
    return lo;
  }

  function updateActive(force) {
    const idx = nearestLine(window.scrollY + state.focusY);
    if (idx === state.activeIdx && !force) return;
    if (state.activeIdx >= 0 && state.lineEls[state.activeIdx]) state.lineEls[state.activeIdx].classList.remove('active');
    state.activeIdx = idx;
    if (idx >= 0) state.lineEls[idx].classList.add('active');
    highlightMatches();
  }

  let scrollRaf = 0;
  window.addEventListener('scroll', () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updateActive(false); });
  }, { passive: true });
  window.addEventListener('resize', measureSoon);
  if (window.ResizeObserver) new ResizeObserver(measureSoon).observe(el.sheet);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measureSoon);

  // -------------------------------------------------------- auto-scroll

  // Slider 0..100 maps exponentially to 4..240 px/s, so the slow end has
  // fine control. 1.0x = 20 px/s (roughly one line every two seconds).
  const speedPx = (v) => 4 * Math.pow(60, v / 100);
  function updateSpeedOut() {
    const x = speedPx(+el.speed.value) / 20;
    el.speedOut.textContent = (x < 1 ? x.toFixed(2) : x.toFixed(1)) + '×';
  }

  const scroller = {
    playing: false,
    pos: 0,
    last: 0,
    lastSet: -1,
    raf: 0,
    start() {
      if (this.playing) return;
      if (this.atEnd()) window.scrollTo(0, 0);
      this.playing = true;
      this.pos = window.scrollY;
      this.lastSet = window.scrollY;
      this.last = performance.now();
      this.raf = requestAnimationFrame((t) => this.step(t));
      el.playBtn.querySelector('.ico').textContent = '⏸';
      el.playBtn.querySelector('.lbl').textContent = 'توقف';
      el.playBtn.setAttribute('aria-pressed', 'true');
      el.focusLine.classList.add('show');
      if (listener.active) {
        updateCurrentChordHighlight();
      }
      wakeLock.update();
    },
    stop() {
      if (!this.playing) return;
      this.playing = false;
      cancelAnimationFrame(this.raf);
      el.playBtn.querySelector('.ico').textContent = '▶';
      el.playBtn.querySelector('.lbl').textContent = 'اسکرول';
      el.playBtn.setAttribute('aria-pressed', 'false');
      if (!listener.active) el.focusLine.classList.remove('show');
      wakeLock.update();
    },
    toggle() { if (this.playing) this.stop(); else this.start(); },
    endY() {
      const c = state.lineCenters;
      const lastLine = c.length ? c[c.length - 1] - state.focusY + 24 : Infinity;
      return Math.min(lastLine, document.documentElement.scrollHeight - window.innerHeight);
    },
    atEnd() { return window.scrollY >= this.endY() - 2; },
    step(ts) {
      if (!this.playing) return;
      const dt = Math.min(100, Math.max(0, ts - this.last));
      this.last = ts;
      // The reader grabbed the page: continue from where they left it.
      if (Math.abs(window.scrollY - this.lastSet) > 3) this.pos = window.scrollY;

      // In chord-sync practice mode (when mic is listening), movement is driven by guitar chords
      if (listener.active) {
        this.lastSet = window.scrollY;
        this.raf = requestAnimationFrame((t) => this.step(t));
        return;
      }

      this.pos += (speedPx(+el.speed.value) * dt) / 1000;
      const end = this.endY();
      if (this.pos >= end) {
        window.scrollTo(0, end);
        this.stop();
        toast('پایان آهنگ 🎉');
        return;
      }
      window.scrollTo(0, this.pos);
      this.lastSet = window.scrollY;
      this.raf = requestAnimationFrame((t) => this.step(t));
    },
    restart() {
      window.scrollTo(0, 0);
      this.pos = 0;
      this.lastSet = window.scrollY;
      resetChordProgress();
      updateActive(true);
    },
  };

  // ------------------------------------------------------------ wake lock

  const wakeLock = {
    sentinel: null,
    async update() {
      const want = (scroller.playing || listener.active) && document.visibilityState === 'visible';
      try {
        if (want && !this.sentinel && navigator.wakeLock) {
          this.sentinel = await navigator.wakeLock.request('screen');
          this.sentinel.addEventListener('release', () => { this.sentinel = null; });
        } else if (!want && this.sentinel) {
          await this.sentinel.release();
          this.sentinel = null;
        }
      } catch (e) { /* not allowed (battery saver, iframe, etc.) */ }
    },
  };
  document.addEventListener('visibilitychange', () => wakeLock.update());

  // ------------------------------------------------- transpose and zoom

  function setTranspose(t) {
    let v = ((t % 12) + 12) % 12;
    if (v > 6) v -= 12; // keep within -5..+6
    state.transpose = v;
    songPrefs(state.song.id).transpose = v;
    saveSettings();
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  }

  function setZoom(z) {
    settings.zoom = Math.round(clamp(z, 0.6, 2.4) * 10) / 10;
    document.documentElement.style.setProperty('--zoom', settings.zoom);
    el.zoomOut.textContent = Math.round(settings.zoom * 100) + '%';
    saveSettings();
    measureSoon();
  }

  // ------------------------------------------------------------ metronome

  const metronome = new AE.Metronome();
  metronome.onBeat = (beatIdx, isAccent) => {
    const dots = Array.from(el.beats.children);
    dots.forEach((dot, idx) => {
      dot.classList.toggle('on', idx === beatIdx);
      dot.classList.toggle('accent', idx === beatIdx && isAccent);
    });
  };
  const tapper = new AE.TapTempo();

  function renderBeatDots(n) {
    el.beats.innerHTML = '<i></i>'.repeat(n);
  }

  function setBpm(v, persist) {
    const bpm = clamp(Math.round(Number(v) || 90), 20, 300);
    el.bpm.value = bpm;
    metronome.setBpm(bpm);
    if (persist !== false && state.song) {
      songPrefs(state.song.id).bpm = bpm;
      saveSettings();
    }
  }

  async function toggleMetronome() {
    if (metronome.running) {
      metronome.stop();
      el.metroBtn.classList.remove('on');
      Array.from(el.beats.children).forEach((d) => d.classList.remove('on', 'accent'));
    } else {
      try {
        await metronome.start();
        el.metroBtn.classList.add('on');
      } catch (e) {
        toast('مرورگر از Web Audio پشتیبانی نمی‌کند.');
      }
    }
  }

  // ------------------------------------------------------ chord detector

  const tracker = new CD.ChordTracker();
  const listener = new AE.ChordListener(tracker, onDetect);
  const NOTE_NAMES = MT.SHARP_NAMES;
  const chromaBars = [];
  (function buildChroma() {
    const box = $('chroma');
    box.innerHTML = NOTE_NAMES.map((n) => `<div><span class="bar"></span><small>${n}</small></div>`).join('');
    box.querySelectorAll('.bar').forEach((b) => chromaBars.push(b));
  })();

  const det = {
    chord: $('detChord'), status: $('detStatus'), dot: $('detDot'), conf: $('detConf'), sub: $('detSub'),
    alt: $('detAlt'), level: $('levelFill'), gate: $('levelGate'), history: $('detHistory'),
    songOnly: $('songOnly'), sens: $('sensitivity'), file: $('audioFile'), useMic: $('useMicBtn'),
    close: $('detClose'), min: $('detMin'),
  };
  let lastShown = null;
  let historyList = [];

  const STATUS_TEXT = {
    quiet: 'ساکت — یک آکورد بزن',
    listening: 'در حال گوش دادن…',
    analyzing: 'در حال تحلیل…',
    detected: 'تشخیص داده شد',
  };
  const ERROR_TEXT = {
    insecure: 'میکروفون فقط روی https یا localhost کار می‌کند. پوشه را با یک سرور محلی باز کن (راهنما در README).',
    unsupported: 'این مرورگر از میکروفون یا Web Audio پشتیبانی نمی‌کند.',
    denied: 'اجازهٔ میکروفون داده نشد. از آیکون قفل کنار نوار آدرس، میکروفون را «مجاز» کن و دوباره امتحان کن.',
    notfound: 'میکروفونی پیدا نشد. یک میکروفون وصل کن.',
    busy: 'میکروفون در اختیار برنامهٔ دیگری است. آن برنامه را ببند و دوباره امتحان کن.',
    unknown: 'باز کردن میکروفون ممکن نشد.',
    ended: 'اتصال میکروفون قطع شد.',
    'file-ended': 'پخش فایل تمام شد.',
  };

  function sensToGate(s) { return -30 - 0.45 * s; } // 0..100 -> -30..-75 dBFS

  function updateVocabulary() {
    if (!state.song) return;
    if (det.songOnly.checked && state.chords.length) tracker.setVocabulary(state.chords, null, state.preferFlats);
    else tracker.setVocabulary(null, state.chords, state.preferFlats);
  }

  function setDetStatus(text, live) {
    det.status.textContent = text;
    det.dot.classList.toggle('live', !!live);
  }

  function showDetector(show) {
    el.detector.hidden = !show;
    measureSoon();
  }

  async function startListening(kind, file) {
    showDetector(true);
    resetDetectorView();
    if (kind === 'mic') {
      const perm = await AE.micPermission();
      if (perm === 'denied') {
        setDetStatus('دسترسی رد شده', false);
        toast(ERROR_TEXT.denied, 6000);
        return;
      }
      setDetStatus('در انتظار اجازهٔ میکروفون…', false);
    } else {
      setDetStatus('در حال بارگذاری فایل…', false);
    }
    try {
      updateVocabulary();
      tracker.setSensitivity(sensToGate(+det.sens.value));
      if (kind === 'mic') await listener.startMic();
      else await listener.startFile(file);
      el.micBtn.classList.add('on');
      setDetStatus(kind === 'mic' ? 'در حال گوش دادن…' : 'در حال پخش و تحلیل فایل…', true);
    } catch (err) {
      const code = (err && err.code) || 'unknown';
      setDetStatus('خطا', false);
      toast(ERROR_TEXT[code] || ERROR_TEXT.unknown, 6500);
      el.micBtn.classList.remove('on');
      if (window.console) console.warn('[chord detector]', code, err);
    }
    wakeLock.update();
  }

  function stopListening(hide) {
    listener.stop();
    el.micBtn.classList.remove('on');
    setDetStatus('خاموش', false);
    state.detected = null;
    highlightMatches();
    if (hide) showDetector(false);
    wakeLock.update();
  }

  function resetDetectorView() {
    lastShown = null;
    historyList = [];
    det.chord.textContent = '—';
    det.chord.className = 'det-chord mono';
    det.history.innerHTML = '';
    det.alt.textContent = '';
    det.sub.textContent = '';
    det.conf.style.width = '0%';
  }

  let lastAdvanceTime = 0;
  let lastAdvancedChord = '';

  /** Advance one chord at a time using actual DOM order of chords in the sheet. */
  function advanceToDetectedChord(r) {
    const chordName = typeof r === 'string' ? r : (r && r.chord);
    if (!chordName) return;
    const chordEls = Array.from(el.sheet.querySelectorAll('b[data-c]'));
    if (!chordEls.length || state.progressIdx >= chordEls.length) return;

    const currentEl = chordEls[state.progressIdx];
    const expected = currentEl.dataset.c;
    let matched = MT.sameChord(expected, chordName);

    // Also check runner-up candidates if available
    if (!matched && r && r.candidates && r.candidates.length) {
      for (let i = 0; i < Math.min(3, r.candidates.length); i++) {
        if (r.candidates[i].score >= 0.70 && MT.sameChord(expected, r.candidates[i].name)) {
          matched = true;
          break;
        }
      }
    }

    // Look-ahead tolerance (skip at most 1 chord if the player moved ahead)
    let skip = 0;
    if (!matched && state.progressIdx + 1 < chordEls.length) {
      const nextExpected = chordEls[state.progressIdx + 1].dataset.c;
      if (MT.sameChord(nextExpected, chordName)) {
        matched = true;
        skip = 1;
      }
    }

    if (!matched) return; // wrong chord, wait

    // Anti-chatter: if re-strumming same chord name, require onset or debounce > 350ms
    const now = performance.now();
    const isSameChord = lastAdvancedChord && MT.sameChord(lastAdvancedChord, chordName);
    const hasOnset = r && r.onset;
    if (isSameChord && !hasOnset && (now - lastAdvanceTime < 350)) {
      return;
    }

    lastAdvanceTime = now;
    lastAdvancedChord = chordName;

    // Mark current chord done
    currentEl.classList.remove('current-chord');
    currentEl.classList.add('done', 'just-hit');
    setTimeout(() => currentEl.classList.remove('just-hit'), 400);

    if (skip > 0) {
      state.progressIdx += skip;
      const skippedEl = chordEls[state.progressIdx];
      skippedEl.classList.add('done', 'just-hit');
      setTimeout(() => skippedEl.classList.remove('just-hit'), 400);
    }

    state.progressIdx++;

    // Highlight the next chord
    updateCurrentChordHighlight();

    // Scroll to the line containing the next chord
    if (state.progressIdx < chordEls.length) {
      const nextEl = chordEls[state.progressIdx];
      const line = nextEl.closest('.line');
      if (line) {
        const idx = state.lineEls.indexOf(line);
        if (idx >= 0) {
          const targetY = state.lineCenters[idx] - state.focusY;
          window.scrollTo({ top: Math.max(0, targetY), behavior: "smooth" });
          line.classList.add("chord-hit");
          setTimeout(() => line.classList.remove("chord-hit"), 400);
        }
      }
    } else {
      toast("آهنگ تمام شد 🎉");
    }
  }

  function onDetect(r, err) {
    if (err) {
      el.micBtn.classList.remove('on');
      setDetStatus(err.code === 'file-ended' ? 'تمام شد' : 'قطع شد', false);
      toast(ERROR_TEXT[err.code] || ERROR_TEXT.unknown);
      wakeLock.update();
      return;
    }
    // Chord name
    const name = r.chord;
    if (name !== lastShown) {
      lastShown = name;
      det.chord.textContent = name || '—';
      det.chord.classList.remove('bump');
      void det.chord.offsetWidth; // restart the bump animation
      if (name) {
        det.chord.classList.add('bump');
        setTimeout(() => det.chord.classList.remove('bump'), 140);
        historyList.push(name);
        if (historyList.length > 10) historyList.shift();
      }
      state.detected = name;
      highlightMatches();
      renderHistory();
    }
    // Advance chord progression on chord match
    if (name) advanceToDetectedChord(r);
    det.chord.classList.toggle('stale', !r.active);
    det.conf.style.width = (name && r.active ? clamp(r.score, 0, 1) * 100 : 0) + '%';
    setDetStatus(STATUS_TEXT[r.status] || '', true);

    const parts = [];
    if (r.bass) parts.push('bass ' + MT.pcToName(r.bass.pc, state.preferFlats));
    if (r.tuningCents) parts.push('tune ' + (r.tuningCents > 0 ? '+' : '') + r.tuningCents + '¢');
    det.sub.textContent = parts.join(' · ');
    det.alt.textContent = r.candidates.slice(0, 3).map((c) => c.name + ' ' + Math.round(clamp(c.score, 0, 1) * 100) + '%').join(' · ');

    const tones = name ? (MT.parseChord(name) || { pcs: [] }).pcs : [];
    for (let i = 0; i < 12; i++) {
      chromaBars[i].style.transform = 'scaleY(' + Math.max(0.02, r.chroma[i]).toFixed(3) + ')';
      chromaBars[i].classList.toggle('tone', tones.includes(i));
    }
    const lvl = Number.isFinite(r.levelDb) ? r.levelDb : -100;
    const toPct = (db) => clamp(((db + 90) / 80) * 100, 0, 100);
    det.level.style.width = toPct(lvl) + '%';
    det.level.classList.toggle('open', r.gateOpen);
    det.gate.style.left = toPct(r.threshold) + '%';
  }

  function renderHistory() {
    const songSet = state.chords;
    det.history.innerHTML = historyList.map((n) => {
      const inSong = songSet.some((c) => MT.sameChord(c, n));
      return `<span class="${inSong ? 'match' : ''}">${esc(n)}</span>`;
    }).join('');
  }

  /** Marks chords in the active line and the strip that match the detected chord. */
  function highlightMatches() {
    const name = state.detected;
    el.sheet.querySelectorAll('b[data-c]').forEach((b) => {
      const isMatch = !!name && MT.sameChord(b.dataset.c, name);
      b.classList.toggle('match', isMatch);
      b.classList.toggle('hit', isMatch);
    });
    el.strip.querySelectorAll('.diagram').forEach((d) => {
      const isMatch = !!name && MT.sameChord(d.dataset.c, name);
      d.classList.toggle('match', isMatch);
      d.classList.toggle('hit', isMatch);
    });
  }

  // ----------------------------------------------------------- chord pop

  function hidePop() {
    el.pop.hidden = true;
  }
  function showPop(name, anchor) {
    const shape = CS.getShape(name, state.transpose === 0 ? state.song.shapes : null);
    const c = MT.parseChord(name);
    el.pop.innerHTML = CS.diagramSVG(name, shape, { width: 110, height: 140, rootPc: c ? c.rootPc : null }) +
      `<div class="pop-name">${esc(name)}</div>`;
    el.pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    const x = clamp(r.left + r.width / 2 - 60, 8, window.innerWidth - 128);
    const y = r.bottom + 6;
    el.pop.style.left = x + 'px';
    el.pop.style.top = y + 'px';
  }

  el.sheet.addEventListener('click', (ev) => {
    const b = ev.target.closest('b[data-c]');
    if (!b) return;
    showPop(b.dataset.c, b);

    // In chord-sync practice mode or when mic is active: jump progress to clicked chord!
    const chordEls = Array.from(el.sheet.querySelectorAll('b[data-c]'));
    const clickedIdx = chordEls.indexOf(b);
    if (clickedIdx >= 0) {
      state.progressIdx = clickedIdx;
      chordEls.forEach((el, i) => {
        el.classList.toggle('done', i < clickedIdx);
      });
      updateCurrentChordHighlight();
    }
  });
  el.strip.addEventListener('click', (ev) => {
    const d = ev.target.closest('.diagram');
    if (!d) return;
    showPop(d.dataset.c, d);
  });
  document.addEventListener('click', (ev) => {
    if (!el.pop.hidden && !el.pop.contains(ev.target) && !ev.target.closest('b[data-c], .diagram')) hidePop();
  });

  // ------------------------------------------------------------- controls

  el.playBtn.addEventListener('click', () => scroller.toggle());
  el.restartBtn.addEventListener('click', () => scroller.restart());
  el.speed.addEventListener('input', () => {
    updateSpeedOut();
    if (state.song) {
      songPrefs(state.song.id).speed = +el.speed.value;
      saveSettings();
    }
  });

  el.transDown.addEventListener('click', () => setTranspose(state.transpose - 1));
  el.transUp.addEventListener('click', () => setTranspose(state.transpose + 1));
  el.keyOut.addEventListener('click', () => setTranspose(0));

  el.zoomInBtn.addEventListener('click', () => setZoom(settings.zoom + 0.1));
  el.zoomOutBtn.addEventListener('click', () => setZoom(settings.zoom - 0.1));

  el.metroBtn.addEventListener('click', toggleMetronome);
  el.bpm.addEventListener('change', () => setBpm(el.bpm.value));
  el.bpmDown.addEventListener('click', () => setBpm(+el.bpm.value - 1));
  el.bpmUp.addEventListener('click', () => setBpm(+el.bpm.value + 1));
  el.tapBtn.addEventListener('click', () => {
    const bpm = tapper.tap();
    if (bpm) setBpm(bpm);
  });

  el.micBtn.addEventListener('click', () => {
    if (listener.active) {
      stopListening(true);
      if (!scroller.playing) el.focusLine.classList.remove('show');
    } else {
      // Start chord-sync practice mode
      resetChordProgress();
      el.focusLine.classList.add('show');
      startListening('mic').then(() => {
        toast('🎸 حالت همگام با گیتار: با نواختن آکوردها، صفحه جلو می‌رود');
        updateCurrentChordHighlight();
      });
    }
  });
  el.themeBtn.addEventListener('click', toggleTheme);
  el.fsBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
    else document.exitFullscreen();
  });
  el.moreBtn.addEventListener('click', () => {
    el.toolbar.classList.toggle('expanded');
  });

  // Song select
  el.songSelect.addEventListener('change', () => loadSong(el.songSelect.value));

  // Detector panel controls
  det.close.addEventListener('click', () => stopListening(true));
  det.min.addEventListener('click', () => {
    el.detector.classList.toggle('min');
    el.detector.classList.toggle('minimized');
  });
  det.songOnly.addEventListener('change', () => {
    settings.songOnly = det.songOnly.checked;
    saveSettings();
    updateVocabulary();
  });
  det.sens.addEventListener('input', () => {
    settings.sensitivity = +det.sens.value;
    saveSettings();
    tracker.setSensitivity(sensToGate(+det.sens.value));
  });
  det.file.addEventListener('change', () => {
    const f = det.file.files[0];
    if (f) startListening('file', f);
  });
  det.useMic.addEventListener('click', () => startListening('mic'));

  // ------------------------------------------------------------- add/edit song dialog

  const songDialog = $('songDialog');
  const songForm = $('songForm');
  const songSave = $('songSave');
  const songCopy = $('songCopy');
  const songDelete = $('songDelete');
  const songCancel = $('songCancel');

  function openSongDialog(songToEdit) {
    if (!songDialog) return;
    songForm.reset();
    if (songToEdit) {
      songForm.title.value = songToEdit.title || '';
      songForm.artist.value = songToEdit.artist || '';
      songForm.key.value = songToEdit.key || '';
      songForm.bpm.value = songToEdit.bpm || '';
      songForm.timeSignature.value = songToEdit.timeSignature || '';
      songForm.rtl.checked = songToEdit.lang === 'fa';
      songForm.body.value = songToEdit.body || '';
      songDelete.hidden = !songToEdit.user;
      songDialog._editingId = songToEdit.id;
    } else {
      songDelete.hidden = true;
      songDialog._editingId = null;
    }
    songDialog.showModal();
  }

  function saveSongFromDialog() {
    const title = songForm.title.value.trim();
    const body = songForm.body.value.trim();
    if (!title || !body) {
      toast('عنوان و متن آهنگ الزامی هستند.');
      return;
    }
    const artist = songForm.artist.value.trim();
    const key = songForm.key.value.trim();
    const bpm = Number(songForm.bpm.value) || undefined;
    const timeSignature = songForm.timeSignature.value.trim() || undefined;
    const isFa = songForm.rtl.checked || /[؀-ۿ]/.test(body);

    const existingIdx = songDialog._editingId ? userSongs.findIndex((s) => s.id === songDialog._editingId) : -1;
    const id = existingIdx >= 0 ? userSongs[existingIdx].id : 'user-' + Date.now();

    const song = {
      id,
      title,
      artist,
      key: key || undefined,
      bpm,
      timeSignature,
      lang: isFa ? 'fa' : 'en',
      body,
      user: true,
    };

    if (existingIdx >= 0) {
      userSongs[existingIdx] = song;
    } else {
      userSongs.push(song);
    }

    try {
      localStorage.setItem(USER_SONGS_KEY, JSON.stringify(userSongs));
    } catch (e) {
      toast('حافظه مرورگر پر است.');
      return;
    }

    populateSongSelect();
    loadSong(song.id);
    songDialog.close();
    toast('آهنگ ذخیره شد 🎉');
  }

  function copySongLibraryFormat() {
    const title = songForm.title.value.trim() || 'Untitled';
    const body = songForm.body.value;
    const artist = songForm.artist.value.trim();
    const key = songForm.key.value.trim();
    const bpm = Number(songForm.bpm.value) || 90;
    const timeSignature = songForm.timeSignature.value.trim() || '4/4';
    const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'song-' + Date.now();
    const obj = {
      id,
      title,
      artist: artist || undefined,
      key: key || undefined,
      bpm: bpm || undefined,
      timeSignature: timeSignature !== '4/4' ? timeSignature : undefined,
      body,
    };
    const code = '  ' + JSON.stringify(obj, null, 2).replace(/\n/g, '\n  ') + ',';
    navigator.clipboard.writeText(code).then(() => {
      toast('کد در کلیپ‌بورد کپی شد');
    }).catch(() => {
      toast('امکان کپی خودکار وجود نداشت');
    });
  }

  function deleteCurrentSong() {
    if (!songDialog._editingId) return;
    userSongs = userSongs.filter((s) => s.id !== songDialog._editingId);
    try { localStorage.setItem(USER_SONGS_KEY, JSON.stringify(userSongs)); } catch (e) {}
    populateSongSelect();
    loadSong(allSongs()[0]?.id);
    songDialog.close();
    toast('آهنگ حذف شد');
  }

  if (songSave) songSave.addEventListener('click', saveSongFromDialog);
  if (songCopy) songCopy.addEventListener('click', copySongLibraryFormat);
  if (songDelete) songDelete.addEventListener('click', deleteCurrentSong);
  if (songCancel) songCancel.addEventListener('click', () => songDialog.close());
  el.addSongBtn.addEventListener('click', () => openSongDialog(null));

  // ------------------------------------------------------------- init

  function init() {
    // Theme
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(settings.theme || (prefersDark ? 'dark' : 'light'));
    // Zoom
    setZoom(settings.zoom || 1);
    // Detector defaults
    det.songOnly.checked = settings.songOnly !== false;
    det.sens.value = settings.sensitivity || 55;
    // Songs
    populateSongSelect();
    const fromHash = songIdFromHash();
    loadSong(fromHash || settings.songId || (allSongs()[0] && allSongs()[0].id), { keepHash: !!fromHash });
    // Keyboard
    document.addEventListener('keydown', (ev) => {
      if (ev.target.matches('input, textarea, select')) return;
      if (ev.key === ' ') { ev.preventDefault(); scroller.toggle(); }
      else if (ev.key === 'r' || ev.key === 'R') scroller.restart();
      else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        el.speed.value = Math.min(100, +el.speed.value + 5);
        el.speed.dispatchEvent(new Event('input'));
      }
      else if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        el.speed.value = Math.max(0, +el.speed.value - 5);
        el.speed.dispatchEvent(new Event('input'));
      }
      else if (ev.key === '[') setTranspose(state.transpose - 1);
      else if (ev.key === ']') setTranspose(state.transpose + 1);
      else if (ev.key === '0') setTranspose(0);
      else if (ev.key === '+' || ev.key === '=') setZoom(settings.zoom + 0.1);
      else if (ev.key === '-' || ev.key === '_') setZoom(settings.zoom - 0.1);
      else if (ev.key === 'm' || ev.key === 'M') toggleMetronome();
      else if (ev.key === 't' || ev.key === 'T') {
        const bpm = tapper.tap();
        if (bpm) setBpm(bpm);
      }
      else if (ev.key === 'l' || ev.key === 'L') el.micBtn.click();
      else if (ev.key === 'd' || ev.key === 'D') toggleTheme();
      else if (ev.key === 'f' || ev.key === 'F') el.fsBtn.click();
      else if (ev.key === 'Escape') {
        hidePop();
        if (songDialog && songDialog.open) songDialog.close();
      }
    });
    window.addEventListener('hashchange', () => {
      const id = songIdFromHash();
      if (id && (!state.song || state.song.id !== id)) loadSong(id, { keepHash: true });
    });
  }

  // Small debugging hook for the browser console.
  window.GP.app = { state, scroller, metronome, tracker, listener, loadSong, setTranspose, setZoom, measure };
})();
