#!/usr/bin/env node
/* ==========================================================================
   真实时间（非虚拟时间）端到端验证 —— 通过 Chrome DevTools Protocol 驱动
   --------------------------------------------------------------------------
   为什么需要它：`chrome --headless --virtual-time-budget --dump-dom` 会把**虚拟时间**
   快进，但 **AudioContext 的时钟是真实时钟** —— 播放器以 ctx.currentTime 为主时钟，
   所以在那个环境里 #tNow 永远停在 0:00.0（假象，不是 bug）。
   本脚本用 CDP 连上真实运行的页面，等真实的秒数过去，再读真实的时间轴。

   用法：
     node app/tests/realtime.test.js
   ========================================================================== */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : null,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);

const PLAYER = path.resolve(__dirname, '..');
const PORT = 9333 + (process.pid % 200);
const SCORE_REL = '传奇.json';

let PASS = 0, FAIL = 0;
function ok(name, cond, detail) {
  if (cond) { PASS++; console.log('  \u2713 ' + name); }
  else { FAIL++; console.log('  \u2717 ' + name + (detail ? '  -> ' + detail : '')); }
}

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForDevtools(port, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json/version');
      if (r.ok) return await r.json();
    } catch (_) { /* not up yet */ }
    await sleep(150);
  }
  throw new Error('DevTools 端口 ' + port + ' 在 ' + timeoutMs + 'ms 内没起来');
}

async function listTargets(port) {
  const r = await fetch('http://127.0.0.1:' + port + '/json/list');
  return await r.json();
}

/* ------------------------- 极简 CDP 客户端 ------------------------- */
function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const events = [];

  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', (e) => rej(new Error('WebSocket 连接失败: ' + (e && e.message))));
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.method + ' ' + JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });

  function send(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error('CDP 超时: ' + method)); }
      }, 60000);
    });
  }

  return { ready, send, events, close: () => ws.close() };
}

