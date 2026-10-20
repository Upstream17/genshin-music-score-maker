// 校验 task-8 验收标准 2、3：全库音符总数 + 4 首音符数
const fs = require('fs');
const path = require('path');
const B = require(path.resolve(__dirname, '..', '..', 'player', 'js', 'bettergi-parse.js'));

const TARGETS = {
  'aLIEz - SawanoHiroyuki[nZk]_mizuki 歌詞.json': 3893,
  '樱花树下的约定 - TrCB9nJF.json': 1604,
  '纳塔 Natlan - 8Hox91Rl.json': 1508,
  '葬花 - Ybe8N1wO.json': 1280
};

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full, out); }
    else if (/[.]json$/i.test(e.name)) { out.push(full); }
  }
  return out;
}

const files = walk(path.resolve(__dirname, '..', '..', '完整曲库'), []);
let total = 0, failed = 0;
const found = {};
for (const f of files) {
  const obj = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
  const s = B.parseScore(obj);
  if (!s.ok) { failed++; console.log('  ! ok:false', path.basename(f), s.error); continue; }
  total += s.notes.length;
  const base = path.basename(f);
  if (base in TARGETS) { found[base] = s.notes.length; }
}

console.log('文件数        =', files.length, '(ok:false =', failed + ')');
console.log('全库音符总数  =', total, total === 321330 ? '✓ 期望 321330' : '✗ 期望 321330');
console.log('');
let allOk = total === 321330;
for (const t of Object.keys(TARGETS)) {
  const got = found[t];
  const ok = got === TARGETS[t];
  if (!ok) { allOk = false; }
  console.log((ok ? '✓' : '✗'), t, '=>', got, '(期望 ' + TARGETS[t] + ')');
}
console.log('');
console.log(allOk ? '验收标准 2、3：PASS' : '验收标准 2、3：FAIL');
process.exit(allOk ? 0 : 1);
