// task-8 验收标准逐条自检
const fs = require('fs');
const path = require('path');
const B = require(path.resolve(__dirname, '..', '..', 'player', 'js', 'bettergi-parse.js'));

const results = [];
function check(name, ok, detail) { results.push({ name, ok, detail: detail || '' }); }

// 1 最小复现
const m = B.parseScore({ type: 'keyboard', bpm: 120, notes: 'ZZZZZZ/ZZ[4]' });
check('1 最小复现第7音 end === 3470.0',
  m.ok && m.notes[6].end === 3470,
  'end=' + (m.ok ? m.notes[6].end : m.error) + ' start=' + (m.ok ? m.notes[6].start : '-'));

// 4 契约不变：字段
const c = B.parseScore({ notes: 'Z[4]' });
const contractKeys = ['ok', 'error', 'name', 'author', 'instrument', 'type', 'bpm', 'ticks', 'notes', 'warnings', 'stats'];
check('6 Score 字段契约不变', contractKeys.every((k) => k in c), Object.keys(c).join(','));
check('6 Note 字段契约不变',
  ['key', 'pitch', 'start', 'end', 'velocity'].every((k) => k in c.notes[0]),
  Object.keys(c.notes[0]).join(','));
check('6 stats 字段契约不变',
  ['events', 'noteCount', 'durationMs', 'keysUsed', 'maxPolyphony'].every((k) => k in c.stats),
  Object.keys(c.stats).join(','));
check('6 durationMs 仍是 cursor 终值（Z[4]@120 => 500）', c.stats.durationMs === 500,
  'durationMs=' + c.stats.durationMs);

// 5 selfTest
const st = B.selfTest();
check('5 selfTest 0 failed', st.failed === 0, 'passed=' + st.passed + ' failed=' + st.failed);
const normalizeCases = st.cases.filter((x) => x.name.indexOf('Normalize') === 0);
check('5 新增 ≥2 条 Normalize 回归用例', normalizeCases.length >= 2,
  normalizeCases.length + ' 条: ' + normalizeCases.map((x) => x.name).join(' | '));
check('5 selfTest 返回 ok 为 boolean', st.cases.every((x) => typeof x.ok === 'boolean'), '');

// 2/3 全库
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full, out); }
    else if (/[.]json$/i.test(e.name)) { out.push(full); }
  }
  return out;
}
const files = walk(path.resolve(__dirname, '..', '..', '完整曲库'), []);
const TARGETS = {
  'aLIEz - SawanoHiroyuki[nZk]_mizuki 歌詞.json': 3893,
  '樱花树下的约定 - TrCB9nJF.json': 1604,
  '纳塔 Natlan - 8Hox91Rl.json': 1508,
  '葬花 - Ybe8N1wO.json': 1280
};
let total = 0, bad = 0, invariantFail = 0, zeroLen = 0, pitchOut = 0, keyOut = 0, orderBad = 0;
const counts = {};
for (const f of files) {
  const obj = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
  const s = B.parseScore(obj);
  if (!s.ok) { bad++; continue; }
  total += s.notes.length;
  const base = path.basename(f);
  if (base in TARGETS) { counts[base] = s.notes.length; }
  let prev = -Infinity;
  for (const n of s.notes) {
    if (!(n.start < n.end)) { zeroLen++; invariantFail++; }
    if (n.pitch < 48 || n.pitch > 83) { pitchOut++; invariantFail++; }
    if (B.KEY_TO_PITCH[n.key] === undefined) { keyOut++; invariantFail++; }
    if (n.start < prev) { orderBad++; invariantFail++; }
    prev = n.start;
  }
}
check('2 全库音符总数 === 321330', total === 321330, '实际 ' + total);
check('3 四首音符数全部命中', Object.keys(TARGETS).every((k) => counts[k] === TARGETS[k]),
  Object.keys(TARGETS).map((k) => path.basename(k).slice(0, 12) + '=' + counts[k] + '/' + TARGETS[k]).join(' '));
check('4 全库 307/307 ok', files.length === 307 && bad === 0, '文件 ' + files.length + '，ok:false ' + bad);
check('4 不变量失败 0', invariantFail === 0,
  'zeroLen=' + zeroLen + ' pitchOut=' + pitchOut + ' keyOut=' + keyOut + ' orderBad=' + orderBad);

console.log('task-8 验收标准逐条自检');
console.log('');
let all = true;
for (const r of results) {
  if (!r.ok) { all = false; }
  console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.name + (r.detail ? '   [' + r.detail + ']' : ''));
}
console.log('');
console.log(all ? '全部通过' : '存在失败项');
process.exit(all ? 0 : 1);