/* ------------------------- 页面内测试脚本 ------------------------- */
function pageScript(scoreUrl) {
  return `(async () => {
  const out = [];
  const ok = (n, c, d) => out.push((c ? 'PASS  ' : 'FAIL  ') + n + (d ? '  -> ' + d : ''));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const sec = s => { const m = /^(\\d+):(\\d+(?:\\.\\d+)?)$/.exec(s.trim()); return m ? (+m[1]) * 60 + parseFloat(m[2]) : NaN; };

  try {
    /* ---- 0. 基线：AudioContext 时钟在真实时间里确实会走 ---- */
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    await ctx.resume();
    const ca = ctx.currentTime;
    await sleep(1000);
    const cb = ctx.currentTime;
    ok('AudioContext 时钟在真实时间里前进（' + (cb - ca).toFixed(3) + 's / 1s）', (cb - ca) > 0.8 && (cb - ca) < 1.4);
    ok('AudioContext 处于 running', ctx.state === 'running', ctx.state);

    /* ---- 1. app.js 已初始化 ---- */
    ok('渲染出 21 个键', document.querySelectorAll('#keyboard .key').length === 21);
    ok('没有致命故障层', document.body.textContent.indexOf('播放器无法启动') < 0);

    /* ---- 2. 导入真实曲谱 ---- */
    const txt = await new Promise((res, rej) => {
      const x = new XMLHttpRequest();
      x.open('GET', ${JSON.stringify(scoreUrl)}, true);
      x.onload = () => res(x.responseText);
      x.onerror = () => rej(new Error('XHR 失败'));
      x.send();
    });
    const name = ${JSON.stringify(scoreUrl.split('/').pop())};
    const dt = new DataTransfer();
    dt.items.add(new File([txt], name, { type: 'application/json' }));
    const input = document.getElementById('fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
    await sleep(600);
    const items = document.querySelectorAll('#scoreList li[data-id]');
    ok('导入后列表有 1 首', items.length === 1, '实际 ' + items.length);
    if (!items.length) { return out.join('\\n'); }

    items[0].click();
    await sleep(200);
    const total = sec(document.getElementById('tTotal').textContent);
    ok('总时长 ' + total + 's 已就绪', total > 5, String(total));

    /* ---- 3. 真实时间播放：时间轴必须真的走；同时统计高亮 ----
       ⚠ 高亮必须在这里真实断言。之前写成「litNow >= 0」（恒真），
         等于「高亮类回归抓不到」—— 而高亮恰好是最容易回归的地方。 */
    document.getElementById('btnPlay').click();
    let t1 = 0, t2 = 0, t3 = 0, litSamples = 0, maxLit = 0, noteSeen = '';
    for (let k = 0; k < 40; k++) {
      await sleep(100);
      const lit = document.querySelectorAll('#keyboard .key.on').length;
      if (lit > 0) litSamples++;
      if (lit > maxLit) maxLit = lit;
      const nm = document.getElementById('npNoteName').textContent;
      if (nm && nm !== '-') noteSeen = nm;
      if (k === 4) t1 = sec(document.getElementById('tNow').textContent);
      if (k === 19) t2 = sec(document.getElementById('tNow').textContent);
      if (k === 34) t3 = sec(document.getElementById('tNow').textContent);
    }
    ok('播放后时间轴前进：' + t1 + ' -> ' + t2 + ' -> ' + t3, t2 > t1 + 0.5 && t3 > t2 + 0.5,
      t1 + '/' + t2 + '/' + t3);
    const rate = (t3 - t1) / 3.0;
    ok('1.0× 速度下推进速率 ≈1（实测 ' + rate.toFixed(2) + '×）', rate > 0.75 && rate < 1.3, rate.toFixed(3));
    ok('播放中有琴键高亮：' + litSamples + '/40 次采样有高亮，最多同时 ' + maxLit + ' 个',
      litSamples >= 5 && maxLit >= 1 && maxLit <= 21, 'litSamples=' + litSamples + ' maxLit=' + maxLit);
    ok('播放中显示过音名（' + noteSeen + '）', noteSeen !== '');

    /* ---- 4. 变速：2× 时推进速率应约为 2 倍（且不变调） ---- */
    const sp = document.getElementById('speed');
    sp.value = '2';
    sp.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(300);
    const b1 = sec(document.getElementById('tNow').textContent);
    await sleep(1600);
    const b2 = sec(document.getElementById('tNow').textContent);
    const rate2 = (b2 - b1) / 1.6;
    ok('2.0× 速度下推进速率 ≈2（实测 ' + rate2.toFixed(2) + '×）', rate2 > 1.5 && rate2 < 2.5, rate2.toFixed(3));
    sp.value = '1';
    sp.dispatchEvent(new Event('input', { bubbles: true }));

    /* ---- 5. 拖动进度条跳转 ----
       读数的时刻已经比 seek 晚 600ms，而播放还在继续，所以容差只给 1.5s。 */
    const seek = document.getElementById('seek');
    seek.value = '600';
    seek.dispatchEvent(new Event('input', { bubbles: true }));
    seek.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(600);
    const tSeek = sec(document.getElementById('tNow').textContent);
    ok('拖到 60% 后时间 ≈ ' + (total * 0.6).toFixed(1) + 's（实测 ' + tSeek + 's）',
      Math.abs(tSeek - total * 0.6) < 1.5, String(tSeek));

    /* ---- 6. 停止 ---- */
    document.getElementById('btnStop').click();
    await sleep(300);
    ok('停止后时间归零', sec(document.getElementById('tNow').textContent) < 0.05,
      document.getElementById('tNow').textContent);
    ok('停止后无残留高亮', document.querySelectorAll('#keyboard .key.on').length === 0);

    /* ---- 7. 循环必须真的生效 ----
       ⚠ 原来这里写的是 ok(勾选循环不抛异常, true) —— 恒真断言，等于没测。
         改成真实验证：跳到接近曲尾 → 开启循环 → 播放 → 时间应当绕回开头。 */
    const lp = document.getElementById('loop');
    lp.checked = true;
    lp.dispatchEvent(new Event('change', { bubbles: true }));
    ok('循环勾选状态已生效（checkbox = true）', lp.checked === true);

    seek.value = '995';
    seek.dispatchEvent(new Event('input', { bubbles: true }));
    seek.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(300);
    const tNearEnd = sec(document.getElementById('tNow').textContent);
    ok('已跳到接近曲尾（' + tNearEnd.toFixed(1) + 's / ' + total + 's）', tNearEnd > total - 1.5,
      String(tNearEnd));

    document.getElementById('btnPlay').click();
    let wrapped = false, minAfter = 1e9;
    for (let k = 0; k < 60; k++) {
      await sleep(200);
      const cur = sec(document.getElementById('tNow').textContent);
      if (cur < minAfter) minAfter = cur;
      if (cur < tNearEnd - 1) { wrapped = true; break; }
    }
    ok('循环开启时播到曲尾会绕回开头（' + tNearEnd.toFixed(1) + 's 之后最低回退到 ' +
      (minAfter === 1e9 ? 'n/a' : minAfter.toFixed(1)) + 's）', wrapped);
    document.getElementById('btnStop').click();
    await sleep(250);
    lp.checked = false;
    lp.dispatchEvent(new Event('change', { bubbles: true }));

    /* ---- 8. 合成音色：真的出声、音高对、会衰减 ----
       做法：拿引擎的 master 节点另接一个 AnalyserNode（fan-out，不影响原链路），
       然后播单音，读频谱峰值与时域 RMS。这是对「振荡器实际调在哪个频率上」的实测，
       不是把 midiToFreq 的数学结果再抄一遍。 */
    const eng = window.BGIAudio.createEngine();
    await eng.resume();
    const actx = eng.master.context;
    const an = actx.createAnalyser();
    an.fftSize = 16384;
    an.smoothingTimeConstant = 0;
    eng.master.connect(an);
    eng.setMasterVolume(1);

    const rms = () => {
      const b = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(b);
      let s = 0;
      for (let i = 0; i < b.length; i++) s += b[i] * b[i];
      return Math.sqrt(s / b.length);
    };
    const peakHz = () => {
      const bins = new Float32Array(an.frequencyBinCount);
      an.getFloatFrequencyData(bins);
      let best = 1, bestV = -Infinity;
      for (let i = 2; i < bins.length; i++) if (bins[i] > bestV) { bestV = bins[i]; best = i; }
      return { hz: best * actx.sampleRate / an.fftSize, db: bestV };
    };

    const probes = [[69, 440, 'A4'], [60, 261.6256, 'C4'], [48, 130.8128, 'C3'], [83, 987.7666, 'B5']];
    for (const [pitch, expect, name] of probes) {
      eng.setInstrument('windsong');
      eng.stopAll();
      await sleep(120);
      eng.noteOn(pitch, actx.currentTime + 0.02, 2.0, 1);
      await sleep(320);
      const pk = peakHz();
      const r1 = rms();
      await sleep(900);
      const r2 = rms();
      eng.stopAll();
      /* 峰值可能落在某个谐波上（拨弦音色的基频不一定最强），
         所以只要它贴近该基频的某个整数倍就算对。 */
      let bestK = 0, bestErr = 1e9;
      for (let k = 1; k <= 8; k++) {
        const e = Math.abs(pk.hz - expect * k) / (expect * k);
        if (e < bestErr) { bestErr = e; bestK = k; }
      }
      ok('windsong 出声 ' + name + '：频谱峰值 ' + pk.hz.toFixed(1) + 'Hz（= 基频 ' + expect.toFixed(1) +
        'Hz 的第 ' + bestK + ' 谐波，误差 ' + (bestErr * 100).toFixed(2) + '%），RMS=' + r1.toFixed(4),
        r1 > 0.0008 && bestErr < 0.04);
      ok('windsong 是「拨弦」而非「持续音」：' + name + ' 后段 RMS ' + r2.toFixed(4) +
        ' < 前段 ' + r1.toFixed(4), r2 < r1 * 0.92);
    }

    /* 四种合成音色都得出声 */
    for (const id of ['windsong', 'harp', 'piano', 'musicbox']) {
      eng.setInstrument(id);
      eng.stopAll();
      await sleep(100);
      eng.noteOn(69, actx.currentTime + 0.02, 1.5, 1);
      await sleep(320);
      const r = rms();
      eng.stopAll();
      ok('音色 ' + id + ' 出声（RMS=' + r.toFixed(4) + '）', r > 0.0008);
    }

    /* 持续音采样（如晚风圆号）按传入 dur 收尾，不会在短音上拖长延音 */
    {
      const sr = actx.sampleRate;
      const buf = actx.createBuffer(1, sr * 2, sr);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < ch.length; i++) ch[i] = 0.4 * Math.sin(2 * Math.PI * 440 * i / sr);
      eng._samples[69] = { buffer: buf, name: 'A4.wav' };
      eng._sampleMidis = [69];
      eng.setSampleOptions({ sustain: true, release: 0.12, minLength: 0.06 });
      eng.setInstrument('sample');
      eng.stopAll();
      await sleep(80);
      eng.noteOn(69, actx.currentTime + 0.02, 0.15, 1);
      await sleep(100);
      const rOn = rms();
      await sleep(900);
      const rOff = rms();
      eng.clearSamples();
      eng.stopAll();
      ok('持续音采样短音（dur=0.15s）发声且在音尾后收净（rOn=' + rOn.toFixed(4) + ', rOff=' + rOff.toFixed(4) + '）',
        rOn > 0.01 && rOff < rOn * 0.08);
    }
    eng.setMasterVolume(0.8);

    return out.join('\\n');
  } catch (e) {
    out.push('FATAL  ' + (e && e.stack ? e.stack : e));
    return out.join('\\n');
  }
})()`;
}

