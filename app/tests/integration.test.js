#!/usr/bin/env node
/* ==========================================================================
   集成 / 契约测试（Lead 维护）
   --------------------------------------------------------------------------
   作用：两个实现件（bettergi-parse.js / audio-engine.js）都是「classic script +
   window 全局」的形态，无法直接 import。这里用 Node 的 vm 建一个最小 window 沙箱
   把它们跑起来，然后：
     1) 校验接口契约 v1 的成员是否齐全、类型是否正确；
     2) 跑它们各自的 selfTest()；
     3) 用解析器扫示范曲库 `library`，校验不变量（start<end、pitch∈[48,83]、key∈21键）
        并输出汇总。
   用法：
     node app/tests/integration.test.js                 # 用默认曲库路径
     node app/tests/integration.test.js "<曲库目录>"
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PLAYER = path.resolve(__dirname, '..');
const PROJECT = path.resolve(PLAYER, '..');

let PASS = 0, FAIL = 0, SKIP = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { PASS++; console.log('  \u2713 ' + name); }
  else { FAIL++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  \u2717 ' + name + (detail ? '  -> ' + detail : '')); }
}
function skip(name, why) { SKIP++; console.log('  - ' + name + '  (skip: ' + why + ')'); }
function section(t) { console.log('\n=== ' + t + ' ==='); }

/* selfTest 的 case 形态宽容读取：
   契约 v1 写的是 {name, ok, detail}，但实现里可能用 {name, status:'passed'|'failed'|'skipped', expected, actual}。
   两种都认，免得把「通过」误报成「失败」。 */
function caseStatus(c) {
  if (!c) return 'unknown';
  if (typeof c.ok === 'boolean') return c.ok ? 'passed' : 'failed';
  if (typeof c.status === 'string') {
    if (c.status === 'pass' || c.status === 'passed' || c.status === 'ok') return 'passed';
    if (c.status === 'skip' || c.status === 'skipped') return 'skipped';
    return 'failed';
  }
  if (typeof c.passed === 'boolean') return c.passed ? 'passed' : 'failed';
  return 'unknown';
}
function caseDetail(c) {
  if (!c) return '';
  if (c.detail) return c.detail;
  var parts = [];
  if (c.expected !== undefined) parts.push('期望 ' + JSON.stringify(c.expected));
  if (c.actual !== undefined) parts.push('实际 ' + JSON.stringify(c.actual));
  if (c.reason) parts.push(String(c.reason));
  return parts.join(' / ');
}

/* ---------------- 把 classic script 装进最小 window 沙箱 ---------------- */
function loadScript(relPath) {
  const file = path.join(PLAYER, relPath);
  if (!fs.existsSync(file)) return { error: '文件不存在: ' + file };
  const code = fs.readFileSync(file, 'utf8');

  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Math, JSON, Date, Array, Object, String, Number, Boolean, RegExp, Error,
    parseFloat, parseInt, isFinite, isNaN, encodeURIComponent, decodeURIComponent,
    performance: { now: () => Date.now() },
    navigator: { userAgent: 'node' },
    document: undefined,
    AudioContext: undefined,
    webkitAudioContext: undefined,
    FileReader: undefined
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  try {
    vm.runInContext(code, sandbox, { filename: file });
  } catch (e) {
    return { error: '加载即抛异常: ' + (e && e.message) };
  }
  return { sandbox, file };
}

/* ---------------- 递归找 .json ---------------- */
function walkJson(dir, out, limit) {
  out = out || [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      walkJson(p, out, limit);
    } else if (/\.json$/i.test(e.name)) {
      out.push(p);
      if (limit && out.length >= limit) return out;
    }
  }
  return out;
}

/* ========================================================================== */
console.log('项目根: ' + PROJECT);
console.log('player : ' + PLAYER);

/* ---------------------------- 1. 解析器 ---------------------------- */
section('1. window.BGIParse（曲谱解析器）');
const P = loadScript('js/bettergi-parse.js');

