/*
 * app/tests/audio.test.js — zero-dependency Node test for app/js/audio-engine.js
 *
 * Run:  node app/tests/audio.test.js
 *
 * Design notes:
 *  - The engine is loaded as a **classic script** through `vm`, not `require()`.
 *    That proves the file is really a plain <script> with no CommonJS/ESM
 *    semantics, and it also guards against the file ever growing a
 *    module-level export.
 *  - Pure-pitch-mapping cases run everywhere (Node has no AudioContext).
 *  - Web Audio cases are reported as SKIP by BGIAudio.selfTest() instead of
 *    being faked as passes.
 *  - Exit code is 1 when anything FAILS.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ENGINE_REL = path.join('app', 'js', 'audio-engine.js');
var ENGINE_ABS = path.resolve(__dirname, '..', 'js', 'audio-engine.js');

/* ------------------------------------------------------------------ harness */

var totals = { passed: 0, failed: 0, skipped: 0 };
var sectionStats = {};
var currentSection = '(none)';

function section(title) {
  currentSection = title;
  console.log('');
  console.log('-- ' + title + ' --');
  sectionStats[title] = { passed: 0, failed: 0, skipped: 0 };
}

function pass(label, detail) {
  totals.passed++;
  sectionStats[currentSection].passed++;
  console.log('PASS  ' + label + (detail ? '   [' + detail + ']' : ''));
}

function fail(label, detail) {
  totals.failed++;
  sectionStats[currentSection].failed++;
  console.log('FAIL  ' + label + (detail ? '   [' + detail + ']' : ''));
}

function skip(label, why) {
  totals.skipped++;
  sectionStats[currentSection].skipped++;
  console.log('SKIP  ' + label + (why ? '   (' + why + ')' : ''));
}

function check(label, condition, detail) {
  if (condition) pass(label, detail); else fail(label, detail);
}

function checkEqual(label, actual, expected) {
  var a = JSON.stringify(actual);
  var e = JSON.stringify(expected);
  if (a === e) pass(label + ' -> ' + e);
  else fail(label + ' -> expected ' + e + ', got ' + a);
}

/* -------------------------------------------------------- load the engine */

console.log('=== BGIAudio engine tests ===');
console.log('engine file : ' + ENGINE_REL);

var src;
try {
  src = fs.readFileSync(ENGINE_ABS, 'utf8');
} catch (err) {
  console.log('FATAL: cannot read ' + ENGINE_ABS + ': ' + err.message);
  process.exit(2);
}
console.log('engine bytes: ' + Buffer.byteLength(src, 'utf8'));

var sandbox = {
  console: console,
  process: process,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  Promise: Promise
};
vm.createContext(sandbox);
try {
  vm.runInContext(src, sandbox, { filename: 'audio-engine.js' });
} catch (err2) {
  console.log('FATAL: engine threw while loading as a classic script: ' + err2.message);
  console.log(err2.stack);
  process.exit(2);
}

var A = sandbox.BGIAudio;
if (!A) {
  console.log('FATAL: engine did not define globalThis.BGIAudio');
  process.exit(2);
}
console.log('BGIAudio    : v' + A.VERSION + ' (classic script, loaded via vm)');

/* --------------------------------------------------------- static guards */

section('static guards (forbidden patterns)');