/* ============================== main ============================== */
(async function main() {
  const chrome = findChrome();
  if (!chrome) { console.error('找不到 Chrome/Edge，无法做真实时间验证'); process.exit(2); }
  console.log('浏览器: ' + chrome);

  const userDir = path.join(os.tmpdir(), 'bgi-cdp-' + Date.now());
  const proc = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    '--allow-file-access-from-files',
    '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=' + PORT,
    '--remote-allow-origins=*',
    '--user-data-dir=' + userDir,
    'about:blank'
  ], { stdio: 'ignore' });

  let cdp = null;
  let exitCode = 1;
  try {
    await waitForDevtools(PORT, 20000);
    let targets = await listTargets(PORT);
    let page = targets.find(t => t.type === 'page');
    if (!page) { await sleep(500); targets = await listTargets(PORT); page = targets.find(t => t.type === 'page'); }
    if (!page) throw new Error('没有找到 page target');

    cdp = connectCdp(page.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    /* 打开 Network 域，用于「运行时零网络」审计（源码 grep 证明不了运行时行为） */
    await cdp.send('Network.enable');

    const indexUrl = require('url').pathToFileURL(path.join(PLAYER, 'index.html')).href;
    const scoreUrl = require('url').pathToFileURL(path.join(PLAYER, '..', 'library', SCORE_REL)).href;
    console.log('页面: ' + indexUrl);
    console.log('曲谱: ' + SCORE_REL);

    await cdp.send('Page.navigate', { url: indexUrl });

    /* 等 load 完成 */
    const t0 = Date.now();
    let ready = false;
    while (Date.now() - t0 < 15000) {
      const r = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      if (r.result && r.result.value === 'complete') { ready = true; break; }
      await sleep(200);
    }
    if (!ready) throw new Error('页面 15s 内没有 load 完成');
    await sleep(400);   /* 给 DOMContentLoaded 里的 init() 一点时间 */

    console.log('\n=== 真实时间端到端（Chrome headless + CDP）===');
    const res = await cdp.send('Runtime.evaluate', {
      expression: pageScript(scoreUrl),
      awaitPromise: true,
      returnByValue: true
    });
    if (res.exceptionDetails) throw new Error('页面内异常: ' + JSON.stringify(res.exceptionDetails));

    const text = String(res.result.value || '');
    console.log(text);
    for (const line of text.split('\n')) {
      if (line.startsWith('PASS  ')) PASS++;
      else if (line.startsWith('FAIL  ')) FAIL++;
    }

    /* ---------- 运行时网络审计（CDP Network 域） ----------
       「零网络请求」是这个工具的核心承诺之一，而源码 grep 只能证明「没写 fetch」，
       证明不了运行时到底发了什么请求。这里直接看浏览器实际发出的请求。 */
    const reqs = cdp.events
      .filter(e => e.method === 'Network.requestWillBeSent')
      .map(e => e.params && e.params.request && e.params.request.url)
      .filter(Boolean);
    const httpReqs = reqs.filter(u => /^https?:/i.test(u));
    const fileReqs = reqs.filter(u => /^file:/i.test(u));
    const otherReqs = reqs.filter(u => !/^https?:/i.test(u) && !/^file:/i.test(u));

    console.log('\n=== 运行时网络审计（CDP Network 域）===');
    console.log('  实际请求 ' + reqs.length + ' 个：file:// ' + fileReqs.length +
      ' · http(s) ' + httpReqs.length + ' · 其它 ' + otherReqs.length);
    fileReqs.forEach(u => console.log('    file:// …/' + u.replace(/^file:\/\/.*\//, '')));
    httpReqs.forEach(u => console.log('    \u26a0 http(s)  ' + u));
    otherReqs.forEach(u => console.log('    \u26a0 其它     ' + u));
    ok('运行时零 http(s) 请求', httpReqs.length === 0, httpReqs.join(', '));
    ok('运行时零非 file:// 请求', otherReqs.length === 0, otherReqs.join(', '));
    ok('运行时确实只加载了本地资源（' + fileReqs.length + ' 个 file://）', fileReqs.length > 0,
      '实际 ' + fileReqs.length);

    exitCode = FAIL ? 1 : 0;
  } catch (e) {
    console.error('运行失败: ' + (e && e.message));
    console.error(e && e.stack);
    exitCode = 1;
  } finally {
    if (cdp) try { cdp.close(); } catch (_) { }
    try { proc.kill(); } catch (_) { }
    await sleep(300);
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (_) { }
  }

  console.log('\n' + '='.repeat(52));
  console.log('PASS ' + PASS + '   FAIL ' + FAIL);
  console.log('='.repeat(52));
  process.exit(exitCode);
})();
