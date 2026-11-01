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
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
    { theme: null, zoom: 1, songId: null, songs: {}, unrestricted: false, sensitivity: 55 },
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
  };

  // Chord-synced scroll state (see js/chord-follower.js).
  const follower = new GP.ChordFollower.ChordFollower([]);
  const follow = { on: false, anim: 0 };

  const el = {
    appbar: $('appbar'), toolbar: $('toolbar'), songSelect: $('songSelect'),
    playBtn: $('playBtn'), restartBtn: $('restartBtn'), speed: $('speed'), speedOut: $('speedOut'),
    transDown: $('transDown'), transUp: $('transUp'), keyOut: $('keyOut'),
    zoomInBtn: $('zoomInBtn'), zoomOutBtn: $('zoomOutBtn'), zoomOut: $('zoomOut'),
    metroBtn: $('metroBtn'), bpm: $('bpm'), bpmDown: $('bpmDown'), bpmUp: $('bpmUp'), tapBtn: $('tapBtn'), beats: $('beats'),
    micBtn: $('micBtn'), followBtn: $('followBtn'), themeBtn: $('themeBtn'), fsBtn: $('fsBtn'), moreBtn: $('moreBtn'), addSongBtn: $('addSongBtn'),
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
    follower.next = 0; // a new song starts waiting for its first chord
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
    // Flat chord sequence in reading order, for chord-synced scrolling.
    state.events = [];
    state.lineEls.forEach((ln, i) => {
      ln.querySelectorAll('.cd b').forEach((b) => state.events.push({ line: i, chord: b.dataset.c, el: b }));
    });
    follower.setEvents(state.events);
    renderFollowMarks();
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
      if (follow.on) setFollow(false); // timer and chord-follow are exclusive
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
      wakeLock.update();
    },
    stop() {
      if (!this.playing) return;
      this.playing = false;
      cancelAnimationFrame(this.raf);
      el.playBtn.querySelector('.ico').textContent = '▶';
      el.playBtn.querySelector('.lbl').textContent = 'اسکرول';
      el.playBtn.setAttribute('aria-pressed', 'false');
      el.focusLine.classList.remove('show');
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
      if (follow.on) {
        follower.resetToLine(0);
        renderFollowMarks();
      }
      window.scrollTo(0, 0);
      this.pos = 0;
      this.lastSet = window.scrollY;
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

  metronome.onBeat = (beat, accent) => {
    const dots = el.beats.children;
    for (let i = 0; i < dots.length; i++) dots[i].classList.remove('on', 'accent');
    if (dots[beat]) {
      dots[beat].classList.add('on');
      if (accent) dots[beat].classList.add('accent');
    }
  };

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
    unrestricted: $('unrestricted'), cands: $('detCands'), sens: $('sensitivity'), file: $('audioFile'), useMic: $('useMicBtn'),
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

  // Unrestricted mode: below this confidence (0..1) the panel says "unknown"
  // instead of guessing (speech, noise, unrelated note clusters).
  const UNKNOWN_BELOW = 0.3;

  function isUnrestricted() { return det.unrestricted.checked; }

  /**
   * Restricted (default): only the current song's chords, in the current key.
   * Unrestricted: all 24 major/minor triads, ranking kept live even without
   * a fresh strum (so a sung or held note can move between chords), and weak
   * results reported as unknown.
   */
  function updateVocabulary() {
    if (!state.song) return;
    const free = isUnrestricted();
    el.detector.classList.toggle('unrestricted', free);
    if (free) {
      tracker.setVocabulary(CD.allTriadNames(state.preferFlats), null, state.preferFlats);
      tracker.setOptions({ sustainActiveMs: Infinity });
      tracker.setUnknownThreshold(UNKNOWN_BELOW);
    } else {
      if (state.chords.length) tracker.setVocabulary(state.chords, null, state.preferFlats);
      else tracker.setVocabulary(null, null, state.preferFlats);
      tracker.setOptions({ sustainActiveMs: CD.DEFAULTS.sustainActiveMs });
      tracker.setUnknownThreshold(null);
    }
  }

  function renderCandidates(r) {
    const list = r.gateOpen ? r.candidates.slice(0, 4) : [];
    let html = '';
    for (let i = 0; i < 4; i++) {
      const c = list[i];
      if (!c) { html += '<div class="cand weak"><b>·</b><div class="cbar"><i style="width:0"></i></div><small>&nbsp;</small></div>'; continue; }
      const pct = Math.round(c.confidence * 100);
      const cls = 'cand' + (i === 0 && !r.unknown ? ' top' : '') + (c.confidence < UNKNOWN_BELOW ? ' weak' : '');
      html += `<div class="${cls}"><b>${esc(c.name)}</b><div class="cbar"><i style="width:${pct}%"></i></div><small>${pct}%</small></div>`;
    }
    det.cands.innerHTML = html;
  }

  function setDetStatus(text, live) {
    det.status.textContent = text;
    det.dot.classList.toggle('live', Boolean(live));
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
    if (hide && follow.on) setFollow(false);
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

  function onDetect(r, err) {
    if (err) {
      el.micBtn.classList.remove('on');
      setDetStatus(err.code === 'file-ended' ? 'تمام شد' : 'قطع شد', false);
      toast(ERROR_TEXT[err.code] || ERROR_TEXT.unknown);
      wakeLock.update();
      return;
    }
    // Chord name ("unknown" in unrestricted mode when nothing is convincing)
    const free = isUnrestricted();
    const unknown = free && r.unknown;
    const name = unknown ? null : r.chord;
    const shownKey = unknown ? '?unknown' : name;
    det.chord.classList.toggle('unknown', unknown);
    if (shownKey !== lastShown) {
      lastShown = shownKey;
      det.chord.textContent = unknown ? 'unknown' : name || '—';
      det.chord.title = unknown ? 'نامشخص — صدا به هیچ آکوردی شبیه نیست' : '';
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
    det.chord.classList.toggle('stale', !r.active);
    const topConf = free && r.candidates[0] ? r.candidates[0].confidence : clamp(r.score, 0, 1);
    det.conf.style.width = (name && r.active ? topConf * 100 : 0) + '%';
    if (free) renderCandidates(r);
    const exp = follow.on ? follower.expected() : null;
    setDetStatus((STATUS_TEXT[r.status] || '') + (exp ? ' · منتظر ' + exp.chord : ''), true);
    if (follow.on && name && r.active) followDetected(name);

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
    el.sheet.querySelectorAll('.cd b.match').forEach((b) => b.classList.remove('match'));
    el.strip.querySelectorAll('.diagram.match').forEach((b) => b.classList.remove('match'));
    det.chord.classList.remove('match');
    const name = state.detected;
    if (!name) return;
    let inLine = false;
    const line = state.lineEls[state.activeIdx];
    if (line) {
      line.querySelectorAll('.cd b').forEach((b) => {
        if (MT.sameChord(b.dataset.c, name)) { b.classList.add('match'); inLine = true; }
      });
    }
    el.strip.querySelectorAll('.diagram').forEach((d) => {
      if (MT.sameChord(d.dataset.c, name)) d.classList.add('match');
    });
    det.chord.classList.toggle('match', inLine);
  }

  // ------------------------------------------------ chord-synced scrolling

  /**
   * Follow mode: the page moves only when the player changes to the chord
   * the sheet expects (or one within the next two chord lines). In
   * unrestricted mode any new confident chord moves one chord forward.
   */
  function setFollow(on) {
    follow.on = on;
    el.followBtn.classList.toggle('on', on);
    el.followBtn.setAttribute('aria-pressed', String(on));
    document.body.classList.toggle('following', on);
    if (on) {
      scroller.stop();
      follower.resetToLine(Math.max(0, state.activeIdx));
      // In free mode the chord already ringing is not a "change".
      if (isUnrestricted()) follower.lastChord = state.detected;
      if (!listener.active) startListening('mic');
      const exp = follower.expected();
      toast(exp ? 'اسکرول با آکورد روشن شد — آکورد ' + exp.chord + ' را بزن' : 'اسکرول با آکورد روشن شد');
    }
    renderFollowMarks();
    wakeLock.update();
  }

  function renderFollowMarks() {
    el.sheet.querySelectorAll('.cd b.expect, .cd b.window').forEach((b) => b.classList.remove('expect', 'window'));
    if (!follow.on || !state.events) return;
    follower.window().forEach((i) => state.events[i].el.classList.add('window'));
    const exp = follower.expected();
    if (exp) exp.el.classList.add('expect');
  }

  function scrollToLine(lineIdx) {
    const c = state.lineCenters[lineIdx];
    if (c === undefined) return;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const from = window.scrollY;
    const to = clamp(c - state.focusY, 0, max);
    const t0 = performance.now();
    const dur = 450;
    cancelAnimationFrame(follow.anim);
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      window.scrollTo(0, from + (to - from) * e);
      if (p < 1) follow.anim = requestAnimationFrame(step);
    };
    follow.anim = requestAnimationFrame(step);
  }

  function followDetected(name) {
    const idx = follower.update(name, isUnrestricted());
    if (idx < 0) return;
    scrollToLine(state.events[idx].line);
    renderFollowMarks();
    if (follower.done) toast('پایان آهنگ 🎉');
  }

  el.followBtn.addEventListener('click', () => setFollow(!follow.on));

  // In follow mode, tapping a lyric line moves the "waiting" position there.
  el.sheet.addEventListener('click', (e) => {
    if (!follow.on || e.target.closest('.cd b')) return;
    const line = e.target.closest('.line');
    const i = line ? state.lineEls.indexOf(line) : -1;
    if (i < 0) return;
    follower.resetToLine(i);
    renderFollowMarks();
    scrollToLine(i);
  });

  // ------------------------------------------------------ chord popover

  function showChordPop(name, anchor) {
    const c = MT.parseChord(name);
    const custom = state.transpose === 0 ? state.song.shapes : null;
    const shape = CS.getShape(name, custom);
    const tones = c ? c.pcs.map((pc) => MT.pcToName(pc, state.preferFlats)).join(' ') : '';
    el.pop.innerHTML = `<div class="name">${esc(name)}</div>` +
      CS.diagramSVG(name, shape, { width: 120, height: 150, rootPc: c ? c.rootPc : null }) +
      `<div class="tones">${esc(tones)}</div>`;
    el.pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    const pw = el.pop.offsetWidth;
    const ph = el.pop.offsetHeight;
    let left = r.left + r.width / 2 - pw / 2;
    left = clamp(left, 8, window.innerWidth - pw - 8);
    let top = r.bottom + 8;
    if (top + ph > window.innerHeight - 8) top = r.top - ph - 8;
    el.pop.style.left = left + 'px';
    el.pop.style.top = Math.max(8, top) + 'px';
  }
  function hidePop() { el.pop.hidden = true; }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('.cd b, .diagram');
    if (b) {
      showChordPop(b.dataset.c, b);
      e.stopPropagation();
      return;
    }
    if (!e.target.closest('#chordPop')) hidePop();
  });
  window.addEventListener('scroll', () => { if (!el.pop.hidden && !scroller.playing) hidePop(); }, { passive: true });

  // ----------------------------------------------------- user songs dialog

  const dlg = $('songDialog');
  const form = $('songForm');
  // form.title would be the form's own title attribute, so go via .elements.
  const fld = (name) => form.elements.namedItem(name);

  function openSongDialog() {
    const editing = state.song && state.song.user ? state.song : null;
    form.reset();
    if (editing) {
      fld('title').value = editing.title || '';
      fld('artist').value = editing.artist || '';
      fld('key').value = editing.key || '';
      fld('bpm').value = editing.bpm || '';
      fld('timeSignature').value = editing.timeSignature || '';
      fld('rtl').checked = editing.dir === 'rtl';
      fld('body').value = (editing.body || '').trim();
    }
    $('songDelete').hidden = !editing;
    dlg.dataset.editing = editing ? editing.id : '';
    if (dlg.showModal) dlg.showModal();
    else dlg.setAttribute('open', '');
  }
  function closeSongDialog() {
    if (dlg.close) dlg.close();
    else dlg.removeAttribute('open');
  }

  function songFromForm() {
    const title = fld('title').value.trim();
    const body = fld('body').value.replace(/\s+$/, '');
    if (!title || !body.trim()) {
      toast('عنوان و متن آهنگ لازم است.');
      return null;
    }
    const base = title.toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, '-').replace(/^-+|-+$/g, '') || 'song';
    const song = {
      id: dlg.dataset.editing || 'user-' + base + '-' + Date.now().toString(36),
      title,
      artist: fld('artist').value.trim(),
      key: fld('key').value.trim(),
      bpm: Number(fld('bpm').value) || undefined,
      timeSignature: fld('timeSignature').value.trim() || '4/4',
      body: '\n' + body + '\n',
    };
    if (fld('rtl').checked) { song.dir = 'rtl'; song.lang = 'fa'; }
    if (song.key && !MT.parseChord(song.key)) delete song.key;
    return song;
  }

  $('songSave').addEventListener('click', () => {
    const song = songFromForm();
    if (!song) return;
    userSongs = userSongs.filter((s) => s.id !== song.id).concat([song]);
    try { localStorage.setItem(USER_SONGS_KEY, JSON.stringify(userSongs)); } catch (e) { toast('ذخیره ممکن نشد (حافظهٔ مرورگر).'); }
    closeSongDialog();
    populateSongSelect();
    loadSong(song.id);
    toast('آهنگ ذخیره شد.');
  });

  $('songCopy').addEventListener('click', async () => {
    const song = songFromForm();
    if (!song) return;
    const lib = Object.assign({}, song, { id: song.id.replace(/^user-/, '').replace(/-[a-z0-9]+$/, '') });
    const lines = ['  {'];
    Object.keys(lib).forEach((k) => {
      if (lib[k] === undefined || lib[k] === '' || k === 'body') return;
      lines.push(`    ${k}: ${JSON.stringify(lib[k])},`);
    });
    lines.push('    body: `' + lib.body.replace(/`/g, "'").replace(/\$\{/g, '$ {') + '`,');
    lines.push('  },');
    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast('ورودی کپی شد — در آرایهٔ songs/library.js بچسبان.');
    } catch (e) {
      fld('body').value = text;
      fld('body').select();
      toast('کپی خودکار ممکن نشد؛ متن انتخاب شد، با Ctrl+C کپی کن.');
    }
  });

  $('songDelete').addEventListener('click', () => {
    const id = dlg.dataset.editing;
    if (!id || !confirm('این آهنگ حذف شود؟')) return;
    userSongs = userSongs.filter((s) => s.id !== id);
    try { localStorage.setItem(USER_SONGS_KEY, JSON.stringify(userSongs)); } catch (e) { /* ignore */ }
    closeSongDialog();
    populateSongSelect();
    loadSong(allSongs()[0] && allSongs()[0].id);
  });
  $('songCancel').addEventListener('click', closeSongDialog);
  // Enter inside a field saves instead of silently closing the dialog.
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    $('songSave').click();
  });

  // ------------------------------------------------------------- wiring

  el.songSelect.addEventListener('change', () => {
    loadSong(el.songSelect.value);
    el.songSelect.blur();
  });
  window.addEventListener('hashchange', () => {
    const id = songIdFromHash();
    if (id && (!state.song || id !== state.song.id)) loadSong(id, { keepHash: true });
  });

  el.playBtn.addEventListener('click', () => scroller.toggle());
  el.restartBtn.addEventListener('click', () => scroller.restart());
  el.speed.addEventListener('input', () => {
    updateSpeedOut();
    songPrefs(state.song.id).speed = +el.speed.value;
    saveSettings();
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
    if (listener.active) stopListening(false);
    else startListening('mic');
  });
  det.useMic.addEventListener('click', () => startListening('mic'));
  det.file.addEventListener('change', () => {
    if (det.file.files && det.file.files[0]) startListening('file', det.file.files[0]);
    det.file.value = '';
  });
  det.file.parentElement.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); det.file.click(); }
  });
  det.close.addEventListener('click', () => stopListening(true));
  det.min.addEventListener('click', () => {
    el.detector.classList.toggle('min');
    det.min.textContent = el.detector.classList.contains('min') ? '▴' : '▾';
    measureSoon();
  });
  det.unrestricted.checked = settings.unrestricted === true;
  det.unrestricted.addEventListener('change', () => {
    settings.unrestricted = det.unrestricted.checked;
    saveSettings();
    updateVocabulary();
    det.cands.innerHTML = '';
    lastShown = undefined;
  });
  det.sens.value = settings.sensitivity;
  det.sens.addEventListener('input', () => {
    settings.sensitivity = +det.sens.value;
    tracker.setSensitivity(sensToGate(settings.sensitivity));
    saveSettings();
  });

  el.themeBtn.addEventListener('click', toggleTheme);
  el.addSongBtn.addEventListener('click', openSongDialog);

  const canFullscreen = Boolean(document.documentElement.requestFullscreen);
  el.fsBtn.hidden = !canFullscreen;
  function toggleFullscreen() {
    if (!canFullscreen) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  }
  el.fsBtn.addEventListener('click', toggleFullscreen);

  el.moreBtn.addEventListener('click', () => {
    const open = el.toolbar.classList.toggle('expanded');
    el.moreBtn.setAttribute('aria-expanded', String(open));
    measureSoon();
  });

  // Buttons clicked with a mouse/finger should not keep focus, otherwise the
  // next Space press would activate that button instead of the shortcut.
  document.addEventListener('pointerup', (e) => {
    const b = e.target.closest && e.target.closest('button');
    if (b) setTimeout(() => b.blur(), 0);
  });

  // Keyboard shortcuts use physical keys (e.code), so they also work with a
  // Persian keyboard layout.
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target || {};
    const tag = t.tagName;
    if ((tag === 'INPUT' && t.type !== 'range') || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return;
    // A keyboard-focused button/summary keeps its native Space/Enter action.
    if ((tag === 'BUTTON' || tag === 'SUMMARY') && (e.code === 'Space' || e.code === 'Enter')) return;
    if (dlg.open) return;
    switch (e.code) {
      case 'Space': e.preventDefault(); scroller.toggle(); break;
      case 'KeyR': scroller.restart(); break;
      case 'KeyG': el.followBtn.click(); break;
      case 'ArrowUp':
        if (scroller.playing) { e.preventDefault(); el.speed.value = Math.min(100, +el.speed.value + 3); el.speed.dispatchEvent(new Event('input')); }
        break;
      case 'ArrowDown':
        if (scroller.playing) { e.preventDefault(); el.speed.value = Math.max(0, +el.speed.value - 3); el.speed.dispatchEvent(new Event('input')); }
        break;
      case 'BracketLeft': setTranspose(state.transpose - 1); break;
      case 'BracketRight': setTranspose(state.transpose + 1); break;
      case 'Equal': case 'NumpadAdd': setZoom(settings.zoom + 0.1); break;
      case 'Minus': case 'NumpadSubtract': setZoom(settings.zoom - 0.1); break;
      case 'KeyM': toggleMetronome(); break;
      case 'KeyT': el.tapBtn.click(); break;
      case 'KeyL': el.micBtn.click(); break;
      case 'KeyD': toggleTheme(); break;
      case 'KeyF': toggleFullscreen(); break;
      case 'Escape': hidePop(); break;
      default: break;
    }
  });

  // --------------------------------------------------------------- boot

  applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
  setZoom(settings.zoom || 1);
  populateSongSelect();
  loadSong(songIdFromHash() || settings.songId || (allSongs()[0] && allSongs()[0].id), { keepHash: Boolean(songIdFromHash()) });

  // Small debugging hook for the browser console.
  window.GP.app = { state, follower, scroller, metronome, tracker, listener, loadSong, setTranspose, setZoom, measure };
})();