check('no fetch( call', !/\bfetch\s*\(/.test(src));
check('no require( call', !/\brequire\s*\(/.test(src));
check('no dynamic import(', !/\bimport\s*\(/.test(src));
check('no ESM import/export statement', !/^[ \t]*(import|export)\b/m.test(src));
check('no <script> tag', !/<script/i.test(src));
check('no external URL (http/https)', !/https?:\/\//i.test(src));
check('no CDN / src= attribute', !/\bsrc\s*=\s*["']/.test(src));
check('IIFE-wrapped (ends with globalThis fallback)',
  /typeof window\s*!==\s*'undefined'\s*\?\s*window\s*:\s*globalThis/.test(src));

/* ------------------------------------------- mapNameToPitch (pure, Node) */

section('mapNameToPitch — pure function, no AudioContext needed');

var MAPPING_CASES = [
  // --- scientific pitch notation ---
  ['C3.mp3', 48, 'scientific, low edge of the 21-key range'],
  ['C4.wav', 60, 'scientific, middle C'],
  ['A4.wav', 69, 'scientific, A4 = 440 Hz'],
  ['B5.mp3', 83, 'scientific, high edge of the 21-key range'],
  ['c3.mp3', 48, 'lowercase note letter'],
  ['C5.MP3', 72, 'uppercase extension'],
  ['b5.wav', 83, 'lowercase letter and extension'],
  ['C#3.mp3', 49, 'sharp'],
  ['Db3.wav', 49, 'flat'],
  ['C\u266F3.wav', 49, 'unicode sharp sign'],
  ['E\u266D4.wav', 63, 'unicode flat sign'],
  ['A0.wav', 21, 'octave 0 is valid MIDI but outside the lyre'],
  ['C-1.wav', 0, 'octave -1 is valid MIDI'],
  ['C9.mp3', 120, 'octave 9 is valid MIDI but far outside the lyre'],
  // --- BetterGI / Genshin 21-key letters (whole filename only) ---
  ['Z.wav', 48, 'key letter Z = C3'],
  ['X.wav', 50, 'key letter X'],
  ['C.wav', 52, 'key letter C (not a note name here)'],
  ['V.wav', 53, 'key letter V'],
  ['N.wav', 57, 'key letter N'],
  ['M.wav', 59, 'key letter M'],
  ['A.wav', 60, 'key letter A = C4'],
  ['S.wav', 62, 'key letter S'],
  ['H.wav', 69, 'key letter H = A4'],
  ['J.wav', 71, 'key letter J'],
  ['Q.wav', 72, 'key letter Q = C5'],
  ['W.wav', 74, 'key letter W'],
  ['T.wav', 79, 'key letter T'],
  ['Y.wav', 81, 'key letter Y'],
  ['U.mp3', 83, 'key letter U = B5'],
  // --- MIDI numbers ---
  ['48.wav', 48, 'bare MIDI number (low edge)'],
  ['60.wav', 60, 'bare MIDI number'],
  ['83.wav', 83, 'bare MIDI number (high edge)'],
  ['midi69.wav', 69, 'explicit midi prefix'],
  ['n48.wav', 48, 'short midi prefix'],
  // --- numbered notation (jianpu) ---
  ['1.mp3', 60, 'jianpu 1 = do (C4)'],
  ['7.mp3', 71, 'jianpu 7 = si (B4)'],
  ['1-.mp3', 48, 'jianpu 1 with low-octave suffix'],
  ['7+.mp3', 83, 'jianpu 7 with high-octave suffix'],
  ['2+.wav', 74, 'jianpu 2 with high-octave suffix'],
  // --- solfege ---
  ['do.wav', 60, 'solfege do'],
  ['sol.mp3', 67, 'solfege sol'],
  ['si.wav', 71, 'solfege si'],
  ['do+.wav', 72, 'solfege do, high octave'],
  // --- messy real-world filenames ---
  ['windsong_C4.mp3', 60, 'instrument prefix + note'],
  ['C4 (1).wav', 60, 'duplicate-download suffix'],
  ['C4-1.wav', 60, 'duplicate-download dash suffix'],
  ['piano/A4.wav', 69, 'posix path prefix'],
  ['C:\\samples\\A4.wav', 69, 'windows path prefix'],
  // --- must NOT map ---
  ['readme.txt', null, 'not an audio extension'],
  ['kick.wav', null, 'drum name, not a pitch'],
  ['komi.wav', null, 'arbitrary name'],
  ['K.wav', null, 'letter not in the 21-key layout'],
  ['part_a.wav', null, 'fragment single letter must not become key A'],
  ['bass_1.wav', null, 'fragment digit must not become jianpu do'],
  ['999.wav', null, 'out of MIDI range'],
  ['', null, 'empty string'],
  [null, null, 'null input'],
  [undefined, null, 'undefined input']
];

var mappingFailures = [];
MAPPING_CASES.forEach(function (c) {
  var actual = A.mapNameToPitch(c[0]);
  if (actual === c[1]) {
    pass('mapNameToPitch(' + JSON.stringify(c[0]) + ') === ' + c[1] + '   # ' + c[2]);
  } else {
    fail('mapNameToPitch(' + JSON.stringify(c[0]) + ') expected ' + c[1] + ', got ' + actual +
      '   # ' + c[2]);
    mappingFailures.push(c[0]);
  }
});
check('case count >= 15', MAPPING_CASES.length >= 15, MAPPING_CASES.length + ' cases');
check('invalid-name cases produce null',
  mappingFailures.filter(function (n) {
    return n === 'readme.txt' || n === 'kick.wav' || n === 'komi.wav' || n === 'K.wav' ||
      n === 'part_a.wav' || n === 'bass_1.wav' || n === '999.wav' || n === '' ||
      n === null || n === undefined;
  }).length === 0);

/* ------------------------------------------------- pure helper / theory */

section('pitch math and 21-key layout (pure)');

checkEqual('midiToFreq(69) is exactly 440', A.midiToFreq(69), 440);
check('midiToFreq(60) ~= 261.6255653',
  Math.abs(A.midiToFreq(60) - 261.6255653) < 1e-6, A.midiToFreq(60));
checkEqual('midiToFreq(57) is exactly 220 (A4 / 2)', A.midiToFreq(57), 220);
check('every +12 semitones exactly doubles the frequency',
  A.midiToFreq(81) === A.midiToFreq(69) * 2, A.midiToFreq(81));
check('midiToFreq(48) is C3 = 130.8128 Hz',
  Math.abs(A.midiToFreq(48) - 130.8127826503) < 1e-6, A.midiToFreq(48));
// The 21 lyre keys are white keys only. NOTE: iterating every integer in
// 48..83 would include the 15 black keys — the invariant is over the 21 keys.
check('all 21 lyre keys are C-major white keys (no accidentals)',
  Object.keys(A.KEY_LAYOUT).every(function (k) {
    return [0, 2, 4, 5, 7, 9, 11].indexOf(((A.KEY_LAYOUT[k] % 12) + 12) % 12) !== -1;
  }), Object.keys(A.KEY_LAYOUT).join(''));
checkEqual('midiToName(48)', A.midiToName(48), 'C3');
checkEqual('midiToName(69)', A.midiToName(69), 'A4');
checkEqual('midiToName(83)', A.midiToName(83), 'B5');
check('freqToMidi is the inverse of midiToFreq',
  Math.abs(A.freqToMidi(A.midiToFreq(83)) - 83) < 1e-9, A.freqToMidi(A.midiToFreq(83)));

var letters = Object.keys(A.KEY_LAYOUT);
checkEqual('KEY_LAYOUT has 21 entries', letters.length, 21);
// The 21 keys are the C-major white keys of octaves 3,4,5 — not 21 consecutive MIDI numbers.
check('KEY_LAYOUT covers exactly the 21 white keys C3..B5',
  (function () {
    var vals = letters.map(function (k) { return A.KEY_LAYOUT[k]; })
      .sort(function (a, b) { return a - b; });
    var white = [0, 2, 4, 5, 7, 9, 11], expect = [];
    for (var oct = 3; oct <= 5; oct++) {
      for (var w = 0; w < white.length; w++) expect.push((oct + 1) * 12 + white[w]);
    }
    expect.sort(function (a, b) { return a - b; });
    return vals.length === expect.length &&
      vals.every(function (v, i) { return v === expect[i]; });
  })(), letters.join(''));
check('every key letter resolves to its MIDI number via mapNameToPitch',
  letters.every(function (L) { return A.mapNameToPitch(L + '.wav') === A.KEY_LAYOUT[L]; }));
check('C3..B5 all 21 white keys in range',
  A.PITCH_MIN === 48 && A.PITCH_MAX === 83, A.PITCH_MIN + '..' + A.PITCH_MAX);
check('all 21 notes of the range map back to distinct names',
  (function () {
    var seen = {};
    for (var p = 48; p <= 83; p++) {
      var nm = A.midiToName(p);
      if (seen[nm]) return false;
      seen[nm] = 1;
    }
    return true;
  })());

/* --------------------------------------------------- listInstruments API */

section('interface contract v1 shape');

check('BGIAudio.createEngine is a function', typeof A.createEngine === 'function');
check('BGIAudio.listInstruments is a function', typeof A.listInstruments === 'function');
check('BGIAudio.mapNameToPitch is a function', typeof A.mapNameToPitch === 'function');
check('BGIAudio.selfTest is a function', typeof A.selfTest === 'function');

var engine = null;
try { engine = A.createEngine(); } catch (e) { engine = null; }
check('createEngine() works without AudioContext', !!engine);

if (engine) {
  ['resume', 'setMasterVolume', 'setInstrument', 'noteOn', 'noteOff', 'stopAll', 'loadSampleFiles']
    .forEach(function (m) {
      check('engine.' + m + ' is a function', typeof engine[m] === 'function');
    });
  check('engine.currentTime is a number', typeof engine.currentTime === 'number',
    String(engine.currentTime));
  check('engine.hasSamples is a boolean', typeof engine.hasSamples === 'boolean');
  check('engine.hasSamples === false before loading', engine.hasSamples === false);
  // Cross-realm safe promise detection (the engine runs inside a vm context).
  function isPromiseOf(v) {
    return !!v && typeof v.then === 'function' &&
      Object.prototype.toString.call(v) === '[object Promise]';
  }
  check('resume() returns a Promise (async per contract v1)',
    isPromiseOf(engine.resume()));
  // resume() must be rejection-safe: no unhandled rejection when there is no ctx.
  var resumeSettled = false, resumeValue = null;
  engine.resume().then(function (v) { resumeSettled = true; resumeValue = v; },
    function () { resumeSettled = true; resumeValue = 'REJECTED'; });
  check('noteOn without resumed AudioContext does not throw',
    (function () { try { engine.noteOn(69, 0, 0.5, 0.8); return true; } catch (e) { return false; } })());
  check('noteOff / stopAll / setMasterVolume do not throw',
    (function () {
      try { engine.noteOff(69, 0); engine.stopAll(); engine.setMasterVolume(0.5); return true; }
      catch (e) { return false; }
    })());
  check('setInstrument(unknown) returns false and does not throw',
    (function () { try { return engine.setInstrument('__nope__') === false; } catch (e) { return false; } })());
  check('setInstrument(windsong) returns true', engine.setInstrument('windsong') === true);
  check('setInstrument(sample) is false while no samples are loaded',
    engine.setInstrument('sample') === false);
}

var instruments = A.listInstruments();
check('listInstruments() returns an array', Array.isArray(instruments));
check('listInstruments() ids unique',
  new Set(instruments.map(function (x) { return x.id; })).size === instruments.length);
check('every instrument has id/name/kind with kind in synth|sample',
  instruments.every(function (x) {
    return typeof x.id === 'string' && x.id &&
      typeof x.name === 'string' && x.name &&
      (x.kind === 'synth' || x.kind === 'sample');
  }), instruments.map(function (x) { return x.id + ':' + x.kind; }).join(', '));
check('default instrument windsong exists',
  instruments.some(function (x) { return x.id === 'windsong' && x.kind === 'synth'; }));
['windsong', 'piano', 'musicbox', 'harp'].forEach(function (id) {
  check('required synth instrument present: ' + id,
    instruments.some(function (x) { return x.id === id && x.kind === 'synth'; }));
});
check('at least one instrument of kind sample exists',
  instruments.some(function (x) { return x.kind === 'sample'; }));

/* ----------------------------------------------- loadSampleFiles contract */

section('loadSampleFiles() contract (no AudioContext in Node)');

var loadResult = null;
var loadThrew = null;
try {
  var p = engine ? engine.loadSampleFiles([]) : null;
  if (p && typeof p.then === 'function') {
    p.then(function (r) { loadResult = r; }, function (e) { loadThrew = e; });
  }
} catch (e) { loadThrew = e; }

// Give the microtask queue a chance; loadSampleFiles([]) settles asynchronously.
setTimeout(function () {
  check('loadSampleFiles([]) does not throw', loadThrew === null,
    loadThrew ? String(loadThrew && loadThrew.message) : '');
  check('loadSampleFiles() returns a Promise (async per contract v1)',
    !!(p && typeof p.then === 'function' &&
      Object.prototype.toString.call(p) === '[object Promise]'));
  check('resume() settles (never rejects) without AudioContext',
    resumeSettled && resumeValue !== 'REJECTED', 'resolved with ' + String(resumeValue));
  if (loadResult) {
    check('result has loaded (number)', typeof loadResult.loaded === 'number', String(loadResult.loaded));
    check('result has mapping (object)', loadResult.mapping && typeof loadResult.mapping === 'object');
    check('result has missing (array)', Array.isArray(loadResult.missing));
    if (!sandbox.AudioContext && !sandbox.webkitAudioContext) {
      skip('loadSampleFiles decoding real audio', 'no AudioContext in Node');
    }
  } else {
    skip('loadSampleFiles result assertions', 'promise did not settle in this tick');
  }

  /* ------------------------------------------------------- selfTest() ---- */

  currentSection = 'selfTest';
  section('BGIAudio.selfTest() — Web Audio cases SKIP without AudioContext');

  var st = null;
  try { st = A.selfTest(); } catch (e) { st = null; }
  check('selfTest() returns an object', !!st);
  if (st) {
    check('selfTest() has passed/failed/skipped/cases',
      typeof st.passed === 'number' && typeof st.failed === 'number' &&
      typeof st.skipped === 'number' && Array.isArray(st.cases));
    check('selfTest() case count === passed + failed + skipped',
      st.cases.length === st.passed + st.failed + st.skipped,
      st.cases.length + ' === ' + st.passed + '+' + st.failed + '+' + st.skipped);

    // --- contract v1 case shape: {name, ok, detail, ...} ---
    var badShape = st.cases.filter(function (c) {
      if (!c || typeof c.name !== 'string' || !c.name) return true;
      if (typeof c.detail !== 'string') return true;
      if (c.status !== 'passed' && c.status !== 'failed' && c.status !== 'skipped') return true;
      if (!('ok' in c)) return true;
      if (c.status === 'skipped') return c.ok !== null;      // skipped must not claim ok
      return typeof c.ok !== 'boolean' || c.ok !== (c.status === 'passed');
    });
    check('every case has {name, ok, detail, status} per contract v1',
      badShape.length === 0,
      badShape.length ? JSON.stringify(badShape[0]) : st.cases.length + ' cases');
    check('skipped cases expose reason and map it into detail',
      st.cases.filter(function (c) { return c.status === 'skipped'; })
        .every(function (c) {
          return typeof c.reason === 'string' && c.reason &&
            c.detail.indexOf(c.reason) !== -1;
        }));
    check('ok === (status === "passed") for every non-skipped case',
      st.cases.filter(function (c) { return c.status !== 'skipped'; })
        .every(function (c) { return c.ok === (c.status === 'passed'); }));

    st.cases.forEach(function (c) {
      var label = c.name + '   [' + c.detail + ']';
      if (c.status === 'passed') pass(label);
      else if (c.status === 'skipped') skip(label);
      else fail(label);
    });
    console.log('');
    console.log('   selfTest totals: passed=' + st.passed + ' failed=' + st.failed +
      ' skipped=' + st.skipped);
    console.log('   environment    : ' + JSON.stringify(st.environment));
    check('selfTest has no failures', st.failed === 0, 'failed=' + st.failed);
    check('selfTest skipped > 0 in Node (Web Audio cases are honest, not faked)',
      !(sandbox.AudioContext || sandbox.webkitAudioContext) ? st.skipped > 0 : true,
      'skipped=' + st.skipped);
  }

  /* ---------------------------------------------------------- summary ---- */

  console.log('');
  console.log('=== summary ===');
  Object.keys(sectionStats).forEach(function (k) {
    var s = sectionStats[k];
    console.log('  ' + k.padEnd(34) + ' passed=' + s.passed + ' failed=' + s.failed +
      ' skipped=' + s.skipped);
  });
  console.log('');
  console.log('TOTAL: passed=' + totals.passed + ' failed=' + totals.failed +
    ' skipped=' + totals.skipped);
  console.log('RESULT: ' + (totals.failed === 0 ? 'PASS' : 'FAIL'));
  process.exit(totals.failed === 0 ? 0 : 1);
}, 50);
