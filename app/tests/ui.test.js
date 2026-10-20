#!/usr/bin/env node
/* ==========================================================================
   新功能验收测试（真实时间，CDP 驱动）
   --------------------------------------------------------------------------
   覆盖本轮新增的三件事：
     1. 真实音源：samples.js 的 21 个采样被解码并启用
     2. 键盘弹奏：按 QWERTYU/ASDFGHJ/ZXCVBNM 能发声并使对应键亮起
     3. 音符编辑：进入编辑模式 → 新增 / 选中 / 改音高 / 删除 / 撤销 / 还原
     4. 歌单连播：多首导入后 trackIndex 正确，下一首能切换
   用法：node app/tests/ui.test.js
   ========================================================================== */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const url = require('url');

const PLAYER = path.resolve(__dirname, '..');
const PORT = 9600 + (process.pid % 150);
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : null,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean).find(p => fs.existsSync(p));

let PASS = 0, FAIL = 0;
const ok = (n, c, d) => {
  if (c) { PASS++; console.log('  \u2713 ' + n); }
  else { FAIL++; console.log('  \u2717 ' + n + (d ? '  -> ' + d : '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 1; const pend = new Map();
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', e => rej(new Error('WS ' + (e && e.message))));
  });
  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id); pend.delete(m.id);
      m.error ? p.reject(new Error(m.method + ' ' + JSON.stringify(m.error))) : p.resolve(m.result);
    }
  });
  return {
    ready,
    send(method, params) {
      const n = id++;
      return new Promise((resolve, reject) => {
        pend.set(n, { resolve, reject });
        ws.send(JSON.stringify({ id: n, method, params: params || {} }));
        setTimeout(() => { if (pend.has(n)) { pend.delete(n); reject(new Error('timeout ' + method)); } }, 60000);
      });
    },
    close: () => ws.close()
  };
}

