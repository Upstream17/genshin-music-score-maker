#!/usr/bin/env node
/*
 * app/tests/parse.test.js —— BetterGI 曲谱解析器全库测试（Node，零依赖）
 *
 * 用法：
 *   node app/tests/parse.test.js "library"
 *
 * 做四件事：
 *   1. 递归遍历 <dir> 下所有 .json，逐个交给 BGIParse.parseScore；
 *   2. 断言 ok 覆盖所有可解析文件，且每个音符满足
 *        start < end、pitch ∈ [48,83]、key ∈ 21 键、notes 按 start 非降序；
 *   3. 打印 type 分布、ok/failed 计数、总音符数、每首持续时间、失败清单；
 *   4. 跑 BGIParse.selfTest() 并打印结果。
 *
 * 退出码：有断言失败 / 解析失败则 1，否则 0。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ------------------------------------------------------------------ *
 * 载入被测模块（IIFE + classic script，Node 里用 vm 取 globalThis.BGIParse）
 * ------------------------------------------------------------------ */

const PARSER_PATH = path.resolve(__dirname, '..', 'js', 'bettergi-parse.js');

function loadParser() {
  const source = fs.readFileSync(PARSER_PATH, 'utf8');

  // 先自证「纯 classic script」：不能出现 import / export / require / fetch
  const banned = [
    { re: /^\s*import\s/m, what: 'import 语句' },
    { re: /^\s*export\s/m, what: 'export 语句' },
    { re: /\brequire\s*\(/, what: 'require() 调用' },
    { re: /\bfetch\s*\(/, what: 'fetch() 调用' },
    { re: /\bimportScripts\s*\(/, what: 'importScripts() 调用' }
  ];
  for (const b of banned) {
    if (b.re.test(source)) {
      throw new Error('bettergi-parse.js 出现被禁用的 ' + b.what);
    }
  }

  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: PARSER_PATH });

  const mod = sandbox.BGIParse;
  if (!mod) { throw new Error('脚本没有在 globalThis 上挂 BGIParse'); }
  return mod;
}

let BGIParse;
try {
  BGIParse = loadParser();
} catch (e) {
  console.error('[FATAL] 载入 app/js/bettergi-parse.js 失败：' + e.message);
  process.exit(2);
}

/* ------------------------------------------------------------------ *
 * 参数与文件遍历
 * ------------------------------------------------------------------ */

const dirArg = process.argv[2] || 'library';
const ROOT = path.resolve(process.cwd(), dirArg);

if (!fs.existsSync(ROOT) || !fs.statSync(ROOT).isDirectory()) {
  console.error('[FATAL] 目录不存在：' + ROOT);
  process.exit(2);
}

const SUPPORTED_KEY_SET = new Set(BGIParse.SUPPORTED_KEYS);

function walkJson(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkJson(full, out);
    } else if (ent.isFile() && /\.json$/i.test(ent.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = walkJson(ROOT, []);

/* ------------------------------------------------------------------ *
 * 主循环
 * ------------------------------------------------------------------ */

const rel = (p) => path.relative(ROOT, p) || p;

const typeCount = {};
const typeOk = {};
const typeNotes = {};
const typeDuration = {};
const failures = [];        // {file, reason, kind}
const parseFailed = [];     // ok:false
const invariantFailed = []; // 断言失败
const durations = [];       // {file, ms, type}
let totalNotes = 0;
let totalEvents = 0;
let totalWarnings = 0;
const warningKinds = {};
let maxPolyphony = 0;
let maxPolyphonyFile = '';
let notesWithZeroOrNegative = 0;
let pitchesOut = 0;
const keysUsedGlobal = new Set();

function fail(kind, file, reason) {
  failures.push({ kind, file, reason });
  if (kind === 'parse') { parseFailed.push({ file, reason }); } else { invariantFailed.push({ file, reason }); }
}

for (const file of files) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    fail('parse', file, '读取失败：' + e.message);
    continue;
  }

  let obj;
  try {
    obj = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (e) {
    fail('parse', file, 'JSON 解析失败：' + e.message);
    continue;
  }

  let score;
  try {
    score = BGIParse.parseScore(obj);
  } catch (e) {
    fail('parse', file, 'parseScore 抛出异常（契约要求绝不抛）：' + e.message);
    continue;
  }

  const type = score.type || (obj && obj.type) || '(缺省)';
  const bucket = obj && obj.type ? String(obj.type) : '(缺省→yuanqin)';
  typeCount[bucket] = (typeCount[bucket] || 0) + 1;

  if (!score.ok) {
    fail('parse', file, 'ok:false — ' + score.error);
    continue;
  }

  typeOk[bucket] = (typeOk[bucket] || 0) + 1;
  typeNotes[bucket] = (typeNotes[bucket] || 0) + score.notes.length;
  typeDuration[bucket] = (typeDuration[bucket] || 0) + score.stats.durationMs;

  totalNotes += score.notes.length;
  totalEvents += score.stats.events;
  totalWarnings += score.warnings.length;
  for (const w of score.warnings) {
    const kind = w.replace(/[0-9]+/g, 'N').slice(0, 28);
    warningKinds[kind] = (warningKinds[kind] || 0) + 1;
  }
  for (const k of score.stats.keysUsed) { keysUsedGlobal.add(k); }

  if (score.stats.maxPolyphony > maxPolyphony) {
    maxPolyphony = score.stats.maxPolyphony;
    maxPolyphonyFile = rel(file);
  }

  durations.push({ file: rel(file), ms: score.stats.durationMs, type: bucket });

  // ---- 契约不变量 ----
  const problems = [];
  let prevStart = -Infinity;

  for (let i = 0; i < score.notes.length; i++) {
    const n = score.notes[i];

    if (!(n.start < n.end)) {
      notesWithZeroOrNegative++;
      problems.push('第 ' + i + ' 音 start=' + n.start + ' >= end=' + n.end);
    }
    if (!(n.pitch >= 48 && n.pitch <= 83)) {
      pitchesOut++;
      problems.push('第 ' + i + ' 音 pitch=' + n.pitch + ' 越界');
    }
    if (!SUPPORTED_KEY_SET.has(n.key)) {
      problems.push('第 ' + i + ' 音 key=' + n.key + ' 不在 21 键内');
    }
    if (BGIParse.KEY_TO_PITCH[n.key] !== n.pitch) {
      problems.push('第 ' + i + ' 音 key/pitch 不自洽 ' + n.key + '/' + n.pitch);
    }
    if (typeof n.velocity !== 'number') {
      problems.push('第 ' + i + ' 音缺 velocity');
    }
    if (n.start < prevStart) {
      problems.push('第 ' + i + ' 音 start=' + n.start + ' 小于前一个 ' + prevStart + '（未按 start 升序）');
    }
    prevStart = n.start;

    if (problems.length > 6) { problems.push('…（更多省略）'); break; }
  }

  if (score.notes.length === 0) {
    problems.push('可解析但 0 个音符');
  }
  if (typeof score.stats.durationMs !== 'number' || !(score.stats.durationMs >= 0)) {
    problems.push('durationMs 非法：' + score.stats.durationMs);
  }

  if (problems.length) {
    fail('invariant', file, problems.join('; '));
  }
}

/* ------------------------------------------------------------------ *
 * 报告
 * ------------------------------------------------------------------ */

const line = (s) => console.log(s);
const okCount = files.length - parseFailed.length;

line('============================================================');
line(' BetterGI 曲谱解析器 · 全库测试');
line(' 脚本 : ' + rel(PARSER_PATH));
line(' 曲库 : ' + ROOT);
line('============================================================');
line('');
line('[1] 文件与解析结果');
line('  扫描 JSON 文件      : ' + files.length);
line('  解析成功 (ok:true)  : ' + (files.length - parseFailed.length - invariantFailed.length));
line('  解析失败 (ok:false) : ' + parseFailed.length);
line('  不变量失败          : ' + invariantFailed.length);
line('');

line('[2] type 分布（按文件里的原始 type 字段，缺省单列）');
const buckets = Object.keys(typeCount).sort();
const pad = (s, n) => String(s).padEnd(n, ' ');
for (const b of buckets) {
  const n = typeCount[b];
  const okN = typeOk[b] || 0;
  const notesN = typeNotes[b] || 0;
  const durN = typeDuration[b] || 0;
  line('  ' + pad(b, 22) + ' 文件 ' + pad(n, 5) + ' ok ' + pad(okN, 5) +
    ' 音符 ' + pad(notesN, 8) + ' 累计时长 ' + (durN / 1000).toFixed(1) + 's');
}
line('');

line('[3] 汇总');
line('  可解析文件          : ' + okCount);
line('  总音符数            : ' + totalNotes);
line('  总事件数(down+up)   : ' + totalEvents);
line('  warnings 总条数     : ' + totalWarnings);
line('  全库用到的键        : ' + keysUsedGlobal.size + '/21  [' +
  Array.from(keysUsedGlobal).sort().join('') + ']');
line('  最大同刻键数        : ' + maxPolyphony + '  (' + maxPolyphonyFile + ')');
line('  零/负时长音符       : ' + notesWithZeroOrNegative);
line('  超出 48..83 的音符  : ' + pitchesOut);
line('');

line('[4] 全库时长分布（前 10 长 / 前 10 短）');
const sorted = durations.slice().sort((a, b) => b.ms - a.ms);
line('  --- 最长 10 ---');
for (const d of sorted.slice(0, 10)) {
  line('    ' + (d.ms / 1000).toFixed(1).padStart(8) + 's  [' + pad(d.type, 8) + ']  ' + d.file);
}
line('  --- 最短 10 ---');
for (const d of sorted.slice(-10)) {
  line('    ' + (d.ms / 1000).toFixed(1).padStart(8) + 's  [' + pad(d.type, 8) + ']  ' + d.file);
}
line('');

if (Object.keys(warningKinds).length) {
  line('[5] warnings 归类');
  const wk = Object.keys(warningKinds).sort((a, b) => warningKinds[b] - warningKinds[a]);
  for (const k of wk) { line('  ' + String(warningKinds[k]).padStart(6) + '  ' + k); }
  line('');
}

line('[6] 失败清单');
if (!failures.length) {
  line('  （无）');
} else {
  for (const f of failures.slice(0, 60)) {
    line('  [' + f.kind + '] ' + rel(f.file));
    line('        ' + f.reason);
  }
  if (failures.length > 60) { line('  … 还有 ' + (failures.length - 60) + ' 条'); }
}
line('');

/* ------------------------------------------------------------------ *
 * selfTest
 * ------------------------------------------------------------------ */

line('[7] BGIParse.selfTest()');
let st;
try {
  st = BGIParse.selfTest();
} catch (e) {
  line('  selfTest 抛出异常：' + e.message);
  st = { passed: 0, failed: 1, cases: [{ name: 'selfTest 执行', ok: false, detail: e.message }] };
}
line('  passed: ' + st.passed + '   failed: ' + st.failed + '   (共 ' + st.cases.length + ' 条)');
for (const c of st.cases) {
  if (!c.ok) { line('    FAIL ' + c.name + '  -> ' + c.detail); }
}
line('');

/* ------------------------------------------------------------------ *
 * 回归护栏：小写键字母（曾整段被误删的真 bug）
 * ------------------------------------------------------------------ */

line('[8] 回归护栏');
{
  const guard = BGIParse.parseScore({ notes: 'h[4](en)[4]' });
  const guardKeys = guard.notes.map((n) => n.key).join('');
  const guardOk = guard.ok && guardKeys === 'HEN' && guard.warnings.length === 0;
  line('  小写谱面 h[4](en)[4] -> ' + guardKeys + '  warnings=' + guard.warnings.length +
    '  ' + (guardOk ? 'OK' : 'FAIL'));
  if (!guardOk) {
    line('    [guard] 小写键字母未先大写再过滤（应按 H、E、N 解析且无 warning）');
  }

  const smallKeys = Object.keys(BGIParse.KEY_TO_PITCH).map((k) => k.toLowerCase()).join('');
  const lowerChord = BGIParse.parseScore({ notes: '(' + smallKeys + ')[4]' });
  const lowerOk = lowerChord.ok && lowerChord.notes.length === 21;
  line('  21 键全小写和弦 -> 音符数 ' + (lowerChord.ok ? lowerChord.notes.length : 'ok:false') +
    '  ' + (lowerOk ? 'OK' : 'FAIL'));
  if (!lowerOk) { line('    [guard] 全小写 21 键应解析出 21 个音符'); }
  line('');
}

/* ------------------------------------------------------------------ *
 * 结论
 * ------------------------------------------------------------------ */

const selfTestOk = st.failed === 0;
const guardFailed = !(BGIParse.parseScore({ notes: 'h[4](en)[4]' }).notes.length === 3);
const allOk = failures.length === 0 && selfTestOk && !guardFailed;

line('============================================================');
line(' 结论：' + (allOk ? 'PASS' : 'FAIL') +
  '   解析失败 ' + parseFailed.length +
  ' / 不变量失败 ' + invariantFailed.length +
  ' / selfTest 失败 ' + st.failed);
line('============================================================');

process.exit(allOk ? 0 : 1);
