/* ============================================================
 * 鲸落·深渊 —— 音频层（30-audio.js）
 * 纯 Web Audio 程序化合成：短音效 + 3 段深海氛围循环 BGM
 * 不加载任何外部音频文件（无 fetch / 无 new Audio），不碰 DOM。
 * AudioContext 懒创建：首次 init() 或首次 sfx() 才建（浏览器要用户手势）。
 * 增益三条链：master ← sfx / music
 * ============================================================ */
(function () {
  'use strict';

  function clamp01(v) {
    v = +v;
    if (!isFinite(v)) return 0;
    if (v < 0) return 0;
    if (v > 1) return 1;
    return v;
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function hz(n) { return 440 * Math.pow(2, (n - 69) / 12); }

  /* ---------- 三段背景乐（track 1/2/3，0 = 关） ---------- */
  const TRACKS = {
    1: {
      bpm: 46, len: 32,
      chords: [[45, 52, 57, 60], [43, 50, 55, 58], [41, 48, 53, 56], [40, 47, 52, 55]],
      padType: 'triangle', padGain: 0.075, padCut: 480, padAttack: 1.6,
      seq: [0, 0, 0, 0, 76, 0, 0, 0, 0, 0, 74, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 72, 0, 0, 0, 0, 0, 71, 0, 0, 0, 0, 0],
      noteType: 'sine', noteGain: 0.05, noteDur: 1.8, noteCut: 2600,
      noise: { gain: 0.010, cut: 360, q: 0.7 }
    },
    2: {
      bpm: 96, len: 32,
      chords: [[38, 45, 50], [36, 43, 48], [41, 48, 53], [40, 47, 52]],
      padType: 'sawtooth', padGain: 0.035, padCut: 420, padAttack: 0.5,
      seq: [62, 0, 65, 0, 69, 0, 65, 0, 62, 0, 70, 0, 69, 0, 65, 0,
        60, 0, 64, 0, 67, 0, 64, 0, 60, 0, 67, 0, 65, 0, 62, 0],
      noteType: 'square', noteGain: 0.034, noteDur: 0.22, noteCut: 1800,
      pulse: 2, pulseGain: 0.07, hat: true, hatGain: 0.015,
      noise: { gain: 0.008, cut: 700, q: 0.9 }
    },
    3: {
      bpm: 132, len: 32,
      chords: [[36, 43, 48], [34, 41, 46], [36, 42, 48], [33, 40, 45]],
      padType: 'sawtooth', padGain: 0.042, padCut: 520, padAttack: 0.25,
      seq: [60, 63, 67, 63, 70, 67, 63, 60, 58, 62, 65, 62, 69, 65, 62, 58,
        60, 63, 67, 72, 70, 67, 63, 60, 57, 60, 65, 69, 67, 65, 60, 57],
      noteType: 'triangle', noteGain: 0.042, noteDur: 0.18, noteCut: 2600,
      pulse: 1, pulseGain: 0.085, hat: true, hatGain: 0.018,
      noise: { gain: 0.010, cut: 1100, q: 1.0 }
    }
  };

  /* ---------- 同名音效的最小间隔（防止一帧几十发叠成噪音） ---------- */
  const THROTTLE = {
    shoot: 0.045, hit: 0.028, slash: 0.05, enemy_die: 0.05, kill: 0.05,
    pickup: 0.035, gem: 0.04, ui: 0.025, ui_bad: 0.05, explode: 0.06,
    hurt: 0.12, heal: 0.15, freeze: 0.2, dodge: 0.08
  };

  function build() {
    const A = { ready: false };

    let ac = null;          // AudioContext
    let master = null;      // 总音量
    let sfxBus = null;      // 音效链
    let musicBus = null;    // 音乐链
    let noiseBuf = null;    // 预生成噪声 buffer

    const vol = { master: 0.7, music: 0.45, sfx: 0.7 };
    const lastAt = {};
    let cur = null;         // 当前音乐实例
    let curTrack = -1;
    let pendingTrack = 0;   // init 之前先记下要放哪段

    /* ================= 基础构件 ================= */

    function makeNoise(sec) {
      const len = Math.max(256, Math.floor(ac.sampleRate * sec));
      const buf = ac.createBuffer(1, len, ac.sampleRate);
      const d = buf.getChannelData(0);
      let s = 22695477;
      for (let i = 0; i < len; i++) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        d[i] = ((s / 0x7fffffff) * 2 - 1) * 0.9;
      }
      const fade = Math.min(256, len >> 4);
      for (let i = 0; i < fade; i++) {
        const k = i / fade;
        d[i] *= k;
        d[len - 1 - i] *= k;
      }
      return buf;
    }

    function env(g, t0, peak, atk, dur) {
      const p = Math.max(0.0001, peak);
      const a = Math.max(0.002, atk);
      const end = Math.max(a + 0.012, dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(p, t0 + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + end);
    }

    // 单个振荡器 + 包络（可选滤波 / 扫频）
    function tone(o) {
      const t0 = isNum(o.t) ? o.t : ac.currentTime;
      const dur = isNum(o.dur) ? o.dur : 0.15;
      const f0 = isNum(o.f0) ? o.f0 : 440;
      const f1 = isNum(o.f1) ? o.f1 : f0;
      const osc = ac.createOscillator();
      osc.type = o.type || 'sine';
      osc.frequency.setValueAtTime(Math.max(1, f0), t0);
      if (Math.abs(f1 - f0) > 0.01) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
      }
      if (isNum(o.detune)) osc.detune.setValueAtTime(o.detune, t0);
      const g = ac.createGain();
      env(g, t0, isNum(o.gain) ? o.gain : 0.15, isNum(o.attack) ? o.attack : 0.005, dur);
      osc.connect(g);
      let tail = g;
      if (o.filter) {
        const f = ac.createBiquadFilter();
        f.type = o.filter;
        f.frequency.setValueAtTime(Math.max(20, isNum(o.ff) ? o.ff : 1200), t0);
        if (isNum(o.ff1)) {
          f.frequency.exponentialRampToValueAtTime(Math.max(20, o.ff1), t0 + dur);
        }
        f.Q.setValueAtTime(isNum(o.q) ? o.q : 1, t0);
        g.connect(f);
        tail = f;
      }
      tail.connect(o.dest || sfxBus);
      osc.start(t0);
      osc.stop(t0 + dur + 0.06);
      return osc;
    }

    // 预生成噪声 + 滤波 + 包络
    function noise(o) {
      const t0 = isNum(o.t) ? o.t : ac.currentTime;
      const dur = isNum(o.dur) ? o.dur : 0.2;
      const src = ac.createBufferSource();
      src.buffer = noiseBuf;
      src.loop = true;
      const f = ac.createBiquadFilter();
      f.type = o.filter || 'bandpass';
      f.frequency.setValueAtTime(Math.max(20, isNum(o.f0) ? o.f0 : 900), t0);
      if (isNum(o.f1)) {
        f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t0 + dur);
      }
      f.Q.setValueAtTime(isNum(o.q) ? o.q : 1, t0);
      const g = ac.createGain();
      env(g, t0, isNum(o.gain) ? o.gain : 0.08, isNum(o.attack) ? o.attack : 0.004, dur);
      src.connect(f);
      f.connect(g);
      g.connect(o.dest || sfxBus);
      src.start(t0);
      src.stop(t0 + dur + 0.06);
      return src;
    }

    /* ================= 上下文 / 音量 ================= */

    function setNodeGain(node, v) {
      if (!node) return;
      const t = ac.currentTime;
      try {
        node.gain.cancelScheduledValues(t);
        node.gain.setValueAtTime(Math.max(0.0001, node.gain.value), t);
        node.gain.linearRampToValueAtTime(Math.max(0.0001, v), t + 0.05);
      } catch (e) { }
    }

    function refreshVolumes() {
      if (!ac) return;
      setNodeGain(master, vol.master);
      setNodeGain(sfxBus, vol.sfx);
      setNodeGain(musicBus, vol.music);
    }

    function resume() {
      if (!ac) return;
      try {
        if (ac.state === 'suspended' && ac.resume) {
          const p = ac.resume();
          if (p && p.catch) p.catch(function () { });
        }
      } catch (e) { }
    }

    // 懒创建 AudioContext，只有这里碰 window
    function ensure() {
      if (ac) return true;
      if (typeof window === 'undefined' || !window) return false;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      let ctx = null;
      try { ctx = new AC(); } catch (e) { return false; }
      ac = ctx;
      try {
        master = ac.createGain();
        master.gain.value = Math.max(0.0001, vol.master);
        master.connect(ac.destination);
        sfxBus = ac.createGain();
        sfxBus.gain.value = Math.max(0.0001, vol.sfx);
        sfxBus.connect(master);
        musicBus = ac.createGain();
        musicBus.gain.value = Math.max(0.0001, vol.music);
        musicBus.connect(master);
      } catch (e2) {
        ac = null; master = null; sfxBus = null; musicBus = null;
        return false;
      }
      try { noiseBuf = makeNoise(1.6); } catch (e3) { noiseBuf = null; }
      try {
        ac.onstatechange = function () {
          if (ac && ac.state === 'running') A.ready = true;
        };
      } catch (e4) { }
      // 浏览器要求手势后出声：平时挂一次全局解锁
      try {
        if (window.addEventListener) {
          const unlock = function () {
            if (ac && ac.state !== 'running') resume();
          };
          window.addEventListener('pointerdown', unlock);
          window.addEventListener('keydown', unlock);
          window.addEventListener('touchstart', unlock);
        }
      } catch (e5) { }
      return true;
    }

    /* ================= 音乐 ================= */

    function musicStep(st, i, t) {
      const d = st.def;
      const chord = d.chords[Math.floor(i / 8) % d.chords.length];
      const beat = i % 8;
      const barDur = (60 / d.bpm) * 8;
      if (beat === 0) {
        for (let k = 0; k < chord.length; k++) {
          tone({
            t: t, type: d.padType, f0: hz(chord[k]), dur: barDur * 0.96,
            gain: (d.padGain / (1 + k * 0.5)),
            attack: d.padAttack || 0.8,
            filter: 'lowpass', ff: d.padCut || 600, q: 0.8,
            dest: st.gain, detune: (k % 2 ? 5 : -5)
          });
        }
      }
      const n = d.seq[i];
      if (n) {
        tone({
          t: t, type: d.noteType || 'sine', f0: hz(n), dur: d.noteDur || 1.4,
          gain: (d.noteGain || 0.04) * (0.72 + Math.random() * 0.28),
          attack: 0.02, filter: 'lowpass', ff: d.noteCut || 3000, q: 0.6,
          dest: st.gain
        });
      }
      if (d.pulse && beat % d.pulse === 0) {
        tone({
          t: t, type: 'sine', f0: hz(chord[0] - 12), f1: hz(chord[0] - 12) * 0.97,
          dur: 0.3, gain: d.pulseGain || 0.06, attack: 0.012, dest: st.gain
        });
      }
      if (d.hat && (beat % 2 === 1)) {
        noise({ t: t, dur: 0.05, gain: d.hatGain || 0.018, filter: 'highpass', f0: 5200, dest: st.gain });
      }
    }

    function musicSched(st) {
      if (!ac || st.stop) return;
      const stepDur = 60 / st.def.bpm / 2;
      let guard = 0;
      while (st.next < ac.currentTime + 0.45 && guard < 64) {
        try { musicStep(st, st.step, st.next); } catch (e) { }
        st.next += stepDur;
        st.step = (st.step + 1) % st.def.len;
        guard++;
      }
      st.timer = setTimeout(function () { musicSched(st); }, 140);
    }

    function startTrack(def) {
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, ac.currentTime);
      g.connect(musicBus);
      const st = { def: def, gain: g, timer: 0, step: 0, next: ac.currentTime + 0.08, stop: false, bed: null };
      if (def.noise && noiseBuf) {
        try {
          const src = ac.createBufferSource();
          src.buffer = noiseBuf;
          src.loop = true;
          const f = ac.createBiquadFilter();
          f.type = 'lowpass';
          f.frequency.value = def.noise.cut || 400;
          f.Q.value = def.noise.q || 0.6;
          const ng = ac.createGain();
          ng.gain.value = def.noise.gain || 0.01;
          src.connect(f); f.connect(ng); ng.connect(g);
          src.start(ac.currentTime);
          st.bed = src;
        } catch (e) { }
      }
      try {
        g.gain.exponentialRampToValueAtTime(1, ac.currentTime + 1.2);
      } catch (e2) {
        g.gain.value = 1;
      }
      musicSched(st);
      return st;
    }

    function fadeOutTrack(st, fade) {
      if (!st) return;
      st.stop = true;
      if (st.timer) { clearTimeout(st.timer); st.timer = 0; }
      const t = ac.currentTime;
      try {
        st.gain.gain.cancelScheduledValues(t);
        st.gain.gain.setValueAtTime(Math.max(0.0001, st.gain.gain.value), t);
        st.gain.gain.exponentialRampToValueAtTime(0.0001, t + fade);
      } catch (e) { }
      if (st.bed) {
        try { st.bed.stop(t + fade + 0.15); } catch (e2) { }
      }
      setTimeout(function () {
        try { st.gain.disconnect(); } catch (e3) { }
      }, Math.round((fade + 0.5) * 1000));
    }

    /* ================= 音效分支 ================= */

    function playSfx(name, o) {
      const amp = (o.vol == null ? 1 : clamp01(o.vol));
      const t0 = (isNum(o.t) ? Math.max(ac.currentTime, o.t) : ac.currentTime);
      const D = sfxBus;

      switch (name) {
        case 'shoot':
          tone({ t: t0, type: 'square', f0: 920, f1: 340, dur: 0.09, gain: 0.085 * amp, attack: 0.004, filter: 'lowpass', ff: 2600, q: 1.2, dest: D });
          noise({ t: t0, dur: 0.04, gain: 0.028 * amp, filter: 'highpass', f0: 2400, dest: D });
          return true;

        case 'hit':
          tone({ t: t0, type: 'triangle', f0: 240, f1: 150, dur: 0.07, gain: 0.09 * amp, attack: 0.003, dest: D });
          noise({ t: t0, dur: 0.06, gain: 0.06 * amp, filter: 'bandpass', f0: 1500, f1: 700, q: 1.1, dest: D });
          return true;

        case 'slash':
          noise({ t: t0, dur: 0.13, gain: 0.07 * amp, filter: 'highpass', f0: 2600, f1: 900, q: 0.9, dest: D });
          tone({ t: t0, type: 'sine', f0: 760, f1: 220, dur: 0.11, gain: 0.04 * amp, attack: 0.003, dest: D });
          return true;

        case 'kill':
        case 'enemy_die':
          tone({ t: t0, type: 'sawtooth', f0: 320, f1: 70, dur: 0.22, gain: 0.075 * amp, attack: 0.004, filter: 'lowpass', ff: 1400, ff1: 500, q: 1, dest: D });
          noise({ t: t0, dur: 0.16, gain: 0.05 * amp, filter: 'lowpass', f0: 1400, f1: 300, q: 0.8, dest: D });
          return true;

        case 'explode':
          noise({ t: t0, dur: 0.55, gain: 0.18 * amp, filter: 'lowpass', f0: 1500, f1: 110, q: 0.9, dest: D });
          tone({ t: t0, type: 'sine', f0: 110, f1: 32, dur: 0.5, gain: 0.16 * amp, attack: 0.005, dest: D });
          return true;

        case 'pickup':
          tone({ t: t0, type: 'sine', f0: 660, dur: 0.07, gain: 0.07 * amp, attack: 0.003, dest: D });
          tone({ t: t0 + 0.05, type: 'sine', f0: 990, dur: 0.08, gain: 0.06 * amp, attack: 0.003, dest: D });
          return true;

        case 'gem':
          tone({ t: t0, type: 'triangle', f0: 880, dur: 0.06, gain: 0.055 * amp, attack: 0.003, dest: D });
          tone({ t: t0 + 0.045, type: 'triangle', f0: 1320, dur: 0.08, gain: 0.045 * amp, attack: 0.003, dest: D });
          return true;

        case 'levelup': {
          const seq = [523.25, 659.25, 783.99, 1046.5];
          for (let i = 0; i < seq.length; i++) {
            tone({ t: t0 + i * 0.075, type: 'triangle', f0: seq[i], dur: 0.22, gain: 0.07 * amp, attack: 0.006, filter: 'lowpass', ff: 3200, dest: D });
          }
          tone({ t: t0 + 0.3, type: 'sine', f0: 1568, dur: 0.4, gain: 0.035 * amp, attack: 0.01, dest: D });
          return true;
        }

        case 'chest':
          tone({ t: t0, type: 'triangle', f0: 1046.5, dur: 0.16, gain: 0.06 * amp, attack: 0.004, dest: D });
          tone({ t: t0, type: 'sine', f0: 1568, dur: 0.2, gain: 0.05 * amp, attack: 0.004, dest: D });
          tone({ t: t0 + 0.09, type: 'sine', f0: 2093, dur: 0.26, gain: 0.035 * amp, attack: 0.004, dest: D });
          noise({ t: t0, dur: 0.1, gain: 0.03 * amp, filter: 'bandpass', f0: 3200, q: 2, dest: D });
          return true;

        case 'evolve':
          tone({ t: t0, type: 'sawtooth', f0: 180, f1: 1440, dur: 0.85, gain: 0.06 * amp, attack: 0.02, filter: 'lowpass', ff: 600, ff1: 4800, q: 2.2, dest: D });
          tone({ t: t0 + 0.02, type: 'triangle', f0: 270, f1: 2160, dur: 0.8, gain: 0.045 * amp, attack: 0.03, dest: D });
          noise({ t: t0 + 0.1, dur: 0.7, gain: 0.035 * amp, filter: 'bandpass', f0: 500, f1: 4000, q: 1.4, dest: D });
          return true;

        case 'hurt':
          tone({ t: t0, type: 'sawtooth', f0: 190, f1: 80, dur: 0.22, gain: 0.09 * amp, attack: 0.004, filter: 'lowpass', ff: 1100, q: 1, dest: D });
          noise({ t: t0, dur: 0.16, gain: 0.05 * amp, filter: 'bandpass', f0: 900, f1: 400, q: 0.9, dest: D });
          return true;

        case 'death':
          tone({ t: t0, type: 'sawtooth', f0: 420, f1: 55, dur: 1.25, gain: 0.1 * amp, attack: 0.01, filter: 'lowpass', ff: 1600, ff1: 240, q: 1.2, dest: D });
          tone({ t: t0 + 0.05, type: 'sine', f0: 140, f1: 45, dur: 1.0, gain: 0.06 * amp, attack: 0.02, dest: D });
          noise({ t: t0, dur: 1.1, gain: 0.06 * amp, filter: 'lowpass', f0: 1200, f1: 120, q: 0.8, dest: D });
          return true;

        case 'boss':
          tone({ t: t0, type: 'sawtooth', f0: 58, dur: 1.0, gain: 0.1 * amp, attack: 0.03, filter: 'lowpass', ff: 320, q: 3, dest: D });
          tone({ t: t0, type: 'sawtooth', f0: 87, dur: 0.9, gain: 0.07 * amp, attack: 0.04, filter: 'lowpass', ff: 380, q: 2.5, dest: D });
          noise({ t: t0, dur: 0.5, gain: 0.09 * amp, filter: 'lowpass', f0: 900, f1: 160, q: 0.8, dest: D });
          return true;

        case 'boss_slam':
          tone({ t: t0, type: 'sine', f0: 90, f1: 26, dur: 0.7, gain: 0.16 * amp, attack: 0.004, dest: D });
          noise({ t: t0, dur: 0.5, gain: 0.12 * amp, filter: 'lowpass', f0: 800, f1: 90, q: 0.7, dest: D });
          return true;

        case 'boss_fan':
          for (let i = 0; i < 3; i++) {
            noise({ t: t0 + i * 0.07, dur: 0.18, gain: (0.07 - i * 0.012) * amp, filter: 'bandpass', f0: 2200 - i * 500, f1: 700, q: 1.6, dest: D });
          }
          return true;

        case 'dodge':
          noise({ t: t0, dur: 0.11, gain: 0.05 * amp, filter: 'bandpass', f0: 700, f1: 2600, q: 1.4, dest: D });
          return true;

        case 'freeze':
          tone({ t: t0, type: 'sine', f0: 2400, f1: 1800, dur: 0.4, gain: 0.045 * amp, attack: 0.01, dest: D });
          tone({ t: t0 + 0.02, type: 'triangle', f0: 3200, f1: 2200, dur: 0.35, gain: 0.03 * amp, attack: 0.01, dest: D });
          noise({ t: t0, dur: 0.3, gain: 0.03 * amp, filter: 'highpass', f0: 4000, q: 0.7, dest: D });
          return true;

        case 'heal':
          tone({ t: t0, type: 'sine', f0: 523.25, f1: 784, dur: 0.5, gain: 0.06 * amp, attack: 0.05, dest: D });
          tone({ t: t0 + 0.06, type: 'sine', f0: 659.25, f1: 988, dur: 0.45, gain: 0.04 * amp, attack: 0.06, dest: D });
          return true;

        case 'ui':
          tone({ t: t0, type: 'sine', f0: 1200, dur: 0.045, gain: 0.05 * amp, attack: 0.002, dest: D });
          return true;

        case 'ui_bad':
          tone({ t: t0, type: 'square', f0: 240, dur: 0.09, gain: 0.05 * amp, attack: 0.003, filter: 'lowpass', ff: 900, dest: D });
          tone({ t: t0 + 0.09, type: 'square', f0: 170, dur: 0.13, gain: 0.045 * amp, attack: 0.003, filter: 'lowpass', ff: 700, dest: D });
          return true;

        default:
          return false;   // 未知名字静默容错，不抛错
      }
    }

    /* ================= 对外 API ================= */

    A.init = function init() {
      try {
        if (!ac && !ensure()) return A;
        resume();
        A.ready = true;
        refreshVolumes();
        if (pendingTrack) {
          const p = pendingTrack;
          pendingTrack = 0;
          curTrack = -1;
          A.music(p);
        }
      } catch (e) { }
      return A;
    };

    A.sfx = function sfx(name, opts) {
      try {
        if (!ac) {
          A.init();
          if (!ac) return false;
        }
        if (!sfxBus) return false;
        if (typeof name !== 'string' || !name) return false;
        if (ac.state === 'suspended') resume();
        const gap = (THROTTLE[name] == null ? 0.012 : THROTTLE[name]);
        const tNow = ac.currentTime;
        if (lastAt[name] != null && tNow - lastAt[name] < gap) return false;
        lastAt[name] = tNow;
        return playSfx(name, opts || {});
      } catch (e) {
        return false;
      }
    };

    A.music = function music(track) {
      try {
        let want = Math.round(+track || 0);
        if (!TRACKS[want]) want = 0;
        pendingTrack = want;
        if (!ac) {
          if (want === 0) { curTrack = 0; pendingTrack = 0; return A; }
          A.init();
          if (!ac) { curTrack = want; return A; }
        }
        if (want === curTrack && cur) { pendingTrack = 0; return A; }
        if (ac.state === 'suspended') resume();
        if (cur) { fadeOutTrack(cur, 1.1); cur = null; }
        curTrack = want;
        pendingTrack = 0;
        if (want) cur = startTrack(TRACKS[want]);
        return A;
      } catch (e) {
        return A;
      }
    };

    A.setVolume = function setVolume(v) {
      if (!isNum(+v)) return A;
      vol.master = clamp01(v);
      refreshVolumes();
      return A;
    };

    A.setMusicVolume = function setMusicVolume(v) {
      if (!isNum(+v)) return A;
      vol.music = clamp01(v);
      refreshVolumes();
      return A;
    };

    A.setSfxVolume = function setSfxVolume(v) {
      if (!isNum(+v)) return A;
      vol.sfx = clamp01(v);
      refreshVolumes();
      return A;
    };

    // 只读探针（调试用，不影响任何行为）
    A.state = function state() {
      return {
        ready: A.ready,
        ctx: ac ? ac.state : 'none',
        track: curTrack,
        master: vol.master,
        music: vol.music,
        sfx: vol.sfx
      };
    };

    return A;
  }

  const AUDIO = build();

  if (typeof window !== 'undefined' && window) {
    const G = (window.G = window.G || {});
    G.AUDIO = AUDIO;
  } else if (typeof globalThis !== 'undefined') {
    // 非浏览器环境（自检脚本）也能拿到同一个对象
    const G = (globalThis.G = globalThis.G || {});
    G.AUDIO = AUDIO;
  }
})();