/* ── 页面内测试脚本 ── */
function pageScript(scoreUrls) {
  return `(async () => {
  const out = [];
  const ok = (n, c, d) => out.push((c ? 'PASS  ' : 'FAIL  ') + n + (d ? '  -> ' + d : ''));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const $ = s => document.querySelector(s);
  const notesCount = () => {
    const t = ($('#editInfo') || {}).textContent || '';
    const m = /共 (\\d+) 音/.exec(t);
    return m ? parseInt(m[1], 10) : -1;
  };
  const xhr = u => new Promise((res, rej) => {
    const x = new XMLHttpRequest(); x.open('GET', u, true);
    x.onload = () => res(x.responseText); x.onerror = () => rej(new Error('xhr')); x.send();
  });

  try {
    /* ───────── 0. 基础 ───────── */
    ok('渲染 21 键', document.querySelectorAll('#keyboard .key').length === 21);

    /* ───────── 1. 真实音源 ───────── */
    let stat = '';
    for (let i = 0; i < 60; i++) {
      await sleep(100);
      stat = ($('#sampleStat') || {}).textContent || '';
      if (stat.indexOf('/21') >= 0 || stat.indexOf('失败') >= 0) break;
    }
    ok('真实采样已加载（' + stat.trim() + '）', /21\\s*音/.test(stat) && !/失败/.test(stat), stat);
    ok('默认音色是真实采样（风物之诗琴）', $('#instrument').value === 'real:windsong_lyre', $('#instrument').value);

    /* ───────── 1b. 多套真实音色：清单 / 按需加载 / 切换 ───────── */
    const sel = $('#instrument');
    const realOpts = [...sel.options].filter(o => o.value.indexOf('real:') === 0).map(o => o.value);
    const synthOpts = [...sel.options].filter(o => o.value.indexOf('synth:') === 0);
    ok('下拉里有 ' + realOpts.length + ' 套真实音色', realOpts.length >= 7, realOpts.join(','));
    ok('合成音色被明确标成「备用」', synthOpts.length > 0 && /备用/.test(synthOpts[0].textContent),
      synthOpts[0] ? synthOpts[0].textContent : '无');

    const waitStat = async (pred) => {
      let s = '';
      for (let i = 0; i < 100; i++) {
        await sleep(100);
        s = $('#sampleStat').textContent;
        if (/\\/21/.test(s) && s.indexOf('正在加载') < 0 && pred(s)) break;
      }
      return s;
    };

    sel.value = realOpts[1];
    sel.dispatchEvent(new Event('change'));
    const s2 = await waitStat(() => true);
    ok('切换到「' + realOpts[1] + '」并完成加载（' + s2.trim() + '）', /\\/21/.test(s2), s2);

    sel.value = 'real:windsong_lyre';
    sel.dispatchEvent(new Event('change'));
    const s3 = await waitStat(s => s.indexOf('风物之诗琴') >= 0);
    ok('切回风物之诗琴（' + s3.trim() + '）', s3.indexOf('风物之诗琴') >= 0 && /21\\/21/.test(s3), s3);

    sel.value = synthOpts[0].value;
    sel.dispatchEvent(new Event('change'));
    await sleep(300);
    ok('可切到合成（备用）音色', /合成/.test($('#sampleStat').textContent), $('#sampleStat').textContent);

    sel.value = 'real:windsong_lyre';
    sel.dispatchEvent(new Event('change'));
    await waitStat(s => s.indexOf('风物之诗琴') >= 0);

    /* ───────── 2. 键盘弹奏 ───────── */
    const keyQ = document.querySelector('.key[data-key="Q"]');
    const energy = () => parseFloat(keyQ.style.getPropertyValue('--e') || '0');
    const down = new KeyboardEvent('keydown', { key: 'q', code: 'KeyQ', bubbles: true });
    document.dispatchEvent(down);
    for (let i = 0; i < 20; i++) { await sleep(20); if (energy() > 0.6) break; }
    ok('按下 Q 后该键亮起（--e=' + energy().toFixed(2) + '）', energy() > 0.6, String(energy()));
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'q', code: 'KeyQ', bubbles: true }));
    for (let i = 0; i < 40; i++) { await sleep(20); if (energy() < 0.1) break; }
    ok('松开后该键熄灭（--e=' + energy().toFixed(2) + '）', energy() < 0.1, String(energy()));

    /* 关闭键盘弹奏后按键不再发声 */
    $('#playKeys').checked = false;
    $('#playKeys').dispatchEvent(new Event('change'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', code: 'KeyQ', bubbles: true }));
    await sleep(150);
    ok('关闭「键盘弹奏」后按键不再触发', energy() < 0.2, String(energy()));
    $('#playKeys').checked = true;
    $('#playKeys').dispatchEvent(new Event('change'));
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'q', code: 'KeyQ', bubbles: true }));

    /* ───────── 3. 导入两首（供歌单与编辑） ───────── */
    const urls = ${JSON.stringify(scoreUrls)};
    const dt = new DataTransfer();
    const texts = [];
    for (const u of urls) texts.push(await xhr(u));
    urls.forEach((u, i) => {
      const name = decodeURIComponent(u.split('/').pop());
      dt.items.add(new File([texts[i]], name, { type: 'application/json' }));
    });
    $('#fileInput').files = dt.files;
    $('#fileInput').dispatchEvent(new Event('change'));
    for (let i = 0; i < 100; i++) { await sleep(100); if (document.querySelectorAll('#scoreList li[data-id]').length >= 2) break; }
    const lis = document.querySelectorAll('#scoreList li[data-id]');
    ok('导入 2 首', lis.length === 2, '实际 ' + lis.length);

    /* ───────── 4. 歌单连播 ───────── */
    lis[0].click();
    await sleep(250);
    const idx1 = ($('#trackIndex') || {}).textContent || '';
    const title1 = $('#npTitle').textContent;
    ok('队列指示为 1 / 2（' + idx1.trim() + '）', /^\\s*1\\s*\\/\\s*2\\s*$/.test(idx1), idx1);
    $('#btnNext').click();
    await sleep(350);
    const idx2 = ($('#trackIndex') || {}).textContent || '';
    const title2 = $('#npTitle').textContent;
    ok('「下一首」切到 2 / 2（' + idx2.trim() + '）', /^\\s*2\\s*\\/\\s*2\\s*$/.test(idx2), idx2);
    ok('标题已切换（' + title1 + ' -> ' + title2 + '）', title1 !== title2, title1 + ' / ' + title2);
    ok('连播开关默认为开', $('#autoplay').checked === true);

    /* ───────── 5. 编辑：新增 / 选中 / 改音高 / 删除 / 撤销 / 还原 ───────── */
    const before = notesCount();
    ok('进入编辑模式前能读到音符数（' + before + '）', before > 0, String(before));

    $('#modeEdit').click();
    await sleep(150);
    ok('编辑条已显示', $('#editBar').hidden === false);

    const cv = $('#roll');
    const r = cv.getBoundingClientRect();
    const cx = Math.round(r.left + r.width * 0.62);
    const cy = Math.round(r.top + r.height * 0.72);
    cv.dispatchEvent(new MouseEvent('click', { clientX: cx, clientY: cy, bubbles: true }));
    await sleep(150);
    const afterAdd = notesCount();
    ok('点击空白新增音符（' + before + ' -> ' + afterAdd + '）', afterAdd === before + 1, String(afterAdd));
    ok('新音符被选中', /已选/.test($('#editInfo').textContent), $('#editInfo').textContent);

    const pitchOf = () => {
      const m = /已选\\s*([A-G]#?\\d)/.exec($('#editInfo').textContent || '');
      return m ? m[1] : '';
    };
    const pitchBefore = pitchOf();
    $('#btnPitchUp').click();
    await sleep(120);
    const pitchAfter = (($('#editInfo').textContent.match(/已选\\s*([A-G]#?\\d)/) || [])[1] || '');
    ok('音高上移（' + pitchBefore + ' -> ' + pitchAfter + '）', pitchBefore !== pitchAfter && !!pitchAfter,
      pitchBefore + ' / ' + pitchAfter);

    $('#btnDurUp').click();
    await sleep(120);
    ok('时长可加长', /时值\\s*\\d+ms/.test($('#editInfo').textContent), $('#editInfo').textContent);

    $('#btnDel').click();
    await sleep(120);
    ok('删除后音符数回到 ' + before, notesCount() === before, String(notesCount()));

    $('#btnEditUndo').click();
    await sleep(120);
    ok('撤销后恢复到 ' + afterAdd, notesCount() === afterAdd, String(notesCount()));

    $('#btnEditReset').click();
    await sleep(300);
    ok('还原为原始曲谱（' + before + '）', notesCount() === before, String(notesCount()));

    /* Delete 键删除 */
    cv.dispatchEvent(new MouseEvent('click', { clientX: cx, clientY: cy, bubbles: true }));
    await sleep(120);
    const nBeforeDel = notesCount();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await sleep(120);
    ok('Delete 键可删除选中音符', notesCount() === nBeforeDel - 1, nBeforeDel + ' -> ' + notesCount());

    $('#modePlay').click();
    await sleep(120);
    ok('切回演奏模式后编辑条隐藏', $('#editBar').hidden === true);

    /* ───────── 6. 歌单连播：曲终自动切下一首 ───────── */
    document.querySelectorAll('#scoreList li[data-id]')[0].click();
    await sleep(300);
    const tFirst = $('#npTitle').textContent;
    const seekEl = $('#seek');
    seekEl.value = '975';
    seekEl.dispatchEvent(new Event('input', { bubbles: true }));
    seekEl.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(250);
    $('#btnPlay').click();
    let switched = false;
    for (let i = 0; i < 80; i++) {
      await sleep(200);
      if ($('#npTitle').textContent !== tFirst) { switched = true; break; }
    }
    ok('曲终自动连播到下一首（' + tFirst + ' -> ' + $('#npTitle').textContent + '）', switched);
    $('#btnStop').click();
    await sleep(200);
    ok('停止后时间归零', $('#tNow').textContent === '0:00.0', $('#tNow').textContent);

    return out.join('\\n');
  } catch (e) {
    out.push('FATAL  ' + (e && e.stack ? e.stack : e));
    return out.join('\\n');
  }
})()`;
}