if (P.error) {
  ok('bettergi-parse.js 可加载', false, P.error);
} else {
  const API = P.sandbox.BGIParse;
  ok('bettergi-parse.js 可加载', true);
  ok('window.BGIParse 存在', !!API);

  if (API) {
    const KEYMAP = API.KEY_TO_PITCH || {};
    const EXPECT = { Z:48, X:50, C:52, V:53, B:55, N:57, M:59, A:60, S:62, D:64, F:65, G:67, H:69, J:71, Q:72, W:74, E:76, R:77, T:79, Y:81, U:83 };
    let mapOk = true, badMap = [];
    for (const k in EXPECT) if (KEYMAP[k] !== EXPECT[k]) { mapOk = false; badMap.push(k + '=' + KEYMAP[k]); }
    ok('KEY_TO_PITCH 21 键与 BetterGI StandardMappings 完全一致', mapOk,
      badMap.length ? '不一致: ' + badMap.join(',') : ('实际 ' + Object.keys(KEYMAP).length + ' 键'));

    ok('PITCH_TO_KEY 反向表存在且自洽', !!API.PITCH_TO_KEY &&
      Object.keys(EXPECT).every(k => API.PITCH_TO_KEY[EXPECT[k]] === k));
    ok('SUPPORTED_KEYS 为 21 个', Array.isArray(API.SUPPORTED_KEYS) && API.SUPPORTED_KEYS.length === 21,
      API.SUPPORTED_KEYS ? String(API.SUPPORTED_KEYS.length) : 'undefined');
    ok('typeof parseScore === function', typeof API.parseScore === 'function');
    ok('typeof pitchName === function', typeof API.pitchName === 'function');
    if (typeof API.pitchName === 'function') {
      ok('pitchName(60) === "C4"', API.pitchName(60) === 'C4', API.pitchName(60));
      ok('pitchName(48) === "C3"', API.pitchName(48) === 'C3', API.pitchName(48));
      ok('pitchName(83) === "B5"', API.pitchName(83) === 'B5', API.pitchName(83));
    }

    /* 三个 type 的最小样例 */
    if (typeof API.parseScore === 'function') {
      const s1 = API.parseScore({ name: 't', type: 'midi', bpm: '60', ticks: '1000', notes: 'DZ0|UZ500|' });
      ok('midi 型最小样例 ok', s1 && s1.ok === true, s1 && s1.error);
      if (s1 && s1.ok) {
        ok('midi 型解析出 1 个音', s1.notes.length === 1, 'notes=' + s1.notes.length);
        if (s1.notes.length) {
          const n = s1.notes[0];
          ok('midi 型 pitch=48 / key=Z', n.pitch === 48 && n.key === 'Z', JSON.stringify(n));
          ok('midi 型 start≈0, end≈500', Math.abs(n.start - 0) < 1 && Math.abs(n.end - 500) < 1, JSON.stringify(n));
        }
      }

      const s2 = API.parseScore({ name: 't', type: 'yuanqin', bpm: '60', time_signature: '4/4', notes: 'Z[4]X[4]|' });
      ok('yuanqin 型最小样例 ok', s2 && s2.ok === true, s2 && s2.error);
      if (s2 && s2.ok) {
        ok('yuanqin 型解析出 2 个音', s2.notes.length === 2, 'notes=' + s2.notes.length);
        if (s2.notes.length === 2) {
          ok('yuanqin 型一拍 = 1000ms', Math.abs(s2.notes[0].end - s2.notes[0].start - 1000) < 1,
            JSON.stringify(s2.notes[0]));
          ok('yuanqin 型第二个音 start≈1000', Math.abs(s2.notes[1].start - 1000) < 2,
            String(s2.notes[1].start));
        }
      }

      const s3 = API.parseScore({ name: 't', type: 'keyboard', bpm: '120', notes: 'ZX' });
      ok('keyboard 型最小样例 ok', s3 && s3.ok === true, s3 && s3.error);
      if (s3 && s3.ok) {
        /* bpm=120 ⇒ 1 拍 = 500ms；`ZX` = Z 占 1 拍、X 占 1 拍 */
        ok('keyboard 型：Z 在 0ms', s3.notes[0] && Math.abs(s3.notes[0].start - 0) < 1,
          s3.notes[0] && String(s3.notes[0].start));
        ok('keyboard 型：X 在 500ms（顺序推进 1 拍）',
          s3.notes[1] && Math.abs(s3.notes[1].start - 500) < 1,
          s3.notes[1] && String(s3.notes[1].start));
      }

      /* ---- keyboard 预处理 5 步（spec §4.1）：空格→0、`-`=+1拍、括号同构、`>` 删除 ---- */
      const kb = (notes) => API.parseScore({ name: 't', type: 'keyboard', bpm: '120', notes: notes });

      const kSpace = kb('Z X');
      ok('keyboard：空格 → 休止（X 被推到 1000ms）',
        kSpace && kSpace.ok && kSpace.notes[1] && Math.abs(kSpace.notes[1].start - 1000) < 1,
        kSpace && kSpace.ok ? String(kSpace.notes[1] && kSpace.notes[1].start) : (kSpace && kSpace.error));

      const kDash = kb('Z-X');
      ok('keyboard：`-` 每次只 +1 拍（Z 占 2 拍 ⇒ X 在 1000ms）',
        kDash && kDash.ok && kDash.notes[1] && Math.abs(kDash.notes[1].start - 1000) < 1,
        kDash && kDash.ok ? String(kDash.notes[1] && kDash.notes[1].start) : (kDash && kDash.error));

      const kChord = kb('(ZX)');
      ok('keyboard：`(...)` 和弦 = 同刻',
        kChord && kChord.ok && kChord.notes.length === 2 &&
        Math.abs(kChord.notes[0].start - kChord.notes[1].start) < 1e-6,
        kChord && kChord.ok ? JSON.stringify(kChord.notes.map(n => n.start)) : (kChord && kChord.error));

      const kArp = kb('[ZX]');
      ok('keyboard：`[...]` 琶音 = 均分时值（第二个音在 250ms）',
        kArp && kArp.ok && kArp.notes[1] && Math.abs(kArp.notes[1].start - 250) < 1,
        kArp && kArp.ok ? String(kArp.notes[1] && kArp.notes[1].start) : (kArp && kArp.error));

      const kGt = kb('Z>X');
      ok('keyboard：`>` 被删除（等价于 ZX ⇒ X 在 500ms）',
        kGt && kGt.ok && kGt.notes[1] && Math.abs(kGt.notes[1].start - 500) < 1,
        kGt && kGt.ok ? String(kGt.notes[1] && kGt.notes[1].start) : (kGt && kGt.error));

      const kRest0 = kb('Z0X');
      ok('keyboard：字面 `0` 也是休止（X 在 1000ms）',
        kRest0 && kRest0.ok && kRest0.notes[1] && Math.abs(kRest0.notes[1].start - 1000) < 1,
        kRest0 && kRest0.ok ? String(kRest0.notes[1] && kRest0.notes[1].start) : (kRest0 && kRest0.error));

      const s4 = API.parseScore({ name: 't', type: 'nosuchtype', notes: 'Z[4]' });
      ok('未知 type -> ok:false', s4 && s4.ok === false, s4 && JSON.stringify({ ok: s4.ok, error: s4.error }));

      const s5 = API.parseScore({ name: 't', type: 'midi' });
      ok('缺 notes -> ok:false', s5 && s5.ok === false, s5 && JSON.stringify({ ok: s5.ok, error: s5.error }));

      const s6 = API.parseScore({ name: 't', bpm: 100, notes: 'Z[4]X[4]' });
      ok('缺 type 时按 yuanqin 处理（BetterGI 默认）', s6 && s6.ok === true && s6.type === 'yuanqin',
        s6 && JSON.stringify({ ok: s6.ok, type: s6.type, err: s6.error }));
    }

    /* 全库扫描 */
    const libArg = process.argv[2];
    const libDir = libArg ? path.resolve(libArg) : path.join(PROJECT, 'library');
    if (!fs.existsSync(libDir)) {
      skip('全库扫描', '目录不存在: ' + libDir);
    } else if (typeof API.parseScore !== 'function') {
      skip('全库扫描', 'parseScore 不可用');
    } else {
      const files = walkJson(libDir, []);
      console.log('\n  [全库] ' + libDir + '  共 ' + files.length + ' 个 json');
      const byType = {}, badFiles = [];
      let totalNotes = 0, invalidPitch = 0, invalidKey = 0, nonPosLen = 0, unsorted = 0, zeroNote = 0;
      for (const f of files) {
        let obj;
        try { obj = JSON.parse(fs.readFileSync(f, 'utf8')); }
        catch (e) { badFiles.push([f, 'JSON 解析失败: ' + e.message]); continue; }
        let sc;
        try { sc = API.parseScore(obj, { filename: path.basename(f) }); }
        catch (e) { badFiles.push([f, 'parseScore 抛异常: ' + (e && e.message)]); continue; }
        if (!sc || !sc.ok) { badFiles.push([f, 'ok:false -> ' + (sc && sc.error)]); continue; }
        byType[sc.type] = (byType[sc.type] || 0) + 1;
        totalNotes += sc.notes.length;
        if (!sc.notes.length) zeroNote++;
        let prev = -Infinity;
        for (const n of sc.notes) {
          if (!(n.pitch >= 48 && n.pitch <= 83)) invalidPitch++;
          if (typeof n.key !== 'string' || n.key.length !== 1 || !(n.key in EXPECT)) invalidKey++;
          if (!(n.end > n.start)) nonPosLen++;
          if (n.start < prev - 1e-9) unsorted++;
          prev = n.start;
        }
      }
      ok('全库全部文件 ok', badFiles.length === 0,
        badFiles.length ? badFiles.length + ' 个失败，例如 ' + badFiles.slice(0, 5).map(x => path.basename(x[0]) + ' (' + x[1] + ')').join(' | ') : '');
      ok('全库 pitch 全部落在 48..83', invalidPitch === 0, invalidPitch + ' 个越界');
      ok('全库 key 全部是 21 键之一', invalidKey === 0, invalidKey + ' 个非法');
      ok('全库 start < end 恒成立', nonPosLen === 0, nonPosLen + ' 个非正时长');
      ok('全库 notes 按 start 非降序', unsorted === 0, unsorted + ' 处乱序');
      console.log('  [全库] type 分布: ' + JSON.stringify(byType));
      console.log('  [全库] 总音符数: ' + totalNotes + '，空谱 ' + zeroNote + ' 首');
      if (badFiles.length) {
        console.log('  [全库] 失败样例:');
        badFiles.slice(0, 20).forEach(x => console.log('      - ' + path.relative(PROJECT, x[0]) + ' :: ' + x[1]));
      }
    }

    /* selfTest */
    if (typeof API.selfTest === 'function') {
      try {
        const r = API.selfTest();
        const cases = r.cases || [];
        const st = { passed: 0, failed: 0, skipped: 0, unknown: 0 };
        cases.forEach(c => { st[caseStatus(c)] = (st[caseStatus(c)] || 0) + 1; });
        console.log('  [BGIParse.selfTest] passed=' + r.passed + ' failed=' + r.failed +
          (r.skipped != null ? ' skipped=' + r.skipped : '') +
          '  |  cases 统计 ' + JSON.stringify(st));
        cases.filter(c => caseStatus(c) === 'failed').forEach(c =>
          console.log('      \u2717 ' + c.name + '  ' + caseDetail(c)));
        ok('BGIParse.selfTest() 无 failed', !r.failed, r.failed + ' 个失败');
      } catch (e) { ok('BGIParse.selfTest() 可运行', false, (e && e.message)); }
    } else {
      skip('BGIParse.selfTest()', '未实现');
    }
  }
}

