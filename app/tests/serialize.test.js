#!/usr/bin/env node
/*
 * app/tests/serialize.test.js —— 序列化回归（Node，零依赖）
 *
 * 用法：
 *   node app/tests/serialize.test.js [曲库目录]
 *
 * 守的是这条规则（见 app/js/bettergi-parse.js buildMidiNotesString 注释）：
 *   同键「抬起 U → 按下 D」相邻时，必须在两者之间插 U@0 占位符，
 *   否则解析器的回拨分支会让每处同键连击丢 30ms（总时长变短、密集段变快）。
 *
 * 断言：
 *   1. 同键连击 20 音：序列化必须含 U@0，且再解析 durationMs 严格等于理论值；
 *   2. 对照组：同一串音符若手工去掉 U@0，解析时长必须**短**（证明这条规则真的在生效）；
 *   3. 不同键相邻 / 同键相邻 / 同刻 U-D：占位符只在需要时出现，时值不被改写；
 *   4. 曲库全量：parse → buildMidiNotesString → parse，音符数与时长必须收敛。
 *
 * 退出码：有断言失败则 1，否则 0。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PARSER_PATH = path.resolve(__dirname, '..', 'js', 'bettergi-parse.js');

function loadParser() {
  const source = fs.readFileSync(PARSER_PATH, 'utf8');
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

if (typeof BGIParse.buildMidiNotesString !== 'function') {
  console.error('[FATAL] BGIParse.buildMidiNotesString 未导出');
  process.exit(2);
}

/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    const msg = fn();
    if (msg) {
      failed++;
      failures.push(name + ' → ' + msg);
      console.log('  ✗ ' + name + '：' + msg);
    } else {
      passed++;
      console.log('  ✓ ' + name);
    }
  } catch (e) {
    failed++;
    failures.push(name + ' → 抛错 ' + (e && e.message));
    console.log('  ✗ ' + name + '：抛错 ' + (e && e.message));
  }
}

function parse(notes) {
  return BGIParse.parseScore({ type: 'midi', bpm: 60, ticks: 1000, notes: notes });
}

function makeNotes(specs) {
  return specs.map(([start, end, key]) => ({ start: start, end: end, key: key }));
}

/* ------------------------------------------------------------------ *
 * 1. 同键连击：20 音 / 129ms 间隔 / 99ms 时值 → 理论末点 2550ms
 * ------------------------------------------------------------------ */

const TREMOLO = makeNotes(
  Array.from({ length: 20 }, (_, i) => [i * 129, i * 129 + 99, 'G'])
);

check('同键连击 20 音：序列化插入 U@0', () => {
  const s = BGIParse.buildMidiNotesString(TREMOLO);
  const n = (s.match(/U@0/g) || []).length;
  return n === 19 ? '' : 'U@0 数量 = ' + n + '（期望 19 处，共 ' + (TREMOLO.length - 1) + ' 次连击）';
});

check('同键连击 20 音：再解析末点 = 2550ms', () => {
  const s = BGIParse.buildMidiNotesString(TREMOLO);
  const r = parse(s);
  return Math.abs(r.stats.durationMs - 2550) < 1e-6
    ? '' : 'durationMs = ' + r.stats.durationMs + '（期望 2550）';
});

check('对照组：同一批音符手工去掉 U@0，解析末点必须变短（规则确实生效）', () => {
  const s = BGIParse.buildMidiNotesString(TREMOLO).split('|').filter(t => t !== 'U@0').join('|');
  const r = parse(s);
  return Math.abs(r.stats.durationMs - 1980) < 1e-6
    ? '' : 'durationMs = ' + r.stats.durationMs + '（期望 1980 = 2550 − 19×30）';
});

/* ------------------------------------------------------------------ *
 * 2. 只在需要时插占位符
 * ------------------------------------------------------------------ */

check('不同键相邻（G→A）：不插 U@0', () => {
  const s = BGIParse.buildMidiNotesString(makeNotes([[0, 100, 'G'], [100, 200, 'A']]));
  return s.indexOf('U@0') < 0 ? '' : '不该出现 U@0，实际 = ' + s;
});

check('同键相邻（G 100ms 后重击）：插 U@0 且末点仍为 230ms', () => {
  const s = BGIParse.buildMidiNotesString(makeNotes([[0, 100, 'G'], [130, 230, 'G']]));
  if (s.indexOf('U@0') < 0) { return '缺少 U@0，实际 = ' + s; }
  const r = parse(s);
  return Math.abs(r.stats.durationMs - 230) < 1e-6
    ? '' : 'durationMs = ' + r.stats.durationMs + '（期望 230）';
});

check('同刻收尾相接（U@100 与 D@100）：U 必须排在 D 之前', () => {
  const s = BGIParse.buildMidiNotesString(makeNotes([[0, 100, 'G'], [100, 200, 'G']]));
  // 期望：先 D@0，再 U@100，占位符，最后才是 D@100（delta 0）
  return s === 'DG0|UG100|U@0|DG0|UG100' ? '' : '实际 = ' + s + '（期望 DG0|UG100|U@0|DG0|UG100）';
});

/* ------------------------------------------------------------------ *
 * 3. 曲库全量：parse → 序列化 → parse 必须收敛
 * ------------------------------------------------------------------ */

const dirArg = process.argv[2] || 'library';
const LIB = path.resolve(process.cwd(), dirArg);
if (!fs.existsSync(LIB)) {
  console.error('[FATAL] 目录不存在：' + LIB);
  process.exit(2);
}

function walkJson(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) { walkJson(full, out); } else if (/\.json$/i.test(ent.name)) { out.push(full); }
  }
  return out;
}

const files = walkJson(LIB, []).sort();
console.log('\n曲库往返收敛检查（' + files.length + ' 个文件，' + dirArg + '）：');

let rtChecked = 0;
files.forEach(file => {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return; // 非法 JSON 不归本测试管
  }
  const first = BGIParse.parseScore(raw);
  if (!first.ok) { return; }
  const rebuilt = BGIParse.buildMidiNotesString(first.notes);
  const second = parse(rebuilt);
  rtChecked++;
  const name = path.basename(file);
  check(name + '：往返后音符数/时长一致', () => {
    if (!second.ok) { return '二次解析失败：' + second.error; }
    if (second.stats.noteCount !== first.stats.noteCount) {
      return '音符数 ' + first.stats.noteCount + ' → ' + second.stats.noteCount;
    }
    const d = Math.abs(second.stats.durationMs - first.stats.durationMs);
    return d <= 2 ? '' : '时长漂移 ' + d.toFixed(1) + 'ms（' + first.stats.durationMs + ' → ' + second.stats.durationMs + '）';
  });
});

/* ------------------------------------------------------------------ */

console.log('\n===============================');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项' + (rtChecked ? '（曲库往返 ' + rtChecked + ' 首）' : ''));
if (failed) {
  console.log('\n失败清单：');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log('全部通过');