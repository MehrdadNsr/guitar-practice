/*
 * Optional end-to-end check in a real (headless) Chromium.
 *
 *   node tests/browser-e2e.js
 *
 * Needs Playwright with Chromium available (`npm i -g playwright` or any
 * global install). The app itself has no dependencies; this script is only a
 * developer tool and is not picked up by `node --test`.
 *
 * It serves the repo with a tiny built-in static server, writes a synthetic
 * guitar recording (Am C Em D) to a temp WAV, feeds it to Chromium as a fake
 * microphone, and checks: console errors, pixel alignment of every chord over
 * its word (also when zoomed and wrapped on a phone-sized screen), auto-scroll
 * movement + centre highlight, transposition, and live chord detection.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('./helpers/audio-sim.js');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  console.error('Playwright is not installed; skipping browser e2e (the app itself needs nothing).');
  process.exit(0);
}

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function makeWav() {
  const sr = 48000;
  const seq = ['Am', 'C', 'Em', 'D', 'Am', 'C', 'Em', 'D'];
  const sig = S.renderProgression(sr, S.mulberry32(5), seq, { per: 2, lead: 1, pluckPos: 0.2, strumsPerChord: 2, amp: 0.3 });
  let mx = 0;
  for (let i = 0; i < sig.length; i++) mx = Math.max(mx, Math.abs(sig[i]));
  for (let i = 0; i < sig.length; i++) sig[i] = (sig[i] / mx) * 0.6;
  const file = path.join(os.tmpdir(), 'gp-progression.wav');
  fs.writeFileSync(file, S.writeWav(sig, sr));
  return file;
}

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures.push(name);
}

async function alignment(page) {
  return page.$$eval('.line:not(.chords-only) .ck', (cks) => {
    let n = 0;
    let bad = 0;
    cks.forEach((ck) => {
      const b = ck.querySelector('.cd b');
      const tn = ck.querySelector('.ly').firstChild;
      if (!b || !tn || !tn.textContent.length) return;
      const r = document.createRange();
      r.setStart(tn, 0);
      r.setEnd(tn, 1);
      const cr = r.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      n++;
      if (Math.abs(br.left + 1 - cr.left) > 0.5 || br.bottom > cr.top + 2) bad++;
    });
    return { n, bad };
  });
}

(async () => {
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/index.html`;
  const wav = makeWav();
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(url + '#song=haunted');
    await page.waitForTimeout(500);

    const a = await alignment(page);
    check('chords aligned over their words (desktop)', a.n > 20 && a.bad === 0, `${a.n} chords, ${a.bad} off`);

    await page.click('#playBtn');
    await page.waitForTimeout(1500);
    const sc = await page.evaluate(() => {
      const act = document.querySelector('.line.active').getBoundingClientRect();
      return { y: scrollY, d: Math.abs(act.top + act.height / 2 - GP.app.state.focusY), lineH: act.height };
    });
    await page.click('#playBtn');
    check('auto-scroll moves the page', sc.y > 10, `scrollY ${Math.round(sc.y)}`);
    check('highlighted line is at the screen centre', sc.d < sc.lineH, `${Math.round(sc.d)}px from centre`);

    await page.click('#transUp');
    const strip = await page.$$eval('.chord-strip .name', (n) => n.map((x) => x.textContent).join(' '));
    check('transpose +1 respells Em song in Fm', strip === 'Bbm Db Fm Eb', strip);
    await page.click('#keyOut');

    await page.click('#micBtn');
    const seen = [];
    for (let i = 0; i < 90; i++) {
      const c = await page.textContent('#detChord');
      if (seen[seen.length - 1] !== c) seen.push(c);
      await page.waitForTimeout(100);
    }
    const seq = seen.filter((c) => c !== '—').join(' ');
    check('microphone detection follows Am C Em D', /^Am C Em D Am/.test(seq), seq);
    await page.click('#detClose');

    // Unrestricted mode: off by default, persisted, shows 4 candidates.
    check('restricted (song) mode is the default', !(await page.isChecked('#unrestricted')));
    await page.click('#micBtn');
    await page.check('#unrestricted');
    await page.reload();
    await page.waitForTimeout(400);
    check('unrestricted toggle survives a reload', await page.isChecked('#unrestricted'));
    await page.click('#micBtn');
    const freeSeen = new Set();
    let cells = 0;
    for (let i = 0; i < 60; i++) {
      freeSeen.add(await page.textContent('#detChord'));
      cells = Math.max(cells, await page.$$eval('#detCands .cand b', (n) => n.filter((x) => x.textContent !== '·').length));
      await page.waitForTimeout(100);
    }
    check('unrestricted mode shows 3-4 candidates side by side', cells >= 3, `${cells} candidates`);
    check('unrestricted mode still detects the played chords', ['Am', 'C', 'Em', 'D'].filter((c) => freeSeen.has(c)).length >= 3, [...freeSeen].join(' '));
    await page.click('#detClose');
    await page.uncheck('#unrestricted');

    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    phone.on('pageerror', (e) => errors.push(e.message));
    await phone.goto(url + '#song=haunted');
    await phone.waitForTimeout(400);
    const ov = await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    check('no horizontal overflow on a phone', ov);
    await phone.tap('#moreBtn'); // zoom lives in the collapsed toolbar on phones
    for (let i = 0; i < 8; i++) await phone.tap('#zoomInBtn');
    await phone.waitForTimeout(300);
    const b = await alignment(phone);
    check('chords stay aligned when zoomed and wrapped (phone)', b.n > 20 && b.bad === 0, `${b.n} chords, ${b.bad} off`);

    check('no console errors', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    server.close();
  }
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall browser checks passed');
})();