/* ---------------------------- 2. 音频引擎 ---------------------------- */
section('2. window.BGIAudio（音频引擎）');
const A = loadScript('js/audio-engine.js');

if (A.error) {
  ok('audio-engine.js 可加载', false, A.error);
} else {
  const API = A.sandbox.BGIAudio;
  ok('audio-engine.js 可加载（无 AudioContext 也不抛）', true);
  ok('window.BGIAudio 存在', !!API);

  if (API) {
    ok('typeof createEngine === function', typeof API.createEngine === 'function');
    ok('typeof listInstruments === function', typeof API.listInstruments === 'function');
    ok('typeof mapNameToPitch === function（契约要求可在 Node 下测的纯函数）',
      typeof API.mapNameToPitch === 'function');

    if (typeof API.listInstruments === 'function') {
      let list = [];
      try { list = API.listInstruments() || []; } catch (e) { list = []; }
      ok('listInstruments() 返回非空数组', Array.isArray(list) && list.length > 0,
        'len=' + (list && list.length));
      const ids = list.map(x => x.id);
      ok('内置音色包含 windsong（风物之诗琴）', ids.indexOf('windsong') >= 0, ids.join(','));
      console.log('  [音色] ' + list.map(x => x.id + '(' + x.kind + ')').join(', '));
    }

    if (typeof API.mapNameToPitch === 'function') {
      const cases = [
        ['C3.wav', 48], ['C4.mp3', 60], ['A4.wav', 69], ['B5.ogg', 83],
        ['c3.wav', 48], ['a4.WAV', 69], ['C#3.wav', 49], ['Db4.mp3', 61],
        ['Z.wav', 48], ['U.wav', 83], ['q.wav', 72],
        ['48.wav', 48], ['83.wav', 83], ['60.wav', 60],
        ['noise.wav', null], ['', null]
      ];
      let bad = [];
      for (const [name, want] of cases) {
        let got;
        try { got = API.mapNameToPitch(name); } catch (e) { got = 'throw:' + e.message; }
        const g = (got === undefined) ? null : got;
        if (g !== want) bad.push(name + ' -> ' + g + ' (期望 ' + want + ')');
      }
      ok('mapNameToPitch 16 个命名用例', bad.length === 0, bad.join(' | '));
    }

    if (typeof API.selfTest === 'function') {
      try {
        const r = API.selfTest();
        const cases = r.cases || [];
        const st = { passed: 0, failed: 0, skipped: 0, unknown: 0 };
        cases.forEach(c => { st[caseStatus(c)] = (st[caseStatus(c)] || 0) + 1; });
        console.log('  [BGIAudio.selfTest] passed=' + r.passed + ' failed=' + r.failed +
          (r.skipped != null ? ' skipped=' + r.skipped : '') +
          '  |  cases 统计 ' + JSON.stringify(st));
        cases.filter(c => caseStatus(c) === 'failed').forEach(c =>
          console.log('      \u2717 ' + c.name + '  ' + caseDetail(c)));
        ok('BGIAudio.selfTest() 无 failed', !r.failed, r.failed + ' 个失败');
      } catch (e) { ok('BGIAudio.selfTest() 可运行', false, (e && e.message)); }
    } else {
      skip('BGIAudio.selfTest()', '未实现');
    }

    /* createEngine 在无 Web Audio 环境下不应把进程炸掉 */
    if (typeof API.createEngine === 'function') {
      try {
        const eng = API.createEngine();
        ok('createEngine() 在 Node 下不抛异常', true);
        const need = ['setMasterVolume', 'setInstrument', 'noteOn', 'noteOff', 'stopAll', 'resume', 'loadSampleFiles'];
        const miss = need.filter(m => typeof eng[m] !== 'function');
        ok('Engine 成员齐全（含 loadSampleFiles）', miss.length === 0, '缺: ' + miss.join(','));
        try { eng.noteOn(60, 1.0, 0.5, 1); ok('无 AudioContext 时 noteOn 不抛', true); }
        catch (e) { ok('无 AudioContext 时 noteOn 不抛', false, e && e.message); }
        try { eng.stopAll(); ok('无 AudioContext 时 stopAll 不抛', true); }
        catch (e) { ok('无 AudioContext 时 stopAll 不抛', false, e && e.message); }
      } catch (e) {
        ok('createEngine() 在 Node 下不抛异常', false, e && e.message);
      }
    }
  }
}

