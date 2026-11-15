#!/usr/bin/env node
/* ==========================================================================
   真实时间截图工具（开发用）
   --------------------------------------------------------------------------
   为什么不能用 `chrome --headless --screenshot`：
     `--virtual-time-budget` 只快进**虚拟**时间，CSS 入场动画不会被驱动，
     带 animation-delay 的元素会停在 opacity:0 —— 截出来是一片黑。
   本工具用 CDP 驱动真实时间，可以：
     · 等动画跑完再截
     · 先导入一首真实曲谱（甚至播放 N 毫秒）再截
   用法：
     node app/tests/screenshot.js out.png
     node app/tests/screenshot.js out.png --score=传奇.json
     node app/tests/screenshot.js out.png --score=传奇.json --play=2600
   可选：--w=1440 --h=900 --wait=1000
   ========================================================================== */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PLAYER = path.resolve(__dirname, '..');
const PORT = 9400 + (process.pid % 200);
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : null,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name, dflt) {
  const p = process.argv.find((a) => a.startsWith('--' + name + '='));
  return p ? p.slice(name.length + 3) : dflt;
}

function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', (e) => rej(new Error('WS 连接失败: ' + (e && e.message))));
  });
  ws.addEventListener('message', (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.method + ' ' + JSON.stringify(m.error)));
      else resolve(m.result);
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
  return { ready, send, close: () => ws.close() };
}

/* 页面内：导入并选中一首真实曲谱（用绝对 file:// URL，避免相对路径算错） */
function driveScript(scoreUrl) {
  return `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const url = ${JSON.stringify(scoreUrl)};
  const txt = await new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open('GET', url, true);
    x.onload = () => res(x.responseText);
    x.onerror = () => rej(new Error('XHR fail: ' + url));
    x.send();
  });
  const name = ${JSON.stringify(decodeURIComponent(scoreUrl.split('/').pop()))};
  const dt = new DataTransfer();
  dt.items.add(new File([txt], name, { type: 'application/json' }));
  const input = document.getElementById('fileInput');
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (document.querySelectorAll('#scoreList li[data-id]').length) break;
  }
  const li = document.querySelector('#scoreList li[data-id]');
  if (li) li.click();
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    if (document.getElementById('btnPlay').disabled === false) break;
  }
  return document.getElementById('npTitle').textContent;
})()`;
}

(async function main() {
  const out = path.resolve(process.argv[2] || path.join(__dirname, '_shot.png'));
  const scoreRel = arg('score', null);
  const playMs = parseInt(arg('play', '0'), 10);
  const W = parseInt(arg('w', '1440'), 10);
  const H = parseInt(arg('h', '900'), 10);
  const waitMs = parseInt(arg('wait', '1000'), 10);

  const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!chrome) { console.error('找不到 Chrome/Edge'); process.exit(2); }

  const userDir = path.join(os.tmpdir(), 'bgi-shot-' + Date.now());
  const proc = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--no-default-browser-check', '--mute-audio',
    '--allow-file-access-from-files',
    '--autoplay-policy=no-user-gesture-required',
    '--force-color-profile=srgb',
    '--remote-debugging-port=' + PORT,
    '--remote-allow-origins=*',
    '--user-data-dir=' + userDir,
    'about:blank'
  ], { stdio: 'ignore' });

  let cdp = null;
  try {
    const t0 = Date.now();
    let version = null;
    while (Date.now() - t0 < 20000) {
      try {
        const r = await fetch('http://127.0.0.1:' + PORT + '/json/version');
        if (r.ok) { version = await r.json(); break; }
      } catch (_) { }
      await sleep(150);
    }
    if (!version) throw new Error('DevTools 没起来');

    let targets = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
    let page = targets.find((t) => t.type === 'page');
    if (!page) { await sleep(500); targets = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); page = targets.find((t) => t.type === 'page'); }
    if (!page) throw new Error('没有 page target');

    cdp = connectCdp(page.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: W, height: H, deviceScaleFactor: 1, mobile: false
    });

    const indexUrl = require('url').pathToFileURL(path.join(PLAYER, 'index.html')).href;
    await cdp.send('Page.navigate', { url: indexUrl });

    const t1 = Date.now();
    while (Date.now() - t1 < 15000) {
      const r = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      if (r.result && r.result.value === 'complete') break;
      await sleep(150);
    }
    await sleep(waitMs);   /* 等入场动画跑完 */

    if (scoreRel) {
      const scoreUrl = require('url').pathToFileURL(
        path.join(PLAYER, '..', 'library', scoreRel)
      ).href;
      const r = await cdp.send('Runtime.evaluate', {
        expression: driveScript(scoreUrl), awaitPromise: true, returnByValue: true
      });
      if (r.exceptionDetails) throw new Error('导入失败: ' + JSON.stringify(r.exceptionDetails.text || r.exceptionDetails));
      console.log('已选中：' + (r.result && r.result.value));
      await sleep(400);
    }

    if (playMs > 0) {
      await cdp.send('Runtime.evaluate', { expression: "document.getElementById('btnPlay').click()" });
      await sleep(playMs);
      console.log('已播放 ' + playMs + 'ms');
    }

    /* --eval="<js>" 或 --evalFile="<path>"：截图前跑一段页面脚本 */
    const evalFile = arg('evalFile', null);
    const evalCode = evalFile ? fs.readFileSync(path.resolve(evalFile), 'utf8') : arg('eval', null);
    if (evalCode) {
      const rr = await cdp.send('Runtime.evaluate', {
        expression: evalCode, awaitPromise: true, returnByValue: true
      });
      if (rr.exceptionDetails) console.log('  eval 异常: ' + JSON.stringify(rr.exceptionDetails.text || rr.exceptionDetails));
      else if (rr.result && rr.result.value !== undefined) console.log('  eval 返回: ' + JSON.stringify(rr.result.value));
      await sleep(400);
    }

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('截图已保存: ' + out + '  (' + fs.statSync(out).size + ' bytes)');
  } catch (e) {
    console.error('失败: ' + (e && e.message));
    process.exitCode = 1;
  } finally {
    if (cdp) try { cdp.close(); } catch (_) { }
    try { proc.kill(); } catch (_) { }
    await sleep(300);
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (_) { }
  }
})();
