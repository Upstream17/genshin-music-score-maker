/*!
 * app/js/audio-engine.js — BGIAudio v1.0.0
 * ---------------------------------------------------------------------------
 * 原神 21 键本地播放器的音频引擎。纯 classic script，零依赖，零外部资源。
 *
 * 设计依据：docs/audio-sources.md（同仓库）
 *   - 结论：没有「许可清晰、可随包分发」的风物之诗琴采样集。
 *     社区只有从游戏包提取的裸 mp3（仓库无 LICENSE，音频版权属 miHoYo）。
 *   - 因此本引擎默认只用**程序合成**音色（零资源、无版权问题），
 *     原声采样一律由用户用 <input type=file> 自己加载，永不打包、永不上传。
 *
 * 硬性约束（必须保持）：
 *   1. 不使用 ES module / import / export / fetch / 外部库 / CDN。
 *      IIFE 包裹，挂到 typeof window!=='undefined' ? window : globalThis。
 *   2. 音频资源不能靠 URL 加载（file:// 下会被 CORS 拦）。
 *      唯一入口是 loadSampleFiles(File[])，走 arrayBuffer() → decodeAudioData。
 *   3. 所有发声时刻都由 AudioContext 时间轴决定（when 参数），不用 setTimeout。
 *
 * 接口契约 v1（Lead 定稿，不得单方面更改）：
 *   window.BGIAudio = {
 *     createEngine() -> Engine,
 *     listInstruments() -> [{id, name, kind:'synth'|'sample'}]
 *   };
 *   Engine:
 *     async resume()
 *     get currentTime():number          // ctx.currentTime 秒（无 ctx 时 0）
 *     setMasterVolume(v)
 *     setInstrument(id)
 *     noteOn(pitch, whenSec, durSec, velocity)
 *     noteOff(pitch, whenSec)
 *     stopAll()
 *     async loadSampleFiles(files) -> {loaded, mapping, missing}
 *     get hasSamples():boolean
 *   BGIAudio.selfTest() -> {passed, failed, skipped, cases, environment}
 *     cases[i] = {name, ok, detail, status, expected?, actual?, reason?}
 *       ok : passed→true / failed→false / **skipped→null**（跳过不当成通过）
 *       detail : 一句话说明，可直接显示
 *       status : 'passed' | 'failed' | 'skipped'（信息量更大，与 ok 并存）
 *
 * 时间语义（重要）：
 *   whenSec 是 **AudioContext 绝对时间**（秒），基点是 engine.currentTime。
 *   传入已过去的时刻不会抛错，而是被夹到「现在 + 2ms」。
 *   durSec 只决定「闸门」长度；合成音色没有持续延音，闸门只用来限制余韵上限。
 *
 * 文件名 → 音高 的判定优先级（纯函数，见 mapNameToPitch）：
 *   1) 科学音高记号  C3 / C#3 / Db3 / c-1 / C♯3
 *   2) MIDI 号       0..127，但 1..7 让位给简谱；`midi69` / `n69` / `m69` 亦可
 *   3) 简谱          1..7（+ = 高八度，- = 低八度，基准 C4）
 *   4) 唱名          do re mi fa sol la si/ti（+/- 同上）
 *   5) 21 键字母     Z X C V B N M A S D F G H J Q W E R T Y U（仅当整个文件名就是该字母）
 *   6) 都不匹配 → null（进 missing）
 *   整名候选先试；失败后再试「按 _ 空格 . - 切出的片段」（片段里只接受
 *   科学音高记号 / 简谱 / 唱名 / 48..83 的 MIDI 号，避免 `part_a.wav` 这类误判）。
 *
 * @license MIT
 */
