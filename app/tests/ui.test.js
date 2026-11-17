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
    ok('已移除旧版镜花之琴并加入晚风圆号',
      realOpts.indexOf('real:floral_zither_old') === -1 && realOpts.indexOf('real:nightwind_horn') >= 0,
      realOpts.join(','));
    ok('合成音色被明确标成「备用」', synthOpts.length > 0 && /备用/.test(synthOpts[0].textContent),
      synthOpts[0] ? synthOpts[0].textContent : '无');

    const waitStat = async (pred) => {
      let s = '';
      for (let i = 0; i < 100; i++) {
        await sleep(100);
        s = $('#sampleStat').textContent;
        if (/\\/(?:14|21)/.test(s) && s.indexOf('正在加载') < 0 && pred(s)) break;
      }
      return s;
    };

    sel.value = realOpts[1];
    sel.dispatchEvent(new Event('change'));
    const s2 = await waitStat(() => true);
    ok('切换到「' + realOpts[1] + '」并完成加载（' + s2.trim() + '）', /\\/(?:14|21)/.test(s2), s2);

    sel.value = 'real:nightwind_horn';
    sel.dispatchEvent(new Event('change'));
    const sHorn = await waitStat(s => s.indexOf('晚风圆号') >= 0);
    const hornNotes = window.BGI_SAMPLE_SETS && window.BGI_SAMPLE_SETS['nightwind_horn'] && window.BGI_SAMPLE_SETS['nightwind_horn'].notes;
    ok('切换到晚风圆号（14/14，映射在 Q–U / A–J 且启用 sustain）',
      sHorn.indexOf('晚风圆号') >= 0 && /14\\/14/.test(sHorn) &&
      !!(window.BGI_SAMPLE_SETS['nightwind_horn'] && window.BGI_SAMPLE_SETS['nightwind_horn'].sustain) &&
      !!(hornNotes && hornNotes.C5 && hornNotes.C4 && !hornNotes.C3),
      sHorn);

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
    $('#btnPlayKeys').click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', code: 'KeyQ', bubbles: true }));
    await sleep(150);
    ok('关闭「键盘」后按键不再触发', !$('#btnPlayKeys').classList.contains('is-on') && energy() < 0.2, String(energy()));
    $('#btnPlayKeys').click();
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

    /* ───────── 5. 无模式合一：单行常驻工具栏 + 零布局跳动 + 新增/选中/改音高/删除/撤销/还原 ───────── */
    const before = notesCount();
    ok('无模式工具栏直接能读到音符数（' + before + '）', before > 0, String(before));
    ok('合一单行工具栏常驻显示', $('#editBar').hidden === false);

    const cv = $('#roll');
    const r = cv.getBoundingClientRect();
    const rollTopBefore = r.top;
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

    const rollTopAfter = cv.getBoundingClientRect().top;
    ok('无模式交互全程零像素纵向跳动', Math.abs(rollTopAfter - rollTopBefore) < 1,
      rollTopBefore + ' -> ' + rollTopAfter);

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

    /* ───────── 7. 3 模播放按钮循环切换 ───────── */
    const modeBtn = $('#btnPlayMode');
    ok('默认模式为「列表循环」', /列表循环/.test(modeBtn.textContent) && $('#autoplay').checked && !$('#loop').checked);
    modeBtn.click();
    await sleep(100);
    ok('点击一切到「单曲循环」', /单曲循环/.test(modeBtn.textContent) && $('#loop').checked && !$('#autoplay').checked);
    modeBtn.click();
    await sleep(100);
    ok('点击二切到「顺序播放」', /顺序播放/.test(modeBtn.textContent) && !$('#loop').checked && !$('#autoplay').checked);
    modeBtn.click();
    await sleep(100);
    ok('点击三回回「列表循环」', /列表循环/.test(modeBtn.textContent) && $('#autoplay').checked && !$('#loop').checked);

    /* ───────── 8. 方案 B 热更新（重新导入同名曲目，原地热重载） ───────── */
    const starLi = [...document.querySelectorAll('#scoreList li[data-id]')].find(li => /小星星/.test(li.textContent));
    starLi.click();
    await sleep(200);
    const titleBeforeHot = $('#npTitle').textContent;
    ok('选中小星星准备热更新（' + titleBeforeHot + '）', /小星星/.test(titleBeforeHot), titleBeforeHot);

    const hotDt = new DataTransfer();
    const hotSongObj = JSON.parse(texts[0]);
    hotSongObj.name = '小星星（热更新版）';
    if (Array.isArray(hotSongObj.notes)) {
      hotSongObj.notes.push({ key: 'Z', pitch: 48, start: 50, end: 350 });
    }
    const hotFileName = decodeURIComponent(urls[0].split('/').pop());
    hotDt.items.add(new File([JSON.stringify(hotSongObj)], hotFileName, { type: 'application/json' }));
    $('#fileInput').files = hotDt.files;
    $('#fileInput').dispatchEvent(new Event('change'));
    await sleep(350);

    const lisAfter = document.querySelectorAll('#scoreList li[data-id]');
    ok('热更新后歌曲数量未增加（覆盖更新）', lisAfter.length === 2, '当前数量 ' + lisAfter.length);
    const updatedTitle = $('#npTitle').textContent;
    ok('正在选中的曲目原地更新曲名（' + updatedTitle + '）', /热更新版/.test(updatedTitle), updatedTitle);

    /* ───────── 9. 新建曲谱与编曲工作流（从零建谱 / 改名 / 跨曲目保留编辑） ───────── */
    $('#btnNewScore').click();
    await sleep(200);
    const lisAfterNew = document.querySelectorAll('#scoreList li[data-id]');
    ok('点击「＋ 新建曲谱」后歌单增加到 3 首', lisAfterNew.length === 3, '当前数量 ' + lisAfterNew.length);
    ok('新曲谱自动选中且初始 0 音', $('#npTitle').textContent === '未命名曲谱 1' && notesCount() === 0,
      $('#npTitle').textContent + ' / ' + notesCount());
    ok('标题处于可内联编辑状态', $('#npTitle').getAttribute('contenteditable') === 'true');

    /* 在新曲谱网格上点击落音 */
    const rNew = cv.getBoundingClientRect();
    const cxNew = Math.round(rNew.left + rNew.width * 0.62);
    const cyNew = Math.round(rNew.top + rNew.height * 0.72);
    cv.dispatchEvent(new MouseEvent('click', { clientX: cxNew, clientY: cyNew, bubbles: true }));
    await sleep(150);
    ok('新曲谱点击网格落音成功（0 -> 1 音）', notesCount() === 1,
      notesCount() + ' / rect=' + Math.round(rNew.top) + 'x' + Math.round(rNew.height) + ' / info=' + $('#editInfo').textContent);
    ok('副标题实时更新音符统计（' + $('#npSub').textContent + '）', /原创.*1\\s*音/.test($('#npSub').textContent), $('#npSub').textContent);

    /* 内联改名且不触发琴键弹奏 */
    $('#npTitle').focus();
    $('#npTitle').textContent = '晨曦酒庄练习曲';
    $('#npTitle').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(120);
    const activeLiText = (document.querySelector('#scoreList li.sel .nm') || {}).textContent || '';
    ok('内联修改曲名同步到侧栏歌单（' + activeLiText + '）', activeLiText === '晨曦酒庄练习曲', activeLiText);

    /* 切换到其他曲目再切回，新编的音符不丢失 */
    document.querySelectorAll('#scoreList li[data-id]')[1].click();
    await sleep(150);
    document.querySelectorAll('#scoreList li[data-id]')[0].click();
    await sleep(150);
    ok('切歌再切回后新编曲谱音符保留（1 音）', notesCount() === 1 && $('#npTitle').textContent === '晨曦酒庄练习曲',
      $('#npTitle').textContent + ' / ' + notesCount());

    /* ───────── 10. 歌单曲目单独编辑重命名与单独删除 ───────── */
    const firstLi = document.querySelectorAll('#scoreList li[data-id]')[0];
    const editBtn = firstLi.querySelector('.li-edit');
    ok('歌单项带有单独编辑与删除按钮', !!editBtn && !!firstLi.querySelector('.li-del'));
    editBtn.click();
    await sleep(80);
    const nmNode = firstLi.querySelector('.nm');
    ok('点击歌单项编辑按钮进入行内编辑状态', nmNode.getAttribute('contenteditable') === 'true');
    nmNode.textContent = '风神之诗练习';
    nmNode.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(100);
    ok('歌单项行内改名后主标题与列表同步（' + $('#npTitle').textContent + '）',
      $('#npTitle').textContent === '风神之诗练习' &&
      document.querySelector('#scoreList li.sel .nm').textContent === '风神之诗练习');

    const delBtn = document.querySelector('#scoreList li[data-id] .li-del');
    delBtn.click();
    await sleep(150);
    const lisAfterSingleDel = document.querySelectorAll('#scoreList li[data-id]');
    ok('点击歌单项删除按钮仅移除该曲（3 -> 2 首）', lisAfterSingleDel.length === 2, '当前 ' + lisAfterSingleDel.length);
    ok('删除当前选中曲目后自动无缝切到下一首（' + $('#npTitle').textContent + '）',
      $('#npTitle').textContent !== '风神之诗练习' && $('#npTitle').textContent !== '未选择曲目');

    /* ───────── 11. 冗余空白清理 + ? 帮助弹窗 + 方向键微调时间戳 + 按键不松随时间戳实时拉长音符 ───────── */
    ok('音色与设置底部冗余 #diag 空白框已移除', !document.querySelector('#diag'));

    $('#btnHelp').click();
    await sleep(60);
    ok('点击「?」按钮打开操作说明弹窗', $('#helpModal').hidden === false);
    $('#btnHelpClose').click();
    await sleep(60);
    ok('点击关闭按钮收起操作说明弹窗', $('#helpModal').hidden === true);

    $('#btnNewScore').click();
    await sleep(150);
    ok('新建空白曲谱供录制与微调测试（0 音）', notesCount() === 0);

    /* 设置吸附步进为 100ms 并测试时间戳微调按钮与方向键 ArrowRight / ArrowLeft */
    $('#editSnap').value = '100';
    $('#editSnap').dispatchEvent(new Event('change'));
    $('#btnStepFwd').click();
    await sleep(80);
    ok('时间戳前进按钮微调 +100ms（' + $('#tNow').textContent + '）', $('#tNow').textContent === '0:00.1', $('#tNow').textContent);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }));
    await sleep(80);
    ok('方向键 → 微调当前时间戳 +100ms（' + $('#tNow').textContent + '）', $('#tNow').textContent === '0:00.2', $('#tNow').textContent);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', code: 'ArrowLeft', bubbles: true }));
    await sleep(80);
    ok('方向键 ← 微调当前时间戳 -100ms（' + $('#tNow').textContent + '）', $('#tNow').textContent === '0:00.1', $('#tNow').textContent);

    /* 开启录制：验证暂停态按住 Q 不松并用 → 后移时间戳时，未松键前音符实时变长 */
    $('#btnRecord').click();
    await sleep(80);
    ok('开启录制模式（按钮高亮且文案为「录制中」）', $('#btnRecord').classList.contains('is-rec') && /录制中/.test($('#btnRecordLabel').textContent));

    const recDurOf = () => {
      const m = /时值\\s*(\\d+)ms/.exec(($('#editInfo') || {}).textContent || '');
      return m ? parseInt(m[1], 10) : -1;
    };

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', code: 'KeyQ', bubbles: true }));
    await sleep(50);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }));
    await sleep(80);
    const heldStepDur = recDurOf();
    ok('暂停态按住 Q 不松并用 → 后移时间戳，未松键时音符已实时拉长（' + heldStepDur + 'ms）', heldStepDur >= 380, $('#editInfo').textContent);
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'q', code: 'KeyQ', bubbles: true }));
    await sleep(60);
    ok('暂停态录制完成（0 -> 1 音）', notesCount() === 1, '当前 ' + notesCount());

    /* 播放态：按住 W 不松，验证未松键期间音符时值随时间轴推进实时增长 */
    $('#btnPlay').click();
    await sleep(80);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', bubbles: true }));
    await sleep(60);
    const durEarly = recDurOf();
    await sleep(260);
    const durWhileHeld = recDurOf();
    ok('边播放边按住 W 不松，未松键期间音符随时间戳后移实时变长（' + durEarly + 'ms -> ' + durWhileHeld + 'ms）',
      durWhileHeld > durEarly && durWhileHeld >= 180, durEarly + ' -> ' + durWhileHeld + ' / ' + $('#editInfo').textContent);
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'w', code: 'KeyW', bubbles: true }));
    await sleep(80);
    $('#btnStop').click();
    await sleep(100);
    ok('边播放边按 W 键实时录制旋律（1 -> 2 音）', notesCount() === 2, '当前 ' + notesCount());

    $('#btnRecord').click();
    await sleep(60);
    ok('关闭录制模式恢复常态', !$('#btnRecord').classList.contains('is-rec'));

    /* ───────── 12. 拖拽修改 Ctrl+Z 撤销 + 批量框选与批量操作 + 时间段剪辑（删空白前移 / 插空白后移） ───────── */
    $('#btnNewScore').click();
    await sleep(120);
    const rBox = cv.getBoundingClientRect();
    const xN1 = Math.round(rBox.left + 38 + (rBox.width - 50) * 0.35);
    const yN1 = Math.round(rBox.top + rBox.height * 0.55);
    const xN2 = Math.round(rBox.left + 38 + (rBox.width - 50) * 0.72);
    const yN2 = Math.round(rBox.top + rBox.height * 0.45);

    /* 落第一个音符并测试鼠标拖拽移动后 Ctrl+Z 能否恢复原始起点 */
    cv.dispatchEvent(new MouseEvent('click', { clientX: xN1, clientY: yN1, bubbles: true }));
    await sleep(80);
    const origInfo1 = $('#editInfo').textContent;
    cv.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, clientX: xN1 + 2, clientY: yN1, bubbles: true }));
    cv.dispatchEvent(new PointerEvent('pointermove', { button: 0, pointerId: 1, clientX: xN1 + 90, clientY: yN1 - 18, bubbles: true }));
    cv.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 1, clientX: xN1 + 90, clientY: yN1 - 18, bubbles: true }));
    await sleep(80);
    const draggedInfo1 = $('#editInfo').textContent;
    ok('拖拽音符后起点/音高已改变（' + origInfo1 + ' -> ' + draggedInfo1 + '）', draggedInfo1 !== origInfo1, draggedInfo1);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true }));
    await sleep(80);
    cv.dispatchEvent(new MouseEvent('click', { clientX: xN1, clientY: yN1, bubbles: true }));
    await sleep(60);
    const restoredInfo1 = $('#editInfo').textContent;
    ok('拖拽修改后按 Ctrl+Z 成功恢复到拖拽前原始状态（' + restoredInfo1 + '）', restoredInfo1 === origInfo1,
      restoredInfo1 + ' vs ' + origInfo1);

    /* 在较远时间点落第二个音符，制造中间空白并测试矩形框选 */
    cv.dispatchEvent(new MouseEvent('click', { clientX: xN2, clientY: yN2, bubbles: true }));
    await sleep(80);
    const note2BeforeCut = $('#editInfo').textContent;
    ok('落第二个音符（共 2 音）', notesCount() === 2, note2BeforeCut);

    /* 在画布空白处按住左键拖拽框选两个音符 */
    const bxStart = Math.round(rBox.left + 44);
    const byStart = Math.round(rBox.top + 24);
    const bxEnd = Math.round(rBox.right - 16);
    const byEnd = Math.round(rBox.bottom - 8);
    cv.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 2, clientX: bxStart, clientY: byStart, bubbles: true }));
    cv.dispatchEvent(new PointerEvent('pointermove', { button: 0, pointerId: 2, clientX: bxEnd, clientY: byEnd, bubbles: true }));
    cv.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 2, clientX: bxEnd, clientY: byEnd, bubbles: true }));
    await sleep(80);
    ok('矩形框选成功选中 2 个音符（' + $('#editInfo').textContent + '）', /已选\\s*2\\s*音/.test($('#editInfo').textContent), $('#editInfo').textContent);

    /* 批量删除再 Ctrl+Z 撤销恢复 */
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await sleep(80);
    ok('批量删除框选的 2 个音符（2 -> 0 音）', notesCount() === 0, '当前 ' + notesCount());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true }));
    await sleep(80);
    ok('Ctrl+Z 撤销批量删除恢复 2 个音符', notesCount() === 2, '当前 ' + notesCount());

    /* 在两个音符之间的顶部时间轴表头拖拽选区，验证按钮变为「✂ 删时间段」并支持直接删除该时间空间 */
    const rulerY = Math.round(rBox.top + 8);
    const gapX0 = Math.round((xN1 + xN2) / 2 - 40);
    const gapX1 = Math.round((xN1 + xN2) / 2 + 40);
    cv.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 3, clientX: gapX0, clientY: rulerY, bubbles: true }));
    cv.dispatchEvent(new PointerEvent('pointermove', { button: 0, pointerId: 3, clientX: gapX1, clientY: rulerY, bubbles: true }));
    cv.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 3, clientX: gapX1, clientY: rulerY, bubbles: true }));
    await sleep(80);
    ok('顶部时间轴表头拖拽选中整段时间列，删除按钮自动变为「✂ 删时间段」（' + $('#editInfo').textContent + '）',
      /已选时间列/.test($('#editInfo').textContent) && !$('#btnDel').disabled && /删时间段/.test($('#btnDel').textContent),
      $('#editInfo').textContent + ' / btn=' + $('#btnDel').textContent);

    const durBeforeCut = $('#tTotal').textContent;
    $('#btnDel').click();
    await sleep(100);
    const durAfterCut = $('#tTotal').textContent;
    ok('删除顶部表头选定的时间列后后续音符整体前移、总时长缩短（' + durBeforeCut + ' -> ' + durAfterCut + '）',
      notesCount() === 2 && durAfterCut !== durBeforeCut && durAfterCut < durBeforeCut, durBeforeCut + ' -> ' + durAfterCut);

    /* 长音符中间插有早结束的短音符时，长音后半段仍可选中并拖拽右边缘改时长 */
    $('#btnNewScore').click();
    await sleep(100);
    const xLongStart = Math.round(rBox.left + 40 + (rBox.width - 50) * 0.30);
    const yLong = Math.round(rBox.top + rBox.height * 0.45);
    const yShort = Math.round(rBox.top + rBox.height * 0.65);
    cv.dispatchEvent(new MouseEvent('click', { clientX: xLongStart, clientY: yLong, bubbles: true }));
    await sleep(60);
    for (let k = 0; k < 6; k++) $('#btnDurUp').click();
    await sleep(60);
    const longInfoBefore = $('#editInfo').textContent;
    const longDurMatch = /时值\\s*(\\d+)ms/.exec(longInfoBefore);
    const longDurMs = longDurMatch ? parseInt(longDurMatch[1], 10) : 0;
    /* 在长音中途另一行落一个短音（它的 end 远早于长音的 end） */
    cv.dispatchEvent(new MouseEvent('click', { clientX: xLongStart + 70, clientY: yShort, bubbles: true }));
    await sleep(60);
    /* 计算长音右边缘坐标（roll 默认 8s 窗口，plotW = rBox.width - 46） */
    const plotW = rBox.width - 46;
    const xLongEdge = Math.round(xLongStart + (longDurMs / 8000) * plotW);
    /* 先清空选中，再悬停 & 拖拽长音右边缘 */
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(40);
    cv.dispatchEvent(new PointerEvent('pointermove', { clientX: xLongEdge, clientY: yLong, bubbles: true }));
    await sleep(40);
    const edgeCursor = cv.style.cursor;
    cv.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 4, clientX: xLongEdge, clientY: yLong, bubbles: true }));
    cv.dispatchEvent(new PointerEvent('pointermove', { button: 0, pointerId: 4, clientX: xLongEdge + 60, clientY: yLong, bubbles: true }));
    cv.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 4, clientX: xLongEdge + 60, clientY: yLong, bubbles: true }));
    await sleep(80);
    const longInfoAfter = $('#editInfo').textContent;
    const longDurAfterMatch = /时值\\s*(\\d+)ms/.exec(longInfoAfter);
    const longDurAfterMs = longDurAfterMatch ? parseInt(longDurAfterMatch[1], 10) : 0;
    ok('长音中途存在短音时，后半段右边缘仍可识别并拉长（cursor=' + edgeCursor + ', ' + longDurMs + 'ms -> ' + longDurAfterMs + 'ms）',
      edgeCursor === 'ew-resize' && longDurAfterMs > longDurMs,
      longInfoBefore + ' -> ' + longInfoAfter);

    return out.join('\\n');
  } catch (e) {
    out.push('FATAL  ' + (e && e.stack ? e.stack : e));
    return out.join('\\n');
  }
})()`;
}

(async function main() {
  if (!CHROME) { console.error('找不到 Chrome/Edge'); process.exit(2); }
  const userDir = path.join(os.tmpdir(), 'bgi-ui-' + Date.now());
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

  let cdp = null, exitCode = 1, fixtureDir = '';
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

    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgi-ui-fixtures-'));
    const mkNotes = (key, count) => {
      const ev = [];
      for (let i = 0; i < count; i++) {
        ev.push('D' + key + (i === 0 ? 0 : 100));
        ev.push('U' + key + 400);
      }
      return ev.join('|');
    };
    const fStar = path.join(fixtureDir, '小星星.json');
    const fCanon = path.join(fixtureDir, '卡农.json');
    fs.writeFileSync(fStar, JSON.stringify({
      name: '小星星', author: '测试样例', type: 'midi', bpm: '60', ticks: '1000',
      notes: mkNotes('G', 24)
    }), 'utf8');
    fs.writeFileSync(fCanon, JSON.stringify({
      name: '卡农', author: '测试样例', type: 'midi', bpm: '60', ticks: '1000',
      notes: mkNotes('D', 24)
    }), 'utf8');
    const fixtureFiles = [fStar, fCanon];
    const urls = fixtureFiles.map(p => url.pathToFileURL(p).href);

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

    /* ───────── 9. 原生 OS 拖放导入验收（验证非 fileInput 的真实 DragEvent） ───────── */
    const dragScorePath = fixtureFiles[0];
    await cdp.send('Input.dispatchDragEvent', {
      type: 'dragEnter', x: 400, y: 400,
      data: { items: [], files: [dragScorePath], dragOperationsMask: 1 }
    });
    await cdp.send('Input.dispatchDragEvent', {
      type: 'dragOver', x: 400, y: 400,
      data: { items: [], files: [dragScorePath], dragOperationsMask: 1 }
    });
    await cdp.send('Input.dispatchDragEvent', {
      type: 'drop', x: 400, y: 400,
      data: { items: [], files: [dragScorePath], dragOperationsMask: 1 }
    });
    await sleep(600);
    const dropCheck = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        toast: document.querySelector('.toast') ? document.querySelector('.toast').textContent : '',
        listCount: document.querySelectorAll('#scoreList li[data-id]').length
      })`,
      returnByValue: true
    });
    const dc = JSON.parse(dropCheck.result.value || '{}');
    ok('原生 OS 拖拽文件成功导入/热更新', /更新|导入/.test(dc.toast), 'toast: ' + dc.toast);

    /* ───────── 10. 顶栏 GitHub 跳转按钮 + 刷新后本地缓存持久化 ───────── */
    const preReload = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        ghHref: document.querySelector('#btnGithub') ? document.querySelector('#btnGithub').getAttribute('href') : '',
        ghTarget: document.querySelector('#btnGithub') ? document.querySelector('#btnGithub').getAttribute('target') : '',
        ghWidth: document.querySelector('#btnGithub') ? document.querySelector('#btnGithub').getBoundingClientRect().width : 0,
        listCount: document.querySelectorAll('#scoreList li[data-id]').length,
        npTitle: document.querySelector('#npTitle') ? document.querySelector('#npTitle').textContent : '',
        editInfo: document.querySelector('#editInfo') ? document.querySelector('#editInfo').textContent : ''
      })`,
      returnByValue: true
    });
    const pr = JSON.parse(preReload.result.value || '{}');
    ok('顶栏包含 GitHub 跳转按钮且链接正确',
      pr.ghHref === 'https://github.com/Upstream17/genshin-music-score-maker' && pr.ghTarget === '_blank' && pr.ghWidth > 0,
      JSON.stringify(pr));

    await cdp.send('Page.reload');
    await sleep(1200);
    const postReload = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        listCount: document.querySelectorAll('#scoreList li[data-id]').length,
        npTitle: document.querySelector('#npTitle') ? document.querySelector('#npTitle').textContent : '',
        editInfo: document.querySelector('#editInfo') ? document.querySelector('#editInfo').textContent : '',
        hasStorage: !!localStorage.getItem('bgi_lyre_workspace_v1')
      })`,
      returnByValue: true
    });
    const po = JSON.parse(postReload.result.value || '{}');
    ok('刷新页面后自动保留本地缓存曲目与当前选中曲谱',
      po.hasStorage && po.listCount === pr.listCount && po.npTitle === pr.npTitle && po.editInfo === pr.editInfo,
      'before=' + JSON.stringify(pr) + ' after=' + JSON.stringify(po));

    /* ───────── 11. 多客户端适配（顶栏折叠按钮 + 平板/手机抽屉 + 编辑区工具栏可分行） ───────── */
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(150);
    await cdp.send('Runtime.evaluate', { expression: `document.querySelector('#btnSidebar').click()` });
    await sleep(120);
    const deskCollapse = JSON.parse((await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        collapsed: document.querySelector('#appRoot').classList.contains('is-sidebar-collapsed'),
        expandedAttr: document.querySelector('#btnSidebar').getAttribute('aria-expanded'),
        sidebarWidth: document.querySelector('#sidebarPanel').getBoundingClientRect().width
      })`,
      returnByValue: true
    })).result.value || '{}');
    ok('桌面端顶栏按钮可折叠左侧曲目栏',
      deskCollapse.collapsed && deskCollapse.expandedAttr === 'false' && deskCollapse.sidebarWidth === 0,
      JSON.stringify(deskCollapse));
    await cdp.send('Runtime.evaluate', { expression: `document.querySelector('#btnSidebar').click()` });
    await sleep(120);

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 768, height: 1024, deviceScaleFactor: 2, mobile: true });
    await sleep(180);
    const tabletInit = JSON.parse((await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        drawerOpen: document.querySelector('#appRoot').classList.contains('is-sidebar-open'),
        expandedAttr: document.querySelector('#btnSidebar').getAttribute('aria-expanded'),
        docOverflow: document.documentElement.scrollWidth > window.innerWidth,
        resetRight: document.querySelector('#btnEditReset').getBoundingClientRect().right,
        exportRight: document.querySelector('#btnEditExport').getBoundingClientRect().right,
        winWidth: window.innerWidth,
        mainRight: document.querySelector('.main').getBoundingClientRect().right
      })`,
      returnByValue: true
    })).result.value || '{}');
    ok('平板视口默认收起曲目栏且工具栏无横向溢出',
      !tabletInit.drawerOpen && tabletInit.expandedAttr === 'false' && !tabletInit.docOverflow &&
      tabletInit.resetRight <= tabletInit.mainRight + 1 && tabletInit.exportRight <= tabletInit.winWidth + 1,
      JSON.stringify(tabletInit));

    const btnRectTablet = JSON.parse((await cdp.send('Runtime.evaluate', {
      expression: `(function(){ var r = document.querySelector('#btnSidebar').getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); })()`,
      returnByValue: true
    })).result.value || '{}');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btnRectTablet.x, y: btnRectTablet.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btnRectTablet.x, y: btnRectTablet.y, button: 'left', clickCount: 1 });
    await sleep(220);
    const tabletOpen = JSON.parse((await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        drawerOpen: document.querySelector('#appRoot').classList.contains('is-sidebar-open'),
        sidebarLeft: document.querySelector('#sidebarPanel').getBoundingClientRect().left,
        sidebarWidth: document.querySelector('#sidebarPanel').getBoundingClientRect().width
      })`,
      returnByValue: true
    })).result.value || '{}');
    ok('平板端点击顶栏按钮可展开曲目抽屉',
      tabletOpen.drawerOpen && tabletOpen.sidebarLeft >= 0 && tabletOpen.sidebarWidth >= 240,
      JSON.stringify(tabletOpen));
    await cdp.send('Runtime.evaluate', { expression: `document.querySelector('#btnSidebarClose').click()` });
    await sleep(220);

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 2, mobile: true });
    await sleep(180);
    const btnRectTabLand = JSON.parse((await cdp.send('Runtime.evaluate', {
      expression: `(function(){ var r = document.querySelector('#btnSidebar').getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); })()`,
      returnByValue: true
    })).result.value || '{}');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btnRectTabLand.x, y: btnRectTabLand.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btnRectTabLand.x, y: btnRectTabLand.y, button: 'left', clickCount: 1 });
    await sleep(150);
    const tabLandCollapse = JSON.parse((await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        collapsed: document.querySelector('#appRoot').classList.contains('is-sidebar-collapsed'),
        sidebarWidth: document.querySelector('#sidebarPanel').getBoundingClientRect().width
      })`,
      returnByValue: true
    })).result.value || '{}');
    ok('平板横屏点击顶栏按钮可折叠与恢复曲目栏',
      tabLandCollapse.collapsed && tabLandCollapse.sidebarWidth === 0,
      JSON.stringify(tabLandCollapse));
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btnRectTabLand.x, y: btnRectTabLand.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btnRectTabLand.x, y: btnRectTabLand.y, button: 'left', clickCount: 1 });
    await sleep(150);

    const tabLandScrollRoll = JSON.parse((await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        rollHeight: document.querySelector('#roll').getBoundingClientRect().height,
        scrollHeight: document.documentElement.scrollHeight,
        touchAction: getComputedStyle(document.querySelector('#roll')).touchAction
      })`,
      returnByValue: true
    })).result.value || '{}');
    ok('平板横屏允许页面上下滚动且卷帘区不被压缩（高 >= 310px）',
      tabLandScrollRoll.rollHeight >= 310 && tabLandScrollRoll.scrollHeight > 768 && tabLandScrollRoll.touchAction === 'none',
      JSON.stringify(tabLandScrollRoll));

    const touchMulti = await cdp.send('Runtime.evaluate', {
      expression: `(function(){
        var cv = document.querySelector('#roll');
        var r = cv.getBoundingClientRect();
        var x0 = r.left + r.width * 0.22, y0 = r.top + r.height * 0.15;
        var x1 = r.left + r.width * 0.88, y1 = r.top + r.height * 0.90;
        cv.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 9, pointerType: 'touch', clientX: x0, clientY: y0, bubbles: true }));
        cv.dispatchEvent(new PointerEvent('pointermove', { button: 0, pointerId: 9, pointerType: 'touch', clientX: x1, clientY: y1, bubbles: true }));
        cv.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 9, pointerType: 'touch', clientX: x1, clientY: y1, bubbles: true }));
        return (document.querySelector('#editInfo') || {}).textContent || '';
      })()`,
      returnByValue: true
    });
    ok('触屏手指拖拽框选可正常多选音符', /已选\s+\d+\s*音/.test(touchMulti.result.value || ''), touchMulti.result.value);

    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await sleep(140);
    const defaultLightInOsDark = JSON.parse((await cdp.send('Runtime.evaluate', {
      expression: `(function(){
        var cv = document.querySelector('#roll');
        var ctx = cv.getContext('2d');
        var px = ctx.getImageData(4, 4, 1, 1).data;
        var themeAttr = document.documentElement.getAttribute('data-theme');
        return JSON.stringify({ r: px[0], g: px[1], b: px[2], themeAttr: themeAttr });
      })()`,
      returnByValue: true
    })).result.value || '{}');
    ok('系统处于夜间模式时网页默认仍保持浅色纸白主题',
      defaultLightInOsDark.themeAttr !== 'dark' && defaultLightInOsDark.r > 230 && defaultLightInOsDark.g > 230 && defaultLightInOsDark.b > 230,
      JSON.stringify(defaultLightInOsDark));

    await cdp.send('Runtime.evaluate', { expression: `document.querySelector('#btnTheme').click()` });
    await sleep(140);
    const toggledDarkPx = JSON.parse((await cdp.send('Runtime.evaluate', {
      expression: `(function(){
        var cv = document.querySelector('#roll');
        var ctx = cv.getContext('2d');
        var px = ctx.getImageData(4, 4, 1, 1).data;
        var themeAttr = document.documentElement.getAttribute('data-theme');
        var pressed = document.querySelector('#btnTheme').getAttribute('aria-pressed');
        return JSON.stringify({ r: px[0], g: px[1], b: px[2], themeAttr: themeAttr, pressed: pressed });
      })()`,
      returnByValue: true
    })).result.value || '{}');
    ok('点击主题按钮可切换深色模式且编辑区画布同步深色配色',
      toggledDarkPx.themeAttr === 'dark' && toggledDarkPx.pressed === 'true' &&
      toggledDarkPx.r < 60 && toggledDarkPx.g < 60 && toggledDarkPx.b < 60,
      JSON.stringify(toggledDarkPx));

    await cdp.send('Runtime.evaluate', { expression: `document.querySelector('#btnTheme').click()` });
    await sleep(140);
    const toggledBackLightPx = JSON.parse((await cdp.send('Runtime.evaluate', {
      expression: `(function(){
        var cv = document.querySelector('#roll');
        var ctx = cv.getContext('2d');
        var px = ctx.getImageData(4, 4, 1, 1).data;
        var themeAttr = document.documentElement.getAttribute('data-theme');
        var pressed = document.querySelector('#btnTheme').getAttribute('aria-pressed');
        return JSON.stringify({ r: px[0], g: px[1], b: px[2], themeAttr: themeAttr, pressed: pressed });
      })()`,
      returnByValue: true
    })).result.value || '{}');
    ok('再次点击主题按钮可切回浅色纸白模式',
      toggledBackLightPx.themeAttr !== 'dark' && toggledBackLightPx.pressed === 'false' &&
      toggledBackLightPx.r > 230 && toggledBackLightPx.g > 230 && toggledBackLightPx.b > 230,
      JSON.stringify(toggledBackLightPx));
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await sleep(120);

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await sleep(180);
    const phoneCheck = JSON.parse((await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        docOverflow: document.documentElement.scrollWidth > window.innerWidth,
        rollHeadHeight: document.querySelector('.roll-head').getBoundingClientRect().height,
        resetRight: document.querySelector('#btnEditReset').getBoundingClientRect().right,
        exportRight: document.querySelector('#btnEditExport').getBoundingClientRect().right,
        zoomRight: document.querySelector('#zoom').getBoundingClientRect().right,
        mainRight: document.querySelector('.main').getBoundingClientRect().right
      })`,
      returnByValue: true
    })).result.value || '{}');
    ok('手机视口编辑区工具栏自动分行且无水平溢出',
      !phoneCheck.docOverflow && phoneCheck.rollHeadHeight > 42 &&
      phoneCheck.resetRight <= phoneCheck.mainRight + 1 && phoneCheck.exportRight <= 391 &&
      phoneCheck.zoomRight <= phoneCheck.mainRight + 1,
      JSON.stringify(phoneCheck));

    await cdp.send('Runtime.evaluate', { expression: `document.querySelector('#btnSidebar').click()` });
    await sleep(220);
    await cdp.send('Runtime.evaluate', {
      expression: `(function(){
        var lis = document.querySelectorAll('#scoreList li[data-id]');
        if (lis.length > 0) lis[0].click();
      })()`
    });
    await sleep(220);
    const phoneSelectClose = JSON.parse((await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        drawerOpen: document.querySelector('#appRoot').classList.contains('is-sidebar-open'),
        expandedAttr: document.querySelector('#btnSidebar').getAttribute('aria-expanded')
      })`,
      returnByValue: true
    })).result.value || '{}');
    ok('手机端在抽屉选择曲目后自动收起抽屉',
      !phoneSelectClose.drawerOpen && phoneSelectClose.expandedAttr === 'false',
      JSON.stringify(phoneSelectClose));

    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(100);

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    await sleep(220);
    const laptopOneScreen = JSON.parse((await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        docOverflow: document.documentElement.scrollHeight > window.innerHeight + 1,
        mainOverflow: (function(){ var m = document.querySelector('.main'); return m.scrollHeight > m.clientHeight + 2; })(),
        rollTop: document.querySelector('#roll').getBoundingClientRect().top,
        rollBottom: document.querySelector('#roll').getBoundingClientRect().bottom,
        rollHeight: document.querySelector('#roll').getBoundingClientRect().height,
        innerHeight: window.innerHeight
      })`,
      returnByValue: true
    })).result.value || '{}');
    ok('电脑端 1280x720 视口一屏智能缩放铺满（无上下滚动且卷帘贴底完整）',
      !laptopOneScreen.docOverflow && !laptopOneScreen.mainOverflow &&
      laptopOneScreen.rollHeight >= 220 && laptopOneScreen.rollBottom <= laptopOneScreen.innerHeight + 1,
      JSON.stringify(laptopOneScreen));

    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(100);

    /* ───────── 12. 顶栏「保存（Ctrl+S 覆盖原文件）」与「导出（另存为）」重构验收 ───────── */
    const saveExportRes = JSON.parse((await cdp.send('Runtime.evaluate', {
      expression: `(async function(){
        var out = {};
        out.saveInTop = !!document.querySelector('.top #btnEditSave');
        out.exportInTop = !!document.querySelector('.top #btnEditExport');
        out.exportInEditOps = !!document.querySelector('.edit-ops #btnEditExport');

        var baseDoc = {
          name: '顶栏保存测试',
          author: '原著',
          instrument: '风物之诗琴',
          description: '原始描述保留验证',
          type: 'midi',
          bpm: 60,
          ticks: 1000,
          notes: 'DZ200|UZ400|DG400|UG400'
        };
        var origDiskText = JSON.stringify(baseDoc);
        var origWriteCount = 0;
        var origHandle = {
          kind: 'file',
          name: 'top_save_test.json',
          queryPermission: async function(){ return 'granted'; },
          requestPermission: async function(){ return 'granted'; },
          getFile: async function(){
            return new File([origDiskText], 'top_save_test.json', { type: 'application/json' });
          },
          createWritable: async function(){
            return {
              write: async function(txt){ origDiskText = String(txt); origWriteCount++; },
              close: async function(){}
            };
          }
        };

        var copyDiskText = '';
        var copyWriteCount = 0;
        var copyHandle = {
          kind: 'file',
          name: 'top_save_copy.json',
          queryPermission: async function(){ return 'granted'; },
          requestPermission: async function(){ return 'granted'; },
          createWritable: async function(){
            return {
              write: async function(txt){ copyDiskText = String(txt); copyWriteCount++; },
              close: async function(){}
            };
          }
        };

        window.showOpenFilePicker = async function(){ return [origHandle]; };
        window.showSaveFilePicker = async function(){ return copyHandle; };

        document.querySelector('#btnPickFiles').click();
        for (var i = 0; i < 40; i++) {
          await new Promise(function(r){ setTimeout(r, 50); });
          if (document.querySelector('#npTitle').textContent === '顶栏保存测试') break;
        }
        out.loadedTitle = document.querySelector('#npTitle').textContent;

        /* 新增一个音符触发未保存状态 */
        var cv = document.querySelector('#roll');
        var rr = cv.getBoundingClientRect();
        cv.dispatchEvent(new MouseEvent('click', { clientX: Math.round(rr.left + rr.width * 0.65), clientY: Math.round(rr.top + rr.height * 0.25), bubbles: true }));
        await new Promise(function(r){ setTimeout(r, 100); });
        out.dirtyBeforeSave = document.querySelector('#btnEditSave').classList.contains('is-dirty');

        /* Ctrl+S 直接覆盖原文件 */
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true }));
        for (var j = 0; j < 30; j++) {
          await new Promise(function(r){ setTimeout(r, 50); });
          if (origWriteCount > 0 && !document.querySelector('#btnEditSave').classList.contains('is-dirty')) break;
        }
        var savedObj = JSON.parse(origDiskText);
        var parsedSaved = window.BGIParse.parseScore(savedObj);
        out.origWriteCount = origWriteCount;
        out.dirtyAfterSave = document.querySelector('#btnEditSave').classList.contains('is-dirty');
        out.savedNamePreserved = savedObj.name === '顶栏保存测试';
        out.savedDescPreserved = savedObj.description === '原始描述保留验证';
        out.savedNoteCount = parsedSaved.ok ? parsedSaved.stats.noteCount : -1;

        /* 再改一音，点击顶栏「导出」另存为副本，验证不覆盖原文件且不修改原绑定句柄 */
        cv.dispatchEvent(new MouseEvent('click', { clientX: Math.round(rr.left + rr.width * 0.78), clientY: Math.round(rr.top + rr.height * 0.30), bubbles: true }));
        await new Promise(function(r){ setTimeout(r, 100); });
        document.querySelector('#btnEditExport').click();
        for (var k = 0; k < 30; k++) {
          await new Promise(function(r){ setTimeout(r, 50); });
          if (copyWriteCount > 0) break;
        }
        var copyObj = copyDiskText ? JSON.parse(copyDiskText) : {};
        out.copyWriteCount = copyWriteCount;
        out.origWriteAfterExport = origWriteCount;
        out.copyName = copyObj.name || '';
        return JSON.stringify(out);
      })()`,
      awaitPromise: true,
      returnByValue: true
    })).result.value || '{}');

    ok('顶栏放置「保存」和「导出」按钮，且编辑区不再包含导出按钮',
      saveExportRes.saveInTop && saveExportRes.exportInTop && !saveExportRes.exportInEditOps,
      JSON.stringify(saveExportRes));
    ok('Ctrl+S 直接覆盖当前原文件（保留原曲名与描述并清除未保存标记）',
      saveExportRes.loadedTitle === '顶栏保存测试' && saveExportRes.dirtyBeforeSave &&
      saveExportRes.origWriteCount === 1 && !saveExportRes.dirtyAfterSave &&
      saveExportRes.savedNamePreserved && saveExportRes.savedDescPreserved && saveExportRes.savedNoteCount === 3,
      JSON.stringify(saveExportRes));
    ok('顶栏「导出」作为另存为新文件，不覆写原文件句柄',
      saveExportRes.copyWriteCount === 1 && saveExportRes.origWriteAfterExport === 1 &&
      /（编辑）/.test(saveExportRes.copyName),
      JSON.stringify(saveExportRes));

    await cdp.send('Runtime.evaluate', {
      expression: `document.querySelector('#btnClearList').click()`
    });
    await sleep(300);
    const clearedCheck = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        listCount: document.querySelectorAll('#scoreList li[data-id]').length,
        hasStorage: !!localStorage.getItem('bgi_lyre_workspace_v1')
      })`,
      returnByValue: true
    });
    const cc = JSON.parse(clearedCheck.result.value || '{}');
    ok('点击「清空」同步清理列表与本地缓存', cc.listCount === 0 && !cc.hasStorage, JSON.stringify(cc));

    exitCode = FAIL ? 1 : 0;
  } catch (e) {
    console.error('失败: ' + (e && e.message));
    exitCode = 1;
  } finally {
    if (cdp) try { cdp.close(); } catch (_) { }
    try { proc.kill(); } catch (_) { }
    await sleep(300);
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (_) { }
    try { if (typeof fixtureDir === 'string') fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch (_) { }
  }

  console.log('\n' + '='.repeat(50));
  console.log('PASS ' + PASS + '   FAIL ' + FAIL);
  console.log('='.repeat(50));
  process.exit(exitCode);
})();
