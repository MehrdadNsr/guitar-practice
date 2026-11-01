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
  const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
    progressIdx: 0,          // next expected chord index in the full sequence
    playedSet: new Set(),    // chords already successfully played in this session
    practiceMode: false,
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
    practiceBar: $('practiceBar'), pTargetChord: $('pTargetChord'), pNextChord: $('pNextChord'),
    pCount: $('pCount'), pPrevBtn: $('pPrevBtn'), pNextBtn: $('pNextBtn'), pRestartBtn: $('pRestartBtn'),
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
    resetChordProgress(); // a new song starts at its first chord
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
    document.querySelectorAll('.yt-frame').forEach((f) => f.remove()); // video of the previous song
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
    // Re-rendering (e.g. transposing) keeps the practice position.
    const total = el.sheet.querySelectorAll('b[data-c]').length;
    state.progressIdx = Math.min(state.progressIdx, total);
    updateCurrentChordHighlight();
  }

  function resetChordProgress() {
    state.progressIdx = 0;
    lastFollowChord = null;
    lastVotedChord = undefined;
    state.playedSet.clear();
    const chordEls = Array.from(el.sheet.querySelectorAll('b[data-c]'));
    chordEls.forEach((b) => {
      b.classList.remove('done', 'current-chord', 'just-hit', 'match', 'hit');
    });
    if (typeof follower !== 'undefined' && follower) follower.reset();
    updateCurrentChordHighlight();
  }

  function updateCurrentChordHighlight() {
    const chordEls = Array.from(el.sheet.querySelectorAll('b[data-c]'));
    const total = chordEls.length;
    const win = state.practiceMode ? toleranceWindow(chordEls) : [];
    chordEls.forEach((b, i) => {
      b.classList.toggle('done', state.practiceMode && i < state.progressIdx);
      b.classList.toggle('current-chord', state.practiceMode && i === state.progressIdx);
      b.classList.toggle('window', i !== state.progressIdx && win.includes(i));
    });

    const current = chordEls[state.progressIdx];
    if (typeof follower !== 'undefined' && follower) {
      follower.setTarget(current ? current.dataset.c : null);
    }

    if (state.practiceMode && el.practiceBar) {
      el.practiceBar.hidden = false;
      const next = chordEls[state.progressIdx + 1];
      if (current) {
        el.pTargetChord.textContent = current.dataset.c;
        el.pNextChord.textContent = next ? `➔ بعدی: ${next.dataset.c}` : '➔ پایان آهنگ';
        el.pCount.textContent = `(${state.progressIdx + 1} از ${total})`;
      } else {
        el.pTargetChord.textContent = '🎉';
        el.pNextChord.textContent = 'پایان آهنگ';
        el.pCount.textContent = `(${total} از ${total})`;
      }
    } else if (el.practiceBar) {
      el.practiceBar.hidden = true;
    }

    updateStripCurrent();
  }

  function advanceChord(delta = 1) {
    const chordEls = Array.from(el.sheet.querySelectorAll('b[data-c]'));
    if (!chordEls.length) return;

    if (delta > 0 && state.progressIdx < chordEls.length) {
      const currentEl = chordEls[state.progressIdx];
      currentEl.classList.remove('current-chord');
      currentEl.classList.add('done', 'just-hit');
      setTimeout(() => currentEl.classList.remove('just-hit'), 400);
    }

    const prevIdx = state.progressIdx;
    state.progressIdx = Math.max(0, Math.min(chordEls.length, state.progressIdx + delta));

    if (state.progressIdx < chordEls.length) {
      const nextEl = chordEls[state.progressIdx];
      const nextLine = nextEl.closest('.line');
      if (nextLine) {
        const nextLineIdx = state.lineEls.indexOf(nextLine);
        // Only scroll if we moved to a different line!
        const prevEl = chordEls[prevIdx];
        const prevLine = prevEl ? prevEl.closest('.line') : null;
        if (nextLine !== prevLine && nextLineIdx >= 0) {
          const targetY = state.lineCenters[nextLineIdx] - state.focusY;
          window.scrollTo({ top: Math.max(0, targetY), behavior: "smooth" });
          nextLine.classList.add("chord-hit");
          setTimeout(() => nextLine.classList.remove("chord-hit"), 400);
        }
      }
    } else {
      toast("آهنگ تمام شد 🎉");
    }

    updateCurrentChordHighlight();
  }

  function updateStripCurrent() {
    const chordEls = Array.from(el.sheet.querySelectorAll('b[data-c]'));
    const expected = chordEls[state.progressIdx] ? chordEls[state.progressIdx].dataset.c : null;
    el.strip.querySelectorAll('.diagram').forEach((d) => {
      d.classList.toggle('current-chord', state.practiceMode && !!expected && MT.sameChord(d.dataset.c, expected));
    });
  }

  // ------------------------------------------- layout + centre highlight

  let measureRaf = 0;
  function measureSoon() {
    cancelAnimationFrame(measureRaf);
    measureRaf = requestAnimationFrame(measure);
  }

  function readingArea() {
    let top = el.appbar.getBoundingClientRect().bottom;
    if (el.practiceBar && !el.practiceBar.hidden) top = Math.max(top, el.practiceBar.getBoundingClientRect().bottom);
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
      if (state.practiceMode) setPracticeMode(false); // timer scroll replaces chord-following
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
      if (!state.practiceMode) el.focusLine.classList.remove('show');
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

      // In practice mode movement is driven by the played chords, not the clock.
      if (state.practiceMode) {
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
  const follower = new CD.SongFollower(tracker, { strictness: settings.strictness || 'strict' });
  const listener = new AE.ChordListener(tracker, onDetect);
  const recorder = new AE.AudioRecorder();
  let recordedBlob = null;
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
    dbgToggle: $('dbgToggleBtn'), dbgPanel: $('dbgPanel'), fsmBadge: $('dbgFsmBadge'), strumLed: $('dbgStrumLed'),
    targetVal: $('dbgTargetVal'), bestVal: $('dbgBestVal'), targetScoreNum: $('dbgTargetScoreNum'),
    threshNum: $('dbgThreshNum'), targetScoreFill: $('dbgTargetScoreFill'), targetThreshLine: $('dbgTargetThreshLine'),
    liveReason: $('dbgLiveReason'), recordBtn: $('dbgRecordBtn'), playRecordBtn: $('dbgPlayRecordBtn'),
    recordTimer: $('dbgRecordTimer'), testSeqBtn: $('dbgTestSeqBtn'), testRingingBtn: $('dbgTestRingingBtn'),
    clearLogBtn: $('dbgClearLogBtn'), logList: $('dbgLogList'),
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

  function isUnrestricted() { return Boolean(det.unrestricted && det.unrestricted.checked); }

  /**
   * Restricted (default): only the current song's chords, in the current key.
   * Unrestricted: all 24 major/minor triads, ranking kept live even without a
   * fresh strum, and weak results reported as unknown.
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
      const conf = typeof c.confidence === 'number' ? c.confidence : clamp(c.score, 0, 1);
      const pct = Math.round(conf * 100);
      const cls = 'cand' + (i === 0 && !r.unknown ? ' top' : '') + (conf < UNKNOWN_BELOW ? ' weak' : '');
      html += `<div class="${cls}"><b>${esc(c.name)}</b><div class="cbar"><i style="width:${pct}%"></i></div><small>${pct}%</small></div>`;
    }
    det.cands.innerHTML = html;
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
        return false;
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
      wakeLock.update();
      return true;
    } catch (err) {
      const code = (err && err.code) || 'unknown';
      setDetStatus('خطا', false);
      toast(ERROR_TEXT[code] || ERROR_TEXT.unknown, 6500);
      el.micBtn.classList.remove('on');
      if (window.console) console.warn('[chord detector]', code, err);
    }
    wakeLock.update();
    return false;
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
    if (det.cands) det.cands.innerHTML = '';
    det.alt.textContent = '';
    det.sub.textContent = '';
    det.conf.style.width = '0%';
  }

  let lastStrumFlashTimeout = null;

  function updateDebugView(r, fRes, target) {
    if (!det.dbgPanel || det.dbgPanel.hidden) return;

    const strictness = (follower && follower.opts && follower.opts.strictness) || 'strict';
    const cfg = (CD.FOLLOWER_CONFIGS && CD.FOLLOWER_CONFIGS[strictness]) || { minScore: 0.60 };
    const targetScore = fRes ? fRes.targetScore : 0;
    const bestChord = fRes ? fRes.bestChord : (r ? r.chord : null);
    const bestScore = fRes ? fRes.bestScore : (r ? r.score : 0);
    const stateName = fRes ? fRes.state : 'IDLE';

    // FSM State badge
    if (det.fsmBadge) {
      det.fsmBadge.textContent = stateName;
      det.fsmBadge.className = 'dbg-fsm-badge ' + (
        stateName === 'WAITING_FOR_STRUM' ? 'state-waiting' :
        stateName === 'EVALUATING' ? 'state-evaluating' :
        stateName === 'ACCEPTED' ? 'state-accepted' :
        stateName === 'LOCKOUT' ? 'state-lockout' : ''
      );
    }

    // Strum LED flash
    if (det.strumLed && ((fRes && fRes.isOnset) || (r && r.onset))) {
      det.strumLed.classList.add('active');
      clearTimeout(lastStrumFlashTimeout);
      lastStrumFlashTimeout = setTimeout(() => {
        if (det.strumLed) det.strumLed.classList.remove('active');
      }, 250);
    }

    // Target vs Heard
    if (det.targetVal) det.targetVal.textContent = target || '—';
    if (det.bestVal) det.bestVal.textContent = bestChord ? `${bestChord} (${Math.round(bestScore * 100)}٪)` : '—';

    // Confidence meter & threshold mark
    const threshPct = Math.round(cfg.minScore * 100);
    const scorePct = Math.round(clamp(targetScore, 0, 1) * 100);
    if (det.targetScoreNum) det.targetScoreNum.textContent = scorePct + '٪';
    if (det.threshNum) det.threshNum.textContent = threshPct + '٪';
    if (det.targetScoreFill) det.targetScoreFill.style.width = scorePct + '%';
    if (det.targetThreshLine) det.targetThreshLine.style.left = threshPct + '%';

    // Live reason text
    if (det.liveReason && fRes && fRes.reason) {
      det.liveReason.textContent = fRes.reason;
    }

    // Render decision log
    renderDebugLog();
  }

  function renderDebugLog() {
    if (!det.logList) return;
    if (!follower || !follower.log || !follower.log.length) {
      det.logList.innerHTML = '<span class="dbg-log-item">هنوز رویدادی ثبت نشده است</span>';
      return;
    }
    det.logList.innerHTML = follower.log.slice(0, 15).map((d) => {
      const cls = d.action === 'advance' ? 'advance' : (d.action === 'reject' ? 'reject' : 'lockout');
      const timeStr = new Date(d.t).toLocaleTimeString('fa-IR', { minute: '2-digit', second: '2-digit' });
      return `<div class="dbg-log-item ${cls}">[${timeStr}] ${esc(d.reason)}</div>`;
    }).join('');
  }

  /*
   * Tolerance on top of the strict step evaluator: when the detector settles
   * on a NEW chord that is not the expected one but appears among the chords
   * of the expected line and the next chord line, the player is a little
   * ahead (or a change was missed) — jump there. In unrestricted mode any
   * other new confident chord moves one chord forward. Anything else: wait.
   */
  let lastFollowChord = null;
  // Last chord the detector displayed; tolerance only reacts when it changes.
  // `undefined` = just reset: record the current reading without acting, so
  // a chord already ringing when practice starts is not taken as a move.
  let lastVotedChord;

  function toleranceWindow(chordEls) {
    const out = [];
    const first = chordEls[state.progressIdx];
    if (!first) return out;
    const lines = [first.closest('.line')];
    // Includes the expected chord itself: a confident change to it advances
    // even if the strict evaluator missed that strum.
    for (let i = state.progressIdx; i < chordEls.length && out.length < 12; i++) {
      const ln = chordEls[i].closest('.line');
      if (!lines.includes(ln)) {
        if (lines.length >= 2) break;
        lines.push(ln);
      }
      out.push(i);
    }
    return out;
  }

  function followByChordChange(r, chordEls, currentTarget) {
    const free = isUnrestricted();
    const name = r.chord && r.active && !(free && r.unknown) ? r.chord : null;
    const fresh = lastVotedChord !== undefined && name !== lastVotedChord;
    lastVotedChord = name;
    if (!fresh || !name || (lastFollowChord && MT.sameChord(name, lastFollowChord))) return;
    lastFollowChord = name;
    const hit = toleranceWindow(chordEls).find((i) => MT.sameChord(chordEls[i].dataset.c, name));
    if (hit !== undefined) advanceChord(hit - state.progressIdx + 1);
    else if (free) advanceChord(1);
    else return;
    const t = chordEls[state.progressIdx];
    follower.setTarget(t ? t.dataset.c : null);
  }

  /** Advance one chord at a time using actual DOM order of chords in the sheet. */
  function advanceToDetectedChord(r) {
    if (!state.practiceMode) return;
    const chordEls = Array.from(el.sheet.querySelectorAll('b[data-c]'));
    if (!chordEls.length || state.progressIdx >= chordEls.length) return;

    const currentTarget = chordEls[state.progressIdx].dataset.c;
    follower.setTarget(currentTarget);
    const followerRes = follower.process(r);

    if (followerRes && followerRes.action === 'advance') {
      advanceChord(1); // the strict evaluator confirmed the expected chord
      lastFollowChord = currentTarget; // a ringing chord never counts twice
      const nextTarget = chordEls[state.progressIdx] ? chordEls[state.progressIdx].dataset.c : null;
      follower.setTarget(nextTarget);
    } else {
      followByChordChange(r, chordEls, currentTarget);
    }

    updateDebugView(r, followerRes, currentTarget);
  }

  function onDetect(r, err) {
    if (err) {
      el.micBtn.classList.remove('on');
      setDetStatus(err.code === 'file-ended' ? 'تمام شد' : 'قطع شد', false);
      toast(ERROR_TEXT[err.code] || ERROR_TEXT.unknown);
      wakeLock.update();
      return;
    }

    // Advance chord progression on strict strum match
    advanceToDetectedChord(r);

    // General display chord ("unknown" in unrestricted mode when nothing is convincing)
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
    const topConf = free && r.candidates[0] && typeof r.candidates[0].confidence === 'number' ? r.candidates[0].confidence : clamp(r.score, 0, 1);
    det.conf.style.width = (name && r.active ? topConf * 100 : 0) + '%';
    if (free) renderCandidates(r);
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
    const line = state.lineEls[state.activeIdx];
    el.sheet.querySelectorAll('b[data-c]').forEach((b) => {
      const isMatch = !!name && !!line && line.contains(b) && MT.sameChord(b.dataset.c, name);
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

    // In practice mode, clicking a chord moves the practice position there.
    if (!state.practiceMode) return;
    const chordEls = Array.from(el.sheet.querySelectorAll('b[data-c]'));
    const clickedIdx = chordEls.indexOf(b);
    if (clickedIdx >= 0) {
      state.progressIdx = clickedIdx;
      lastFollowChord = null;
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
  window.addEventListener('scroll', () => { if (!el.pop.hidden) hidePop(); }, { passive: true });

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

  /**
   * Practice (chord-synced) mode. `withMic: false` is used by the debug test
   * buttons, which feed an audio file instead of the microphone.
   */
  function setPracticeMode(active, opts) {
    const withMic = !opts || opts.withMic !== false;
    if (active === state.practiceMode && !(active && withMic && !listener.active)) return;
    state.practiceMode = active;
    if (active) {
      if (scroller.playing) scroller.stop();
      el.focusLine.classList.add('show');
      if (el.practiceBar) el.practiceBar.hidden = false;
      resetChordProgress();
      measureSoon();
      if (!withMic) return;
      startListening('mic').then((ok) => {
        // On failure startListening already showed the reason; keep practice
        // mode for manual stepping and say so after the error has been read.
        if (ok) toast('🎸 حالت تشخیص آکورد: با نواختن آکوردها یکی‌یکی جلو می‌رود');
        else setTimeout(() => toast('بدون میکروفون هم می‌توانی تمرین کنی: Space یا ▶ آکورد بعدی، ◀ قبلی.', 4000), 6600);
      });
    } else {
      stopListening(true);
      if (el.practiceBar) el.practiceBar.hidden = true;
      el.focusLine.classList.toggle('show', scroller.playing);
      updateCurrentChordHighlight();
      measureSoon();
    }
  }

  el.micBtn.addEventListener('click', () => {
    setPracticeMode(!state.practiceMode);
  });

  if (el.pPrevBtn) el.pPrevBtn.addEventListener('click', () => advanceChord(-1));
  if (el.pNextBtn) el.pNextBtn.addEventListener('click', () => advanceChord(1));
  if (el.pRestartBtn) el.pRestartBtn.addEventListener('click', () => {
    resetChordProgress();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  el.themeBtn.addEventListener('click', toggleTheme);
  // Fullscreen API is missing on iPhone Safari: hide the button there.
  el.fsBtn.hidden = !document.documentElement.requestFullscreen;
  el.fsBtn.addEventListener('click', () => {
    if (!document.documentElement.requestFullscreen) return;
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
    else document.exitFullscreen().catch(() => {});
  });
  el.moreBtn.addEventListener('click', () => {
    const open = el.toolbar.classList.toggle('expanded');
    el.moreBtn.setAttribute('aria-expanded', String(open));
    measureSoon();
  });

  // Song select (blur so Space goes back to the shortcuts)
  el.songSelect.addEventListener('change', () => {
    loadSong(el.songSelect.value);
    el.songSelect.blur();
  });

  // Detector panel controls: closing the panel also leaves practice mode.
  det.close.addEventListener('click', () => {
    if (state.practiceMode) setPracticeMode(false);
    else stopListening(true);
  });
  det.min.addEventListener('click', () => {
    el.detector.classList.toggle('min');
    el.detector.classList.toggle('minimized');
  });
  det.unrestricted.addEventListener('change', () => {
    settings.unrestricted = det.unrestricted.checked;
    saveSettings();
    updateVocabulary();
    det.cands.innerHTML = '';
    lastShown = undefined;
  });
  det.sens.addEventListener('input', () => {
    settings.sensitivity = +det.sens.value;
    saveSettings();
    tracker.setSensitivity(sensToGate(+det.sens.value));
  });
  det.file.addEventListener('change', () => {
    const f = det.file.files[0];
    if (f) startListening('file', f);
    det.file.value = ''; // allow choosing the same file again
  });
  const fileLabel = det.file.closest('label');
  if (fileLabel) fileLabel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); det.file.click(); }
  });
  det.useMic.addEventListener('click', () => startListening('mic'));

  // Debug panel toggle and controls
  if (det.dbgToggle) {
    det.dbgToggle.addEventListener('click', () => {
      det.dbgPanel.hidden = !det.dbgPanel.hidden;
      det.dbgToggle.classList.toggle('active', !det.dbgPanel.hidden);
      el.detector.classList.toggle('debug-open', !det.dbgPanel.hidden);
      if (!det.dbgPanel.hidden) {
        renderDebugLog();
        const chordEls = Array.from(el.sheet.querySelectorAll('b[data-c]'));
        const currentTarget = chordEls[state.progressIdx] ? chordEls[state.progressIdx].dataset.c : null;
        updateDebugView(null, null, currentTarget);
      }
    });
  }

  if (det.clearLogBtn) {
    det.clearLogBtn.addEventListener('click', () => {
      follower.log = [];
      renderDebugLog();
    });
  }

  // Strictness radio listeners
  Array.from(document.querySelectorAll('input[name="strictness"]')).forEach((radio) => {
    radio.addEventListener('change', () => {
      if (radio.checked) {
        follower.setStrictness(radio.value);
        settings.strictness = radio.value;
        saveSettings();
        const cfg = CD.FOLLOWER_CONFIGS[radio.value];
        if (cfg) toast(`حالت تطابق: ${cfg.name}`);
        const chordEls = Array.from(el.sheet.querySelectorAll('b[data-c]'));
        const currentTarget = chordEls[state.progressIdx] ? chordEls[state.progressIdx].dataset.c : null;
        updateDebugView(null, null, currentTarget);
      }
    });
  });

  // Audio recording & playback controls
  if (det.recordBtn) {
    det.recordBtn.addEventListener('click', async () => {
      if (recorder.recording) {
        recorder.stopRecording();
        return;
      }
      det.recordBtn.textContent = '⏹ توقف ضبط';
      det.recordBtn.classList.add('danger');
      if (det.playRecordBtn) det.playRecordBtn.disabled = true;
      try {
        recordedBlob = await recorder.record(5000, (remaining) => {
          if (det.recordTimer) det.recordTimer.textContent = `${remaining}s`;
        });
        det.recordBtn.textContent = '🔴 ضبط ۵ ثانیه';
        det.recordBtn.classList.remove('danger');
        if (det.recordTimer) det.recordTimer.textContent = 'آماده';
        if (det.playRecordBtn) det.playRecordBtn.disabled = !recordedBlob;
        toast('صدای گیتار ضبط شد! دکمه «تست ضبط» را بزن.');
      } catch (e) {
        det.recordBtn.textContent = '🔴 ضبط ۵ ثانیه';
        det.recordBtn.classList.remove('danger');
        if (det.recordTimer) det.recordTimer.textContent = 'خطا در ضبط';
        toast('امکان ضبط صدا فراهم نشد: ' + ((e && e.message) || e));
      }
    });
  }

  if (det.playRecordBtn) {
    det.playRecordBtn.addEventListener('click', () => {
      if (recordedBlob) {
        setPracticeMode(true, { withMic: false });
        startListening('file', recordedBlob);
      }
    });
  }

  // Synthetic audio tests
  if (det.testSeqBtn) {
    det.testSeqBtn.addEventListener('click', () => {
      const testChords = ['Am', 'C', 'Em', 'D'];
      const wavBlob = AE.generateSyntheticProgression(testChords, { per: 1.6, lead: 0.3 });
      setPracticeMode(true, { withMic: false });
      resetChordProgress();
      startListening('file', wavBlob);
      toast('در حال اجرای تست توالی Am → C → Em → D');
    });
  }

  if (det.testRingingBtn) {
    det.testRingingBtn.addEventListener('click', () => {
      const chordEls = Array.from(el.sheet.querySelectorAll('b[data-c]'));
      const targetChord = chordEls[state.progressIdx] ? chordEls[state.progressIdx].dataset.c : 'Em';
      const wavBlob = AE.generateRingingChord(targetChord, 3.2);
      setPracticeMode(true, { withMic: false });
      startListening('file', wavBlob);
      toast(`در حال پخش آکورد کشیده ${targetChord}`);
    });
  }

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
    const heading = songDialog.querySelector('h2');
    if (heading) heading.textContent = songToEdit ? 'ویرایش آهنگ' : 'افزودن آهنگ';
    const newBtn = $('songNew');
    if (newBtn) newBtn.hidden = !songToEdit;
    if (!songDialog.open) songDialog.showModal();
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
    const fallback = () => {
      songForm.body.value = code;
      songForm.body.select();
      toast('کپی خودکار ممکن نشد؛ متن انتخاب شد، با Ctrl+C کپی کن.');
    };
    if (!navigator.clipboard || !navigator.clipboard.writeText) { fallback(); return; }
    navigator.clipboard.writeText(code).then(() => {
      toast('کد در کلیپ‌بورد کپی شد');
    }).catch(fallback);
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
  el.addSongBtn.addEventListener('click', () => openSongDialog(state.song && state.song.user ? state.song : null));
  const songNewBtn = $('songNew');
  if (songNewBtn) songNewBtn.addEventListener('click', () => openSongDialog(null));

  // ------------------------------------------------------------- init

  function init() {
    // Theme
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(settings.theme || (prefersDark ? 'dark' : 'light'));
    // Zoom
    setZoom(settings.zoom || 1);
    // Detector defaults
    det.unrestricted.checked = settings.unrestricted === true;
    updateVocabulary();
    det.sens.value = typeof settings.sensitivity === 'number' ? settings.sensitivity : 55;
    const initialStrictness = settings.strictness || 'strict';
    follower.setStrictness(initialStrictness);
    const radio = document.querySelector(`input[name="strictness"][value="${initialStrictness}"]`);
    if (radio) radio.checked = true;
    // Songs
    populateSongSelect();
    const fromHash = songIdFromHash();
    loadSong(fromHash || settings.songId || (allSongs()[0] && allSongs()[0].id), { keepHash: !!fromHash });
    // Keyboard. Physical keys (ev.code), so shortcuts also work with a
    // Persian layout; browser shortcuts (Ctrl/Cmd/Alt + key) are left alone.
    document.addEventListener('keydown', (ev) => {
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const t = ev.target || {};
      const tag = t.tagName;
      if ((tag === 'INPUT' && t.type !== 'range') || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return;
      if (songDialog && songDialog.open) return;
      // A keyboard-focused button keeps its own Space/Enter action.
      if ((tag === 'BUTTON' || tag === 'SUMMARY') && (ev.code === 'Space' || ev.code === 'Enter')) return;
      switch (ev.code) {
        case 'Space':
          ev.preventDefault();
          if (state.practiceMode) advanceChord(1);
          else scroller.toggle();
          break;
        case 'ArrowRight':
          if (state.practiceMode) { ev.preventDefault(); advanceChord(1); }
          break;
        case 'ArrowLeft':
          if (state.practiceMode) { ev.preventDefault(); advanceChord(-1); }
          break;
        case 'ArrowUp':
        case 'ArrowDown':
          // Only while the timer scroll runs; otherwise arrows scroll the page.
          if (scroller.playing) {
            ev.preventDefault();
            const d = ev.code === 'ArrowUp' ? 5 : -5;
            el.speed.value = clamp(+el.speed.value + d, 0, 100);
            el.speed.dispatchEvent(new Event('input'));
          }
          break;
        case 'KeyR':
          if (state.practiceMode) {
            resetChordProgress();
            window.scrollTo({ top: 0, behavior: 'smooth' });
          } else {
            scroller.restart();
          }
          break;
        case 'BracketLeft': setTranspose(state.transpose - 1); break;
        case 'BracketRight': setTranspose(state.transpose + 1); break;
        case 'Digit0': case 'Numpad0': setTranspose(0); break;
        case 'Equal': case 'NumpadAdd': setZoom(settings.zoom + 0.1); break;
        case 'Minus': case 'NumpadSubtract': setZoom(settings.zoom - 0.1); break;
        case 'KeyM': toggleMetronome(); break;
        case 'KeyT': {
          const bpm = tapper.tap();
          if (bpm) setBpm(bpm);
          break;
        }
        case 'KeyL': el.micBtn.click(); break;
        case 'KeyD': toggleTheme(); break;
        case 'KeyF': el.fsBtn.click(); break;
        case 'Escape': hidePop(); break;
        default: break;
      }
    });
    // Mouse/touch clicks should not leave focus on a button, or the next
    // Space would press that button instead of the shortcut.
    document.addEventListener('pointerup', (ev) => {
      const b = ev.target.closest && ev.target.closest('button');
      if (b && !b.closest('dialog')) setTimeout(() => b.blur(), 0);
    });
    window.addEventListener('hashchange', () => {
      const id = songIdFromHash();
      if (id && (!state.song || state.song.id !== id)) loadSong(id, { keepHash: true });
    });
  }

  // Small debugging hook for the browser console.
  window.GP.app = { state, scroller, metronome, tracker, follower, listener, recorder, loadSong, setTranspose, setZoom, measure, advanceChord };

  init();
})();
