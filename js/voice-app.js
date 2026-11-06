/*
 * voice-app.js
 * UI controller for voice.html: opens the raw microphone, feeds 20 ms frames
 * to the VoiceTracker, draws the live pitch line and loudness bar, lists the
 * last sentences in plain Persian and posts each summary to Supabase.
 */
(function () {
  'use strict';

  const GP = window.GP;
  const VE = GP.VoiceEngine;
  const CFG = GP.Config || {};

  const HOP_MS = 20;
  const FFT_SIZE = 2048;
  const LOW_CUTOFF_HZ = 800;
  const CALIB_MS = 60000;
  const HISTORY_MS = 8000;      // pitch line window
  const MAX_ROWS = 5;
  const BASELINE_KEY = 'gp:voiceBaseline';
  const SETTINGS_KEY = 'gp:settings';

  const $ = (id) => document.getElementById(id);
  const el = {
    startBtn: $('voiceStartBtn'),
    status: $('voiceStatus'),
    configWarn: $('voiceConfigWarn'),
    hz: $('voiceHz'),
    db: $('voiceDb'),
    voiced: $('voiceVoiced'),
    speaking: $('voiceSpeaking'),
    canvas: $('voicePitchCanvas'),
    levelFill: $('voiceLevelFill'),
    levelGate: $('voiceLevelGate'),
    list: $('voiceList'),
    empty: $('voiceEmpty'),
    queue: $('voiceQueue'),
    calibBtn: $('voiceCalibBtn'),
    calibStatus: $('voiceCalibStatus'),
    calibFill: $('voiceCalibFill'),
    baselineInfo: $('voiceBaselineInfo'),
    themeBtn: $('themeBtn'),
    toast: $('toast'),
  };

  // ------------------------------------------------------------ helpers

  const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
  function fa(n, decimals) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    const s = decimals === undefined ? String(n) : Number(n).toFixed(decimals);
    return s.replace(/[0-9]/g, (d) => FA_DIGITS[d]).replace('.', '٫').replace('-', '−');
  }

  let toastTimer = null;
  function toast(msg, ms) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms || 2600);
  }

  function readSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch (e) { return {}; }
  }
  function writeSettings(s) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* private mode */ }
  }

  // -------------------------------------------------------------- theme

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    el.themeBtn.textContent = theme === 'dark' ? '☀️' : '🌙';
  }
  el.themeBtn.addEventListener('click', () => {
    const s = readSettings();
    const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    s.theme = cur === 'dark' ? 'light' : 'dark';
    writeSettings(s);
    applyTheme(s.theme);
  });
  applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');

  // ----------------------------------------------------------- baseline

  let baseline = null;
  try { baseline = JSON.parse(localStorage.getItem(BASELINE_KEY) || 'null'); } catch (e) { baseline = null; }

  function saveBaseline(b) {
    baseline = b;
    try { localStorage.setItem(BASELINE_KEY, JSON.stringify(b)); } catch (e) { /* ignore */ }
    renderBaselineInfo();
  }

  function renderBaselineInfo() {
    if (!baseline) {
      el.baselineInfo.textContent = 'هنوز صدای عادی ثبت نشده؛ توصیف‌ها با مقدارهای پیش‌فرض ساخته می‌شوند.';
      return;
    }
    el.baselineInfo.textContent = 'صدای عادی: زیر و بمی حدود ' + fa(baseline.pitch_median_hz, 0) + ' هرتز، بلندی '
      + fa(baseline.loudness_mean_dbfs, 0) + ' دسی‌بل، ' + fa(baseline.syllable_rate, 1) + ' هجا در ثانیه ('
      + new Date(baseline.started_at).toLocaleDateString('fa-IR') + ').';
  }

  // ------------------------------------------------ plain-Persian summary

  /** «۲.۳ ثانیه، زیر، آخرش رفت بالا، تند» */
  function describe(u) {
    const parts = [fa(u.duration_ms / 1000, 1) + ' ثانیه'];

    if (u.pitch_median_hz !== null) {
      const ref = baseline && baseline.pitch_median_hz ? baseline.pitch_median_hz : null;
      if (ref) {
        const st = 12 * Math.log2(u.pitch_median_hz / ref);
        parts.push(st > 2 ? 'زیرتر از عادی' : st < -2 ? 'بم‌تر از عادی' : 'زیر و بمی عادی');
      } else {
        parts.push(u.pitch_median_hz > 165 ? 'زیر' : u.pitch_median_hz < 120 ? 'بم' : 'میانه');
      }
      const span = u.pitch_p90_hz && u.pitch_p10_hz ? 12 * Math.log2(u.pitch_p90_hz / u.pitch_p10_hz) : 0;
      if (span > 7) parts.push('پر فراز و فرود');
      else if (span < 2) parts.push('یکنواخت');
    } else {
      parts.push('بی‌صدا/زمزمه');
    }

    parts.push(u.pitch_end_trend === 'rising' ? 'آخرش رفت بالا' : u.pitch_end_trend === 'falling' ? 'آخرش اومد پایین' : 'آخرش صاف');

    if (u.syllable_rate !== null) {
      const ref = baseline && baseline.syllable_rate ? baseline.syllable_rate : null;
      const r = u.syllable_rate;
      if (ref) parts.push(r > ref * 1.25 ? 'تند' : r < ref * 0.75 ? 'آروم' : 'سرعت عادی');
      else parts.push(r > 5 ? 'تند' : r < 3 ? 'آروم' : 'سرعت معمولی');
    }

    if (u.loudness_mean_dbfs !== null) {
      const ref = baseline && baseline.loudness_mean_dbfs !== null && baseline.loudness_mean_dbfs !== undefined ? baseline.loudness_mean_dbfs : null;
      if (ref !== null) {
        const d = u.loudness_mean_dbfs - ref;
        if (d > 4) parts.push('بلند');
        else if (d < -4) parts.push('آهسته');
      }
    }

    if (u.pause_before_ms !== null && u.pause_before_ms > 2000) parts.push('بعد از مکث ' + fa(u.pause_before_ms / 1000, 1) + ' ثانیه‌ای');
    return parts.join('، ');
  }

  // --------------------------------------------------------------- sender

  const SEND_LABEL = {
    waiting: 'در صف',
    sending: 'در حال ارسال…',
    sent: 'ارسال شد ✓',
    retry: 'خطا، دوباره تلاش می‌شود',
    noconfig: 'کلید تنظیم نشده',
  };

  const queue = [];           // [{ row, item, attempts }]
  let sendTimer = null;
  let sending = false;

  function configured() {
    return !!(CFG.SUPABASE_PUBLISHABLE_KEY && CFG.SUPABASE_PUBLISHABLE_KEY !== 'PASTE_HERE' && CFG.SUPABASE_URL);
  }

  function setSendStatus(item, state, detail) {
    item.state = state;
    if (!item.statusEl) return;
    item.statusEl.textContent = SEND_LABEL[state] + (detail ? ' (' + detail + ')' : '');
    item.statusEl.className = 'voice-send voice-send-' + state;
  }

  function renderQueue() {
    const n = queue.length;
    el.queue.textContent = n ? fa(n) + ' در صف' : '';
  }

  function enqueue(row, item) {
    queue.push({ row, item, attempts: 0 });
    setSendStatus(item, configured() ? 'waiting' : 'noconfig');
    renderQueue();
    scheduleSend(0);
  }

  function scheduleSend(delayMs) {
    if (sendTimer) return;
    sendTimer = setTimeout(() => { sendTimer = null; drain(); }, delayMs);
  }

  async function drain() {
    if (sending || !queue.length) return;
    if (!configured()) { renderQueue(); return; }
    sending = true;
    const job = queue[0];
    setSendStatus(job.item, 'sending');
    try {
      const res = await fetch(CFG.SUPABASE_URL + '/rest/v1/' + (CFG.SUPABASE_VOICE_TABLE || 'voice_live'), {
        method: 'POST',
        headers: {
          apikey: CFG.SUPABASE_PUBLISHABLE_KEY,
          Authorization: 'Bearer ' + CFG.SUPABASE_PUBLISHABLE_KEY,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(job.row),
      });
      if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try { const j = await res.json(); if (j && j.message) msg += ': ' + j.message; } catch (e) { /* no body */ }
        throw new Error(msg);
      }
      queue.shift();
      setSendStatus(job.item, 'sent');
      sending = false;
      renderQueue();
      if (queue.length) scheduleSend(50);
    } catch (err) {
      job.attempts++;
      sending = false;
      const wait = Math.min(30000, 1000 * Math.pow(2, Math.min(5, job.attempts)));
      setSendStatus(job.item, 'retry', String(err && err.message ? err.message : err).slice(0, 80));
      renderQueue();
      scheduleSend(wait);
    }
  }

  window.addEventListener('online', () => scheduleSend(0));

  // ------------------------------------------------------------ list UI

  const rows = [];

  function addRow(u) {
    const li = document.createElement('li');
    li.className = 'voice-row voice-row-' + u.kind;
    const text = document.createElement('div');
    text.className = 'voice-row-text';
    text.textContent = (u.kind === 'baseline' ? 'صدای عادی (۶۰ ثانیه): ' : '') + describe(u);
    const meta = document.createElement('div');
    meta.className = 'voice-row-meta mono';
    meta.dir = 'ltr';
    meta.textContent = [
      u.pitch_median_hz !== null ? Math.round(u.pitch_median_hz) + ' Hz' : 'unvoiced',
      u.pitch_end_trend,
      Math.round(u.loudness_mean_dbfs) + ' dBFS',
      (u.syllable_rate !== null ? u.syllable_rate.toFixed(1) : '–') + ' syl/s',
      new Date(u.started_at).toLocaleTimeString('fa-IR'),
    ].join(' · ');
    const status = document.createElement('div');
    status.className = 'voice-send';
    li.append(text, meta, status);
    el.list.prepend(li);
    el.empty.hidden = true;
    const item = { li, statusEl: status, state: 'waiting' };
    rows.unshift(item);
    while (rows.length > MAX_ROWS) {
      const old = rows.pop();
      old.li.remove();
      old.statusEl = null; // the queue job keeps retrying without a visible row
    }
    return item;
  }

  function onUtterance(u) {
    const item = addRow(u);
    enqueue(u, item);
  }

  // ----------------------------------------------------------- live view

  const ctx2d = el.canvas.getContext('2d');
  const history = [];   // [{ t, hz, voiced, dbfs }]
  const MIN_HZ = VE.DEFAULTS.minHz;
  const MAX_HZ = VE.DEFAULTS.maxHz;

  function hzToY(hz, h) {
    const f = Math.log(hz / MIN_HZ) / Math.log(MAX_HZ / MIN_HZ);
    return h - f * h;
  }

  function drawPitch(now) {
    const c = el.canvas;
    const dpr = window.devicePixelRatio || 1;
    const cssW = c.clientWidth || 800;
    const cssH = c.clientHeight || 200;
    if (c.width !== Math.round(cssW * dpr) || c.height !== Math.round(cssH * dpr)) {
      c.width = Math.round(cssW * dpr);
      c.height = Math.round(cssH * dpr);
    }
    const w = c.width;
    const h = c.height;
    const g = ctx2d;
    const styles = getComputedStyle(document.documentElement);
    g.clearRect(0, 0, w, h);
    g.direction = 'ltr';

    // Reference lines at 100, 150, 200, 300 Hz.
    g.strokeStyle = styles.getPropertyValue('--line').trim() || '#ddd';
    g.fillStyle = styles.getPropertyValue('--muted').trim() || '#888';
    g.lineWidth = 1;
    g.font = (11 * dpr) + 'px ' + (styles.getPropertyValue('--mono').trim() || 'monospace');
    g.textAlign = 'left';
    [100, 150, 200, 300].forEach((hz) => {
      const y = Math.round(hzToY(hz, h)) + 0.5;
      g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
      g.fillText(hz + ' Hz', 4 * dpr, y - 3 * dpr);
    });
    if (baseline && baseline.pitch_median_hz) {
      g.strokeStyle = styles.getPropertyValue('--accent-2').trim() || '#0f766e';
      g.setLineDash([4 * dpr, 4 * dpr]);
      const y = Math.round(hzToY(baseline.pitch_median_hz, h)) + 0.5;
      g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
      g.setLineDash([]);
    }

    // Raw per-frame pitch dots (no smoothing), joined when consecutive.
    const accent = styles.getPropertyValue('--accent').trim() || '#b45309';
    const t0 = now - HISTORY_MS;
    g.fillStyle = accent;
    g.strokeStyle = accent;
    g.lineWidth = 2 * dpr;
    let prev = null;
    for (const p of history) {
      if (p.t < t0) continue;
      const x = ((p.t - t0) / HISTORY_MS) * w;
      if (p.voiced && p.hz) {
        const y = hzToY(p.hz, h);
        if (prev && p.t - prev.t <= HOP_MS * 2.5) {
          g.beginPath(); g.moveTo(prev.x, prev.y); g.lineTo(x, y); g.stroke();
        } else {
          g.beginPath(); g.arc(x, y, 1.5 * dpr, 0, Math.PI * 2); g.fill();
        }
        prev = { x, y, t: p.t };
      } else {
        prev = null;
      }
    }
  }

  function renderLive(r) {
    el.hz.textContent = r.voiced && r.hz ? Math.round(r.hz) + ' Hz' : '—';
    el.voiced.textContent = r.voiced ? 'صدادار' : r.gateOpen ? 'بی‌صدا' : '';
    el.db.textContent = isFinite(r.dbfs) ? r.dbfs.toFixed(0) + ' dBFS' : '—';
    el.speaking.textContent = r.warmup ? 'در حال شناخت اتاق…' : r.speaking ? 'در حال جمله' : '';
    const pct = (db) => Math.max(0, Math.min(100, ((db + 80) / 80) * 100));
    el.levelFill.style.width = pct(r.dbfs) + '%';
    el.levelFill.classList.toggle('open', r.gateOpen);
    el.levelGate.style.left = pct(r.threshold) + '%';
  }

  // ------------------------------------------------------------ listener

  let audio = null;   // { ctx, stream, source, analyser, lp, lowAnalyser, time, lowTime, db, timer }
  let tracker = null;
  let running = false;
  let rafPending = false;

  function setStatus(msg) { el.status.textContent = msg; }

  const MIC_ERRORS = {
    insecure: 'میکروفون فقط روی HTTPS یا localhost کار می‌کند.',
    unsupported: 'این مرورگر از میکروفون پشتیبانی نمی‌کند.',
    denied: 'دسترسی به میکروفون رد شد. از تنظیمات مرورگر اجازه بده.',
    notfound: 'میکروفونی پیدا نشد.',
    busy: 'میکروفون در اختیار برنامهٔ دیگری است.',
    unknown: 'باز کردن میکروفون ممکن نشد.',
  };

  async function start() {
    if (running) return;
    setStatus('در حال باز کردن میکروفون…');
    try {
      const ctx = await GP.Audio.getContext();
      const stream = await GP.Audio.openRawMic();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = LOW_CUTOFF_HZ;
      lp.Q.value = 0.707;
      const lowAnalyser = ctx.createAnalyser();
      lowAnalyser.fftSize = FFT_SIZE;
      lowAnalyser.smoothingTimeConstant = 0;
      source.connect(analyser);
      source.connect(lp).connect(lowAnalyser);
      audio = {
        ctx, stream, source, analyser, lp, lowAnalyser,
        time: new Float32Array(FFT_SIZE),
        lowTime: new Float32Array(FFT_SIZE),
        db: new Float32Array(analyser.frequencyBinCount),
        timer: null,
      };
      stream.getAudioTracks().forEach((track) => {
        track.addEventListener('ended', () => { if (running) { stop(); toast('میکروفون قطع شد'); } });
      });
      tracker = new VoiceTracker();
      history.length = 0;
      audio.timer = setInterval(tick, HOP_MS);
      running = true;
      el.startBtn.classList.add('on');
      el.startBtn.setAttribute('aria-pressed', 'true');
      el.startBtn.querySelector('.lbl').textContent = 'توقف';
      setStatus('گوش می‌دهم. نیم ثانیه اول برای شناخت نویز اتاق است؛ بعدش حرف بزن.');
    } catch (err) {
      const code = err && err.code;
      setStatus(MIC_ERRORS[code] || MIC_ERRORS.unknown);
      toast(MIC_ERRORS[code] || MIC_ERRORS.unknown);
      cleanupAudio();
    }
  }

  function VoiceTracker() {
    return new VE.VoiceTracker({
      hopMs: HOP_MS,
      clockOffset: Date.now() - performance.now(),
    });
  }

  function cleanupAudio() {
    if (!audio) return;
    if (audio.timer) clearInterval(audio.timer);
    [audio.source, audio.analyser, audio.lp, audio.lowAnalyser].forEach((n) => { try { n.disconnect(); } catch (e) { /* */ } });
    if (audio.stream) audio.stream.getTracks().forEach((t) => t.stop());
    audio = null;
  }

  function stop() {
    if (!running) return;
    running = false;
    if (calib.active) finishCalibration(true);
    if (tracker) {
      const tail = tracker.flush();
      if (tail) onUtterance(tail);
    }
    cleanupAudio();
    el.startBtn.classList.remove('on');
    el.startBtn.setAttribute('aria-pressed', 'false');
    el.startBtn.querySelector('.lbl').textContent = 'شروع شنیدن';
    setStatus('متوقف شد.');
    el.speaking.textContent = '';
  }

  function tick() {
    if (!audio || !tracker) return;
    const a = audio;
    a.analyser.getFloatTimeDomainData(a.time);
    a.lowAnalyser.getFloatTimeDomainData(a.lowTime);
    a.analyser.getFloatFrequencyData(a.db);
    const t = performance.now();
    const r = tracker.process({
      time: a.time,
      lowTime: a.lowTime,
      db: a.db,
      fftSize: FFT_SIZE,
      sampleRate: a.ctx.sampleRate,
      t,
      wall: Date.now(),
    });
    history.push({ t, hz: r.hz, voiced: r.voiced, dbfs: r.dbfs });
    while (history.length && history[0].t < t - HISTORY_MS - 500) history.shift();
    if (r.utterance) onUtterance(r.utterance);
    if (calib.active) renderCalibration(t);
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        renderLive(r);
        drawPitch(performance.now());
      });
    }
  }

  el.startBtn.addEventListener('click', () => (running ? stop() : start()));

  // --------------------------------------------------------- calibration

  const calib = { active: false, startedAt: 0, timer: null };

  async function startCalibration() {
    if (calib.active) { finishCalibration(true); return; }
    if (!running) {
      await start();
      if (!running) return;
    }
    tracker.startBaseline();
    calib.active = true;
    calib.startedAt = performance.now();
    el.calibBtn.classList.add('on');
    el.calibBtn.querySelector('.lbl').textContent = 'توقف کالیبراسیون';
    calib.timer = setTimeout(() => finishCalibration(false), CALIB_MS);
    toast('۶۰ ثانیه با لحن عادی حرف بزن…');
  }

  function renderCalibration(now) {
    const done = Math.min(CALIB_MS, now - calib.startedAt);
    el.calibFill.style.width = (done / CALIB_MS) * 100 + '%';
    el.calibStatus.textContent = 'در حال ضبط صدای عادی… ' + fa(Math.ceil((CALIB_MS - done) / 1000)) + ' ثانیه مانده';
  }

  function finishCalibration(aborted) {
    if (!calib.active) return;
    calib.active = false;
    clearTimeout(calib.timer);
    const elapsed = performance.now() - calib.startedAt;
    const summary = tracker ? tracker.stopBaseline() : null;
    el.calibBtn.classList.remove('on');
    el.calibBtn.querySelector('.lbl').textContent = 'صدای عادی من';
    el.calibFill.style.width = '0%';
    if (aborted && elapsed < CALIB_MS * 0.5) {
      el.calibStatus.textContent = 'کالیبراسیون نیمه‌کاره ماند و ثبت نشد.';
      return;
    }
    if (!summary || summary.voiced_ratio < 0.05) {
      el.calibStatus.textContent = 'صدایی شنیده نشد؛ دوباره امتحان کن.';
      return;
    }
    saveBaseline(summary);
    el.calibStatus.textContent = 'صدای عادی ثبت شد.';
    onUtterance(summary);
  }

  el.calibBtn.addEventListener('click', startCalibration);

  // ---------------------------------------------------------------- init

  el.configWarn.hidden = configured();
  renderBaselineInfo();
  drawPitch(performance.now());
  window.addEventListener('resize', () => drawPitch(performance.now()));
  window.addEventListener('pagehide', () => { if (running) stop(); });
})();