(async function main() {
  if (!CHROME) { console.error('找不到 Chrome/Edge'); process.exit(2); }
  const userDir = path.join(os.tmpdir(), 'dsh-ui-' + Date.now());
  const proc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--no-default-browser-check', '--mute-audio',
    '--allow-file-access-from-files',
    '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=' + PORT,
    '--remote-allow-origins=*',
    '--user-data-dir=' + userDir,
    'about:blank'
  ], { stdio: 'ignore' });

  let cdp = null, exitCode = 1;
  try {
    const t0 = Date.now();
    let up = false;
    while (Date.now() - t0 < 20000) {
      try { if ((await fetch('http://127.0.0.1:' + PORT + '/json/version')).ok) { up = true; break; } } catch (_) { }
      await sleep(150);
    }
    if (!up) throw new Error('DevTools 未就绪');

    let list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
    let page = list.find(t => t.type === 'page');
    if (!page) { await sleep(500); list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); page = list.find(t => t.type === 'page'); }
    if (!page) throw new Error('无 page target');

    cdp = connect(page.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    await cdp.send('Page.navigate', { url: url.pathToFileURL(path.join(PLAYER, 'index.html')).href });
    const t1 = Date.now();
    while (Date.now() - t1 < 15000) {
      const r = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      if (r.result && r.result.value === 'complete') break;
      await sleep(150);
    }
    await sleep(800);

    const scoreUrls = [
      '01_原琴JSON/小星星 - 20i9ia3Z.json',
      '04_MIDI-21键适配JSON/紫阳花 - test.json'
    ];
    /* 第二首换成必定存在的文件 */
    const pumps = ['01_原琴JSON/小星星 - 20i9ia3Z.json', '01_原琴JSON/卡农 - 7BRsrJmI.json'];
    const urls = pumps.map(p => url.pathToFileURL(path.join(PLAYER, '..', 'library-private', p)).href);

    console.log('=== 新功能验收（真实时间 CDP）===');
    const res = await cdp.send('Runtime.evaluate', {
      expression: pageScript(urls), awaitPromise: true, returnByValue: true
    });
    if (res.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(res.exceptionDetails.text || res.exceptionDetails));
    const text = String(res.result.value || '');
    console.log(text);
    for (const line of text.split('\n')) {
      if (line.startsWith('PASS  ')) PASS++;
      else if (line.startsWith('FAIL  ')) FAIL++;
    }
    exitCode = FAIL ? 1 : 0;
  } catch (e) {
    console.error('失败: ' + (e && e.message));
    exitCode = 1;
  } finally {
    if (cdp) try { cdp.close(); } catch (_) { }
    try { proc.kill(); } catch (_) { }
    await sleep(300);
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (_) { }
  }

  console.log('\n' + '='.repeat(50));
  console.log('PASS ' + PASS + '   FAIL ' + FAIL);
  console.log('='.repeat(50));
  process.exit(exitCode);
})();