/* ---------------------------- 3. 页面装配 ---------------------------- */
section('3. 页面装配（index.html / app.js 引用一致性）');
const htmlPath = path.join(PLAYER, 'index.html');
const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : null;
ok('index.html 存在', !!html);
if (html) {
  /* CSS 必须内联：部分内嵌网页预览器会拦外部样式表（实测 <script src> 放行、<link rel=stylesheet> 不生效） */
  ok('样式已内联（<style> 块足够大）', /<style>[\s\S]{2000,}<\/style>/.test(html));
  ok('不再依赖外部样式表', html.indexOf('rel="stylesheet"') < 0);
  ['js/bettergi-parse.js', 'js/audio-engine.js', 'js/app.js'].forEach(rel => {
    ok('index.html 引用 ' + rel, html.indexOf(rel) >= 0);
    ok('  且 ' + rel + ' 文件真实存在', fs.existsSync(path.join(PLAYER, rel)));
  });
  ok('index.html 没有使用 ES module（type="module"）', html.indexOf('type="module"') < 0);
  ok('index.html 没有外部 http(s) 资源引用',
    !/<(?:script|img|audio|video|source|iframe)\b[^>]*\bsrc\s*=\s*["']https?:/i.test(html) &&
    !/<link\b[^>]*\bhref\s*=\s*["']https?:/i.test(html));
}
const appSrc = fs.existsSync(path.join(PLAYER, 'js/app.js'))
  ? fs.readFileSync(path.join(PLAYER, 'js/app.js'), 'utf8') : '';
ok('app.js 没有 fetch(', appSrc.indexOf('fetch(') < 0);
ok('app.js 没有 import/export 语句', !/^\s*(import|export)\s/m.test(appSrc));

/* ---------------------------- 汇总 ---------------------------- */
console.log('\n' + '='.repeat(60));
console.log('PASS ' + PASS + '   FAIL ' + FAIL + '   SKIP ' + SKIP);
if (failures.length) {
  console.log('\n失败项:');
  failures.forEach(f => console.log('  - ' + f));
}
console.log('='.repeat(60));
process.exit(FAIL ? 1 : 0);
