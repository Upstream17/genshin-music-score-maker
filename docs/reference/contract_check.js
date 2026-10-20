// 契约合规性检查（classic script / IIFE / 全局挂载 / 接口形状）
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('player/js/bettergi-parse.js', 'utf8');

console.log('[契约 1] 禁用构造');
const banned = [
  [/^\s*import\s/m, 'import 语句'],
  [/^\s*export\s/m, 'export 语句'],
  [/\brequire\s*\(/, 'require() 调用'],
  [/\bfetch\s*\(/, 'fetch() 调用'],
  [/\bimportScripts\s*\(/, 'importScripts() 调用']
];
let clean = true;
for (const [re, name] of banned) {
  const hit = re.test(src);
  if (hit) clean = false;
  console.log('   ' + name + ': ' + (hit ? '出现 ✗' : '未出现 ✓'));
}
console.log('   IIFE 包裹: ' + (/\(function \(root\) \{/.test(src) ? '✓' : '✗'));
console.log('   window/globalThis 分派: ' +
  (src.indexOf("typeof window !== 'undefined' ? window : globalThis") >= 0 ? '✓' : '✗'));

console.log('\n[契约 2] 浏览器 window 全局路径');
const win = {};
const sb = { window: win, globalThis: {} };
vm.createContext(sb);
vm.runInContext(src, sb, { filename: 'bettergi-parse.js' });
console.log('   window.BGIParse 存在: ' + (typeof win.BGIParse === 'object'));
const B = win.BGIParse;
console.log('   KEY_TO_PITCH 键数: ' + Object.keys(B.KEY_TO_PITCH).length);
console.log('   SUPPORTED_KEYS: ' + B.SUPPORTED_KEYS.join(''));
console.log('   PITCH_TO_KEY 条目: ' + Object.keys(B.PITCH_TO_KEY).length);
console.log('   pitchName(48/60/83): ' + B.pitchName(48) + ' / ' + B.pitchName(60) + ' / ' + B.pitchName(83));
console.log('   解析 Z[4]: ' + JSON.stringify(B.parseScore({ notes: 'Z[4]' }).notes));
const st = B.selfTest();
console.log('   selfTest 形状: passed=' + typeof st.passed + ' failed=' + typeof st.failed +
  ' cases=' + Array.isArray(st.cases) +
  ' 每条含 name/ok/detail=' + st.cases.every((c) => 'name' in c && 'ok' in c && 'detail' in c));
console.log('   ok 全为 boolean: ' + st.cases.every((c) => typeof c.ok === 'boolean'));
console.log('   selfTest: ' + st.passed + ' passed / ' + st.failed + ' failed');

console.log('\n[契约 3] Node 下 globalThis 路径');
console.log('   require() 得到 BGIParse: ' + (typeof require('./player/js/bettergi-parse.js').parseScore === 'function'));

console.log('\n结论: ' + (clean ? '契约 1 通过（无禁用构造）' : '契约 1 失败'));