(function (root) {
  'use strict';

  var VERSION = '1.0.0';

  /* =======================================================================
   * 0. 常量与乐理（纯函数区，不依赖 AudioContext，可直接在 Node 下跑）
   * ===================================================================== */

  // 21 键音域：C 大调白键 C3–B5（MIDI 48–83）
  var PITCH_MIN = 48;   // C3
  var PITCH_MAX = 83;   // B5

  // 21 键 = BetterGI / 原神的键位布局（低→高：Z..M / A..J / Q..U）
  var KEY_LAYOUT = {
    Z: 48, X: 50, C: 52, V: 53, B: 55, N: 57, M: 59,   // C3  D3  E3  F3  G3  A3  B3
    A: 60, S: 62, D: 64, F: 65, G: 67, H: 69, J: 71,   // C4  D4  E4  F4  G4  A4  B4
    Q: 72, W: 74, E: 76, R: 77, T: 79, Y: 81, U: 83    // C5  D5  E5  F5  G5  A5  B5
  };

  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  // 音名 → 八度内半音偏移
  var LETTER_SEMITONE = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  // 简谱 1..7 → 八度内半音偏移（1=do）
  var JIANPU_SEMITONE = [0, 2, 4, 5, 7, 9, 11];
  // 唱名 → 八度内半音偏移
  var SOLFEGE_SEMITONE = {
    do: 0, re: 2, mi: 4, fa: 5, sol: 7, la: 9, si: 11, ti: 11
  };

  var AUDIO_EXT_RE = /\.(mp3|wav|wave|ogg|oga|m4a|aac|flac|opus|weba|webm|aif|aiff|aifc|wma|mp4|caf|3gp|amr|sf2|sf3|sfz|mid|midi)$/i;

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  /** MIDI 号 → 频率（Hz）。A4 = MIDI 69 = 440 Hz（精确）。 */
  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  /** MIDI 号 → 科学音高记号，如 48 → 'C3'，69 → 'A4'，83 → 'B5'。 */
  function midiToName(midi) {
    var pc = ((midi % 12) + 12) % 12;
    return NOTE_NAMES[pc] + (Math.floor(midi / 12) - 1);
  }

  /** 频率 → MIDI 号（浮点，不做四舍五入）。 */
  function freqToMidi(freq) {
    return 69 + 12 * Math.log(freq / 440) / Math.LN2;
  }

  /**
   * 纯函数：文件名 → MIDI 音高。映射不上返回 null。
   * 支持：C3.mp3 / A4.wav / c#3 / Db3 / C♯3 / Z.wav / 48.wav / do.wav /
   *       1.mp3 / 1-.mp3 / 7+.mp3 / midi69.wav / 目录前缀 / 重复下载后缀 (1)
   */
  function mapNameToPitch(name) {
    if (name === null || name === undefined) return null;
    var s = String(name);
    if (!s) return null;

    // 去掉目录部分（Windows 与 POSIX 两种分隔符）
    s = s.replace(/^.*[\\/]/, '');
    // 去掉音频扩展名
    s = s.replace(AUDIO_EXT_RE, '');
    // 统一 Unicode 升降号
    s = s.replace(/\u266F/g, '#').replace(/\u266D/g, 'b');
    // 归一化空白并小写
    s = s.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!s) return null;

    // 整名候选：原名 + 去掉「重复下载标记」的版本（`C4-1` / `C4 (2)` / `C4_03`）
    var primaries = [s];
    var stripped = s
      .replace(/[\s._-]*\(\s*\d{1,3}\s*\)$/, '')
      .replace(/[\s._-]+\d{1,2}$/, '');
    if (stripped && stripped !== s) primaries.push(stripped);

    // 片段候选：按 _ 空格 . - 切开
    var secondary = [];
    var i, j, parts;
    for (i = 0; i < primaries.length; i++) {
      parts = primaries[i].split(/[\s_.\-]+/);
      for (j = 0; j < parts.length; j++) {
        if (parts[j] && secondary.indexOf(parts[j]) === -1) secondary.push(parts[j]);
      }
    }

    // 1) 整名候选：全模式
    for (i = 0; i < primaries.length; i++) {
      var hit = matchPrimary(primaries[i]);
      if (hit !== null) return hit;
    }
    // 2) 片段候选：受限模式（更保守，避免误判）
    for (i = 0; i < secondary.length; i++) {
      var hit2 = matchSecondary(secondary[i]);
      if (hit2 !== null) return hit2;
    }
    return null;
  }

  /** 整名候选：允许全部命名法。 */
  function matchPrimary(c) {
    var m;
    // 科学音高记号
    m = /^([a-g])([#b]?)(-?\d{1,2})$/.exec(c);
    if (m) return sciToMidi(m[1], m[2], m[3]);
    // 纯数字：1..7 = 简谱（基准 C4），其余 = MIDI 号
    m = /^(\d{1,3})$/.exec(c);
    if (m) {
      var n = parseInt(m[1], 10);
      if (n >= 1 && n <= 7) return 60 + JIANPU_SEMITONE[n - 1];
      return (n >= 0 && n <= 127) ? n : null;
    }
    return matchCommon(c, true);
  }

  /** 片段候选：只接受明确无歧义的写法。 */
  function matchSecondary(c) {
    var m;
    // 科学音高记号
    m = /^([a-g])([#b]?)(-?\d{1,2})$/.exec(c);
    if (m) return sciToMidi(m[1], m[2], m[3]);
    // 片段里的纯数字只接受 21 键音域内的 MIDI 号（48..83），避免 `bass_1` 被当成简谱
    m = /^(\d{1,3})$/.exec(c);
    if (m) {
      var n = parseInt(m[1], 10);
      return (n >= PITCH_MIN && n <= PITCH_MAX) ? n : null;
    }
    // 片段里**不**接受单个键字母（`part_a.wav` 不该被当成 A 键）
    return matchCommon(c, false);
  }

  /** 科学音高记号 → MIDI（越界返回 null）。 */
  function sciToMidi(letter, acc, octaveStr) {
    var octave = parseInt(octaveStr, 10);
    var midi = (octave + 1) * 12 + LETTER_SEMITONE[letter];
    if (acc === '#') midi += 1;
    else if (acc === 'b') midi -= 1;
    if (midi < 0 || midi > 127) return null;
    return midi;
  }

  /** 整名与片段共用的模式：简谱±八度 / 唱名±八度 / midiN / 单字母键位。 */
  function matchCommon(c, allowKeyLetter) {
    var m;
    // 简谱 + 八度后缀：1- 1 1+ ... 7+（+ 高八度，- 低八度，基准 C4）
    m = /^([1-7])([+-])$/.exec(c);
    if (m) {
      var shift = m[2] === '+' ? 12 : -12;
      return 60 + JIANPU_SEMITONE[parseInt(m[1], 10) - 1] + shift;
    }
    // 唱名 + 可选八度后缀
    m = /^(do|re|mi|fa|sol|la|si|ti)([+-])?$/.exec(c);
    if (m) {
      var sh = m[2] === '+' ? 12 : (m[2] === '-' ? -12 : 0);
      return 60 + SOLFEGE_SEMITONE[m[1]] + sh;
    }
    // 显式 MIDI 前缀
    m = /^(?:midi|note|n|m)[\s_.\-]*(\d{1,3})$/.exec(c);
    if (m) {
      var v = parseInt(m[1], 10);
      return (v >= 0 && v <= 127) ? v : null;
    }
    // 单个键字母（仅整名，且仅限 21 键布局里的字母）
    if (allowKeyLetter) {
      m = /^([a-z])$/.exec(c);
      if (m) {
        var key = m[1].toUpperCase();
        if (Object.prototype.hasOwnProperty.call(KEY_LAYOUT, key)) return KEY_LAYOUT[key];
      }
    }
    return null;
  }

  /* =======================================================================
   * 1. 合成音色参数表
   *    每个音色：部分音幅度（≥6 个谐波）、轻微 detune、快 attack、指数 decay、
   *    无持续延音；余韵由 tail 控制（windsong 1.5–2s）。
   * ===================================================================== */

  var INSTRUMENTS = [
    {
      id: 'windsong', name: '风物之诗琴（合成·近似）', kind: 'synth',
      partials: [1, 0.52, 0.30, 0.17, 0.10, 0.055],  // 6 个谐波，柔和拨弦
      gain: 0.20, attack: 0.005, tail: 1.80, minTail: 0.90,
      lowpass: 3800, detune: 3.2, voiceGain: 0.42, voices: 2,
      pluck: 0.050, pluckTone: 2.6, pluckDecay: 0.035
    },
    {
      id: 'harp', name: '竖琴（合成）', kind: 'synth',
      partials: [1, 0.60, 0.38, 0.22, 0.13, 0.07, 0.04],  // 7 个谐波，更亮
      gain: 0.18, attack: 0.004, tail: 1.50, minTail: 0.70,
      lowpass: 5200, detune: 2.4, voiceGain: 0.38, voices: 2,
      pluck: 0.060, pluckTone: 3.2, pluckDecay: 0.030
    },
    {
      id: 'piano', name: '钢琴（合成）', kind: 'synth',
      partials: [1, 0.55, 0.40, 0.26, 0.17, 0.11, 0.07, 0.045, 0.030, 0.018],  // 10 个谐波
      gain: 0.19, attack: 0.003, tail: 2.60, minTail: 0.60,
      lowpass: 4400, detune: 1.6, voiceGain: 0.32, voices: 2,
      pluck: 0.045, pluckTone: 3.8, pluckDecay: 0.022
    },
    {
      id: 'musicbox', name: '音乐盒（合成）', kind: 'synth',
      partials: [1, 0.22, 0.55, 0.12, 0.34, 0.08, 0.20],  // 7 个谐波，3/5/7 次突出 → 铃铛感
      gain: 0.15, attack: 0.002, tail: 1.30, minTail: 0.45,
      lowpass: 8600, detune: 4.5, voiceGain: 0.34, voices: 2,
      pluck: 0.050, pluckTone: 5.5, pluckDecay: 0.018
    },
    {
      id: 'sample', name: '采样音色（自备文件）', kind: 'sample',
      partials: null, gain: 0.85, attack: 0.002, tail: 2.20, minTail: 0.15,
      lowpass: 20000, detune: 0, voiceGain: 0, voices: 0,
      pluck: 0, pluckTone: 0, pluckDecay: 0
    }
  ];

  var DEFAULT_INSTRUMENT = 'windsong';
  var MAX_VOICES = 72;      // 同时最多几条 voice，超出就偷最老的
  var EPS = 0.0001;         // 指数包络的非零起点（避免 0 值报错 / click）

  function findInstrument(id) {
    for (var i = 0; i < INSTRUMENTS.length; i++) {
      if (INSTRUMENTS[i].id === id) return INSTRUMENTS[i];
    }
    return null;
  }

  /* =======================================================================
   * 2. Engine
   * ===================================================================== */

  function Engine() {
    this._ctx = null;
    this._silent = false;          // 没有 AudioContext 时进入静默模式
    this._instrumentId = DEFAULT_INSTRUMENT;
    this._masterVolume = 0.9;
    this._voices = [];
    this._samples = {};            // midi -> {buffer, name}
    this._sampleMidis = [];        // 升序的已加载 MIDI
    this._waves = {};              // instrumentId -> PeriodicWave
    this._noiseBuf = null;
    this._rnd = makeRandom(0x9E3779B1);
    this._lastError = null;
  }

  /** 取（必要时创建）AudioContext；不可用时返回 null，永不抛。 */
  Engine.prototype.ensureContext = function () {
    if (this._ctx) return this._ctx;
    if (this._silent) return null;
    var Ctor = null;
    try {
      Ctor = root.AudioContext || root.webkitAudioContext || null;
    } catch (e) { Ctor = null; }
    if (!Ctor) { this._silent = true; return null; }
    try {
      this._ctx = new Ctor();
    } catch (e) {
      this._lastError = e;
      this._silent = true;
      return null;
    }
    try {
      this._buildGraph();
    } catch (e2) {
      this._lastError = e2;   // 图形构建失败也降级，不抛
    }
    return this._ctx;
  };

  /** 建立总线：dry/wet → 压缩器 → master → destination。 */
  Engine.prototype._buildGraph = function () {
    var ctx = this._ctx;

    var master = ctx.createGain();
    master.gain.setValueAtTime(clamp(this._masterVolume, 0, 4), ctx.currentTime);
    master.connect(ctx.destination);

    var comp = null;
    try {
      comp = ctx.createDynamicsCompressor();
      comp.threshold.setValueAtTime(-10, ctx.currentTime);
      comp.knee.setValueAtTime(8, ctx.currentTime);
      comp.ratio.setValueAtTime(6, ctx.currentTime);
      comp.attack.setValueAtTime(0.003, ctx.currentTime);
      comp.release.setValueAtTime(0.25, ctx.currentTime);
      comp.connect(master);
    } catch (e) { comp = null; }

    var busTarget = comp || master;

    var dry = ctx.createGain();
    dry.gain.setValueAtTime(0.86, ctx.currentTime);
    dry.connect(busTarget);

    var wet = ctx.createGain();
    wet.gain.setValueAtTime(0.32, ctx.currentTime);

    // 轻量混响：优先 ConvolverNode + 程序生成 IR；不可用则退化为 feedback-delay
    var conv = null;
    try {
      if (typeof ctx.createConvolver === 'function') {
        conv = ctx.createConvolver();
        conv.buffer = buildImpulse(ctx, 1.7, 2.7, makeRandom(0x1234567));
        if (conv.normalize !== undefined) conv.normalize = true;
        wet.connect(conv);
        conv.connect(busTarget);
      }
    } catch (e) { conv = null; }

    if (!conv) {
      // feedback-delay 混响兜底
      try {
        var d1 = ctx.createDelay(1.0), d2 = ctx.createDelay(1.0);
        var fb = ctx.createGain(), damp = ctx.createBiquadFilter();
        d1.delayTime.setValueAtTime(0.037, ctx.currentTime);
        d2.delayTime.setValueAtTime(0.061, ctx.currentTime);
        fb.gain.setValueAtTime(0.42, ctx.currentTime);
        damp.type = 'lowpass';
        damp.frequency.setValueAtTime(3200, ctx.currentTime);
        wet.connect(d1); d1.connect(damp); damp.connect(d2);
        d2.connect(fb); fb.connect(d1);
        d2.connect(busTarget);
      } catch (e2) { wet.connect(busTarget); }
    }

    this.master = master;
    this.comp = comp;
    this.dry = dry;
    this.wet = wet;
    this.conv = conv;

    // 拨弦起音用的短噪声（复用一个 buffer，避免每次分配）
    try {
      this._noiseBuf = buildNoise(ctx, 0.25, makeRandom(0xC0FFEE));
    } catch (e3) { this._noiseBuf = null; }
  };

  /** 每个音色各自的 PeriodicWave（按引擎缓存）。 */
  Engine.prototype._wave = function (inst) {
    if (this._waves[inst.id]) return this._waves[inst.id];
    if (!this._ctx || !inst.partials) return null;
    var n = inst.partials.length + 1;
    var real = new Float32Array(n);
    var imag = new Float32Array(n);
    for (var i = 0; i < inst.partials.length; i++) imag[i + 1] = inst.partials[i];
    var w = null;
    try {
      w = this._ctx.createPeriodicWave(real, imag);
    } catch (e) { w = null; }
    this._waves[inst.id] = w;
    return w;
  };

  /* ---------------------------- 契约方法 ---------------------------- */

  /** 恢复 AudioContext（async，契约 v1）。被浏览器拒绝也不抛，返回是否 running。 */
  Engine.prototype.resume = async function () {
    var ctx = this.ensureContext();
    if (!ctx) return false;
    if (ctx.state === 'running') return true;
    var p = null;
    try {
      p = ctx.resume();
    } catch (e) {
      this._lastError = e;
      return false;
    }
    if (!p || typeof p.then !== 'function') return ctx.state === 'running';
    try {
      await p;
    } catch (err) {
      this._lastError = err;
      return false;
    }
    return ctx.state === 'running';
  };

  Object.defineProperty(Engine.prototype, 'currentTime', {
    get: function () { return this._ctx ? this._ctx.currentTime : 0; },
    enumerable: true, configurable: true
  });

  Object.defineProperty(Engine.prototype, 'hasSamples', {
    get: function () { return this._sampleMidis.length > 0; },
    enumerable: true, configurable: true
  });

  Object.defineProperty(Engine.prototype, 'instrument', {
    get: function () { return this._instrumentId; },
    enumerable: true, configurable: true
  });

  Object.defineProperty(Engine.prototype, 'context', {
    get: function () { return this._ctx; },
    enumerable: true, configurable: true
  });

  Engine.prototype.setMasterVolume = function (v) {
    var vol = Number(v);
    if (!isFinite(vol)) vol = 1;
    this._masterVolume = clamp(vol, 0, 4);
    if (this.master && this._ctx) {
      try {
        this.master.gain.setTargetAtTime(this._masterVolume, this._ctx.currentTime, 0.02);
      } catch (e) {
        try { this.master.gain.value = this._masterVolume; } catch (e2) { /* ignore */ }
      }
    }
    return this._masterVolume;
  };

  /** 切换音色。未知 id 返回 false（不抛）。`sample` 需要已加载采样。 */
  Engine.prototype.setInstrument = function (id) {
    var inst = findInstrument(id);
    if (!inst) return false;
    if (inst.id === 'sample' && !this.hasSamples) return false;
    this._instrumentId = inst.id;
    return true;
  };

  /** 当前实际用于发声的音色（`sample` 无采样时回退到默认合成音色）。 */
  Engine.prototype._effectiveInstrument = function () {
    var inst = findInstrument(this._instrumentId) || findInstrument(DEFAULT_INSTRUMENT);
    if (inst.id === 'sample' && !this.hasSamples) return findInstrument(DEFAULT_INSTRUMENT);
    return inst;
  };

  /** 把「已过去的 when」夹到「现在 + 2ms」。 */
  Engine.prototype._resolveWhen = function (whenSec) {
    var ctx = this._ctx;
    var now = ctx ? ctx.currentTime : 0;
    var w = Number(whenSec);
    if (!isFinite(w)) return now + 0.002;
    if (w < now) return now + 0.002;
    return w;
  };

  /**
   * 安排一个音发声。所有时刻走 AudioContext 时间轴。
   * @param pitch   MIDI 号，或可被 mapNameToPitch 解析的名字
   * @param whenSec 绝对 AudioContext 时间（秒）；缺省 = 现在 + 5ms
   * @param durSec  闸门长度（秒）；<=0 / 缺省 = 用音色自然余韵
   * @param velocity 0..2，缺省 0.85
   */
  Engine.prototype.noteOn = function (pitch, whenSec, durSec, velocity) {
    var midi = pitch;
    if (typeof midi === 'string') midi = mapNameToPitch(midi);
    if (midi === null || midi === undefined || !isFinite(midi)) return false;
    midi = Math.round(midi);
    if (midi < 0 || midi > 127) return false;

    var ctx = this.ensureContext();
    if (!ctx) return false;

    var inst = this._effectiveInstrument();
    var dur = Number(durSec);
    if (!isFinite(dur) || dur < 0) dur = 0;
    var vel = Number(velocity);
    if (!isFinite(vel)) vel = 0.85;
    vel = clamp(vel, 0.01, 2);

    // AudioContext 被 resume 前也要能安全调度（不抛）
    var when = this._resolveWhen(whenSec);

    try {
      this._purge();
      if (this._voices.length >= MAX_VOICES) this._damp(this._voices[0], when);
      if (inst.id === 'sample') return this._sampleVoice(midi, when, dur, vel, inst);
      return this._synthVoice(midi, when, dur, vel, inst);
    } catch (e) {
      this._lastError = e;
      return false;
    }
  };

  /** 合成 voice：PeriodicWave 加法（≥6 谐波）+ 2 个轻微 detune 振荡器 + 短噪声起音。 */
  Engine.prototype._synthVoice = function (midi, when, dur, vel, inst) {
    var ctx = this._ctx;
    var freq = midiToFreq(midi);
    var tail = clamp(dur > 0 ? dur * 1.25 : inst.tail, inst.minTail, inst.tail);
    var attack = inst.attack;
    var peak = Math.max(0.0002, inst.gain * vel);
    var end = when + tail;
    var decayEnd = when + attack + Math.max(0.02, (tail - attack) * 0.85);

    var out = ctx.createGain();           // 包络：快 attack + 指数 decay + 尾段线性归零
    out.gain.setValueAtTime(EPS, when);
    out.gain.exponentialRampToValueAtTime(peak, when + attack);
    out.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * 0.0006), decayEnd);
    out.gain.linearRampToValueAtTime(0, end);

    var lp = ctx.createBiquadFilter();    // 音色亮度 + 高频键跟踪
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(
      clamp(inst.lowpass * Math.pow(freq / 440, 0.5), 600, ctx.sampleRate * 0.45), when);
    lp.Q.setValueAtTime(0.6, when);
    lp.connect(out);
    out.connect(this.dry);
    out.connect(this.wet);

    var nodes = [out, lp];
    var sources = [out];
    var wave = this._wave(inst);

    var count = Math.max(1, inst.voices | 0);
    for (var i = 0; i < count; i++) {
      var osc = ctx.createOscillator();
      if (wave) { try { osc.setPeriodicWave(wave); } catch (e) { /* 用默认正弦兜底 */ } }
      // 主振荡器 detune = 0 → A4 精确 440；其余做轻微随机 detune 制造厚度
      var cents = (i === 0) ? 0
        : ((i % 2 === 1) ? 1 : -1) * inst.detune * (0.4 + this._rnd() * 0.6);
      osc.frequency.setValueAtTime(freq, when);
      try { osc.detune.setValueAtTime(cents, when); } catch (e2) { /* ignore */ }
      var og = ctx.createGain();
      og.gain.setValueAtTime(i === 0 ? 1 : inst.voiceGain, when);
      osc.connect(og);
      og.connect(lp);
      osc.start(when);
      osc.stop(end + 0.02);
      nodes.push(osc, og);
      sources.push(osc);
    }

    // 拨弦起音噪声：极短带通噪声，让「起音快」听起来像拨到弦
    if (inst.pluck > 0 && this._noiseBuf) {
      try {
        var ns = ctx.createBufferSource();
        ns.buffer = this._noiseBuf;
        var maxOff = Math.max(0, this._noiseBuf.duration - 0.06);
        var off = this._rnd() * maxOff;
        var bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(
          clamp(freq * inst.pluckTone, 300, ctx.sampleRate * 0.45), when);
        bp.Q.setValueAtTime(0.9, when);
        var ng = ctx.createGain();
        var nDur = Math.max(0.012, inst.pluckDecay);
        ng.gain.setValueAtTime(EPS, when);
        ng.gain.exponentialRampToValueAtTime(Math.max(0.0002, inst.pluck * vel), when + 0.002);
        ng.gain.exponentialRampToValueAtTime(0.0002, when + nDur);
        ng.gain.linearRampToValueAtTime(0, when + nDur + 0.01);
        ns.connect(bp); bp.connect(ng); ng.connect(lp);
        ns.start(when, off, nDur + 0.02);
        nodes.push(ns, bp, ng);
        sources.push(ns);
      } catch (e3) { /* 噪声层失败不影响主音 */ }
    }

    this._voices.push({
      midi: midi, start: when, end: end,
      out: out, nodes: nodes, sources: sources, dampTau: 0.045
    });
    return true;
  };

  /** 采样 voice：用邻近采样 + playbackRate 变调兜底。 */
  Engine.prototype._sampleVoice = function (midi, when, dur, vel, inst) {
    var pick = this._nearestSample(midi);
    if (!pick) return false;
    var ctx = this._ctx;

    // 音高换算：目标相对采样原始音高差多少半音 → playbackRate = 2^(n/12)
    var rate = clamp(Math.pow(2, (midi - pick.midi) / 12), 0.125, 8);
    var native = pick.buffer.duration / rate;          // 该采样在这个音高上最长能响多久
    var wanted = dur > 0 ? dur * 1.25 : inst.tail;
    var tail = clamp(wanted, Math.min(inst.minTail, native), native);
    if (!(tail > 0.01)) tail = Math.min(0.01, native);
    var peak = Math.max(0.0002, inst.gain * vel);
    var end = when + tail;

    var src = ctx.createBufferSource();
    src.buffer = pick.buffer;
    try { src.playbackRate.setValueAtTime(rate, when); } catch (e) { src.playbackRate.value = rate; }

    var g = ctx.createGain();
    // 两端各留 2ms / 60ms 淡入淡出，避免采样首尾不干净造成 click
    var fadeOut = Math.min(0.06, tail * 0.5);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + 0.002);
    g.gain.setValueAtTime(peak, Math.max(when + 0.003, end - fadeOut));
    g.gain.linearRampToValueAtTime(0, end);

    src.connect(g);
    g.connect(this.dry);
    g.connect(this.wet);
    src.start(when);
    try { src.stop(end + 0.01); } catch (e2) { /* ignore */ }

    this._voices.push({
      midi: midi, start: when, end: end,
      out: g, nodes: [g], sources: [src, g],
      dampTau: 0.05, sampleMidi: pick.midi, rate: rate, name: pick.name
    });
    return true;
  };

  /** noteOff：对同音高的在响 voice 做平滑阻尼（无持续延音，所以只做衰减）。 */
  Engine.prototype.noteOff = function (pitch, whenSec) {
    var midi = pitch;
    if (typeof midi === 'string') midi = mapNameToPitch(midi);
    if (midi === null || midi === undefined || !isFinite(midi)) return false;
    midi = Math.round(midi);
    if (!this._ctx) return false;
    var when = this._resolveWhen(whenSec);
    var hit = false;
    for (var i = 0; i < this._voices.length; i++) {
      var v = this._voices[i];
      if (v.midi === midi && v.end > when) { this._damp(v, when); hit = true; }
    }
    return hit;
  };

  /** 全部阻尼（约 150ms 平滑收尾，不产生 click）。 */
  Engine.prototype.stopAll = function () {
    if (!this._ctx) return false;
    var when = this._ctx.currentTime + 0.005;
    for (var i = 0; i < this._voices.length; i++) this._damp(this._voices[i], when);
    return true;
  };

  Engine.prototype._damp = function (voice, when) {
    if (!voice || voice.damped) return;
    voice.damped = true;
    var g = voice.out && voice.out.gain;
    if (!g) return;
    try {
      if (typeof g.cancelAndHoldAtTime === 'function') g.cancelAndHoldAtTime(when);
      else g.cancelScheduledValues(when);
    } catch (e) { /* ignore */ }
    try {
      g.setTargetAtTime(0, when, voice.dampTau || 0.045);
    } catch (e2) {
      try { g.linearRampToValueAtTime(0, when + 0.1); } catch (e3) { /* ignore */ }
    }
    // 收尾后提前停掉所有源，尽快释放节点
    var stopAt = when + 0.4;
    for (var i = 0; i < voice.sources.length; i++) {
      var s = voice.sources[i];
      if (s && typeof s.stop === 'function') { try { s.stop(stopAt); } catch (e4) { /* ignore */ } }
    }
    voice.end = Math.min(voice.end, stopAt);
  };

  Engine.prototype._purge = function () {
    if (!this._ctx) return;
    var cutoff = this._ctx.currentTime - 0.3;
    var kept = [];
    for (var i = 0; i < this._voices.length; i++) {
      if (this._voices[i].end >= cutoff) kept.push(this._voices[i]);
    }
    this._voices = kept;
  };

  /* ------------------------ 采样加载（file:// 唯一入口） ------------------------ */

  /**
   * 从用户选择的 File 列表加载采样。
   * 绝不使用 fetch / URL 加载（file:// 下会被 CORS 拦）。
   * @returns {{loaded:number, mapping:Object, missing:string[],
   *            byMidi:Object, entries:Array, total:number, error?:string}}
   *   mapping : {"C3": "my-C3.mp3", ...}  ← 音名 → 原文件名
   *   byMidi  : {"48": "my-C3.mp3", ...}  ← MIDI → 原文件名
   *   entries : [{midi, pitch, fileName}] ← 便于 UI 直接渲染
   *   missing : 映射不上或解码失败的原始文件名
   */
  Engine.prototype.loadSampleFiles = async function (files) {
    var self = this;
    var list = [];
    if (files) {
      if (typeof files.length === 'number') {
        for (var i = 0; i < files.length; i++) list.push(files[i]);
      } else if (typeof files[Symbol.iterator] === 'function') {
        list = Array.prototype.slice.call(files);
      }
    }

    var result = {
      loaded: 0, mapping: {}, missing: [], byMidi: {}, entries: [],
      total: list.length, decoded: 0, failed: []
    };
    var ctx = this.ensureContext();
    if (!ctx) {
      result.error = 'No AudioContext available';
      for (var m = 0; m < list.length; m++) result.missing.push(fileNameOf(list[m]));
      return result;
    }

    var plan = [];
    for (var k = 0; k < list.length; k++) {
      var f = list[k];
      var nm = fileNameOf(f);
      var midi = mapNameToPitch(nm);
      if (midi === null || !f || typeof f.arrayBuffer !== 'function') {
        result.missing.push(nm);
        continue;
      }
      plan.push({ file: f, name: nm, midi: midi });
    }

    try {
      // 每个文件独立解码，单个失败不影响其它
      var results = await Promise.all(plan.map(async function (item) {
        try {
          var ab = await readArrayBuffer(item.file);
          var buffer = await decodeAudio(ctx, ab);
          return { item: item, buffer: buffer };
        } catch (err) {
          return { item: item, error: err };
        }
      }));

      for (var n = 0; n < results.length; n++) {
        var r = results[n];
        if (!r || r.error || !r.buffer) {
          var badName = r && r.item ? r.item.name : 'unknown';
          result.missing.push(badName);
          result.failed.push(badName);
          continue;
        }
        var midiHit = r.item.midi;
        if (!self._samples[midiHit]) {
          self._sampleMidis.push(midiHit);
          self._sampleMidis.sort(function (a, b) { return a - b; });
        }
        // 同音高重复出现时后加载的覆盖前者（用户后选的文件优先）
        self._samples[midiHit] = { buffer: r.buffer, name: r.item.name };
        var pitchName = midiToName(midiHit);
        result.mapping[pitchName] = r.item.name;
        result.byMidi[String(midiHit)] = r.item.name;
        result.entries.push({ midi: midiHit, pitch: pitchName, fileName: r.item.name });
        result.decoded++;
      }
    } catch (err2) {
      result.error = String(err2 && err2.message ? err2.message : err2);
    }

    result.entries.sort(function (a, b) { return a.midi - b.midi; });
    result.loaded = result.entries.length;
    // 有采样了就自动切到 sample 音色（用户显式 setInstrument 可改回）
    if (result.loaded > 0) self._instrumentId = 'sample';
    return result;
  };

  /**
   * 清空已加载的采样。
   * 为什么必须有它：loadSampleFiles 是**按 midi 合并写入**的（同 midi 后写覆盖），
   * 换乐器时若不先清空，上一套音色的采样会残留在没有新覆盖的音高上，
   * 变成「新旧音色混在一起」。UI 切换音色前先调这个。
   */
  Engine.prototype.clearSamples = function () {
    this._samples = {};
    this._sampleMidis = [];
    if (this._instrumentId === 'sample') this._instrumentId = DEFAULT_INSTRUMENT;
    return true;
  };

  /** 找最接近 midi 的已加载采样（缺音变调兜底）。 */
  Engine.prototype._nearestSample = function (midi) {
    var keys = this._sampleMidis;
    if (!keys.length) return null;
    if (this._samples[midi]) return { midi: midi, buffer: this._samples[midi].buffer, name: this._samples[midi].name };
    var lo = 0, hi = keys.length - 1, m;
    while (lo < hi) {
      m = (lo + hi) >> 1;
      if (keys[m] < midi) lo = m + 1; else hi = m;
    }
    var best = keys[lo];
    // 平手时取较低的采样（升调比降调更不容易出现怪异音色）
    if (lo > 0 && Math.abs(keys[lo - 1] - midi) <= Math.abs(best - midi)) best = keys[lo - 1];
    return { midi: best, buffer: this._samples[best].buffer, name: this._samples[best].name };
  };

  /** 调试信息：当前采样覆盖情况。 */
  Engine.prototype.sampleInfo = function () {
    var covered = [];
    for (var midi = 0; midi < 128; midi++) {
      if (this._samples[midi]) covered.push(midiToName(midi));
    }
    var missingInRange = [];
    for (var p = PITCH_MIN; p <= PITCH_MAX; p++) {
      if (!this._samples[p]) missingInRange.push(midiToName(p));
    }
    return {
      count: this._sampleMidis.length,
      covered: covered,
      missingInRange: missingInRange
    };
  };

  /* ------------------------------ 自检 ------------------------------ */

  /**
   * 自检。纯函数用例在 Node 下也能跑；Web Audio 用例在无 AudioContext 环境
   * 标记为 skipped（绝不算 failed）。
   *
   * 每条 case 的形态（契约 v1）：
   *   {name, ok:boolean, detail:string, status:'passed'|'failed'|'skipped',
   *    expected?, actual?, reason?}
   *   - `ok` 是契约要求的布尔字段：passed→true，failed→false，**skipped→null**
   *     （skipped 既不是成功也不是失败，用 null 避免下游把跳过当通过）。
   *   - `detail` 是给 console / UI 直接显示的一句话。
   */
  function selfTest() {
    var cases = [];
    var pass = 0, fail = 0, skip = 0;

    function fmt(v) {
      if (v === undefined) return 'undefined';
      if (v === null) return 'null';
      if (typeof v === 'string') return JSON.stringify(v);
      return String(v);
    }

    function ok(name, condition, details) {
      var has = details && (details.expected !== undefined || details.actual !== undefined);
      var detail = has
        ? 'expected ' + fmt(details.expected) + ', got ' + fmt(details.actual)
        : (condition ? 'ok' : 'assertion failed');
      cases.push({
        name: name,
        ok: !!condition,
        detail: detail,
        status: condition ? 'passed' : 'failed',
        expected: details ? details.expected : undefined,
        actual: details ? details.actual : undefined
      });
      if (condition) pass++; else fail++;
    }

    function skipCase(name, why) {
      var detail = 'skipped: ' + (why || 'not applicable in this environment');
      cases.push({
        name: name,
        ok: null,                 // 跳过 ≠ 通过
        detail: detail,
        status: 'skipped',
        reason: why,              // 保留原字段，兼容既有读取方
        expected: undefined,
        actual: undefined
      });
      skip++;
    }

    function eq(name, input, expected) {
      var actual = mapNameToPitch(input);
      ok(name + ' (' + String(input) + ' → ' + String(expected) + ')', actual === expected,
        { expected: expected, actual: actual });
    }

    // ---- 纯函数：A4 = 440 必须精确 ----
    ok('A4 = 440 Hz 精确', midiToFreq(69) === 440, { expected: 440, actual: midiToFreq(69) });
    ok('C4 ≈ 261.6256 Hz', Math.abs(midiToFreq(60) - 261.6255653) < 1e-6,
      { expected: 261.6255653, actual: midiToFreq(60) });
    ok('A3 = 220 Hz（A4 的一半）', midiToFreq(57) * 2 === 440,
      { expected: 440, actual: midiToFreq(57) * 2 });
    ok('每 +12 半音频率 ×2', Math.abs(midiToFreq(81) - midiToFreq(69) * 2) < 1e-9,
      { expected: midiToFreq(69) * 2, actual: midiToFreq(81) });
    ok('midiToName(48/69/83) = C3/A4/B5',
      midiToName(48) === 'C3' && midiToName(69) === 'A4' && midiToName(83) === 'B5',
      { actual: [midiToName(48), midiToName(69), midiToName(83)].join(',') });

    // ---- 纯函数：21 键完整性 ----
    var keyLetters = Object.keys(KEY_LAYOUT);
    var seen = {}, dup = false, inRange = true;
    for (var i = 0; i < keyLetters.length; i++) {
      var v = KEY_LAYOUT[keyLetters[i]];
      if (seen[v]) dup = true;
      seen[v] = true;
      if (v < PITCH_MIN || v > PITCH_MAX) inRange = false;
    }
    ok('21 键布局恰好 21 个键', keyLetters.length === 21, { expected: 21, actual: keyLetters.length });
    ok('21 键音高互不重复', !dup);
    ok('21 键全部落在 C3–B5 (48–83)', inRange);
    ok('21 键全部是 C 大调白键（无半音）',
      (function () {
        var white = [0, 2, 4, 5, 7, 9, 11];
        for (var k = 0; k < keyLetters.length; k++) {
          if (white.indexOf(KEY_LAYOUT[keyLetters[k]] % 12) === -1) return false;
        }
        return true;
      })());
    ok('每键字母都能被 mapNameToPitch 解析',
      keyLetters.every(function (L) { return mapNameToPitch(L + '.wav') === KEY_LAYOUT[L]; }));

    // ---- 纯函数：文件名映射 ----
    eq('科学音高记号 C3', 'C3.mp3', 48);
    eq('科学音高记号 A4', 'A4.wav', 69);
    eq('科学音高记号 B5', 'B5.mp3', 83);
    eq('升号 C#3', 'C#3.mp3', 49);
    eq('降号 Db3', 'Db3.wav', 49);
    eq('小写 c3', 'c3.mp3', 48);
    eq('大写扩展名', 'C5.MP3', 72);
    eq('键字母 Z', 'Z.wav', 48);
    eq('键字母 A', 'A.wav', 60);
    eq('键字母 U', 'U.mp3', 83);
    eq('MIDI 号 48', '48.wav', 48);
    eq('MIDI 号 83', '83.wav', 83);
    eq('唱名 do', 'do.wav', 60);
    eq('简谱 1', '1.mp3', 60);
    eq('简谱低八度 1-', '1-.mp3', 48);
    eq('简谱高八度 7+', '7+.mp3', 83);
    eq('非法名 readme', 'readme.txt', null);
    eq('非法名 kick', 'kick.wav', null);
    eq('非法名 komi', 'komi.wav', null);
    eq('空字符串', '', null);
    eq('null 输入', null, null);

    // ---- Web Audio 相关 ----
    var Ctor = null;
    try { Ctor = root.AudioContext || root.webkitAudioContext || null; } catch (e) { Ctor = null; }
    var engine = null;
    try { engine = createEngine(); } catch (e2) { engine = null; }

    ok('createEngine() 返回 Engine 形状',
      !!engine && typeof engine.resume === 'function' &&
      typeof engine.noteOn === 'function' && typeof engine.noteOff === 'function' &&
      typeof engine.stopAll === 'function' && typeof engine.setInstrument === 'function' &&
      typeof engine.setMasterVolume === 'function' &&
      typeof engine.loadSampleFiles === 'function' &&
      typeof engine.currentTime === 'number' &&
      typeof engine.hasSamples === 'boolean');

    ok('listInstruments() 含 windsong/piano/musicbox/harp 且 kind 合法',
      (function () {
        var list = listInstruments();
        var ids = list.map(function (x) { return x.id; });
        var need = ['windsong', 'piano', 'musicbox', 'harp'];
        for (var i = 0; i < need.length; i++) if (ids.indexOf(need[i]) === -1) return false;
        return list.every(function (x) {
          return x && typeof x.id === 'string' && typeof x.name === 'string' &&
            (x.kind === 'synth' || x.kind === 'sample');
        });
      })());

    if (engine) {
      ok('noteOn 在未 resume 时不抛（静默也安全）',
        (function () { try { engine.noteOn(69, 0, 0.5, 0.8); return true; } catch (e) { return false; } })());
      ok('noteOff/stopAll/setMasterVolume 不抛',
        (function () {
          try { engine.noteOff(69, 0); engine.stopAll(); engine.setMasterVolume(0.9); return true; }
          catch (e) { return false; }
        })());
      ok('setInstrument 未知 id 返回 false 且不抛',
        (function () { try { return engine.setInstrument('__nope__') === false; } catch (e) { return false; } })());
      ok('currentTime 是有限数', isFinite(engine.currentTime));
      ok('hasSamples 初始为 false', engine.hasSamples === false);
    } else {
      skipCase('engine 基础行为', 'createEngine() 失败');
    }

    if (!Ctor) {
      skipCase('AudioContext 创建 / 混响 IR / 真实调度', 'Node 环境无 AudioContext（预期）');
      skipCase('loadSampleFiles 真实解码', '无 AudioContext，无 decodeAudioData');
    } else if (!engine) {
      skipCase('AudioContext 创建 / 混响 IR / 真实调度', 'createEngine() 失败');
      skipCase('loadSampleFiles 真实解码', 'createEngine() 失败');
    } else {
      var savedVol = engine._masterVolume;
      engine.setMasterVolume(0);
      var ctx = engine.ensureContext();
      ok('AudioContext 创建成功', !!ctx, { actual: ctx ? ctx.state : 'null' });
      ok('混响节点已建立（convolver 或 feedback-delay）',
        !!(engine.dry && engine.wet && (engine.conv || engine.master)));
      ok('调度后 voice 计数 > 0',
        (function () {
          var before = engine._voices.length;
          engine.noteOn(69, engine.currentTime + 0.02, 0.4, 0.8);
          engine.noteOn(72, engine.currentTime + 0.04, 0.4, 0.8);
          return engine._voices.length > before;
        })());
      engine.stopAll();
      engine.setMasterVolume(savedVol);
      skipCase('loadSampleFiles 真实解码', '需要真实浏览器 File 对象，Node 自检跳过');
    }

    return {
      passed: pass, failed: fail, skipped: skip,
      cases: cases,
      environment: {
        hasAudioContext: !!Ctor,
        audioContextState: engine && engine.context ? engine.context.state : null,
        sampleRate: engine && engine.context ? engine.context.sampleRate : null,
        node: typeof process !== 'undefined' && process.versions ? process.versions.node : null,
        version: VERSION
      }
    };
  }

  /* =======================================================================
   * 3. 工具
   * ===================================================================== */

  function fileNameOf(entry) {
    if (!entry) return '';
    if (typeof entry === 'string') return entry;
    return String(entry.name || entry.fileName || entry.path || '');
  }

  /** File → ArrayBuffer。优先 arrayBuffer()，回退 FileReader。绝不 fetch。 */
  function readArrayBuffer(file) {
    if (file && typeof file.arrayBuffer === 'function') {
      try {
        var p = file.arrayBuffer();
        if (p && typeof p.then === 'function') return p;
      } catch (e) { /* 回退 FileReader */ }
    }
    return new Promise(function (resolve, reject) {
      var FR = root.FileReader || (typeof FileReader !== 'undefined' ? FileReader : null);
      if (!FR) { reject(new Error('FileReader unavailable')); return; }
      var reader = new FR();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error || new Error('FileReader error')); };
      try { reader.readAsArrayBuffer(file); } catch (e2) { reject(e2); }
    });
  }

  /** decodeAudioData 的 Promise 包装（兼容回调式旧实现）。 */
  function decodeAudio(ctx, arrayBuffer) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      function done(b) { if (!settled) { settled = true; resolve(b); } }
      function bad(e) { if (!settled) { settled = true; reject(e || new Error('decodeAudioData failed')); } }
      var p = null;
      try {
        p = ctx.decodeAudioData(arrayBuffer, done, bad);
      } catch (e) { bad(e); return; }
      if (p && typeof p.then === 'function') p.then(done, bad);
    });
  }

  /** 固定种子的 LCG：让 detune / 混响 IR 每次一致（可复现）。 */
  function makeRandom(seed) {
    var s = seed >>> 0;
    return function () {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  /** 程序生成混响脉冲响应：低通噪声 × 指数衰减 + 几个早期反射。 */
  function buildImpulse(ctx, seconds, decay, rnd) {
    var rate = ctx.sampleRate;
    var len = Math.max(8, Math.floor(rate * seconds));
    var buf = ctx.createBuffer(2, len, rate);
    var taps = [0.011, 0.019, 0.031, 0.047];
    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch);
      var lp = 0;
      for (var i = 0; i < len; i++) {
        var t = i / len;
        lp = lp * 0.72 + (rnd() * 2 - 1) * 0.28;   // 一阶低通 → 柔和的尾巴，不是白噪声
        d[i] = lp * Math.pow(1 - t, decay);
      }
      d[0] = 0;                                     // 起点清零，防 click
      for (var k = 0; k < taps.length; k++) {
        var idx = Math.floor(taps[k] * (ch ? 1.13 : 1) * rate);
        if (idx > 0 && idx < len) d[idx] += (0.22 - 0.04 * k) * (rnd() < 0.5 ? -1 : 1);
      }
    }
    return buf;
  }

  /** 短噪声 buffer，用于拨弦起音。 */
  function buildNoise(ctx, seconds, rnd) {
    var rate = ctx.sampleRate;
    var len = Math.max(16, Math.floor(rate * seconds));
    var buf = ctx.createBuffer(1, len, rate);
    var d = buf.getChannelData(0);
    var lp = 0;
    for (var i = 0; i < len; i++) {
      lp = lp * 0.5 + (rnd() * 2 - 1) * 0.5;
      d[i] = lp;
    }
    d[0] = 0;
    return buf;
  }

  /* =======================================================================
   * 4. 导出
   * ===================================================================== */

  function createEngine() { return new Engine(); }

  function listInstruments() {
    return INSTRUMENTS.map(function (x) {
      return { id: x.id, name: x.name, kind: x.kind };
    });
  }

  var BGIAudio = {
    // --- 契约 v1 ---
    createEngine: createEngine,
    listInstruments: listInstruments,

    // --- 契约要求的纯函数导出（Node 下可直接测） ---
    mapNameToPitch: mapNameToPitch,
    selfTest: selfTest,

    // --- 附加工具（只增不改，方便播放器/测试复用同一套乐理） ---
    midiToFreq: midiToFreq,
    midiToName: midiToName,
    freqToMidi: freqToMidi,
    KEY_LAYOUT: KEY_LAYOUT,
    PITCH_MIN: PITCH_MIN,
    PITCH_MAX: PITCH_MAX,
    DEFAULT_INSTRUMENT: DEFAULT_INSTRUMENT,
    VERSION: VERSION
  };

  root.BGIAudio = BGIAudio;
})(typeof window !== 'undefined' ? window : globalThis);
