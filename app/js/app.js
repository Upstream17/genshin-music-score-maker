/* ==========================================================================
   风物之诗琴 · 曲谱工坊  —  主程序
   --------------------------------------------------------------------------
   classic script（非 ES module），零依赖，file:// 双击直开。
   依赖（按顺序，先于本文件加载）：
     js/bettergi-parse.js  ->  window.BGIParse     曲谱解析（三种 type）
     js/audio-engine.js    ->  window.BGIAudio     Web Audio 音源
     js/samples.js         ->  window.BGI_SAMPLES  可选：21 音真实采样（base64）

   三个核心承诺：
     · 时间轴以 AudioContext.currentTime 为唯一时钟（setTimeout 只做提前调度）
     · 变速改的是「乐谱时间→音频时间」的换算，不改 playbackRate，所以不变调
     · 停止后不残留高亮（第一个音常在 t=0 起始，容易被误判为「按住」）
   ========================================================================== */
(function () {
  'use strict';

  /* ═══════════════════ 常量 ═══════════════════ */

  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  var SOLFEGE = { 0: 'do', 2: 're', 4: 'mi', 5: 'fa', 7: 'sol', 9: 'la', 11: 'si' };

  /* 原神风物之诗琴 21 键（上→下 三排），与 BetterGI StandardMappings 一致 */
  var ROWS = [
    { tag: '高', range: 'C5–B5', keys: ['Q', 'W', 'E', 'R', 'T', 'Y', 'U'] },
    { tag: '中', range: 'C4–B4', keys: ['A', 'S', 'D', 'F', 'G', 'H', 'J'] },
    { tag: '低', range: 'C3–B3', keys: ['Z', 'X', 'C', 'V', 'B', 'N', 'M'] }
  ];
  /* 低→高的音高顺序（卷帘纵轴） */
  var LABELS = 'ZXCVBNMASDFGHJQWERTYU';

  var FALLBACK_KEY_TO_PITCH = {
    Z: 48, X: 50, C: 52, V: 53, B: 55, N: 57, M: 59,
    A: 60, S: 62, D: 64, F: 65, G: 67, H: 69, J: 71,
    Q: 72, W: 74, E: 76, R: 77, T: 79, Y: 81, U: 83
  };

  var LOOKAHEAD_SEC = 0.30;
  var SCHED_INTERVAL_MS = 25;
  var MAX_IMPORT = 6000;
  var MIN_NOTE_MS = 30;
  var DEFAULT_DUR = 320;      /* 编辑模式下新加音符的默认时值 */
  var END_PAD_MS = 900;       /* 曲尾判定留白 */

  /* ═══════════════════ DOM ═══════════════════ */

  var el = {};
  function cacheDom() {
    [
      'appRoot', 'btnSidebar', 'btnSidebarClose', 'sidebarPanel', 'sidebarBackdrop',
      'btnNewScore', 'btnPickFiles', 'btnPickDir', 'dropzone', 'fileInput', 'dirInput',
      'importProgress', 'importBar', 'importText',
      'search', 'listCount', 'btnClearList', 'scoreList',
      'npTitle', 'npSub', 'npNoteName', 'npNoteSol',
      'btnPlay', 'btnPlayLabel', 'btnStop', 'btnPrev', 'btnNext', 'trackIndex',
      'btnStepBack', 'btnStepFwd',
      'speed', 'speedVal', 'loop', 'autoplay', 'btnPlayMode', 'playModeLabel',
      'tNow', 'tTotal', 'seek', 'seekWrap', 'seekFill', 'seekThumb',
      'keyboard', 'btnPlayKeys', 'playHint', 'btnRecord', 'btnRecordLabel',
      'btnHelp', 'helpModal', 'btnHelpClose',
      'modePlay', 'modeEdit',
      'editBar', 'editInfo', 'btnTimeLeft', 'btnTimeRight', 'btnPitchDown', 'btnPitchUp',
      'btnDurDown', 'btnDurUp', 'btnDel', 'btnRippleCut', 'btnInsertGap', 'btnDeselect', 'editSnap',
      'btnEditUndo', 'btnEditReset', 'btnEditExport',
      'roll', 'rollHint', 'zoom', 'zoomVal',
      'instrument', 'volume', 'btnLoadSamples', 'sampleInput', 'sampleStat',
      'diag', 'liveText', 'toast'
    ].forEach(function (id) { el[id] = document.getElementById(id); });
  }

  /* ═══════════════════ 状态 ═══════════════════ */

  var state = {
    entries: [],
    filter: '',
    selectedId: null,
    current: null,          /* 当前 Score（含可编辑的 notes 副本） */
    currentEntry: null,
    sourceJson: null,       /* 原始解析出来的 JSON 对象（导出 / 还原用） */
    maxNoteMs: 1,

    engine: null,
    instrumentKey: '',      /* 'real:<id>' 真实采样 | 'synth:<id>' 合成 */
    customFiles: null,      /* 用户自己加载的采样（本会话有效） */
    volume: 0.8,
    samplesReady: false,

    playing: false,
    posMs: 0,
    speed: 1,
    loop: false,
    autoplay: true,
    playMode: 'list',       /* 'list' 列表循环 | 'single' 单曲循环 | 'order' 顺序播放 */

    viewSec: 8,
    baseCtxTime: 0,
    baseScoreMs: 0,
    cursor: 0,
    seeking: false,
    nextId: 1,
    schedTimer: null,
    rollCtx: null,
    fatal: false,

    keysDown: null,
    heldKeys: {},           /* PC 键盘按住中的键（只影响视觉） */
    audition: {},
    playKeys: true,
    recording: false,
    recActiveNotes: {},

    edit: {
      on: true,
      selNote: null,
      selNotes: [],
      timeRange: null,
      boxRect: null,
      undo: [],
      dirty: false
    }
  };

  /* ═══════════════════ 小工具 ═══════════════════ */

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function pitchName(m) {
    if (window.BGIParse && typeof window.BGIParse.pitchName === 'function') {
      try { return window.BGIParse.pitchName(m); } catch (_) { /* fall through */ }
    }
    return NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  }
  function solfege(m) { return SOLFEGE[((m % 12) + 12) % 12] || ''; }

  function keyToPitch(k) {
    if (window.BGIParse && window.BGIParse.KEY_TO_PITCH && window.BGIParse.KEY_TO_PITCH[k] != null) {
      return window.BGIParse.KEY_TO_PITCH[k];
    }
    return FALLBACK_KEY_TO_PITCH[k];
  }
  function pitchToKey(p) {
    if (window.BGIParse && window.BGIParse.PITCH_TO_KEY && window.BGIParse.PITCH_TO_KEY[p]) {
      return window.BGIParse.PITCH_TO_KEY[p];
    }
    for (var k in FALLBACK_KEY_TO_PITCH) if (FALLBACK_KEY_TO_PITCH[k] === p) return k;
    return null;
  }
  /** 音级上下移动（只落在 21 键上，所以按白键音阶走） */
  function stepPitch(pitch, dir) {
    var i = LABELS.indexOf(pitchToKey(pitch));
    if (i < 0) return pitch;
    var j = clamp(i + dir, 0, 20);
    return keyToPitch(LABELS[j]);
  }

  function getSelectedNotes() {
    if (!state.current || !state.current.notes) {
      state.edit.selNotes = [];
      state.edit.selNote = null;
      return [];
    }
    var notes = state.current.notes;
    var list = (state.edit.selNotes && state.edit.selNotes.length)
      ? state.edit.selNotes.filter(function (n) { return notes.indexOf(n) >= 0; })
      : (state.edit.selNote && notes.indexOf(state.edit.selNote) >= 0 ? [state.edit.selNote] : []);
    state.edit.selNotes = list;
    state.edit.selNote = list.length ? list[list.length - 1] : null;
    return list;
  }

  function setSelectedNotes(arr) {
    var list = [];
    if (arr && arr.length && state.current && state.current.notes) {
      for (var i = 0; i < arr.length; i++) {
        var n = arr[i];
        if (n && list.indexOf(n) < 0 && state.current.notes.indexOf(n) >= 0) {
          list.push(n);
        }
      }
    }
    state.edit.selNotes = list;
    state.edit.selNote = list.length ? list[list.length - 1] : null;
  }

  function clearSelection() {
    state.edit.selNotes = [];
    state.edit.selNote = null;
    state.edit.timeRange = null;
    state.edit.boxRect = null;
  }

  function isNoteSelected(n) {
    if (!n) return false;
    if (state.edit.selNote === n) return true;
    return !!(state.edit.selNotes && state.edit.selNotes.indexOf(n) >= 0);
  }

  function fmtTime(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    var t = ms / 1000, m = Math.floor(t / 60), s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }
  function fmtDur(ms) {
    var t = Math.round((ms || 0) / 1000);
    return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var toastTimer = null;
  function toast(msg, kind, ms) {
    if (!el.toast) { console.warn(msg); return; }
    el.toast.textContent = msg;
    el.toast.className = 'toast' + (kind ? ' ' + kind : '');
    el.toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.hidden = true; }, ms || 3600);
  }

  function readText(file) {
    return new Promise(function (resolve, reject) {
      if (typeof file.text === 'function') { file.text().then(resolve, reject); return; }
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result)); };
      fr.onerror = function () { reject(fr.error || new Error('读取失败')); };
      fr.readAsText(file, 'utf-8');
    });
  }

  function upperBoundStart(notes, t) {
    var lo = 0, hi = notes.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (notes[mid].start > t) hi = mid; else lo = mid + 1; }
    return lo;
  }
  function lowerBoundEnd(notes, t) {
    var lo = 0, hi = notes.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (notes[mid].end > t) hi = mid; else lo = mid + 1; }
    return lo;
  }

  /* ═══════════════════ 音频引擎 ═══════════════════ */

  function engNow() {
    var e = state.engine;
    if (!e) return 0;
    try {
      var t = (typeof e.currentTime === 'function') ? e.currentTime() : e.currentTime;
      if (typeof t === 'number' && isFinite(t)) return t;
    } catch (_) { }
    try { if (e.ctx && typeof e.ctx.currentTime === 'number') return e.ctx.currentTime; } catch (_) { }
    return 0;
  }

  function ensureEngine() {
    if (state.engine) return true;
    if (!window.BGIAudio || typeof window.BGIAudio.createEngine !== 'function') {
      toast('音频引擎未加载：js/audio-engine.js 缺失', 'err');
      return false;
    }
    try { state.engine = window.BGIAudio.createEngine(); }
    catch (e) { toast('音频引擎初始化失败：' + ((e && e.message) || e), 'err'); return false; }
    try { state.engine.setMasterVolume(state.volume); } catch (_) { }
    /* 先给合成音色兜底；真实采样由 applyInstrument() 随后覆盖 */
    try { state.engine.setInstrument('windsong'); } catch (_) { }
    return true;
  }

  function safeResume() {
    return Promise.resolve()
      .then(function () { if (state.engine && typeof state.engine.resume === 'function') return state.engine.resume(); })
      .catch(function () { toast('浏览器阻止了音频启动 —— 请再点一次「播放」', 'err'); });
  }

  function noteOn(pitch, whenSec, durSec, vel) {
    if (!state.engine) return;
    try { state.engine.noteOn(pitch, whenSec, durSec, vel == null ? 0.9 : vel); } catch (_) { }
  }

  var lastAuditionPitch = null;
  var lastAuditionTime = 0;
  function auditionNote(n, throttled) {
    if (!n || !ensureEngine()) return;
    var now = Date.now();
    if (throttled && lastAuditionPitch === n.pitch && now - lastAuditionTime < 140) return;
    lastAuditionPitch = n.pitch;
    lastAuditionTime = now;
    var durSec = Math.max(0.18, Math.min(0.9, (n.end - n.start) / 1000));
    safeResume().then(function () {
      noteOn(n.pitch, engNow() + 0.005, durSec, n.velocity || 0.95);
    });
  }

  /* ═══════════════════ 音色：真实采样（多套） + 合成兜底 ═══════════════════
     真实采样按「每套一个 js」组织：samples.js 里是**清单 + 默认音色**，
     其余 samples-<id>.js 在切换时用 <script> 动态加载（file:// 下同样可用）。
     engine 的采样是**按 midi 合并写入**的，所以换套之前必须 clearSamples()，
     否则上一套的音色会残留在没被新套覆盖的音高上。 */

  var SYNTH_PREFIX = 'synth:';
  var setLoading = {};         /* id -> Promise（避免重复注入 script） */
  var applyToken = 0;          /* 防止快速连切时旧结果覆盖新选择 */

  function sampleManifest() {
    return (window.BGI_SAMPLE_MANIFEST && window.BGI_SAMPLE_MANIFEST.length)
      ? window.BGI_SAMPLE_MANIFEST : null;
  }

  function setSampleStat(text, kind) {
    if (!el.sampleStat) return;
    el.sampleStat.textContent = text;
    el.sampleStat.className = 'sample-stat' + (kind ? ' ' + kind : '');
  }

  /** 下拉框数据：真实音色在前，合成压到最后并明确标「备用」 */
  function instrumentOptions() {
    var out = [];
    var mf = sampleManifest();
    if (mf) {
      mf.forEach(function (m) {
        out.push({ key: 'real:' + m.id, label: m.name, id: m.id });
      });
    }
    if (state.customFiles) {
      out.push({ key: 'real:custom', label: '自定义采样（本次）', id: 'custom' });
    }
    var synths = [];
    try {
      synths = (window.BGIAudio.listInstruments() || []).filter(function (x) { return x.kind === 'synth'; });
    } catch (_) { }
    synths.forEach(function (s) {
      if (s.id === 'windsong') return; /* 用户要求：合成 风物之诗琴是历史遗留，删去 */
      out.push({
        key: SYNTH_PREFIX + s.id,
        label: '合成（备用）· ' + s.name.replace(/[（(].*?[)）]/g, ''),
        id: s.id
      });
    });
    return out;
  }

  /** 按需注入某套音色的数据文件 */
  function ensureSetScript(id) {
    if (window.BGI_SAMPLE_SETS && window.BGI_SAMPLE_SETS[id]) return Promise.resolve();
    if (setLoading[id]) return setLoading[id];
    var mf = (sampleManifest() || []).filter(function (m) { return m.id === id; })[0];
    if (!mf || !mf.file) return Promise.reject(new Error('没有该音色的数据文件'));
    setLoading[id] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = mf.file;
      s.onload = function () { resolve(); };
      s.onerror = function () { delete setLoading[id]; reject(new Error('无法加载 ' + mf.file)); };
      document.body.appendChild(s);
    });
    return setLoading[id];
  }

  /** base64 → File[]（文件名用科学音高，引擎按文件名识别音高） */
  function filesFromBank(notes) {
    var out = [];
    Object.keys(notes).forEach(function (note) {
      var b64 = String(notes[note]).split(',')[1] || '';
      var bin = atob(b64), len = bin.length, arr = new Uint8Array(len);
      for (var i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
      out.push(new File([arr], note + '.mp3', { type: 'audio/mpeg' }));
    });
    return out;
  }

  async function applyInstrument(key) {
    key = key || state.instrumentKey;
    if (!key) return;
    state.instrumentKey = key;
    if (!ensureEngine()) return;
    var token = ++applyToken;

    /* 合成音色 */
    if (key.indexOf(SYNTH_PREFIX) === 0) {
      try { state.engine.setInstrument(key.slice(SYNTH_PREFIX.length)); } catch (_) { }
      setSampleStat('合成音色（备用）· 没有真实采样时的兜底', '');
      return;
    }

    /* 真实采样 */
    var id = key.slice(5);
    var info = id === 'custom'
      ? { name: '自定义采样' }
      : ((sampleManifest() || []).filter(function (m) { return m.id === id; })[0] || { name: id });

    setSampleStat('正在加载「' + info.name + '」…', '');
    try {
      var files;
      if (id === 'custom') {
        if (!state.customFiles) throw new Error('请重新选择采样文件夹');
        files = state.customFiles;
      } else {
        await ensureSetScript(id);
        var bank = window.BGI_SAMPLE_SETS && window.BGI_SAMPLE_SETS[id];
        if (!bank || !bank.notes) throw new Error('音色数据缺失');
        files = filesFromBank(bank.notes);
      }
      if (token !== applyToken) return;

      if (typeof state.engine.clearSamples === 'function') state.engine.clearSamples();
      var res = await state.engine.loadSampleFiles(files);
      if (token !== applyToken) return;

      state.engine.setInstrument('sample');
      state.samplesReady = true;
      var miss = 21 - res.loaded;
      setSampleStat(info.name + ' · 真实采样 ' + res.loaded + '/21 音' +
        (miss > 0 ? '（缺 ' + miss + ' 音，用邻近采样变调）' : ' ✓'), 'ok');
    } catch (e) {
      if (token !== applyToken) return;
      setSampleStat('「' + info.name + '」加载失败：' + ((e && e.message) || e) + ' · 已回退合成音色', 'err');
      try { state.engine.setInstrument('windsong'); } catch (_) { }
    }
  }

  /* ═══════════════════ 浏览器本地缓存（每用户独立持久化） ═══════════════════ */

  var WORKSPACE_KEY = 'bgi_lyre_workspace_v1';
  var workspaceReady = false;
  var hiddenShowcasePaths = {};
  var saveTimer = null;
  var warnedQuota = false;

  function compactNotes(notes) {
    if (!Array.isArray(notes)) return null;
    var out = [];
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i];
      if (!n || !n.key) continue;
      if (n.velocity != null && n.velocity !== 1) out.push([n.key, n.start, n.end, n.velocity]);
      else out.push([n.key, n.start, n.end]);
    }
    return out;
  }

  function expandNotes(arr) {
    if (!Array.isArray(arr)) return [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var r = arr[i];
      if (!Array.isArray(r) || r.length < 3) continue;
      var k = String(r[0] || '');
      var pitch = keyToPitch(k);
      if (pitch == null) continue;
      var start = Number(r[1]) || 0;
      var end = Math.max(start + MIN_NOTE_MS, Number(r[2]) || (start + MIN_NOTE_MS));
      var vel = r.length >= 4 && r[3] != null ? Number(r[3]) : 1;
      out.push({ key: k, pitch: pitch, start: start, end: end, velocity: vel });
    }
    return out;
  }

  function loadWorkspaceCache() {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) return null;
      var raw = localStorage.getItem(WORKSPACE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function buildWorkspacePayload(compactLargeText) {
    var customEntries = [];
    var showcaseEdits = {};
    for (var i = 0; i < state.entries.length; i++) {
      var e = state.entries[i];
      if (!e) continue;
      if (e.isShowcase) {
        if (e.edited || e.renamed) {
          showcaseEdits[e.path] = {
            name: e.name,
            renamed: !!e.renamed,
            edited: !!e.edited,
            workingNotes: e.edited && e.workingNotes ? compactNotes(e.workingNotes) : null
          };
        }
        continue;
      }
      if (compactLargeText && !e.edited && !e.isNew && e.text && e.text.length > 50000) continue;
      customEntries.push({
        path: e.path,
        fileName: e.fileName,
        name: e.name,
        author: e.author || '',
        type: e.type || 'midi',
        bpm: e.bpm || 120,
        ticks: e.ticks || 1000,
        ok: !!e.ok,
        isNew: !!e.isNew,
        renamed: !!e.renamed,
        edited: !!e.edited,
        error: e.error || '',
        noteCount: e.noteCount || 0,
        durationMs: e.durationMs || 0,
        instrument: e.instrument || '',
        text: e.isNew ? '' : (e.text || ''),
        workingNotes: (e.edited || e.isNew) && e.workingNotes ? compactNotes(e.workingNotes) : null
      });
    }
    return {
      v: 1,
      selectedPath: state.currentEntry ? state.currentEntry.path : null,
      prefs: {
        volume: state.volume,
        speed: state.speed,
        playMode: state.playMode,
        playKeys: !!state.playKeys,
        instrumentKey: state.instrumentKey === 'real:custom' ? '' : state.instrumentKey
      },
      hiddenShowcase: Object.keys(hiddenShowcasePaths),
      showcaseEdits: showcaseEdits,
      customEntries: customEntries
    };
  }

  function saveWorkspaceNow() {
    if (!workspaceReady) return false;
    try {
      if (typeof localStorage === 'undefined' || !localStorage) return false;
      localStorage.setItem(WORKSPACE_KEY, JSON.stringify(buildWorkspacePayload(false)));
      return true;
    } catch (_) {
      try {
        localStorage.setItem(WORKSPACE_KEY, JSON.stringify(buildWorkspacePayload(true)));
        if (!warnedQuota) {
          warnedQuota = true;
          toast('浏览器缓存空间紧张，部分大型未编辑曲谱仅在当前页面保留', 'err', 4200);
        }
        return true;
      } catch (_2) {
        return false;
      }
    }
  }

  function scheduleSaveWorkspace() {
    if (!workspaceReady) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      saveWorkspaceNow();
    }, 250);
  }

  function restoreWorkspaceEntries(saved) {
    hiddenShowcasePaths = {};
    if (!saved) return;
    if (Array.isArray(saved.hiddenShowcase)) {
      for (var h = 0; h < saved.hiddenShowcase.length; h++) {
        var hp = String(saved.hiddenShowcase[h] || '');
        if (hp) hiddenShowcasePaths[hp] = true;
      }
    }
    var list = Array.isArray(saved.customEntries) ? saved.customEntries : [];
    for (var i = 0; i < list.length; i++) {
      var ce = list[i];
      if (!ce || (!ce.isNew && !ce.text)) continue;
      var notes = Array.isArray(ce.workingNotes) ? expandNotes(ce.workingNotes) : null;
      var noteCount = notes ? notes.length : (ce.noteCount || 0);
      var dur = ce.durationMs || 0;
      if (notes) {
        var maxEnd = 0;
        for (var k = 0; k < notes.length; k++) if (notes[k].end > maxEnd) maxEnd = notes[k].end;
        dur = ce.isNew ? maxEnd : Math.max(dur, maxEnd);
      }
      var m = String(ce.name || '').match(/^未命名曲谱\s+(\d+)$/);
      if (m) {
        var seq = parseInt(m[1], 10);
        if (seq > newScoreSeq) newScoreSeq = seq;
      }
      state.entries.push({
        id: state.nextId++,
        path: ce.path || (ce.name + '.json'),
        fileName: ce.fileName || (ce.name + '.json'),
        name: ce.name || '未命名曲谱',
        author: ce.author || '',
        type: ce.type || 'midi',
        bpm: ce.bpm || 120,
        ticks: ce.ticks || 1000,
        ok: ce.ok !== false,
        isNew: !!ce.isNew,
        renamed: !!ce.renamed,
        edited: !!ce.edited,
        error: ce.error || '',
        noteCount: noteCount,
        durationMs: dur,
        instrument: ce.instrument || '',
        text: ce.text || '',
        workingNotes: notes
      });
    }
    if (state.entries.length) {
      sortEntries();
      renderList();
      var want = saved.selectedPath
        ? state.entries.filter(function (e) { return e.path === saved.selectedPath && e.ok; })[0]
        : null;
      if (want) selectEntry(want.id);
    }
    updateTrackNav();
  }

  /* ═══════════════════ 导入 ═══════════════════ */

  function pickJson(files) {
    var json = [], other = 0;
    for (var i = 0; i < files.length; i++) {
      if (/\.json$/i.test(files[i].name)) json.push(files[i]); else other++;
    }
    return { json: json, other: other };
  }

  function walkEntry(entry, out) {
    return new Promise(function (resolve) {
      if (!entry) { resolve(); return; }
      if (entry.isFile) {
        entry.file(function (f) { out.push(f); resolve(); }, function (err) {
          console.warn('读取文件失败: ' + entry.name, err);
          resolve();
        });
      } else if (entry.isDirectory) {
        var reader = entry.createReader(), all = [];
        (function readBatch() {
          reader.readEntries(function (batch) {
            if (!batch || !batch.length) {
              Promise.all(all.map(function (e) { return walkEntry(e, out); })).then(function () { resolve(); });
              return;
            }
            all = all.concat(batch);
            readBatch();
          }, function (err) {
            console.warn('读取目录失败: ' + entry.name, err);
            resolve();
          });
        })();
      } else { resolve(); }
    });
  }

  function collectFromDataTransfer(dt) {
    return new Promise(function (resolve) {
      if (!dt) { resolve([]); return; }
      var items = dt.items;

      // 1. 若浏览器不支持 DataTransferItemList 或为空，直接使用 dt.files
      if (!items || !items.length) {
        resolve(Array.prototype.slice.call(dt.files || []));
        return;
      }

      // 2. 检查是否有目录条目
      var hasDir = false;
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          var testEn = items[i].webkitGetAsEntry ? items[i].webkitGetAsEntry() : null;
          if (testEn && testEn.isDirectory) {
            hasDir = true;
            break;
          }
        }
      }

      // 3. 若仅拖入了文件（无目录），dt.files / getAsFile 是同步原生 File 句柄，
      //    在本地 file:// 协议和各种浏览器下均可直接读取，绝不会遭遇 FileSystemEntry.file 的 EncodingError！
      if (!hasDir) {
        var directFiles = [];
        if (dt.files && dt.files.length) {
          directFiles = Array.prototype.slice.call(dt.files);
        } else {
          for (var j = 0; j < items.length; j++) {
            if (items[j].kind === 'file') {
              var df = items[j].getAsFile ? items[j].getAsFile() : null;
              if (df) directFiles.push(df);
            }
          }
        }
        resolve(directFiles);
        return;
      }

      // 4. 若包含目录：对普通文件优先使用 getAsFile / dt.files，仅对目录走 walkEntry
      var out = [], dirEntries = [];
      for (var k = 0; k < items.length; k++) {
        var it = items[k];
        if (it.kind !== 'file') continue;
        var en = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
        if (en && en.isDirectory) {
          dirEntries.push(en);
        } else {
          var f = it.getAsFile ? it.getAsFile() : null;
          if (!f && dt.files && dt.files[k]) f = dt.files[k];
          if (f) out.push(f);
          else if (en) dirEntries.push(en);
        }
      }

      if (!dirEntries.length) {
        resolve(out);
        return;
      }

      Promise.all(dirEntries.map(function (e) { return walkEntry(e, out); }))
        .then(function () {
          // 若目录递归在沙箱（如 file://）下受限导致未能读取任何文件，但 dt.files 有记录，尝试兜底
          if (!out.length && dt.files && dt.files.length) {
            out = Array.prototype.slice.call(dt.files);
          }
          resolve(out);
        });
    });
  }

  async function importFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) {
      toast('未检测到可导入的文件。若拖入的是文件夹，建议点击左侧「选择文件夹」按钮导入', 'err', 4500);
      return;
    }
    if (files.length > MAX_IMPORT) {
      toast('一次拖入 ' + files.length + ' 个文件，超过上限 ' + MAX_IMPORT, 'err');
      return;
    }
    var picked = pickJson(files);
    if (!picked.json.length) {
      toast('没有找到 .json 曲谱文件' + (picked.other ? '（忽略了 ' + picked.other + ' 个非 json）' : ''), 'err');
      return;
    }

    el.importProgress.hidden = false;
    el.importBar.style.width = '0%';

    var seen = {};
    state.entries.forEach(function (e) { seen[e.path] = true; });

    var added = 0, updated = 0, failed = 0, errors = [];

    for (var i = 0; i < picked.json.length; i++) {
      var f = picked.json[i];
      var path = f.webkitRelativePath || f.name;
      el.importBar.style.width = Math.round(((i + 1) / picked.json.length) * 100) + '%';
      el.importText.textContent = (i + 1) + ' / ' + picked.json.length + ' · ' + f.name;

      var existing = null;
      for (var j = 0; j < state.entries.length; j++) {
        var ee = state.entries[j];
        if (ee.path === path || ee.fileName === f.name) {
          existing = ee;
          break;
        }
      }

      try {
        var text = await readText(f);
        var obj = JSON.parse(text);
        var sc = window.BGIParse.parseScore(obj, { filename: f.name });

        if (existing) {
          existing.name = sc.ok ? (sc.name || f.name.replace(/\.json$/i, '')) : f.name.replace(/\.json$/i, '');
          existing.author = sc.author || '';
          existing.type = sc.type || 'unknown';
          existing.ok = !!sc.ok;
          existing.error = sc.error || '';
          existing.noteCount = sc.stats ? sc.stats.noteCount : 0;
          existing.durationMs = sc.stats ? sc.stats.durationMs : 0;
          existing.instrument = sc.instrument || '';
          existing.text = text;
          existing.edited = false;
          existing.renamed = false;
          existing.workingNotes = null;
          updated++;

          if (state.selectedId === existing.id) {
            state.sourceJson = obj;
            sc.notes = sc.notes.map(function (n) {
              return { key: n.key, pitch: n.pitch, start: n.start, end: n.end, velocity: n.velocity };
            });
            state.current = sc;
            state.currentEntry = existing;
            recomputeDerived();
            renderDiag(existing, sc);
            updateEditBar();
            drawRoll(currentScoreMs());
            if (el.npTitle) el.npTitle.textContent = sc.name || existing.name;
            if (el.npSub) el.npSub.textContent = [sc.author || '未知作者', sc.type,
              'bpm ' + sc.bpm + ' · ticks ' + sc.ticks,
              sc.stats.noteCount + ' 音', fmtDur(sc.stats.durationMs)].join(' · ');
            if (el.tTotal) el.tTotal.textContent = fmtTime(sc.stats.durationMs);
          }
        } else {
          state.entries.push({
            id: state.nextId++,
            path: path,
            fileName: f.name,
            name: sc.ok ? (sc.name || f.name.replace(/\.json$/i, '')) : f.name.replace(/\.json$/i, ''),
            author: sc.author || '',
            type: sc.type || 'unknown',
            ok: !!sc.ok,
            error: sc.error || '',
            noteCount: sc.stats ? sc.stats.noteCount : 0,
            durationMs: sc.stats ? sc.stats.durationMs : 0,
            instrument: sc.instrument || '',
            text: text
          });
          added++;
        }
      } catch (e) {
        failed++;
        if (errors.length < 6) errors.push(f.name + '：' + ((e && e.message) || e));
      }
      if (i % 20 === 0) await new Promise(function (r) { setTimeout(r, 0); });
    }

    el.importProgress.hidden = true;
    sortEntries();
    renderList();

    var msgParts = [];
    if (updated) msgParts.push('更新 ' + updated + ' 首');
    if (added) msgParts.push('导入 ' + added + ' 首');
    if (failed) msgParts.push('失败 ' + failed);
    if (picked.other) msgParts.push('忽略 ' + picked.other);
    var msg = msgParts.join(' · ') || '曲谱已是最新';
    toast(msg, failed ? 'err' : 'ok', 4200);

    if (errors.length) console.warn('导入失败样例：', errors);
    if (state.entries.length && !state.selectedId) {
      var firstOk = state.entries.filter(function (e) { return e.ok; })[0];
      if (firstOk) selectEntry(firstOk.id);
    }
    updateTrackNav();
    if (added || updated) scheduleSaveWorkspace();
  }

  function sortEntries() {
    state.entries.sort(function (a, b) {
      if (a.ok !== b.ok) return a.ok ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
  }

  /* ═══════════════════ 歌单 ═══════════════════ */

  function visibleEntries() {
    var q = state.filter.trim().toLowerCase();
    if (!q) return state.entries;
    return state.entries.filter(function (e) {
      return (e.name + ' ' + e.author + ' ' + e.type + ' ' + e.path).toLowerCase().indexOf(q) >= 0;
    });
  }
  function playableEntries() {
    return state.entries.filter(function (e) { return e.ok; });
  }
  function playlistPos() {
    var list = playableEntries();
    for (var i = 0; i < list.length; i++) if (list[i].id === state.selectedId) return { i: i, n: list.length };
    return { i: -1, n: list.length };
  }

  function updateTrackNav() {
    var p = playlistPos();
    if (el.trackIndex) {
      el.trackIndex.textContent = p.n ? ((p.i < 0 ? '—' : (p.i + 1)) + ' / ' + p.n) : '—';
    }
    var has = p.n > 1;
    if (el.btnPrev) el.btnPrev.disabled = !has;
    if (el.btnNext) el.btnNext.disabled = !has;
  }

  /** 切到歌单里的相对位置（保持播放状态） */
  function jumpTrack(delta, startPlaying) {
    var list = playableEntries();
    if (!list.length) return;
    var cur = playlistPos().i;
    var next = cur < 0 ? 0 : cur + delta;
    if (next < 0) next = list.length - 1;
    if (next >= list.length) {
      if (state.playMode === 'order') {
        stopPlayback();
        return;
      }
      next = 0;
    }
    var wasPlaying = state.playing || startPlaying;
    selectEntry(list[next].id);
    scrollListTo(list[next].id);
    if (wasPlaying) playCurrent();
  }

  function scrollListTo(id) {
    var li = el.scoreList && el.scoreList.querySelector('li[data-id="' + id + '"]');
    if (li && li.scrollIntoView) li.scrollIntoView({ block: 'nearest' });
  }

  /* ═══════════════════ 列表 ═══════════════════ */

  function renderList() {
    var list = visibleEntries();
    el.listCount.textContent = list.length + ' / ' + state.entries.length + ' 首';

    var html = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var cls = 'li' + (e.id === state.selectedId ? ' sel' : '') + (e.ok ? '' : ' bad');
      var badge = e.ok
        ? '<span class="badge">' + esc(e.isNew ? 'new' : e.type) + '</span>'
        : '<span class="badge err">!</span>';
      var sub = e.ok
        ? [fmtDur(e.durationMs), e.noteCount + ' 音', e.author || ''].filter(Boolean).join(' · ')
        : esc(e.error || '无法解析');
      html.push(
        '<li class="' + cls + '" data-id="' + e.id + '" title="' + esc(e.path) + '">' +
        '<div class="li-name">' +
          badge +
          '<span class="nm">' + esc(e.name) + '</span>' +
          '<span class="li-actions">' +
            '<button type="button" class="li-btn li-edit" data-action="edit" title="重命名此曲">' +
              '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>' +
            '</button>' +
            '<button type="button" class="li-btn li-del" data-action="del" title="移除此曲">' +
              '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>' +
            '</button>' +
          '</span>' +
        '</div>' +
        '<div class="li-sub">' + sub + '</div>' +
        '</li>'
      );
    }
    el.scoreList.innerHTML = html.join('') ||
      '<li class="empty-state">还没有曲谱<br>点击上方「＋ 新建曲谱」或导入 .json</li>';
  }

  function resetToEmptyState() {
    state.selectedId = null;
    state.current = null;
    state.currentEntry = null;
    state.sourceJson = null;
    clearSelection();
    stopPlayback();
    el.npTitle.textContent = '未选择曲目';
    updateNpTitleEditable(false);
    el.npSub.textContent = '从左侧新建或导入曲谱，也可以将文件夹拖进来';
    el.btnPlay.disabled = true; el.btnStop.disabled = true; el.seek.disabled = true;
    if (el.btnStepBack) el.btnStepBack.disabled = true;
    if (el.btnStepFwd) el.btnStepFwd.disabled = true;
    el.tTotal.textContent = '0:00.0';
    if (el.diag) el.diag.textContent = '—';
    renderList(); updateTrackNav(); clearKeys(); drawRoll(0); updateEditBar();
  }

  function deleteEntry(id) {
    var idx = -1, target = null;
    for (var i = 0; i < state.entries.length; i++) {
      if (state.entries[i].id === id) { idx = i; target = state.entries[i]; break; }
    }
    if (idx < 0 || !target) return;

    var removedName = target.name || '未命名';
    var wasSelected = (state.selectedId === id);
    if (target.isShowcase && target.path) hiddenShowcasePaths[target.path] = true;
    state.entries.splice(idx, 1);

    if (wasSelected) {
      if (state.entries.length > 0) {
        var nextIdx = Math.min(idx, state.entries.length - 1);
        selectEntry(state.entries[nextIdx].id);
      } else {
        resetToEmptyState();
      }
    } else {
      renderList();
      updateTrackNav();
    }
    scheduleSaveWorkspace();
    toast('已移除「' + removedName + '」', 'ok');
  }

  function startInlineListRename(li, id) {
    var entry = null;
    for (var i = 0; i < state.entries.length; i++) {
      if (state.entries[i].id === id) { entry = state.entries[i]; break; }
    }
    if (!entry || !li) return;
    var nmEl = li.querySelector('.nm');
    if (!nmEl) return;

    nmEl.setAttribute('contenteditable', 'true');
    nmEl.setAttribute('spellcheck', 'false');
    nmEl.focus();
    try {
      var range = document.createRange();
      range.selectNodeContents(nmEl);
      var sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    } catch (_) {}

    var done = false;
    function finish(save) {
      if (done) return;
      done = true;
      nmEl.removeAttribute('contenteditable');
      nmEl.removeEventListener('keydown', onKey);
      nmEl.removeEventListener('blur', onBlur);
      if (!save) {
        nmEl.textContent = entry.name || '未命名曲谱';
        return;
      }
      var nextName = (nmEl.textContent || '').replace(/\s+/g, ' ').trim();
      if (!nextName) nextName = entry.name || '未命名曲谱';
      nmEl.textContent = nextName;
      if (nextName !== entry.name) {
        entry.name = nextName;
        entry.renamed = true;
        if (state.selectedId === entry.id) {
          if (state.current) state.current.name = nextName;
          if (state.sourceJson) state.sourceJson.name = nextName;
          if (el.npTitle) el.npTitle.textContent = nextName;
        }
        renderList();
        scheduleSaveWorkspace();
        toast('曲名已更新为「' + nextName + '」', 'ok');
      }
    }
    function onKey(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        finish(true);
        nmEl.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
        nmEl.blur();
      }
    }
    function onBlur() { finish(true); }
    nmEl.addEventListener('keydown', onKey);
    nmEl.addEventListener('blur', onBlur);
  }

  /* ═══════════════════ 新建与选中曲目 ═══════════════════ */

  var newScoreSeq = 0;

  function copyNote(n) {
    return { key: n.key, pitch: n.pitch, start: n.start, end: n.end, velocity: n.velocity == null ? 1 : n.velocity };
  }

  function createNewScore(opts) {
    opts = opts || {};
    var idx = ++newScoreSeq;
    var name = opts.name || ('未命名曲谱 ' + idx);
    var id = state.nextId++;
    var entry = {
      id: id,
      path: name + '.json',
      fileName: name + '.json',
      name: name,
      author: '原创',
      type: 'midi',
      bpm: 120,
      ticks: 1000,
      ok: true,
      isNew: true,
      error: '',
      noteCount: 0,
      durationMs: 0,
      instrument: '风物之诗琴',
      text: '',
      workingNotes: []
    };
    state.entries.unshift(entry);
    selectEntry(id);
    scrollListTo(id);
    updateTrackNav();
    scheduleSaveWorkspace();
    if (!opts.silent) {
      toast('已新建「' + name + '」· 点击卷帘加音，点击标题可修改曲名', 'ok');
    }
    return entry;
  }

  function updateNpTitleEditable(editable) {
    if (!el.npTitle) return;
    if (editable) {
      el.npTitle.classList.add('is-editable');
      el.npTitle.setAttribute('contenteditable', 'true');
      el.npTitle.setAttribute('spellcheck', 'false');
      el.npTitle.title = '点击直接修改曲谱名称（回车确认）';
    } else {
      el.npTitle.classList.remove('is-editable');
      el.npTitle.removeAttribute('contenteditable');
      el.npTitle.removeAttribute('title');
    }
  }

  function updateNpSubText() {
    var sc = state.current;
    if (!sc || !el.npSub) return;
    el.npSub.textContent = [sc.author || '未知作者', sc.type,
      'bpm ' + sc.bpm + ' · ticks ' + sc.ticks,
      sc.stats.noteCount + ' 音', fmtDur(sc.stats.durationMs)].join(' · ');
  }

  function selectEntry(id, forceReset) {
    var entry = null;
    for (var i = 0; i < state.entries.length; i++) if (state.entries[i].id === id) { entry = state.entries[i]; break; }
    if (!entry) return;

    stopPlayback();
    justHandledDrag = false;
    dragSession = null;
    state.selectedId = id;
    state.currentEntry = entry;
    state.current = null;
    state.sourceJson = null;
    state.maxNoteMs = 1;
    state.posMs = 0;
    clearSelection();
    state.edit.undo = [];
    state.edit.dirty = false;

    if (!entry.ok) {
      el.npTitle.textContent = entry.name;
      updateNpTitleEditable(false);
      el.npSub.textContent = '解析失败：' + (entry.error || '未知原因');
      el.btnPlay.disabled = true;
      el.btnStop.disabled = true;
      el.seek.disabled = true;
      if (el.btnStepBack) el.btnStepBack.disabled = true;
      if (el.btnStepFwd) el.btnStepFwd.disabled = true;
      el.tTotal.textContent = '0:00.0';
      renderList(); renderDiag(entry, null); updateTrackNav();
      clearKeys(); drawRoll(0); updateEditBar();
      return;
    }

    var sc;
    if (entry.isNew) {
      if (forceReset) entry.workingNotes = [];
      state.sourceJson = {
        name: entry.name,
        author: entry.author || '原创',
        instrument: entry.instrument || '风物之诗琴',
        type: 'midi',
        bpm: entry.bpm || 120,
        ticks: entry.ticks || 1000,
        notes: ''
      };
      sc = {
        ok: true,
        isNew: true,
        baseDurationMs: 0,
        name: entry.name,
        author: entry.author || '原创',
        instrument: entry.instrument || '风物之诗琴',
        type: 'midi',
        bpm: entry.bpm || 120,
        ticks: entry.ticks || 1000,
        notes: (entry.workingNotes || []).map(copyNote),
        warnings: [],
        stats: {
          events: 0,
          noteCount: 0,
          durationMs: 0,
          keysUsed: [],
          maxPolyphony: 0
        }
      };
    } else {
      try {
        state.sourceJson = JSON.parse(entry.text);
        sc = window.BGIParse.parseScore(state.sourceJson, { filename: entry.fileName });
      } catch (e) {
        entry.ok = false; entry.error = (e && e.message) || String(e);
        toast('解析失败：' + entry.error, 'err');
        renderList(); updateTrackNav();
        return;
      }
      if (!sc.ok) {
        entry.ok = false; entry.error = sc.error || '解析失败';
        renderList(); renderDiag(entry, sc); updateTrackNav();
        toast('解析失败：' + entry.error, 'err');
        return;
      }
      sc.baseDurationMs = sc.stats ? sc.stats.durationMs : 0;
      if (forceReset) {
        entry.workingNotes = null;
        entry.edited = false;
      }
      if (entry.workingNotes) {
        sc.notes = entry.workingNotes.map(copyNote);
        sc.name = entry.name;
      } else {
        sc.notes = sc.notes.map(copyNote);
      }
    }

    state.current = sc;
    state.cursor = 0;
    recomputeDerived();

    el.npTitle.textContent = sc.name || entry.name;
    updateNpTitleEditable(true);
    updateNpSubText();

    el.btnPlay.disabled = false;
    el.btnStop.disabled = false;
    el.seek.disabled = false;
    el.tTotal.textContent = fmtTime(sc.stats.durationMs);
    el.seek.value = 0;
    el.seekWrap.style.setProperty('--p', '0');

    renderList();
    renderDiag(entry, sc);
    updateTransport();
    updateTrackNav();
    updateEditBar();
    clearKeys();
    drawRoll(0);
    scheduleSaveWorkspace();
  }

  /** notes 变了之后统一重算：排序 / 最长时值 / 统计 / 同步歌单 */
  function recomputeDerived() {
    var sc = state.current;
    if (!sc) return;
    sc.notes.sort(function (a, b) { return a.start - b.start; });
    var maxDur = 1, maxEnd = 0, keysUsed = {}, maxPoly = 0, atTime = {};
    for (var i = 0; i < sc.notes.length; i++) {
      var n = sc.notes[i];
      if (n.end - n.start > maxDur) maxDur = n.end - n.start;
      if (n.end > maxEnd) maxEnd = n.end;
      keysUsed[n.key] = true;
      atTime[n.start] = (atTime[n.start] || 0) + 1;
      if (atTime[n.start] > maxPoly) maxPoly = atTime[n.start];
    }
    state.maxNoteMs = maxDur;
    if (!sc.stats) sc.stats = {};
    sc.stats.noteCount = sc.notes.length;
    sc.stats.keysUsed = Object.keys(keysUsed);
    sc.stats.maxPolyphony = maxPoly;
    sc.stats.durationMs = sc.isNew ? maxEnd : Math.max(sc.baseDurationMs || 0, maxEnd);
    if (el.tTotal) el.tTotal.textContent = fmtTime(sc.stats.durationMs);
    if (state.currentEntry) {
      state.currentEntry.noteCount = sc.stats.noteCount;
      state.currentEntry.durationMs = sc.stats.durationMs;
      state.currentEntry.workingNotes = sc.notes.map(copyNote);
      if (state.edit.dirty) state.currentEntry.edited = true;
    }
    updateNpSubText();
    renderList();
    if (state.edit.dirty) scheduleSaveWorkspace();
  }

  /* ═══════════════════ 播放调度 ═══════════════════ */

  function scoreMsAt(ctxTime) { return state.baseScoreMs + (ctxTime - state.baseCtxTime) * 1000 * state.speed; }
  function ctxTimeAt(scoreMs) { return state.baseCtxTime + (scoreMs - state.baseScoreMs) / 1000 / state.speed; }
  function duration() { return state.current ? state.current.stats.durationMs : 0; }
  function maxScrollMs() { return Math.max(duration() + state.viewSec * 500, state.viewSec * 2000); }

  function currentScoreMs() {
    if (state.playing && state.engine) {
      var raw = scoreMsAt(engNow());
      return state.recording ? Math.max(0, raw) : clamp(raw, 0, duration() + 5000);
    }
    return state.posMs;
  }

  function clearLiveRecordedFlags() {
    if (!state.current || !state.current.notes) return;
    for (var i = 0; i < state.current.notes.length; i++) {
      if (state.current.notes[i]._liveRecorded) delete state.current.notes[i]._liveRecorded;
    }
  }

  function finalizeAllRecNotes() {
    var any = false;
    var nowMs = currentScoreMs();
    var snap = getSnapMs();
    for (var k in state.recActiveNotes) {
      var n = state.recActiveNotes[k];
      if (n && (state.playing || n._recStretched)) {
        var snappedEnd = Math.round(nowMs / snap) * snap;
        n.end = Math.max(n.start + MIN_NOTE_MS, snappedEnd);
        any = true;
      }
      if (n) {
        delete n._recStretched;
        delete n._recActive;
      }
      delete state.recActiveNotes[k];
    }
    if (any) {
      recomputeDerived();
      updateEditBar();
      renderDiag(state.currentEntry, state.current);
    }
  }

  var lastRecBarUpdateTs = 0;

  function syncActiveRecNotes(t) {
    if (!state.recording || !state.current) return false;
    var stretched = false;
    var sc = state.current;
    for (var rk in state.recActiveNotes) {
      if (Object.prototype.hasOwnProperty.call(state.recActiveNotes, rk)) {
        var rn = state.recActiveNotes[rk];
        if (!rn) continue;
        rn._recActive = true;
        if (state.playing || Math.round(t) > rn.start) {
          var nextEnd = Math.max(rn.start + MIN_NOTE_MS, state.playing ? Math.ceil(t) : Math.round(t));
          rn._recStretched = true;
          if (nextEnd !== rn.end) {
            rn.end = nextEnd;
            stretched = true;
          }
        }
      }
    }
    if (stretched) {
      var maxEnd = sc.stats ? sc.stats.durationMs : 0;
      for (var i = 0; i < sc.notes.length; i++) {
        var n = sc.notes[i];
        var d = n.end - n.start;
        if (d > state.maxNoteMs) state.maxNoteMs = d;
        if (n.end > maxEnd) maxEnd = n.end;
      }
      if (sc.stats && maxEnd !== sc.stats.durationMs) {
        sc.stats.durationMs = maxEnd;
        if (el.tTotal) el.tTotal.textContent = fmtTime(maxEnd);
      }
      var nowWall = Date.now();
      if (!state.playing || nowWall - lastRecBarUpdateTs >= 45) {
        lastRecBarUpdateTs = nowWall;
        updateEditBar();
      }
    }
    return stretched;
  }

  function toggleRecording(forceVal) {
    var next = (typeof forceVal === 'boolean') ? forceVal : !state.recording;
    if (next && !state.current) {
      createNewScore({ silent: true });
    }
    if (!next) {
      finalizeAllRecNotes();
      clearLiveRecordedFlags();
    }
    state.recording = next;
    if (next) state.edit.selNote = null;
    if (el.btnRecord) el.btnRecord.classList.toggle('is-rec', next);
    if (el.btnRecordLabel) el.btnRecordLabel.textContent = next ? '录制中' : '录制';
    updateEditBar();
    if (next) {
      toast('已开启录制：按住琴键随时间轴后移实时变长，松开定格', 'ok');
    } else {
      toast('已退出录制模式', 'ok', 1800);
    }
  }

  function recordNoteStart(k) {
    if (!state.recording) return;
    if (!state.current) createNewScore({ silent: true });
    pushUndo();
    var rawMs = currentScoreMs();
    var snap = getSnapMs();
    var snappedStart = Math.round(rawMs / snap) * snap;
    var start = Math.max(0, state.playing ? Math.min(Math.floor(rawMs), snappedStart) : snappedStart);
    var initDur = state.playing ? MIN_NOTE_MS : (state.edit.lastDur || DEFAULT_DUR);
    var note = {
      key: k,
      pitch: keyToPitch(k),
      start: start,
      end: Math.max(start + initDur, Math.ceil(rawMs)),
      velocity: 1,
      _liveRecorded: true,
      _recStretched: !!state.playing,
      _recActive: true
    };
    state.current.notes.push(note);
    state.edit.selNote = null;
    state.edit.dirty = true;
    state.recActiveNotes[k] = note;
    recomputeDerived();
    if (state.playing) {
      state.cursor = lowerBoundEnd(state.current.notes, rawMs);
    }
    updateEditBar();
    renderDiag(state.currentEntry, state.current);
    drawRoll(currentScoreMs());
  }

  function recordNoteEnd(k) {
    var note = state.recActiveNotes[k];
    if (!note) return;
    delete state.recActiveNotes[k];
    if (state.playing || note._recStretched) {
      var snap = getSnapMs();
      var endMs = Math.round(currentScoreMs() / snap) * snap;
      note.end = Math.max(note.start + MIN_NOTE_MS, endMs);
      state.edit.lastDur = note.end - note.start;
    }
    delete note._recStretched;
    delete note._recActive;
    recomputeDerived();
    updateEditBar();
    renderDiag(state.currentEntry, state.current);
    drawRoll(currentScoreMs());
  }

  function startPlayback(fromMs) {
    var sc = state.current;
    if (!sc) return;
    clearLiveRecordedFlags();
    fromMs = state.recording ? Math.max(0, fromMs) : clamp(fromMs, 0, duration());
    state.baseCtxTime = engNow();
    state.baseScoreMs = fromMs;
    state.posMs = fromMs;
    state.cursor = lowerBoundEnd(sc.notes, fromMs);
    state.playing = true;
    updateTransport();
    if (!state.schedTimer) state.schedTimer = setInterval(scheduleTick, SCHED_INTERVAL_MS);
    scheduleTick();
  }

  function scheduleTick() {
    if (!state.playing || !state.current || !state.engine) return;
    var now = engNow();
    var limit = now + LOOKAHEAD_SEC;
    var nowScore = scoreMsAt(now);
    var notes = state.current.notes;

    while (state.cursor < notes.length) {
      var n = notes[state.cursor];
      var w = ctxTimeAt(n.start);
      if (w > limit) break;
      if (!n._liveRecorded) {
        var startMs = Math.max(n.start, nowScore);
        if (n.end > startMs) {
          var when = Math.max(w, now + 0.004);
          var dur = Math.max(MIN_NOTE_MS, (n.end - startMs) / 1000 / state.speed);
          noteOn(n.pitch, when, dur, n.velocity);
        }
      }
      state.cursor++;
    }

    if (!state.recording && nowScore >= duration() + END_PAD_MS) {
      if (state.playMode === 'single' || state.loop) {
        startPlayback(0);
      } else if (state.playMode === 'order') {
        var list = playableEntries();
        var cur = playlistPos().i;
        if (cur >= 0 && cur + 1 >= list.length) {
          stopPlayback();
        } else {
          stopPlayback();
          jumpTrack(1, true);
        }
      } else {
        var wasAutoplay = state.autoplay;
        stopPlayback();
        if (wasAutoplay) jumpTrack(1, true);
      }
    }
  }

  function pausePlayback() {
    if (!state.playing) return;
    finalizeAllRecNotes();
    clearLiveRecordedFlags();
    var raw = scoreMsAt(engNow());
    state.posMs = state.recording ? Math.max(0, raw) : clamp(raw, 0, duration());
    state.playing = false;
    if (state.engine) { try { state.engine.stopAll(); } catch (_) { } }
    updateTransport();
  }

  function stopPlayback() {
    finalizeAllRecNotes();
    clearLiveRecordedFlags();
    state.playing = false;
    if (state.engine) { try { state.engine.stopAll(); } catch (_) { } }
    if (state.schedTimer) { clearInterval(state.schedTimer); state.schedTimer = null; }
    state.posMs = 0;
    state.cursor = 0;
    updateTransport();
    clearKeys();
    drawRoll(0);
  }

  function seekTo(ms, allowBeyond) {
    if (!state.current) return;
    var limitMs = allowBeyond ? maxScrollMs() : Math.max(duration(), (state.current.isNew || state.recording) ? maxScrollMs() : 0);
    ms = clamp(ms, 0, limitMs);
    state.posMs = ms;
    syncActiveRecNotes(ms);
    if (state.playing) startPlayback(ms);
    else {
      state.cursor = lowerBoundEnd(state.current.notes, ms);
      updateTransport();
      drawRoll(ms);
    }
  }

  function stepTimestamp(deltaMs) {
    if (!state.current) return;
    seekTo(clamp(currentScoreMs() + deltaMs, 0, maxScrollMs()), true);
    updateEditBar();
  }

  function playCurrent() {
    if (!state.current) return;
    if (!ensureEngine()) return;
    safeResume().then(function () {
      var from = state.posMs;
      if (!state.recording && from >= duration() - 10) from = 0;
      startPlayback(from);
    });
  }

  function updateTransport() {
    if (!el.btnPlay) return;
    el.btnPlay.classList.toggle('is-playing', state.playing);
    if (el.btnPlayLabel) el.btnPlayLabel.textContent = state.playing ? '暂停' : '播放';
    el.btnPlay.disabled = !state.current;
    el.btnStop.disabled = !state.current;
    if (el.btnStepBack) el.btnStepBack.disabled = !state.current;
    if (el.btnStepFwd) el.btnStepFwd.disabled = !state.current;
  }

  /* ═══════════════════ 播放模式（列表循环 / 单曲循环 / 顺序播放） ═══════════════════ */

  var PLAY_MODES = [
    {
      id: 'list',
      label: '列表循环',
      title: '播放模式：列表循环（点击切换）',
      icon: '<svg class="ico ico-mode" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>'
    },
    {
      id: 'single',
      label: '单曲循环',
      title: '播放模式：单曲循环（点击切换）',
      icon: '<svg class="ico ico-mode" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/><text x="12" y="15" font-size="7.5" font-family="sans-serif" font-weight="700" fill="currentColor" stroke="none" text-anchor="middle">1</text></svg>'
    },
    {
      id: 'order',
      label: '顺序播放',
      title: '播放模式：顺序播放（点击切换）',
      icon: '<svg class="ico ico-mode" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="14" y2="12"/><line x1="4" y1="18" x2="11" y2="18"/><polyline points="16 15 19 18 16 21"/></svg>'
    }
  ];

  function setPlayMode(mode) {
    if (!mode || !PLAY_MODES.some(function (m) { return m.id === mode; })) mode = 'list';
    state.playMode = mode;
    state.loop = (mode === 'single');
    state.autoplay = (mode === 'list');

    if (el.loop) el.loop.checked = state.loop;
    if (el.autoplay) el.autoplay.checked = state.autoplay;

    var cur = PLAY_MODES.filter(function (m) { return m.id === mode; })[0];
    if (el.btnPlayMode && cur) {
      el.btnPlayMode.title = cur.title;
      el.btnPlayMode.innerHTML = cur.icon + '<span id="playModeLabel">' + cur.label + '</span>';
      el.playModeLabel = document.getElementById('playModeLabel');
    }
    scheduleSaveWorkspace();
  }

  function cyclePlayMode() {
    var curIdx = 0;
    for (var i = 0; i < PLAY_MODES.length; i++) {
      if (PLAY_MODES[i].id === state.playMode) { curIdx = i; break; }
    }
    var nextIdx = (curIdx + 1) % PLAY_MODES.length;
    setPlayMode(PLAY_MODES[nextIdx].id);
    var cur = PLAY_MODES[nextIdx];
    toast('已切换为：' + cur.label, 'ok', 1600);
  }

  /**
   * 播放位置 t(ms) 处正在响的音符。
   * 回溯上界用精确值：只要 t - start >= maxNoteMs，更早的音必然已结束。
   */
  function activeAt(t) {
    var sc = state.current;
    if (!sc) return [];
    var notes = sc.notes;
    var idx = upperBoundStart(notes, t);
    var out = [], limit = state.maxNoteMs || 1, scanned = 0;
    for (var i = idx - 1; i >= 0; i--) {
      var n = notes[i];
      if (!n._recActive && t - n.start >= limit) break;
      if (n.end > t || n._recActive) out.push(n);
      if (++scanned > 3000) break;
    }
    if (state.recording) {
      for (var rk in state.recActiveNotes) {
        if (Object.prototype.hasOwnProperty.call(state.recActiveNotes, rk)) {
          var rn = state.recActiveNotes[rk];
          if (rn && out.indexOf(rn) < 0) out.push(rn);
        }
      }
    }
    return out;
  }

  /**
   * 停止后（posMs 归零）不画「按住的键」：
   * 曲谱第一个音常常正好在 t=0 起始，activeAt(0) 会把它判为按住，键会残留。
   */
  function shouldShowKeys() { return state.playing || state.posMs > 0; }

  /* ═══════════════════ 21 键 ═══════════════════ */

  var keyEls = {};
  var keyEnergy = {};

  function buildKeyboard() {
    var html = [];
    ROWS.forEach(function (row) {
      html.push('<div class="kbrow">');
      html.push('<div class="kbrow-label"><b>' + row.tag + '</b><i>' + row.range + '</i></div>');
      html.push('<div class="kbkeys">');
      row.keys.forEach(function (k) {
        var p = keyToPitch(k);
        var face =
          '<span class="k-letter">' + k + '</span>' +
          '<span class="k-note">' + pitchName(p) + '</span>' +
          '<span class="k-sol">' + solfege(p) + '</span>';
        html.push(
          '<div class="key" data-key="' + k + '" data-pitch="' + p + '" style="--e:0">' +
            '<div class="key-base">' + face + '</div>' +
            '<div class="key-lit">' + face + '</div>' +
          '</div>'
        );
      });
      html.push('</div></div>');
    });
    el.keyboard.innerHTML = html.join('');
    keyEls = {}; keyEnergy = {};
    Array.prototype.forEach.call(el.keyboard.querySelectorAll('.key'), function (node) {
      var k = node.getAttribute('data-key');
      keyEls[k] = node;
      keyEnergy[k] = 0;
      node.addEventListener('pointerdown', function (ev) {
        ev.preventDefault();
        pressPointerKey(k);
      });
      node.addEventListener('pointerup', function () { releasePointerKey(k); });
      node.addEventListener('pointercancel', function () { releasePointerKey(k); });
      node.addEventListener('pointerleave', function () { releasePointerKey(k); });
      node.addEventListener('mousedown', function () {
        if (!pointerActiveKeys[k]) auditionKey(k);
      });
    });
  }

  var pointerActiveKeys = {};

  function pressPointerKey(k) {
    if (!ensureEngine()) return;
    pointerActiveKeys[k] = true;
    var p = keyToPitch(k);
    state.audition[k] = Date.now() + 180;
    safeResume().then(function () {
      noteOn(p, engNow() + 0.005, 0.45, 0.95);
    });
    if (state.recording) recordNoteStart(k);
  }

  function releasePointerKey(k) {
    if (!pointerActiveKeys[k]) return;
    delete pointerActiveKeys[k];
    var p = keyToPitch(k);
    if (state.engine && typeof state.engine.noteOff === 'function') {
      try { state.engine.noteOff(p, engNow() + 0.005); } catch (_) {}
    }
    if (state.recording) recordNoteEnd(k);
  }

  function auditionKey(k) {
    if (!ensureEngine()) return;
    var p = keyToPitch(k), dur = 0.45;
    state.audition[k] = Date.now() + 180;
    safeResume().then(function () { noteOn(p, engNow() + 0.005, dur, 0.95); });
  }

  /* 语义层：只管 .on（测试与无障碍都靠它） */
  function setKeys(activeKeys) {
    state.keysDown = activeKeys;
    for (var k in keyEls) {
      var on = !!activeKeys[k];
      var node = keyEls[k];
      if (on !== node.__on) {
        node.__on = on;
        node.classList.toggle('on', on);
      }
    }
  }
  function clearKeys() { setKeys({}); }

  /* 视觉层：逐帧指数逼近 --e（与 .on 解耦，停止时立即灭 .on、但视觉平滑收尾） */
  function animateKeys(dt) {
    var down = state.keysDown || {};
    var now = Date.now();
    var kIn = 1 - Math.exp(-dt / 0.012);
    var kOut = 1 - Math.exp(-dt / 0.05);
    for (var k in keyEls) {
      var aud = state.audition[k];
      if (aud && aud <= now && !pointerActiveKeys[k]) state.audition[k] = 0;
      var target = (down[k] || state.heldKeys[k] || pointerActiveKeys[k] || (aud && aud > now)) ? 1 : 0;
      var e = keyEnergy[k] || 0;
      if (Math.abs(target - e) < 0.002) {
        if (e !== target) { keyEnergy[k] = target; keyEls[k].style.setProperty('--e', target.toFixed(3)); }
        continue;
      }
      e += (target - e) * (target > e ? kIn : kOut);
      keyEnergy[k] = e;
      keyEls[k].style.setProperty('--e', e.toFixed(3));
    }
  }

  /* ═══════════════════ 卷帘 ═══════════════════ */

  function rollGeom() {
    var cv = el.roll;
    var W = (cv && cv.clientWidth) || 600;
    var H = (cv && cv.clientHeight) || 160;
    var GUT = 40, PAD = 6, TOP = 16;
    var plotW = Math.max(10, W - GUT - PAD);
    var plotH = Math.max(10, H - PAD * 2 - TOP);
    var rowH = plotH / 21;
    var plotTop = PAD + TOP;
    var t = currentScoreMs();
    var t0 = t - state.viewSec * 1000 * 0.25;
    var t1 = t0 + state.viewSec * 1000;
    return {
      W: W, H: H, GUT: GUT, PAD: PAD, TOP: TOP, plotW: plotW, plotH: plotH,
      rowH: rowH, plotTop: plotTop, t0: t0, t1: t1,
      xOf: function (ms) { return GUT + ((ms - t0) / (t1 - t0)) * plotW; },
      timeOf: function (x) { return t0 + ((x - GUT) / plotW) * (t1 - t0); }
    };
  }

  function rowAtY(g, y) {
    var r = Math.floor((g.plotTop + g.plotH - y) / g.rowH);
    return clamp(r, 0, 20);
  }

  var dragSession = null;
  var justHandledDrag = false;

  function initRoll() {
    state.rollCtx = el.roll.getContext('2d');

    el.roll.addEventListener('pointerdown', onRollPointerDown);
    el.roll.addEventListener('pointermove', onRollPointerMove);
    window.addEventListener('pointerup', onRollPointerUp);
    window.addEventListener('pointercancel', onRollPointerUp);

    el.roll.addEventListener('click', function (ev) {
      if (!state.current) return;
      if (justHandledDrag) {
        justHandledDrag = false;
        return;
      }
      var r = el.roll.getBoundingClientRect();
      var g = rollGeom();
      var x = ev.clientX - r.left, y = ev.clientY - r.top;

      handleRollEdit(g, x, y);
    });

    el.roll.addEventListener('wheel', onRollWheel, { passive: false });
    el.roll.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });

    window.addEventListener('resize', function () { drawRoll(currentScoreMs()); });
    if (window.matchMedia) {
      var darkMq = window.matchMedia('(prefers-color-scheme: dark)');
      var onThemeChange = function () { drawRoll(currentScoreMs()); };
      if (typeof darkMq.addEventListener === 'function') darkMq.addEventListener('change', onThemeChange);
      else if (typeof darkMq.addListener === 'function') darkMq.addListener(onThemeChange);
    }
  }

  function markDragHandled() {
    justHandledDrag = true;
    setTimeout(function () { justHandledDrag = false; }, 0);
  }

  function onRollPointerDown(ev) {
    justHandledDrag = false;
    if (ev.button !== 0 && ev.button !== 1 && ev.button !== 2) return;
    var r = el.roll.getBoundingClientRect();
    var g = rollGeom();
    var x = ev.clientX - r.left, y = ev.clientY - r.top;

    // 左侧音名列：即使尚未选曲也允许点击试听对应音高
    if (ev.button === 0 && x < g.GUT && y > g.plotTop) {
      var rRow0 = rowAtY(g, y);
      if (rRow0 >= 0 && rRow0 <= 20) auditionKey(LABELS[rRow0]);
      if (state.current) {
        clearSelection();
        updateEditBar();
        drawRoll(currentScoreMs());
      }
      markDragHandled();
      return;
    }

    // 未选曲时左键点按主网格：即点即建新曲谱
    if (!state.current) {
      if (ev.button === 0 && x >= g.GUT && y > g.plotTop) {
        createNewScore({ silent: true });
      } else {
        return;
      }
    }

    // 中键或右键：平移时间轴
    if (ev.button === 1 || ev.button === 2) {
      ev.preventDefault();
      dragSession = {
        type: 'pan',
        pointerId: ev.pointerId,
        startX: ev.clientX,
        startPosMs: currentScoreMs()
      };
      try { el.roll.setPointerCapture(ev.pointerId); } catch (_) {}
      return;
    }

    if (ev.button !== 0) return;

    // 顶部时间刻度尺区域：轻点跳转播放头，横向拖拽拉出时间选区供剪辑
    if (y <= g.plotTop && x >= g.GUT) {
      dragSession = {
        type: 'ruler',
        pointerId: ev.pointerId,
        startX: ev.clientX,
        downX: x,
        downTime: Math.max(0, g.timeOf(x)),
        moved: false
      };
      markDragHandled();
      try { el.roll.setPointerCapture(ev.pointerId); } catch (_) {}
      return;
    }

    var touchSlop = (ev.pointerType === 'touch') ? 10 : 5;
    var hit = hitTestDetailed(g, x, y, touchSlop);
    if (hit) {
      var note = hit.note;
      state.edit.timeRange = null;
      state.edit.boxRect = null;

      if (ev.shiftKey) {
        var curList = getSelectedNotes().slice();
        var exIdx = curList.indexOf(note);
        if (exIdx >= 0) curList.splice(exIdx, 1);
        else curList.push(note);
        setSelectedNotes(curList);
        auditionNote(note);
        updateEditBar();
        drawRoll(currentScoreMs());
        markDragHandled();
        return;
      }

      var alreadyInBatch = isNoteSelected(note) && getSelectedNotes().length > 1;
      if (!alreadyInBatch) {
        setSelectedNotes([note]);
      } else {
        state.edit.selNote = note;
      }
      auditionNote(note);
      updateEditBar();
      drawRoll(currentScoreMs());

      var activeList = getSelectedNotes();
      dragSession = {
        type: hit.isEdge ? 'resize' : 'move',
        pointerId: ev.pointerId,
        note: note,
        narrowOnClick: alreadyInBatch,
        preSnap: snapshotNotes(),
        items: activeList.map(function (n) {
          return {
            note: n,
            origStart: n.start,
            origEnd: n.end,
            origPitch: n.pitch,
            origKey: n.key,
            origRow: LABELS.indexOf(n.key)
          };
        }),
        startX: ev.clientX,
        startY: ev.clientY,
        origStart: note.start,
        origEnd: note.end,
        origPitch: note.pitch,
        origKey: note.key,
        origRow: LABELS.indexOf(note.key),
        changed: false
      };
      try { el.roll.setPointerCapture(ev.pointerId); } catch (_) {}
    } else if (state.playing) {
      // 播放中点击空白处：跳转播放时刻，避免误加音符
      seekTo(g.timeOf(x));
      markDragHandled();
    } else {
      dragSession = {
        type: 'empty',
        pointerId: ev.pointerId,
        startX: ev.clientX,
        startY: ev.clientY,
        downX: x,
        downY: y,
        downTime: g.timeOf(x),
        downRow: rowAtY(g, y),
        baseSelected: ev.shiftKey ? getSelectedNotes().slice() : [],
        moved: false
      };
    }
  }

  function onRollPointerMove(ev) {
    var r = el.roll.getBoundingClientRect();
    var g = rollGeom();
    var x = ev.clientX - r.left, y = ev.clientY - r.top;

    if (!dragSession) {
      if (x < g.GUT) {
        el.roll.style.cursor = 'pointer';
        return;
      }
      if (y <= g.plotTop) {
        el.roll.style.cursor = 'col-resize';
        return;
      }
      var hover = hitTestDetailed(g, x, y);
      if (hover) {
        el.roll.style.cursor = hover.isEdge ? 'ew-resize' : 'move';
      } else {
        el.roll.style.cursor = state.playing ? 'crosshair' : 'cell';
      }
      return;
    }

    if (dragSession && dragSession.pointerId != null && ev.pointerId != null && ev.pointerId !== dragSession.pointerId) return;
    var dx = ev.clientX - dragSession.startX;
    var dy = ev.clientY - (dragSession.startY || 0);

    if (dragSession.type === 'pan') {
      var dt = (dx / g.plotW) * (g.t1 - g.t0);
      seekTo(clamp(dragSession.startPosMs - dt, 0, maxScrollMs()), true);
      drawRoll(currentScoreMs());
      return;
    }

    if (dragSession.type === 'ruler') {
      if (!dragSession.moved && Math.abs(dx) > 4) {
        dragSession.moved = true;
      }
      if (dragSession.moved) {
        var snapR = getSnapMs();
        var tA = Math.max(0, g.timeOf(dragSession.downX));
        var tB = Math.max(0, g.timeOf(clamp(x, g.GUT, g.W - g.PAD)));
        var rStart = Math.max(0, Math.round(Math.min(tA, tB) / snapR) * snapR);
        var rEnd = Math.max(rStart + snapR, Math.round(Math.max(tA, tB) / snapR) * snapR);
        setSelectedNotes([]);
        state.edit.boxRect = null;
        state.edit.timeRange = { start: rStart, end: rEnd };
        updateEditBar();
        drawRoll(currentScoreMs());
      }
      return;
    }

    if (dragSession.type === 'empty') {
      if (!dragSession.moved && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
        dragSession.moved = true;
        dragSession.type = 'box';
        try { el.roll.setPointerCapture(ev.pointerId); } catch (_) {}
      } else {
        return;
      }
    }

    if (dragSession.type === 'box') {
      var bx0 = clamp(Math.min(dragSession.downX, x), g.GUT, g.W - g.PAD);
      var bx1 = clamp(Math.max(dragSession.downX, x), g.GUT, g.W - g.PAD);
      var by0 = clamp(Math.min(dragSession.downY, y), g.plotTop, g.plotTop + g.plotH);
      var by1 = clamp(Math.max(dragSession.downY, y), g.plotTop, g.plotTop + g.plotH);
      state.edit.timeRange = null;
      state.edit.boxRect = { x0: bx0, y0: by0, x1: bx1, y1: by1 };

      var tMin = Math.max(0, g.timeOf(bx0));
      var tMax = Math.max(tMin, g.timeOf(bx1));
      var rowHigh = rowAtY(g, by0);
      var rowLow = rowAtY(g, by1);
      var rMin = Math.min(rowLow, rowHigh);
      var rMax = Math.max(rowLow, rowHigh);

      var matched = dragSession.baseSelected ? dragSession.baseSelected.slice() : [];
      var allNotes = state.current ? state.current.notes : [];
      for (var bi = 0; bi < allNotes.length; bi++) {
        var bn = allNotes[bi];
        if (bn.end < tMin || bn.start > tMax) continue;
        var br = LABELS.indexOf(bn.key);
        if (br >= rMin && br <= rMax && matched.indexOf(bn) < 0) {
          matched.push(bn);
        }
      }
      setSelectedNotes(matched);
      updateEditBar();
      drawRoll(currentScoreMs());
      return;
    }

    if (dragSession.type === 'resize') {
      var snap = getSnapMs();
      var dtMs = (dx / g.plotW) * (g.t1 - g.t0);
      var newEnd = Math.max(dragSession.origStart + MIN_NOTE_MS, Math.round((dragSession.origEnd + dtMs) / snap) * snap);
      var dDur = newEnd - dragSession.origEnd;
      var itemsR = dragSession.items || [{ note: dragSession.note, origStart: dragSession.origStart, origEnd: dragSession.origEnd }];
      var anyResized = false;
      for (var ri = 0; ri < itemsR.length; ri++) {
        var itR = itemsR[ri];
        var targetEnd = Math.max(itR.origStart + MIN_NOTE_MS, itR.origEnd + dDur);
        if (targetEnd !== itR.note.end) {
          itR.note.end = targetEnd;
          anyResized = true;
        }
      }
      if (anyResized) {
        dragSession.changed = true;
        updateEditBar();
        drawRoll(currentScoreMs());
      }
      return;
    }

    if (dragSession.type === 'move') {
      var snap2 = getSnapMs();
      var dtMs2 = (dx / g.plotW) * (g.t1 - g.t0);
      var targetAnchorStart = Math.max(0, Math.round((dragSession.origStart + dtMs2) / snap2) * snap2);
      var actualDt = targetAnchorStart - dragSession.origStart;

      var itemsM = dragSession.items || [{
        note: dragSession.note,
        origStart: dragSession.origStart,
        origEnd: dragSession.origEnd,
        origPitch: dragSession.origPitch,
        origKey: dragSession.origKey,
        origRow: dragSession.origRow
      }];

      var minOrigStart = Infinity;
      var minOrigRow = 20, maxOrigRow = 0;
      for (var mi = 0; mi < itemsM.length; mi++) {
        if (itemsM[mi].origStart < minOrigStart) minOrigStart = itemsM[mi].origStart;
        if (itemsM[mi].origRow < minOrigRow) minOrigRow = itemsM[mi].origRow;
        if (itemsM[mi].origRow > maxOrigRow) maxOrigRow = itemsM[mi].origRow;
      }
      if (minOrigStart + actualDt < 0) actualDt = -minOrigStart;

      var newRow = rowAtY(g, y);
      var dRow = newRow - dragSession.origRow;
      dRow = clamp(dRow, -minOrigRow, 20 - maxOrigRow);

      var didChange = false;
      var pitchChanged = false;
      for (var mj = 0; mj < itemsM.length; mj++) {
        var itM = itemsM[mj];
        var nextS = itM.origStart + actualDt;
        var nextE = itM.origEnd + actualDt;
        var nextR = clamp(itM.origRow + dRow, 0, 20);
        var nextK = LABELS[nextR];
        var nextP = keyToPitch(nextK);
        if (nextS !== itM.note.start || nextE !== itM.note.end) {
          itM.note.start = nextS;
          itM.note.end = nextE;
          didChange = true;
        }
        if (nextP !== itM.note.pitch) {
          itM.note.pitch = nextP;
          itM.note.key = nextK;
          didChange = true;
          pitchChanged = true;
        }
      }
      if (pitchChanged) {
        auditionNote(dragSession.note, true);
      }
      if (didChange) {
        dragSession.changed = true;
        updateEditBar();
        drawRoll(currentScoreMs());
      }
    }
  }

  function onRollPointerUp(ev) {
    if (!dragSession) return;
    if (dragSession.pointerId != null && ev.pointerId != null && ev.pointerId !== dragSession.pointerId) return;
    var sess = dragSession;
    dragSession = null;
    if (sess.pointerId != null) {
      try { el.roll.releasePointerCapture(sess.pointerId); } catch (_) {}
    }

    if (sess.type === 'pan') {
      markDragHandled();
      return;
    }

    if (sess.type === 'ruler') {
      if (!sess.moved) {
        clearSelection();
        seekTo(sess.downTime, true);
        updateEditBar();
        drawRoll(currentScoreMs());
      }
      markDragHandled();
      return;
    }

    if (sess.type === 'box') {
      state.edit.boxRect = null;
      markDragHandled();
      updateEditBar();
      drawRoll(currentScoreMs());
      return;
    }

    if (sess.type === 'move' || sess.type === 'resize') {
      if (sess.changed) {
        pushUndo(sess.preSnap);
        state.edit.dirty = true;
        recomputeDerived();
        updateEditBar();
        renderDiag(state.currentEntry, state.current);
        auditionNote(sess.note);
        markDragHandled();
      } else if (sess.narrowOnClick && sess.note) {
        setSelectedNotes([sess.note]);
        updateEditBar();
        drawRoll(currentScoreMs());
        markDragHandled();
      }
      return;
    }
  }

  function onRollWheel(ev) {
    ev.preventDefault();
    if (ev.ctrlKey || ev.metaKey) {
      var delta = ev.deltaY < 0 ? -1 : 1;
      var newZoom = clamp(state.viewSec + delta, 3, 24);
      state.viewSec = newZoom;
      if (el.zoom) el.zoom.value = newZoom;
      if (el.zoomVal) el.zoomVal.textContent = newZoom + ' 秒';
    } else {
      var deltaX = (Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) ? ev.deltaX : ev.deltaY;
      var stepSec = (state.viewSec * 0.12) * (deltaX > 0 ? 1 : -1);
      var targetMs = clamp(currentScoreMs() + stepSec * 1000, 0, maxScrollMs());
      seekTo(targetMs, true);
    }
    drawRoll(currentScoreMs());
  }

  /* 无模式点击：刻度尺已在 pointerdown 跳转；命中音符 -> 选中；空白网格 -> 新增 */
  function handleRollEdit(g, x, y) {
    if (y <= g.plotTop || x < g.GUT) return;
    state.edit.timeRange = null;
    state.edit.boxRect = null;
    var hit = hitTest(g, x, y);
    if (hit) {
      setSelectedNotes([hit]);
      auditionNote(hit);
    } else {
      var row = rowAtY(g, y);
      if (row >= 0 && row <= 20) {
        pushUndo();
        var key = LABELS[row];
        var snap = getSnapMs();
        var t = g.timeOf(x);
        var start = Math.max(0, Math.round(t / snap) * snap);
        var dur = state.edit.lastDur || DEFAULT_DUR;
        var note = { key: key, pitch: keyToPitch(key), start: start, end: start + dur, velocity: 1 };
        state.current.notes.push(note);
        setSelectedNotes([note]);
        state.edit.dirty = true;
        state.edit.lastDur = dur;
        auditionNote(note);
        recomputeDerived();
        renderDiag(state.currentEntry, state.current);
      }
    }
    updateEditBar();
    drawRoll(currentScoreMs());
  }

  function hitTestDetailed(g, x, y, padX) {
    padX = (padX == null) ? 5 : padX;
    var edgePad = Math.max(6, padX);
    var notes = state.current ? state.current.notes : [];
    var row = rowAtY(g, y);
    if (row < 0 || row > 20) return null;
    var key = LABELS[row];
    var t = g.timeOf(x);
    var best = null, bestDist = Infinity, isEdge = false;
    var idx = upperBoundStart(notes, t + 600);
    for (var i = idx - 1; i >= 0 && i > idx - 500; i--) {
      var n = notes[i];
      if (!n) continue;
      if (n.end < t - 500) break;
      if (n.key !== key) continue;
      var x0 = g.xOf(n.start);
      var x1 = g.xOf(n.end);
      if (x1 - x0 < 4) x1 = x0 + 4;
      if (x >= x0 - padX && x <= x1 + edgePad) {
        var d = Math.abs((x0 + x1) / 2 - x);
        if (d < bestDist) {
          bestDist = d;
          best = n;
          isEdge = (x >= x1 - edgePad && x <= x1 + edgePad);
        }
      }
    }
    return best ? { note: best, isEdge: isEdge } : null;
  }

  function hitTest(g, x, y) {
    var res = hitTestDetailed(g, x, y);
    return res ? res.note : null;
  }

  function rr(ctx, x, y, w, h, r) {
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath(); ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2)); ctx.fill();
    } else ctx.fillRect(x, y, w, h);
  }

  function isDarkTheme() {
    return typeof window !== 'undefined' && window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function rollPalette() {
    if (isDarkTheme()) {
      return {
        bg: '#191c1a',
        rulerBg: '#1f2320',
        rulerLine: '#2f3531',
        gutBg: '#161817',
        gutLine: '#2a2e2b',
        rowC: '#1e2320',
        rowLine: '#262a27',
        labelC: '#929b95',
        labelKey: '#606863',
        emptyText: '#6c746f',
        snapLine: '#212522',
        majorLine: '#2d332f',
        tickLine: '#3c433e',
        tickText: '#8e9690',
        accent: '#459e80',
        timeRangeFill: 'rgba(69, 158, 128, 0.14)',
        timeRangeHead: 'rgba(69, 158, 128, 0.28)',
        noteLow: '#2d5347',
        noteMid: '#376c5b',
        noteHigh: '#438570',
        noteHot: '#53b896',
        selStroke: '#e3e6e3',
        boxFill: 'rgba(69, 158, 128, 0.16)'
      };
    }
    return {
      bg: '#fbfaf8',
      rulerBg: '#f3f1ec',
      rulerLine: '#e0ddd5',
      gutBg: '#f5f4f1',
      gutLine: '#e5e2db',
      rowC: '#f2efe9',
      rowLine: '#e5e2db',
      labelC: '#8b9099',
      labelKey: '#b3b7bd',
      emptyText: '#b3b7bd',
      snapLine: '#f0ede6',
      majorLine: '#e5e2db',
      tickLine: '#d5d1c8',
      tickText: '#8b9099',
      accent: '#2f6b58',
      timeRangeFill: 'rgba(47, 107, 88, 0.07)',
      timeRangeHead: 'rgba(47, 107, 88, 0.18)',
      noteLow: '#c3d3cb',
      noteMid: '#a9c2b6',
      noteHigh: '#8fae9f',
      noteHot: '#2f6b58',
      selStroke: '#22252b',
      boxFill: 'rgba(47, 107, 88, 0.12)'
    };
  }

  function drawRoll(t) {
    var cv = el.roll, ctx = state.rollCtx;
    if (!cv || !ctx) return;
    var pal = rollPalette();
    var dpr = window.devicePixelRatio || 1;
    var g = rollGeom();
    var W = g.W, H = g.H;

    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    var LABEL_FONT = '8.5px "Cascadia Mono", Consolas, monospace';

    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, W, H);

    /* 顶部时间刻度尺底栏（点击/拖拽跳转播放进度） */
    ctx.fillStyle = pal.rulerBg;
    ctx.fillRect(g.GUT, 0, W - g.GUT, g.plotTop);
    ctx.fillStyle = pal.rulerLine;
    ctx.fillRect(0, g.plotTop - 0.5, W, 0.5);

    /* 左侧音名列 */
    ctx.fillStyle = pal.gutBg;
    ctx.fillRect(0, 0, g.GUT, H);
    ctx.fillStyle = pal.gutLine;
    ctx.fillRect(g.GUT - 0.5, 0, 0.5, H);

    /* 21 行：C 行标音名，其余标键字母 */
    for (var r = 0; r < 21; r++) {
      var k = LABELS[r], p = keyToPitch(k);
      var y = g.plotTop + g.plotH - (r + 1) * g.rowH;
      var isC = (p % 12 === 0);

      if (isC) {
        ctx.fillStyle = pal.rowC;
        ctx.fillRect(g.GUT, y, g.plotW, Math.max(1, g.rowH - 0.5));
      }
      ctx.fillStyle = pal.rowLine;
      ctx.fillRect(g.GUT, y + g.rowH - 0.5, g.plotW, 0.5);

      ctx.textBaseline = 'middle';
      if (g.rowH >= 6) {
        if (isC) {
          ctx.fillStyle = pal.labelC;
          ctx.font = LABEL_FONT;
          ctx.fillText(pitchName(p), 5, y + g.rowH / 2);
        } else {
          ctx.fillStyle = pal.labelKey;
          ctx.font = LABEL_FONT;
          ctx.fillText(k, 25, y + g.rowH / 2);
        }
      }
    }

    if (!state.current) {
      ctx.fillStyle = pal.emptyText;
      ctx.font = '11.5px "Segoe UI", system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText('点击此处直接落音新建曲谱，或从左侧「＋ 新建曲谱 / 导入曲谱」开始', g.GUT + 18, H / 2);
      return;
    }

    /* 时间刻度与吸附网格 */
    var snapMs = getSnapMs();
    var pixPerMs = g.plotW / (g.t1 - g.t0);
    var drawStepMs = snapMs;
    while (drawStepMs * pixPerMs < 14) drawStepMs *= 2;
    var firstSnap = Math.ceil(g.t0 / drawStepMs) * drawStepMs;
    for (var st = firstSnap; st <= g.t1; st += drawStepMs) {
      var sx = g.xOf(st);
      if (sx < g.GUT) continue;
      ctx.fillStyle = pal.snapLine;
      ctx.fillRect(sx, g.plotTop, 1, g.plotH);
    }

    var stepMs = state.viewSec <= 5 ? 1000 : (state.viewSec <= 12 ? 2000 : 4000);
    var first = Math.ceil(g.t0 / stepMs) * stepMs;
    ctx.textBaseline = 'top';
    for (var tt = first; tt <= g.t1; tt += stepMs) {
      var xx = g.xOf(tt);
      if (xx < g.GUT) continue;
      ctx.fillStyle = pal.majorLine;
      ctx.fillRect(xx, g.plotTop, 1, g.plotH);
      ctx.fillStyle = pal.tickLine;
      ctx.fillRect(xx, g.plotTop - 4, 1, 4);
      if (g.rowH >= 5) {
        ctx.fillStyle = pal.tickText;
        ctx.font = LABEL_FONT;
        ctx.fillText((tt / 1000).toFixed(0) + 's', xx + 4, g.PAD - 1);
      }
    }

    /* 时间选区高亮（刻度尺拖拽或空白框选产生） */
    var tr = state.edit.timeRange;
    if (tr && tr.end > tr.start) {
      var rx0 = clamp(g.xOf(tr.start), g.GUT, W - g.PAD);
      var rx1 = clamp(g.xOf(tr.end), g.GUT, W - g.PAD);
      if (rx1 > rx0) {
        ctx.fillStyle = pal.timeRangeFill;
        ctx.fillRect(rx0, g.plotTop, rx1 - rx0, g.plotH);
        ctx.fillStyle = pal.timeRangeHead;
        ctx.fillRect(rx0, 0, rx1 - rx0, g.plotTop);
        ctx.fillStyle = pal.accent;
        ctx.fillRect(rx0, 0, 1, H);
        ctx.fillRect(rx1 - 1, 0, 1, H);
      }
    }

    /* 播放头 */
    var hx = g.GUT + g.plotW * 0.25;
    ctx.fillStyle = pal.accent;
    ctx.fillRect(hx - 0.5, g.plotTop, 1, g.plotH);

    /* 音符 */
    var notes = state.current.notes;
    var barH = Math.max(2, g.rowH - 2);
    var start = upperBoundStart(notes, g.t0 - Math.max(6000, state.maxNoteMs || 6000));

    for (var i = start; i < notes.length; i++) {
      var n = notes[i];
      if (n.start > g.t1) break;
      if (n.end < g.t0) continue;
      var ri = LABELS.indexOf(n.key);
      if (ri < 0) continue;
      var yy = g.plotTop + g.plotH - (ri + 1) * g.rowH;
      var isRecActive = !!n._recActive;
      var x0 = Math.max(g.GUT, g.xOf(n.start));
      var x1 = (isRecActive && state.playing)
        ? Math.min(W - g.PAD, Math.max(x0 + 2, hx))
        : Math.min(W - g.PAD, g.xOf(n.end));
      if (x1 - x0 < 2) x1 = x0 + 2;
      var hot = isRecActive || (n.start <= t && n.end > t);

      /* 低/中/高三排用同一个强调色的三级明度，保持淡雅 */
      ctx.fillStyle = hot ? pal.noteHot
        : (n.pitch < 60 ? pal.noteLow : (n.pitch < 72 ? pal.noteMid : pal.noteHigh));
      rr(ctx, x0, yy + 1, x1 - x0, barH, 2);

      if (isNoteSelected(n)) {
        ctx.strokeStyle = pal.selStroke;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x0 - 1.5, yy + 0.5, x1 - x0 + 3, barH + 1);
        ctx.fillStyle = pal.selStroke;
        ctx.fillRect(x1 - 1, yy + 1, 2, barH);
      }
    }

    /* 矩形框选虚线框 */
    var br = state.edit.boxRect;
    if (br && (br.x1 > br.x0 || br.y1 > br.y0)) {
      var bw = Math.max(1, br.x1 - br.x0);
      var bh = Math.max(1, br.y1 - br.y0);
      ctx.fillStyle = pal.boxFill;
      ctx.fillRect(br.x0, br.y0, bw, bh);
      ctx.save();
      ctx.strokeStyle = pal.accent;
      ctx.lineWidth = 1;
      if (typeof ctx.setLineDash === 'function') ctx.setLineDash([4, 3]);
      ctx.strokeRect(br.x0 + 0.5, br.y0 + 0.5, bw, bh);
      ctx.restore();
    }

    /* 播放头顶部小三角 */
    ctx.fillStyle = pal.accent;
    ctx.beginPath();
    ctx.moveTo(hx - 4, g.plotTop - 6);
    ctx.lineTo(hx + 4, g.plotTop - 6);
    ctx.lineTo(hx, g.plotTop - 0.5);
    ctx.closePath();
    ctx.fill();
  }

  /* ═══════════════════ 编辑 ═══════════════════ */

  function snapshotNotes() {
    if (!state.current) return null;
    return state.current.notes.map(function (n) {
      return { key: n.key, pitch: n.pitch, start: n.start, end: n.end, velocity: n.velocity };
    });
  }

  function pushUndo(customSnap) {
    if (!state.current) return;
    var snap = customSnap || snapshotNotes();
    if (!snap) return;
    state.edit.undo.push(snap);
    if (state.edit.undo.length > 60) state.edit.undo.shift();
  }

  function undoEdit() {
    if (!state.current || !state.edit.undo.length) { toast('没有可撤销的操作'); return; }
    var snap = state.edit.undo.pop();
    state.current.notes = snap;
    clearSelection();
    state.edit.dirty = true;
    recomputeDerived();
    updateEditBar();
    renderDiag(state.currentEntry, state.current);
    drawRoll(currentScoreMs());
  }

  function resetEdit() {
    if (!state.currentEntry) return;
    selectEntry(state.currentEntry.id, true);
    toast('已还原为初始状态', 'ok');
  }

  function getActiveTimeRange() {
    if (state.edit.timeRange && state.edit.timeRange.end > state.edit.timeRange.start) {
      return { start: state.edit.timeRange.start, end: state.edit.timeRange.end };
    }
    return null;
  }

  function updateEditBar() {
    if (el.editBar) el.editBar.hidden = false;
    var selList = getSelectedNotes();
    var sel = state.edit.selNote;
    var hasScore = !!state.current;
    var total = hasScore ? state.current.notes.length : 0;
    var hasSel = selList.length > 0;
    var tr = state.edit.timeRange;
    var hasTimeRange = !!(tr && tr.end > tr.start);
    var activeRange = getActiveTimeRange();

    var activeRec = null;
    if (!hasSel && state.recording) {
      for (var rk in state.recActiveNotes) {
        if (Object.prototype.hasOwnProperty.call(state.recActiveNotes, rk) && state.recActiveNotes[rk]) {
          activeRec = state.recActiveNotes[rk];
        }
      }
    }

    if (el.editInfo) {
      if (hasTimeRange) {
        el.editInfo.innerHTML =
          '已选时间列 <b>' + fmtTime(tr.start) + ' ~ ' + fmtTime(tr.end) +
          '</b>（<b>' + Math.round(tr.end - tr.start) + 'ms</b>）· 按 Delete 删除该时间段并前移后续音符 · 共 ' + total + ' 音';
      } else if (selList.length > 1) {
        var minS = Infinity, maxE = 0;
        for (var i = 0; i < selList.length; i++) {
          if (selList[i].start < minS) minS = selList[i].start;
          if (selList[i].end > maxE) maxE = selList[i].end;
        }
        el.editInfo.innerHTML =
          '已选 <b>' + selList.length + ' 音</b> · 区间 <b>' + fmtTime(minS) + ' ~ ' + fmtTime(maxE) +
          '</b> · 共 ' + total + ' 音';
      } else if (hasSel && sel) {
        el.editInfo.innerHTML =
          '已选 <b>' + pitchName(sel.pitch) + '</b> · 起点 <b>' + fmtTime(sel.start) +
          '</b> · 时值 <b>' + Math.round(sel.end - sel.start) + 'ms</b>' +
          ' · 共 ' + total + ' 音';
      } else if (activeRec) {
        el.editInfo.innerHTML =
          '录制 <b>' + pitchName(activeRec.pitch) + '</b> · 起点 <b>' + fmtTime(activeRec.start) +
          '</b> · 时值 <b>' + Math.round(activeRec.end - activeRec.start) + 'ms</b>' +
          ' · 共 ' + total + ' 音';
      } else if (hasScore) {
        el.editInfo.textContent = '共 ' + total + ' 音 · 画布拖拽框选音符 · 顶部时间轴拖选整列删除 · 点击加音';
      } else {
        el.editInfo.textContent = '未选择曲目 · 共 0 音';
      }
    }

    if (el.btnEditUndo) el.btnEditUndo.disabled = !state.edit.undo.length;
    if (el.btnEditReset) el.btnEditReset.disabled = !hasScore;
    if (el.btnEditExport) el.btnEditExport.disabled = !hasScore;

    if (el.btnTimeLeft) el.btnTimeLeft.disabled = !hasSel;
    if (el.btnTimeRight) el.btnTimeRight.disabled = !hasSel;
    if (el.btnPitchDown) el.btnPitchDown.disabled = !hasSel;
    if (el.btnPitchUp) el.btnPitchUp.disabled = !hasSel;
    if (el.btnDurDown) el.btnDurDown.disabled = !hasSel;
    if (el.btnDurUp) el.btnDurUp.disabled = !hasSel;
    if (el.btnDel) {
      if (hasTimeRange) {
        el.btnDel.disabled = !hasScore;
        el.btnDel.textContent = '✂ 删时间段';
        el.btnDel.title = '删除选定时间段并将后续音符整体前移（Delete）';
      } else {
        el.btnDel.disabled = !hasSel;
        el.btnDel.textContent = '删除';
        el.btnDel.title = '删除选中音符（Delete）';
      }
    }
    if (el.btnRippleCut) el.btnRippleCut.disabled = !(hasScore && activeRange);
    if (el.btnInsertGap) el.btnInsertGap.disabled = !hasScore;
    if (el.btnDeselect) {
      var canDesel = hasSel || hasTimeRange;
      el.btnDeselect.disabled = !canDesel;
      el.btnDeselect.hidden = !canDesel;
    }
  }

  function getSnapMs() {
    var s = el.editSnap ? el.editSnap.value : '50';
    if (s === '1') return 1;
    if (s === '10') return 10;
    if (s === '20') return 20;
    if (s === '50') return 50;
    if (s === '100') return 100;
    var bpm = (state.current && state.current.bpm) || 60;
    var beatMs = 60000 / bpm;
    if (s === 'quarter') return Math.max(20, Math.round(beatMs / 4));
    if (s === 'eighth') return Math.max(20, Math.round(beatMs / 8));
    return 50;
  }

  function requireSelNotes() {
    var list = getSelectedNotes();
    if (!list.length) {
      toast('先点选或拖拽框选音符');
      return null;
    }
    return list;
  }

  function editPitch(dir) {
    var list = requireSelNotes(); if (!list) return;
    var minR = 20, maxR = 0;
    for (var i = 0; i < list.length; i++) {
      var r = LABELS.indexOf(list[i].key);
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
    }
    var actualDir = clamp(dir, -minR, 20 - maxR);
    if (actualDir === 0) return;
    pushUndo();
    for (var j = 0; j < list.length; j++) {
      var np = stepPitch(list[j].pitch, actualDir);
      list[j].pitch = np;
      list[j].key = pitchToKey(np);
    }
    state.edit.dirty = true;
    auditionNote(list[list.length - 1]);
    recomputeDerived(); updateEditBar();
    renderDiag(state.currentEntry, state.current); drawRoll(currentScoreMs());
  }

  function editPitchTo(targetPitch) {
    var list = requireSelNotes(); if (!list) return;
    var anchor = list[list.length - 1];
    if (anchor.pitch === targetPitch) return;
    var targetRow = LABELS.indexOf(pitchToKey(targetPitch));
    var anchorRow = LABELS.indexOf(anchor.key);
    if (targetRow < 0 || anchorRow < 0) return;
    editPitch(targetRow - anchorRow);
  }

  function editTime(deltaMs) {
    var list = requireSelNotes(); if (!list) return;
    var minStart = Infinity;
    for (var i = 0; i < list.length; i++) {
      if (list[i].start < minStart) minStart = list[i].start;
    }
    var actualDelta = Math.max(-minStart, deltaMs);
    if (actualDelta === 0) return;
    pushUndo();
    for (var j = 0; j < list.length; j++) {
      var n = list[j];
      var dur = n.end - n.start;
      var newStart = Math.max(0, n.start + actualDelta);
      n.start = newStart;
      n.end = newStart + dur;
    }
    state.edit.dirty = true;
    recomputeDerived(); updateEditBar();
    renderDiag(state.currentEntry, state.current); drawRoll(currentScoreMs());
  }

  function editDurDelta(deltaMs) {
    var list = requireSelNotes(); if (!list) return;
    pushUndo();
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      var d = Math.max(MIN_NOTE_MS, (n.end - n.start) + deltaMs);
      n.end = n.start + d;
    }
    state.edit.dirty = true;
    auditionNote(list[list.length - 1]);
    recomputeDerived(); updateEditBar();
    renderDiag(state.currentEntry, state.current); drawRoll(currentScoreMs());
  }

  function editDur(factor) {
    var list = requireSelNotes(); if (!list) return;
    pushUndo();
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      var d = Math.max(MIN_NOTE_MS, Math.round((n.end - n.start) * factor));
      n.end = n.start + d;
    }
    state.edit.dirty = true;
    auditionNote(list[list.length - 1]);
    recomputeDerived(); updateEditBar();
    renderDiag(state.currentEntry, state.current); drawRoll(currentScoreMs());
  }

  function editDelete() {
    if (state.edit.timeRange && state.edit.timeRange.end > state.edit.timeRange.start) {
      rippleDeleteRange();
      return;
    }
    var list = requireSelNotes(); if (!list) return;
    pushUndo();
    state.current.notes = state.current.notes.filter(function (n) {
      return list.indexOf(n) < 0;
    });
    clearSelection();
    state.edit.dirty = true;
    recomputeDerived(); updateEditBar();
    renderDiag(state.currentEntry, state.current); drawRoll(currentScoreMs());
  }

  /** 波纹剪辑：删除选定时间区间 [r0, r1]，并将 r1 之后的所有音符整体前移 (r1 - r0) */
  function rippleDeleteRange() {
    if (!state.current) return;
    var range = getActiveTimeRange();
    if (!range || range.end <= range.start) {
      toast('请先在顶部刻度尺或画布空白处拖拽框选要剪除的时间段');
      return;
    }
    var r0 = Math.max(0, range.start);
    var r1 = Math.max(r0, range.end);
    var span = r1 - r0;
    if (span <= 0) return;

    pushUndo();
    var nextNotes = [];
    var notes = state.current.notes;
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i];
      if (n.end <= r0) {
        nextNotes.push(n);
      } else if (n.start >= r1) {
        n.start = Math.max(0, n.start - span);
        n.end = Math.max(n.start + MIN_NOTE_MS, n.end - span);
        nextNotes.push(n);
      } else if (n.start >= r0 && n.end <= r1) {
        /* 落在被剪除区间内的音符直接移除 */
      } else if (n.start < r0 && n.end > r1) {
        n.end = Math.max(n.start + MIN_NOTE_MS, n.end - span);
        nextNotes.push(n);
      } else if (n.start < r0 && n.end > r0) {
        n.end = Math.max(n.start + MIN_NOTE_MS, r0);
        nextNotes.push(n);
      } else if (n.start < r1 && n.end > r1) {
        n.start = r0;
        n.end = Math.max(r0 + MIN_NOTE_MS, n.end - span);
        nextNotes.push(n);
      }
    }
    state.current.notes = nextNotes;
    if (state.current.baseDurationMs) {
      state.current.baseDurationMs = Math.max(0, state.current.baseDurationMs - span);
    }
    clearSelection();
    state.edit.dirty = true;
    recomputeDerived();
    seekTo(r0, true);
    updateEditBar();
    renderDiag(state.currentEntry, state.current);
    drawRoll(currentScoreMs());
    toast('已剪除区间 ' + fmtTime(r0) + ' ~ ' + fmtTime(r1) + '，后续音符已前移 ' + Math.round(span) + 'ms', 'ok');
  }

  /** 在当前播放头（或时间选区起点）向后插入一段空白，后续音符整体后移 */
  function insertBlankGap(customMs) {
    if (!state.current) return;
    var snap = getSnapMs();
    var tr = (state.edit.timeRange && state.edit.timeRange.end > state.edit.timeRange.start) ? state.edit.timeRange : null;
    var insertAt = tr ? tr.start : Math.max(0, Math.round(currentScoreMs() / snap) * snap);
    var gapMs = customMs || (tr ? (tr.end - tr.start) : 1000);
    if (gapMs <= 0) return;

    pushUndo();
    var notes = state.current.notes;
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i];
      if (n.start >= insertAt) {
        n.start += gapMs;
        n.end += gapMs;
      } else if (n.end > insertAt) {
        n.end += gapMs;
      }
    }
    if (state.current.baseDurationMs) {
      state.current.baseDurationMs += gapMs;
    }
    state.edit.dirty = true;
    recomputeDerived();
    updateEditBar();
    renderDiag(state.currentEntry, state.current);
    drawRoll(currentScoreMs());
    toast('已在 ' + fmtTime(insertAt) + ' 处插入 ' + Math.round(gapMs) + 'ms 空白，后续音符已后移', 'ok');
  }

  function selectAllNotes() {
    if (!state.current || !state.current.notes.length) return;
    state.edit.timeRange = null;
    state.edit.boxRect = null;
    setSelectedNotes(state.current.notes.slice());
    updateEditBar();
    drawRoll(currentScoreMs());
    toast('已全选 ' + state.current.notes.length + ' 个音符', 'ok', 1500);
  }

  /** 把当前 notes 导出成 BetterGI 的 midi 型 JSON（ticks=1000,bpm=60 ⇒ 1 tick = 1ms） */
  function buildExportJson() {
    var sc = state.current;
    var evs = [];
    sc.notes.forEach(function (n) {
      evs.push([Math.max(0, Math.round(n.start)), 0, n.key]);
      evs.push([Math.max(0, Math.round(n.end)), 1, n.key]);
    });
    evs.sort(function (a, b) { return (a[0] - b[0]) || (a[1] - b[1]); });
    var cur = 0, parts = [];
    evs.forEach(function (e) {
      var d = Math.max(0, e[0] - cur);
      cur = e[0];
      parts.push((e[1] ? 'U' : 'D') + e[2] + d);
    });
    var src = state.sourceJson || {};
    var isFreshOrRenamed = !!(state.currentEntry && (state.currentEntry.isNew || state.currentEntry.renamed));
    var baseName = sc.name || '未命名曲谱';
    return {
      name: isFreshOrRenamed ? baseName : (baseName + '（编辑）'),
      author: src.author || '',
      instrument: src.instrument || '风物之诗琴',
      description: '由「风物之诗琴 · 曲谱工坊」导出｜源 type=' + (src.type || sc.type) +
        '｜' + sc.notes.length + ' 音｜时长 ' + Math.round(sc.stats.durationMs / 1000) + 's',
      type: 'midi',
      bpm: 60,
      ticks: 1000,
      notes: parts.join('|')
    };
  }

  function exportEdited() {
    if (!state.current) return;
    var json = buildExportJson();
    var text = JSON.stringify(json, null, 1);
    try {
      var blob = new Blob([text], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = (json.name || '曲谱').replace(/[\\/:*?"<>|]/g, '_') + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      toast('已导出：' + a.download, 'ok', 5000);
    } catch (e) {
      toast('导出失败：' + ((e && e.message) || e), 'err');
    }
    /* 同时把解析校验结果打出来，方便自查 */
    try {
      var check = window.BGIParse.parseScore(JSON.parse(text));
      console.log('[导出校验] ok=' + check.ok + ' 音符=' + (check.ok ? check.stats.noteCount : check.error));
    } catch (_) { }
  }

  /* ═══════════════════ 模式（无模式合一） ═══════════════════ */

  function setMode() {
    state.edit.on = true;
    el.roll.style.cursor = 'cell';
    updateEditBar();
    drawRoll(currentScoreMs());
  }

  /* ═══════════════════ 每帧 ═══════════════════ */

  var lastFrameTs = 0;

  function frame(ts) {
    requestAnimationFrame(frame);
    if (state.fatal) return;

    if (!ts) ts = (window.performance && performance.now) ? performance.now() : Date.now();
    var dt = lastFrameTs ? Math.min(0.05, (ts - lastFrameTs) / 1000) : 0.016;
    lastFrameTs = ts;

    var t = currentScoreMs();
    if (state.playing) state.posMs = t;

    if (state.recording) {
      syncActiveRecNotes(t);
    }

    var act = shouldShowKeys() ? activeAt(t) : [];
    var keys = {}, top = null;
    for (var i = 0; i < act.length; i++) {
      keys[act[i].key] = true;
      if (!top || act[i].start >= top.start) top = act[i];
    }
    setKeys(keys);
    animateKeys(dt);

    if (top) {
      var nm = pitchName(top.pitch);
      if (el.npNoteName.textContent !== nm) el.npNoteName.textContent = nm;
      el.npNoteName.classList.remove('is-idle');
      var sol = (solfege(top.pitch) || '') + ' · ' + top.key;
      if (el.npNoteSol.textContent !== sol) el.npNoteSol.textContent = sol;
    } else {
      if (el.npNoteName.textContent !== '—') el.npNoteName.textContent = '—';
      el.npNoteName.classList.add('is-idle');
      if (el.npNoteSol.textContent !== '') el.npNoteSol.textContent = '';
    }

    if (el.liveText) {
      var want = state.recording
        ? (state.playing ? '录制中' : '待命录制')
        : (state.playing ? '播放中' : (state.current ? (state.posMs > 0 ? '已暂停' : '就绪') : '空闲'));
      if (el.liveText.textContent !== want) el.liveText.textContent = want;
      el.liveText.classList.toggle('is-on', state.playing || state.recording);
    }

    var d = duration();
    var frac;
    if (state.seeking) {
      frac = clamp(parseInt(el.seek.value, 10) / 1000, 0, 1);
      el.tNow.textContent = fmtTime(frac * d);
    } else {
      frac = d > 0 ? clamp(t / d, 0, 1) : 0;
      el.tNow.textContent = fmtTime(t);
      if (state.current) el.seek.value = Math.round(frac * 1000);
    }
    if (el.seekWrap) {
      var pv = frac.toFixed(4);
      if (el.seekWrap.__p !== pv) { el.seekWrap.__p = pv; el.seekWrap.style.setProperty('--p', pv); }
      el.seekWrap.classList.toggle('is-active', !!state.seeking);
    }
    if (state.current) {
      var tt = fmtTime(d);
      if (el.tTotal.textContent !== tt) el.tTotal.textContent = tt;
    }

    drawRoll(t);
  }

  /* ═══════════════════ 诊断 ═══════════════════ */

  function maxDistinctKeys(notes) {
    var evs = [];
    for (var i = 0; i < notes.length; i++) {
      evs.push([notes[i].start, 1, notes[i].key]);
      evs.push([notes[i].end, 0, notes[i].key]);
    }
    evs.sort(function (a, b) { return (a[0] - b[0]) || (a[1] - b[1]); });
    var held = {}, cnt = 0, max = 0;
    for (var j = 0; j < evs.length; j++) {
      var k = evs[j][2];
      if (evs[j][1]) { held[k] = (held[k] || 0) + 1; if (held[k] === 1) cnt++; }
      else if (held[k]) { held[k]--; if (!held[k]) cnt--; }
      if (cnt > max) max = cnt;
    }
    return max;
  }

  function renderDiag(entry, sc) {
    if (!el.diag) return;
    var out = [];
    if (!sc || !sc.ok) {
      out.push('<b>' + esc(entry ? entry.name : '—') + '</b>');
      out.push('<span class="fail">解析失败：' + esc((entry && entry.error) || '未知') + '</span>');
      el.diag.innerHTML = out.join('<br>');
      return;
    }
    var st = sc.stats || {};
    out.push('type ' + esc(sc.type) + ' · bpm ' + esc(sc.bpm) + ' · ticks ' + esc(sc.ticks));
    out.push('音符 <b>' + st.noteCount + '</b> · 时长 <b>' + fmtDur(st.durationMs) + '</b>');
    if (st.durationMs > 0) {
      out.push('密度 ' + (st.noteCount / (st.durationMs / 1000)).toFixed(2) + ' 音/秒');
    }
    out.push('按键 <b>' + (st.keysUsed ? st.keysUsed.length : 0) + '/21</b> · 最大同按 <b>' +
      maxDistinctKeys(sc.notes) + ' 键</b>');
    if (sc.warnings && sc.warnings.length) {
      out.push('<span class="warn">warnings ' + sc.warnings.length + '</span>');
    } else {
      out.push('<span class="pass">无 warnings</span>');
    }
    el.diag.innerHTML = out.join('<br>');
  }

  /* ═══════════════════ 音色 ═══════════════════ */

  /** 重建下拉框；preferKey 只在首次或切换后调用 */
  function fillInstruments(preferKey) {
    var opts = instrumentOptions();
    if (!opts.length) {
      opts = [{ key: SYNTH_PREFIX + 'harp', label: '合成（备用）· 竖琴', id: 'harp' }];
    }
    el.instrument.innerHTML = '';
    opts.forEach(function (it) {
      var o = document.createElement('option');
      o.value = it.key;
      o.textContent = it.label;
      el.instrument.appendChild(o);
    });
    var want = preferKey || state.instrumentKey;
    if (!opts.some(function (x) { return x.key === want; })) want = opts[0].key;
    state.instrumentKey = want;
    el.instrument.value = want;
    return want;
  }

  /** 用户自己选的采样文件夹：存起来，之后可以再切回来 */
  async function loadSamples(fileList) {
    if (!ensureEngine()) return;
    var files = Array.prototype.slice.call(fileList || []).filter(function (f) {
      return /\.(wav|mp3|ogg|oga|m4a|aac|flac|webm)$/i.test(f.name);
    });
    if (!files.length) { toast('这个文件夹里没有音频文件', 'err'); return; }
    if (typeof state.engine.loadSampleFiles !== 'function') { toast('当前引擎不支持采样', 'err'); return; }

    setSampleStat('正在解码 ' + files.length + ' 个文件…', '');
    await safeResume();
    /* 先试解一次，能认出音高才接管当前音色 */
    var probe;
    try {
      if (typeof state.engine.clearSamples === 'function') state.engine.clearSamples();
      probe = await state.engine.loadSampleFiles(files);
    } catch (e) {
      setSampleStat('加载失败：' + ((e && e.message) || e), 'err');
      return;
    }
    var n = (probe && probe.loaded) || 0;
    if (!n) {
      setSampleStat('没有识别出音符采样（文件名需为 C3.wav / A4.mp3 / Z.wav / 48.wav）', 'err');
      return;
    }
    state.customFiles = files;
    var miss = (probe && probe.missing) || [];
    fillInstruments('real:custom');
    state.engine.setInstrument('sample');
    setSampleStat('自定义采样 · ' + n + ' 音' + (miss.length ? '，未识别 ' + miss.length + ' 个' : ' ✓'), 'ok');
    toast('自定义采样已启用：' + n + ' 音', 'ok');
  }

  /* ═══════════════════ 事件接线 ═══════════════════ */

  function bind() {
    el.scoreList.addEventListener('click', function (ev) {
      var actBtn = ev.target.closest ? ev.target.closest('button[data-action]') : null;
      var li = ev.target.closest ? ev.target.closest('li[data-id]') : null;
      if (!li) return;
      var id = parseInt(li.getAttribute('data-id'), 10);
      if (actBtn) {
        ev.stopPropagation();
        var act = actBtn.getAttribute('data-action');
        if (act === 'del') {
          deleteEntry(id);
        } else if (act === 'edit') {
          startInlineListRename(li, id);
        }
        return;
      }
      if (ev.target && ev.target.isContentEditable) return;
      if (isCompactViewport()) setSidebarOpen(false);
      if (state.selectedId === id && state.current) return;
      selectEntry(id);
    });
    el.scoreList.addEventListener('dblclick', function (ev) {
      var nm = ev.target.closest ? ev.target.closest('.nm') : null;
      var li = ev.target.closest ? ev.target.closest('li[data-id]') : null;
      if (!nm || !li) return;
      ev.stopPropagation();
      startInlineListRename(li, parseInt(li.getAttribute('data-id'), 10));
    });

    if (el.btnSidebar) {
      el.btnSidebar.addEventListener('click', function () {
        setSidebarOpen(!isSidebarOpen());
      });
    }
    if (el.btnSidebarClose) {
      el.btnSidebarClose.addEventListener('click', function () { setSidebarOpen(false); });
    }
    if (el.sidebarBackdrop) {
      el.sidebarBackdrop.addEventListener('click', function () { setSidebarOpen(false); });
    }
    window.addEventListener('resize', syncSidebarUi);

    if (el.btnNewScore) {
      el.btnNewScore.addEventListener('click', function () {
        createNewScore();
        if (isCompactViewport()) setSidebarOpen(false);
      });
    }
    el.btnPickFiles.addEventListener('click', function () { el.fileInput.click(); });
    el.btnPickDir.addEventListener('click', function () { el.dirInput.click(); });
    el.fileInput.addEventListener('change', function (e) { importFiles(e.target.files); e.target.value = ''; });
    el.dirInput.addEventListener('change', function (e) { importFiles(e.target.files); e.target.value = ''; });

    el.btnLoadSamples.addEventListener('click', function () { el.sampleInput.click(); });
    el.sampleInput.addEventListener('change', function (e) { loadSamples(e.target.files); e.target.value = ''; });

    el.search.addEventListener('input', function () { state.filter = el.search.value; renderList(); });
    el.btnClearList.addEventListener('click', function () {
      state.entries = [];
      hiddenShowcasePaths = {};
      newScoreSeq = 0;
      resetToEmptyState();
      try {
        if (typeof localStorage !== 'undefined' && localStorage) localStorage.removeItem(WORKSPACE_KEY);
      } catch (_) { }
      toast('已清空歌单与本地缓存', 'ok');
    });

    if (el.npTitle) {
      var commitNpTitleRename = function () {
        if (!state.current || !state.currentEntry) return;
        var nextName = (el.npTitle.textContent || '').replace(/\s+/g, ' ').trim();
        if (!nextName) {
          nextName = state.current.name || '未命名曲谱';
        }
        el.npTitle.textContent = nextName;
        if (nextName !== state.current.name) {
          state.current.name = nextName;
          state.currentEntry.name = nextName;
          state.currentEntry.renamed = true;
          if (state.sourceJson) state.sourceJson.name = nextName;
          renderList();
          scheduleSaveWorkspace();
          toast('曲名已更新为「' + nextName + '」', 'ok');
        }
      };
      el.npTitle.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitNpTitleRename();
          el.npTitle.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          if (state.current) el.npTitle.textContent = state.current.name || '未命名曲谱';
          el.npTitle.blur();
        }
      });
      el.npTitle.addEventListener('blur', commitNpTitleRename);
    }

    el.btnPlay.addEventListener('click', function () {
      if (!state.current) return;
      if (state.playing) { pausePlayback(); return; }
      playCurrent();
    });
    el.btnStop.addEventListener('click', function () { stopPlayback(); });
    el.btnPrev.addEventListener('click', function () { jumpTrack(-1, state.playing); });
    el.btnNext.addEventListener('click', function () { jumpTrack(1, state.playing); });
    if (el.btnStepBack) el.btnStepBack.addEventListener('click', function () { stepTimestamp(-getSnapMs()); });
    if (el.btnStepFwd) el.btnStepFwd.addEventListener('click', function () { stepTimestamp(getSnapMs()); });
    if (el.btnRecord) el.btnRecord.addEventListener('click', function () { toggleRecording(); });
    if (el.btnHelp && el.helpModal) {
      el.btnHelp.addEventListener('click', function () {
        el.helpModal.hidden = !el.helpModal.hidden;
      });
    }
    if (el.btnHelpClose && el.helpModal) {
      el.btnHelpClose.addEventListener('click', function () {
        el.helpModal.hidden = true;
      });
    }
    if (el.helpModal) {
      el.helpModal.addEventListener('click', function (ev) {
        if (ev.target === el.helpModal) el.helpModal.hidden = true;
      });
    }

    if (el.modePlay) el.modePlay.addEventListener('click', function () { setMode(false); });
    if (el.modeEdit) el.modeEdit.addEventListener('click', function () { setMode(true); });

    el.speed.addEventListener('input', function () {
      var v = parseFloat(el.speed.value);
      var keep = state.playing ? clamp(scoreMsAt(engNow()), 0, duration()) : state.posMs;
      state.speed = v;
      el.speedVal.textContent = v.toFixed(2) + '×';
      if (state.playing) startPlayback(keep); else state.posMs = keep;
      scheduleSaveWorkspace();
    });
    if (el.btnPlayMode) el.btnPlayMode.addEventListener('click', cyclePlayMode);
    el.loop.addEventListener('change', function () {
      if (el.loop.checked) setPlayMode('single');
      else setPlayMode(el.autoplay.checked ? 'list' : 'order');
    });
    el.autoplay.addEventListener('change', function () {
      if (el.autoplay.checked) setPlayMode('list');
      else setPlayMode(el.loop.checked ? 'single' : 'order');
    });
    if (el.btnPlayKeys) {
      el.btnPlayKeys.addEventListener('click', function () {
        state.playKeys = !state.playKeys;
        if (!state.playKeys) { state.heldKeys = {}; }
        updatePlayKeysBtn();
        scheduleSaveWorkspace();
      });
    }

    el.seek.addEventListener('pointerdown', function () { state.seeking = true; });
    el.seek.addEventListener('input', function () {
      if (!state.current) return;
      state.posMs = (parseInt(el.seek.value, 10) / 1000) * duration();
      el.tNow.textContent = fmtTime(state.posMs);
    });
    el.seek.addEventListener('change', function () { state.seeking = false; seekTo(state.posMs); });
    window.addEventListener('pointerup', function () { state.seeking = false; });

    el.zoom.addEventListener('input', function () {
      state.viewSec = parseInt(el.zoom.value, 10);
      el.zoomVal.textContent = state.viewSec + ' 秒';
    });

    el.instrument.addEventListener('change', function () {
      applyInstrument(el.instrument.value);
      scheduleSaveWorkspace();
    });
    el.volume.addEventListener('input', function () {
      state.volume = parseFloat(el.volume.value);
      if (state.engine) { try { state.engine.setMasterVolume(state.volume); } catch (_) { } }
      scheduleSaveWorkspace();
    });

    /* 编辑操作 */
    if (el.btnTimeLeft) el.btnTimeLeft.addEventListener('click', function () { editTime(-getSnapMs()); });
    if (el.btnTimeRight) el.btnTimeRight.addEventListener('click', function () { editTime(getSnapMs()); });
    el.btnPitchDown.addEventListener('click', function () { editPitch(-1); });
    el.btnPitchUp.addEventListener('click', function () { editPitch(1); });
    el.btnDurDown.addEventListener('click', function () { editDur(1 / 1.5); });
    el.btnDurUp.addEventListener('click', function () { editDur(1.5); });
    el.btnDel.addEventListener('click', editDelete);
    if (el.btnRippleCut) el.btnRippleCut.addEventListener('click', function () { rippleDeleteRange(); });
    if (el.btnInsertGap) el.btnInsertGap.addEventListener('click', function () { insertBlankGap(); });
    if (el.btnDeselect) el.btnDeselect.addEventListener('click', function () {
      clearSelection();
      updateEditBar();
      drawRoll(currentScoreMs());
    });
    if (el.editSnap) el.editSnap.addEventListener('change', function () {
      drawRoll(currentScoreMs());
    });
    el.btnEditUndo.addEventListener('click', undoEdit);
    el.btnEditReset.addEventListener('click', resetEdit);
    el.btnEditExport.addEventListener('click', exportEdited);

    /* 拖放 */
    var dragDepth = 0;
    var veil = document.createElement('div');
    veil.className = 'drag-veil';
    veil.textContent = '松开即导入曲谱';
    veil.hidden = true;
    document.body.appendChild(veil);
    function setDragUi(on) {
      veil.hidden = !on;
      if (el.dropzone) el.dropzone.classList.toggle('hot', on);
    }

    function onDragEnter(e) {
      e.preventDefault();
      dragDepth++;
      setDragUi(true);
    }
    function onDragOver(e) {
      e.preventDefault();
      if (e.dataTransfer) {
        try { e.dataTransfer.dropEffect = 'copy'; } catch (_) {}
      }
    }
    function onDragLeave(e) {
      e.preventDefault();
      if (--dragDepth <= 0) {
        dragDepth = 0;
        setDragUi(false);
      }
    }
    function onDrop(e) {
      e.preventDefault();
      e.stopPropagation();
      dragDepth = 0;
      setDragUi(false);
      if (!e.dataTransfer) return;
      collectFromDataTransfer(e.dataTransfer)
        .then(function (files) { return importFiles(files); })
        .catch(function (err) {
          console.error('拖拽导入失败：', err);
          toast('拖拽导入失败：' + ((err && err.message) || err), 'err');
        });
    }

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);

    document.addEventListener('dragover', function (e) {
      e.preventDefault();
      if (e.dataTransfer) {
        try { e.dataTransfer.dropEffect = 'copy'; } catch (_) {}
      }
    });
    document.addEventListener('drop', function (e) {
      e.preventDefault();
    });

    /* 快捷键 + 键盘弹奏 */
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
  }

  function isTypingTarget(t) {
    var tag = (t && t.tagName) || '';
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!(t && t.isContentEditable);
  }

  function onKeyDown(e) {
    if (isTypingTarget(e.target)) return;

    if (el.helpModal && !el.helpModal.hidden) {
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault();
        el.helpModal.hidden = true;
      }
      return;
    }
    if (e.key === 'Escape' && isCompactViewport() && isSidebarOpen()) {
      e.preventDefault();
      setSidebarOpen(false);
      return;
    }
    if (e.key === '?' || e.key === 'F1') {
      if (el.helpModal) {
        e.preventDefault();
        el.helpModal.hidden = !el.helpModal.hidden;
        return;
      }
    }

    /* 撤销：Ctrl/⌘ + Z，全选：Ctrl/⌘ + A（先于「带修饰键直接放行」判断） */
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault(); undoEdit(); return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault(); selectAllNotes(); return;
    }
    /* Alt + 左右方向键：10ms 极细微调（选中音符时微调音符，未选中时微调时间戳） */
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      var fineDelta = e.key === 'ArrowLeft' ? -10 : 10;
      if (state.edit.on && getSelectedNotes().length > 0) editTime(fineDelta);
      else stepTimestamp(fineDelta);
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    /* 编辑模式：Delete / Backspace 自动按当前选中态执行（选音符 -> 删音符；选表头时间列 -> 删时间段并前移） */
    if (state.edit.on && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      editDelete();
      return;
    }

    if (e.code === 'Space') { e.preventDefault(); el.btnPlay.click(); return; }
    if (e.key === 'Escape') {
      if (state.edit.on && (getSelectedNotes().length > 0 || state.edit.timeRange)) {
        e.preventDefault();
        clearSelection();
        updateEditBar();
        drawRoll(currentScoreMs());
        return;
      }
      stopPlayback();
      return;
    }

    var snapStep = getSnapMs();
    if (e.key === 'Home') {
      e.preventDefault();
      if (state.current) { seekTo(0, true); updateEditBar(); }
      return;
    }

    /* 编辑模式：选中音符时，上下左右方向键专用于微调音符，不切歌！ */
    if (state.edit.on && getSelectedNotes().length > 0) {
      if (e.key === 'ArrowUp') { e.preventDefault(); editPitch(1); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); editPitch(-1); return; }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (e.shiftKey) editDurDelta(-snapStep);
        else editTime(-snapStep);
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (e.shiftKey) editDurDelta(snapStep);
        else editTime(snapStep);
        return;
      }
    }

    /* 未选中音符时，左右方向键按吸附步长微调当前时间戳（Shift 为 ±1 秒） */
    if (e.key === 'ArrowLeft') { e.preventDefault(); stepTimestamp(-(e.shiftKey ? 1000 : snapStep)); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); stepTimestamp(e.shiftKey ? 1000 : snapStep); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); jumpTrack(-1, state.playing); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); jumpTrack(1, state.playing); return; }

    /* 键盘弹奏 / 录制：把字母键映射到 21 键 */
    if ((state.playKeys || state.recording) && e.key && e.key.length === 1) {
      var k = e.key.toUpperCase();
      if (FALLBACK_KEY_TO_PITCH[k] != null && !state.heldKeys[k]) {
        e.preventDefault();
        state.heldKeys[k] = true;
        if (state.recording) recordNoteStart(k);
        if (!ensureEngine()) return;
        safeResume().then(function () { noteOn(keyToPitch(k), engNow() + 0.005, state.recording ? 3.5 : 0.6, 0.92); });
      }
    }
  }

  function onKeyUp(e) {
    if (!e.key || e.key.length !== 1) return;
    var k = e.key.toUpperCase();
    if (state.heldKeys[k]) {
      delete state.heldKeys[k];
      if (state.recording) recordNoteEnd(k);
      if (state.engine && typeof state.engine.noteOff === 'function') {
        try { state.engine.noteOff(keyToPitch(k), engNow() + 0.005); } catch (_) {}
      }
    }
  }

  /* ═══════════════════ 致命错误 / 启动 ═══════════════════ */

  function showFatal(msg) {
    state.fatal = true;
    var d = document.createElement('div');
    d.className = 'fatal-layer';
    d.innerHTML =
      '<div><h2>播放器无法启动</h2>' +
      '<p>' + esc(msg) + '</p>' +
      '<div class="files">请确认 app/ 下有：<br>' +
      'index.html · css/style.css · js/bettergi-parse.js · js/audio-engine.js · js/app.js' +
      '</div></div>';
    document.body.appendChild(d);
  }

  function xhrGetJsonText(url) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText);
        else reject(new Error('HTTP ' + xhr.status));
      };
      xhr.onerror = function () { reject(new Error('network error')); };
      xhr.send();
    });
  }

  /** 在 HTTP(S) 托管环境下自动载入内置示范曲库（file:// 本地直开时不发任何网络请求） */
  async function loadShowcaseLibrary(saved) {
    if (typeof window === 'undefined' || !window.location) return;
    var proto = window.location.protocol;
    if (proto !== 'http:' && proto !== 'https:') return;

    var files;
    try {
      var mfText = await xhrGetJsonText('library/manifest.json');
      var mf = JSON.parse(mfText);
      files = Array.isArray(mf) ? mf : (mf && Array.isArray(mf.files) ? mf.files : []);
    } catch (_) {
      return;
    }
    if (!files.length) return;

    var existingPaths = {};
    state.entries.forEach(function (e) { existingPaths[e.path] = true; });
    var showcaseEdits = (saved && saved.showcaseEdits && typeof saved.showcaseEdits === 'object') ? saved.showcaseEdits : {};
    var added = 0;

    for (var i = 0; i < files.length; i++) {
      var fname = String(files[i] || '');
      if (!fname || !/\.json$/i.test(fname)) continue;
      var relPath = 'library/' + fname;
      if (existingPaths[relPath] || hiddenShowcasePaths[relPath]) continue;
      try {
        var text = await xhrGetJsonText('library/' + encodeURIComponent(fname));
        var obj = JSON.parse(text);
        var sc = window.BGIParse.parseScore(obj, { filename: fname });
        var ov = showcaseEdits[relPath];
        var workingNotes = (ov && ov.edited && Array.isArray(ov.workingNotes)) ? expandNotes(ov.workingNotes) : null;
        var noteCount = workingNotes ? workingNotes.length : (sc.stats ? sc.stats.noteCount : 0);
        var durationMs = sc.stats ? sc.stats.durationMs : 0;
        if (workingNotes) {
          var maxEnd = 0;
          for (var k = 0; k < workingNotes.length; k++) if (workingNotes[k].end > maxEnd) maxEnd = workingNotes[k].end;
          durationMs = Math.max(durationMs, maxEnd);
        }
        state.entries.push({
          id: state.nextId++,
          path: relPath,
          fileName: fname,
          isShowcase: true,
          name: (ov && ov.name) ? ov.name : (sc.ok ? (sc.name || fname.replace(/\.json$/i, '')) : fname.replace(/\.json$/i, '')),
          renamed: !!(ov && ov.renamed),
          edited: !!(ov && ov.edited && workingNotes),
          author: sc.author || '',
          type: sc.type || 'unknown',
          ok: !!sc.ok,
          error: sc.error || '',
          noteCount: noteCount,
          durationMs: durationMs,
          instrument: sc.instrument || '',
          text: text,
          workingNotes: workingNotes
        });
        existingPaths[relPath] = true;
        added++;
      } catch (_) { }
    }

    if (!added) return;
    sortEntries();
    renderList();
    if (!state.selectedId) {
      var wantPath = saved && saved.selectedPath;
      var matched = wantPath ? state.entries.filter(function (e) { return e.path === wantPath && e.ok; })[0] : null;
      var firstOk = matched || state.entries.filter(function (e) { return e.ok; })[0];
      if (firstOk) selectEntry(firstOk.id);
    }
    updateTrackNav();
  }

  var sidebarDesktopOpen = true;
  var sidebarDrawerOpen = false;

  function isCompactViewport() {
    return typeof window !== 'undefined' && window.innerWidth <= 900;
  }

  function isSidebarOpen() {
    return isCompactViewport() ? sidebarDrawerOpen : sidebarDesktopOpen;
  }

  function syncSidebarUi() {
    if (!el.appRoot) return;
    var compact = isCompactViewport();
    var open = compact ? sidebarDrawerOpen : sidebarDesktopOpen;
    el.appRoot.classList.toggle('is-sidebar-open', compact && open);
    el.appRoot.classList.toggle('is-sidebar-collapsed', !compact && !open);
    if (el.sidebarBackdrop) el.sidebarBackdrop.hidden = !(compact && open);
    if (el.btnSidebar) {
      el.btnSidebar.setAttribute('aria-expanded', open ? 'true' : 'false');
      el.btnSidebar.classList.toggle('is-on', open);
      el.btnSidebar.title = open ? '收起曲目栏' : '展开曲目栏';
    }
  }

  function setSidebarOpen(open) {
    if (isCompactViewport()) sidebarDrawerOpen = !!open;
    else sidebarDesktopOpen = !!open;
    syncSidebarUi();
    requestAnimationFrame(function () { drawRoll(currentScoreMs()); });
  }

  function updatePlayKeysBtn() {
    if (!el.btnPlayKeys) return;
    el.btnPlayKeys.classList.toggle('is-on', !!state.playKeys);
    el.btnPlayKeys.setAttribute('aria-pressed', state.playKeys ? 'true' : 'false');
  }

  function init() {
    cacheDom();

    var missing = [];
    if (!window.BGIParse || typeof window.BGIParse.parseScore !== 'function') missing.push('js/bettergi-parse.js');
    if (!window.BGIAudio || typeof window.BGIAudio.createEngine !== 'function') missing.push('js/audio-engine.js');
    if (missing.length) { showFatal('缺少必需文件：' + missing.join('、')); return; }

    var saved = loadWorkspaceCache();
    var prefs = (saved && saved.prefs && typeof saved.prefs === 'object') ? saved.prefs : {};
    if (typeof prefs.volume === 'number' && !isNaN(prefs.volume)) {
      state.volume = clamp(prefs.volume, 0, 1);
      if (el.volume) el.volume.value = String(state.volume);
    }
    if (typeof prefs.speed === 'number' && !isNaN(prefs.speed)) {
      state.speed = clamp(prefs.speed, 0.5, 2);
      if (el.speed) el.speed.value = String(state.speed);
    }
    if (typeof prefs.playKeys === 'boolean') {
      state.playKeys = prefs.playKeys;
    }

    buildKeyboard();
    initRoll();
    var firstKey = fillInstruments(prefs.instrumentKey || '');
    el.speedVal.textContent = state.speed.toFixed(2) + '×';
    el.zoomVal.textContent = state.viewSec + ' 秒';
    setPlayMode(prefs.playMode || 'list');
    updatePlayKeysBtn();

    renderList();
    updateTrackNav();
    updateEditBar();
    setMode(true);
    bind();
    syncSidebarUi();
    requestAnimationFrame(frame);

    restoreWorkspaceEntries(saved);
    workspaceReady = true;

    /* 默认音色 = 真实采样（风物之诗琴）。若未打包采样数据，则切到默认合成音色并提示。 */
    if (!sampleManifest()) {
      applyInstrument(firstKey);
      setSampleStat('当前使用内置合成音色 · 可在下方加载自定义采样文件夹', '');
    } else {
      applyInstrument(firstKey);
    }

    loadShowcaseLibrary(saved);

    window.addEventListener('pagehide', function () { saveWorkspaceNow(); });
    window.addEventListener('beforeunload', function (e) {
      var cachedOk = saveWorkspaceNow();
      if (state.edit.dirty && !cachedOk) { e.preventDefault(); e.returnValue = ''; }
    });

    console.log('原神琴谱制谱器 · 演奏台');
    console.log('自检：BGIParse.selfTest() / BGIAudio.selfTest()');
    console.log('键盘弹奏：QWERTYU / ASDFGHJ / ZXCVBNM（可关闭）');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();
