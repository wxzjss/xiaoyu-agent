/* ============================================================
 * 鲸落·深渊 —— 核心层（画笔 / 烘焙 / 输入 / 相机 / 工具）
 * 本文件只提供底层设施，不含任何玩法逻辑。
 * ============================================================ */
(function () {
  'use strict';
  const G = (window.G = window.G || {});
  G.ART = G.ART || {};
  G.WEAPONS = G.WEAPONS || [];
  G.ENEMIES = G.ENEMIES || [];
  G.PASSIVES = G.PASSIVES || [];

  /* ========== 颜色工具 ========== */
  function hex2rgb(h) {
    if (typeof h !== 'string') return [255, 255, 255];
    h = h.trim();
    if (h[0] === '#') {
      if (h.length === 4) return [parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16), parseInt(h[3] + h[3], 16)];
      return [parseInt(h.substr(1, 2), 16), parseInt(h.substr(3, 2), 16), parseInt(h.substr(5, 2), 16)];
    }
    const m = h.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const p = m[1].split(',').map(Number);
      return [p[0] | 0, p[1] | 0, p[2] | 0];
    }
    return [255, 255, 255];
  }
  function withAlpha(c, a) {
    const [r, g, b] = hex2rgb(c);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }
  function shade(c, k) {
    const [r, g, b] = hex2rgb(c);
    const f = (v) => Math.max(0, Math.min(255, Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k)));
    return 'rgb(' + f(r) + ',' + f(g) + ',' + f(b) + ')';
  }
  G.hex2rgb = hex2rgb;
  G.withAlpha = withAlpha;
  G.shade = shade;

  /* ========== 画笔 Px ========== */
  class Px {
    constructor(w, h) {
      this.w = Math.max(1, w | 0);
      this.h = Math.max(1, h | 0);
      this.cv = document.createElement('canvas');
      this.cv.width = this.w;
      this.cv.height = this.h;
      this.ctx = this.cv.getContext('2d');
      this.ctx.imageSmoothingEnabled = false;
      this._c = null;
    }
    _fill(c) {
      if (c !== undefined && c !== null) {
        if (c !== this._c) {
          this.ctx.fillStyle = c;
          this._c = c;
        }
        return true;
      }
      return this._c !== null;
    }
    px(x, y, c) {
      if (!this._fill(c)) return this;
      this.ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
      return this;
    }
    rect(x, y, w, h, c) {
      if (!this._fill(c)) return this;
      this.ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
      return this;
    }
    line(x0, y0, x1, y1, c) {
      if (!this._fill(c)) return this;
      x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
      let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
      let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      for (let i = 0; i < 4000; i++) {
        this.ctx.fillRect(x0, y0, 1, 1);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
      return this;
    }
    circle(cx, cy, r, c) {
      if (!this._fill(c)) return this;
      cx = Math.round(cx); cy = Math.round(cy); r = Math.max(0, Math.round(r));
      for (let dy = -r; dy <= r; dy++) {
        const k = r * r - dy * dy;
        if (k < 0) continue;
        const dx = Math.floor(Math.sqrt(k));
        this.ctx.fillRect(cx - dx, cy + dy, dx * 2 + 1, 1);
      }
      return this;
    }
    disc(cx, cy, r, c) { return this.circle(cx, cy, r, c); }
    ring(cx, cy, r, c) {
      if (!this._fill(c)) return this;
      cx = Math.round(cx); cy = Math.round(cy); r = Math.max(1, Math.round(r));
      let x = r, y = 0, err = 1 - r;
      while (x >= y) {
        this.ctx.fillRect(cx + x, cy + y, 1, 1);
        this.ctx.fillRect(cx + y, cy + x, 1, 1);
        this.ctx.fillRect(cx - y, cy + x, 1, 1);
        this.ctx.fillRect(cx - x, cy + y, 1, 1);
        this.ctx.fillRect(cx - x, cy - y, 1, 1);
        this.ctx.fillRect(cx - y, cy - x, 1, 1);
        this.ctx.fillRect(cx + y, cy - x, 1, 1);
        this.ctx.fillRect(cx + x, cy - y, 1, 1);
        y++;
        if (err < 0) err += 2 * y + 1;
        else { x--; err += 2 * (y - x) + 1; }
      }
      return this;
    }
    ellipse(cx, cy, rx, ry, c) {
      if (!this._fill(c)) return this;
      cx = Math.round(cx); cy = Math.round(cy);
      rx = Math.max(0, rx); ry = Math.max(1, ry);
      for (let dy = -Math.ceil(ry); dy <= Math.ceil(ry); dy++) {
        const k = 1 - (dy * dy) / (ry * ry);
        if (k < 0) continue;
        const dx = Math.floor(rx * Math.sqrt(k));
        this.ctx.fillRect(cx - dx, cy + dy, dx * 2 + 1, 1);
      }
      return this;
    }
    tri(x0, y0, x1, y1, x2, y2, c) {
      return this.poly([[x0, y0], [x1, y1], [x2, y2]], c);
    }
    poly(pts, c) {
      if (!this._fill(c) || !pts || pts.length < 3) return this;
      let minY = Infinity, maxY = -Infinity;
      for (const p of pts) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
      minY = Math.floor(minY); maxY = Math.ceil(maxY);
      const xs = [];
      for (let y = minY; y <= maxY; y++) {
        xs.length = 0;
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i], b = pts[(i + 1) % pts.length];
          if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
            xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
          }
        }
        xs.sort((p, q) => p - q);
        for (let i = 0; i + 1 < xs.length; i += 2) {
          const x0 = Math.round(xs[i]), x1 = Math.round(xs[i + 1]);
          if (x1 >= x0) this.ctx.fillRect(x0, y, x1 - x0 + 1, 1);
        }
      }
      return this;
    }
    glow(cx, cy, r, c) {
      const g = this.ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, r));
      g.addColorStop(0, withAlpha(c, 0.9));
      g.addColorStop(0.45, withAlpha(c, 0.45));
      g.addColorStop(1, withAlpha(c, 0));
      const old = this.ctx.fillStyle;
      this.ctx.fillStyle = g;
      this.ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
      this.ctx.fillStyle = old;
      this._c = null;
      return this;
    }
    outline(c) {
      const W = this.w, H = this.h;
      const ctx = this.ctx;
      const img = ctx.getImageData(0, 0, W, H);
      const d = img.data;
      const solid = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) solid[i] = d[i * 4 + 3] > 8 ? 1 : 0;
      const rgb = hex2rgb(c);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          if (solid[i]) continue;
          let near = 0;
          if (x > 0 && solid[i - 1]) near = 1;
          else if (x < W - 1 && solid[i + 1]) near = 1;
          else if (y > 0 && solid[i - W]) near = 1;
          else if (y < H - 1 && solid[i + W]) near = 1;
          if (near) {
            d[i * 4] = rgb[0];
            d[i * 4 + 1] = rgb[1];
            d[i * 4 + 2] = rgb[2];
            d[i * 4 + 3] = 255;
          }
        }
      }
      ctx.putImageData(img, 0, 0);
      this._c = null;
      return this;
    }
    noise(x, y, w, h, colors, seed, density) {
      let s = (seed || 1) * 9301 + 49297;
      const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
      density = density == null ? 0.35 : density;
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          if (rnd() < density) this.px(x + i, y + j, colors[(rnd() * colors.length) | 0]);
        }
      }
      return this;
    }
    get(x, y) {
      const d = this.ctx.getImageData(x, y, 1, 1).data;
      return d[3] < 8 ? null : 'rgb(' + d[0] + ',' + d[1] + ',' + d[2] + ')';
    }
  }
  G.Px = Px;

  /* ========== 预烘焙 ========== */
  G.BAKED = {};
  G.bakeArt = function () {
    G.BAKED = {};
    let n = 0;
    for (const id in G.ART) {
      const def = G.ART[id];
      if (!def || !def.draw) continue;
      const fr = Math.max(1, def.frames | 0 || 1);
      const list = [];
      for (let f = 0; f < fr; f++) {
        const p = new Px(def.w | 0 || 8, def.h | 0 || 8);
        try { def.draw(p, f); } catch (e) { console.warn('[art] ' + id + ' 第 ' + f + ' 帧画挂了', e); }
        list.push(p.cv);
      }
      G.BAKED[id] = {
        w: def.w | 0 || 8, h: def.h | 0 || 8,
        frames: list,
        ax: def.ax !== undefined ? def.ax : (def.w | 0 || 8) / 2,
        ay: def.ay !== undefined ? def.ay : (def.h | 0 || 8) / 2,
      };
      n++;
    }
    console.log('[art] 烘焙完成 ' + n + ' 个精灵');
    return n;
  };

  /* 画精灵。opt: {f, flip, ax, ay, scale, alpha, rot, tint} */
  G.drawArt = function (ctx, id, x, y, opt) {
    const a = G.BAKED[id];
    if (!a || !a.frames.length) return false;
    const o = opt || {};
    const f = o.f == null ? 0 : (Math.abs(o.f | 0) % a.frames.length);
    const cv = a.frames[f];
    const ax = o.ax != null ? o.ax : a.ax;
    const ay = o.ay != null ? o.ay : a.ay;
    const px = Math.round(x), py = Math.round(y);
    if (!o.flip && !o.scale && !o.rot && o.alpha == null) {
      ctx.drawImage(cv, px - Math.round(ax), py - Math.round(ay));
      return true;
    }
    ctx.save();
    ctx.translate(px, py);
    if (o.rot) ctx.rotate(o.rot);
    if (o.scale) ctx.scale(o.flip ? -o.scale : o.scale, o.scale);
    else if (o.flip) ctx.scale(-1, 1);
    if (o.alpha != null) ctx.globalAlpha = o.alpha;
    ctx.drawImage(cv, -Math.round(ax), -Math.round(ay));
    ctx.restore();
    return true;
  };

  /* ========== 画布 ============ */
  G.W = 640;
  G.H = 360;

  G.initCanvas = function () {
    G.cv = document.getElementById('game');
    G.uctxEl = document.getElementById('ui');
    G.ctx = G.cv.getContext('2d', { alpha: false });
    G.ctx.imageSmoothingEnabled = false;
    G.uctx = G.uctxEl.getContext('2d');
    G.cv.width = G.W;
    G.cv.height = G.H;
    G.resize();
    window.addEventListener('resize', G.resize);
  };

  G.viewScale = 1;
  G.viewOffX = 0;
  G.viewOffY = 0;

  G.resize = function () {
    const dw = window.innerWidth, dh = window.innerHeight;
    let s = Math.min(dw / G.W, dh / G.H);
    // 尽量取整，画质更锐利
    if (s >= 1) s = Math.floor(s * 2) / 2;
    if (s <= 0) s = 0.5;
    const cw = Math.round(G.W * s), ch = Math.round(G.H * s);
    G.viewScale = s;
    G.viewOffX = Math.round((dw - cw) / 2);
    G.viewOffY = Math.round((dh - ch) / 2);
    G.cv.style.width = cw + 'px';
    G.cv.style.height = ch + 'px';
    G.cv.style.left = G.viewOffX + 'px';
    G.cv.style.top = G.viewOffY + 'px';

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    G.uctxEl.width = Math.round(dw * dpr);
    G.uctxEl.height = Math.round(dh * dpr);
    G.uctxEl.style.width = dw + 'px';
    G.uctxEl.style.height = dh + 'px';
    G.uctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    G.uctx.imageSmoothingEnabled = true;
    G.uiW = dw;
    G.uiH = dh;
    if (G.onResize) G.onResize(dw, dh);
  };

  /* 屏幕坐标 -> 逻辑坐标 */
  G.toLogic = function (sx, sy) {
    return { x: (sx - G.viewOffX) / G.viewScale, y: (sy - G.viewOffY) / G.viewScale };
  };

  /* ========== 输入 ========== */
  const keys = Object.create(null);      // 按住
  const pressed = Object.create(null);   // 本帧刚按下
  const released = Object.create(null);
  G.keys = keys;
  G.pressed = pressed;
  G.released = released;
  G.mouse = { x: G.W / 2, y: G.H / 2, down: false, clicked: false, wx: 0, wy: 0 };
  G.anyKeyThisFrame = false;

  const KEYMAP = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
    Space: 'ok', Enter: 'ok', KeyJ: 'ok',
    Escape: 'esc', KeyP: 'esc',
    ShiftLeft: 'dash', ShiftRight: 'dash', KeyK: 'dash', KeyL: 'dash',
    Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4', Digit5: '5',
    KeyR: 'r', KeyM: 'm', KeyQ: 'q', KeyE: 'e', KeyF: 'f', Tab: 'tab',
  };

  G.setupInput = function () {
    window.addEventListener('keydown', (ev) => {
      const k = KEYMAP[ev.code] || ev.key.toLowerCase();
      if (!keys[k]) pressed[k] = true;
      keys[k] = true;
      G.anyKeyThisFrame = true;
      if (['up', 'down', 'left', 'right', 'ok', 'esc', 'tab'].includes(k)) ev.preventDefault();
    });
    window.addEventListener('keyup', (ev) => {
      const k = KEYMAP[ev.code] || ev.key.toLowerCase();
      keys[k] = false;
      released[k] = true;
    });
    window.addEventListener('blur', () => {
      for (const k in keys) keys[k] = false;
    });

    const moveMouse = (ev) => {
      const lg = G.toLogic(ev.clientX, ev.clientY);
      G.mouse.x = lg.x; G.mouse.y = lg.y;
      G.mouse.sx = ev.clientX; G.mouse.sy = ev.clientY;
      G.anyKeyThisFrame = true;
    };
    window.addEventListener('mousemove', moveMouse);
    window.addEventListener('mousedown', (ev) => {
      if (ev.button === 0) { G.mouse.down = true; G.mouse.clicked = true; }
      moveMouse(ev);
    });
    window.addEventListener('mouseup', (ev) => { if (ev.button === 0) G.mouse.down = false; });
    window.addEventListener('contextmenu', (ev) => ev.preventDefault());

    // 触屏：虚拟摇杆
    G.touch = { active: false, jx: 0, jy: 0, ox: 0, oy: 0, id: null };
    const startTouch = (ev) => {
      G.anyKeyThisFrame = true;
      for (const t of ev.changedTouches) {
        if (G.touch.id === null) {
          G.touch.id = t.identifier;
          G.touch.ox = t.clientX; G.touch.oy = t.clientY;
          G.touch.active = true;
          G.touch.jx = 0; G.touch.jy = 0;
        }
      }
    };
    const moveTouch = (ev) => {
      for (const t of ev.changedTouches) {
        if (t.identifier === G.touch.id) {
          let dx = t.clientX - G.touch.ox, dy = t.clientY - G.touch.oy;
          const d = Math.hypot(dx, dy), max = 60;
          if (d > max) { dx = dx / d * max; dy = dy / d * max; G.touch.ox = t.clientX - dx; G.touch.oy = t.clientY - dy; }
          G.touch.jx = dx / max; G.touch.jy = dy / max;
        }
      }
    };
    const endTouch = (ev) => {
      for (const t of ev.changedTouches) {
        if (t.identifier === G.touch.id) {
          G.touch.id = null; G.touch.active = false; G.touch.jx = 0; G.touch.jy = 0;
        }
      }
    };
    window.addEventListener('touchstart', startTouch, { passive: true });
    window.addEventListener('touchmove', moveTouch, { passive: true });
    window.addEventListener('touchend', endTouch, { passive: true });
    window.addEventListener('touchcancel', endTouch, { passive: true });

    // 手柄
    G.pad = { x: 0, y: 0, ok: false, dash: false, esc: false };
  };

  G.pollGamepad = function () {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let px = 0, py = 0, ok = false, dash = false, esc = false;
    for (const gp of pads) {
      if (!gp || !gp.connected) continue;
      const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
      if (Math.abs(ax) > 0.2) px = ax;
      if (Math.abs(ay) > 0.2) py = ay;
      if (gp.buttons[0] && gp.buttons[0].pressed) ok = true;
      if (gp.buttons[1] && gp.buttons[1].pressed) dash = true;
      if (gp.buttons[9] && gp.buttons[9].pressed) esc = true;
    }
    const p = G.pad;
    if ((p.x === 0 && px !== 0) || (p.y === 0 && py !== 0) || (p.ok === false && ok)) {
      if (px || py || ok) G.anyKeyThisFrame = true;
    }
    p.x = px; p.y = py; p.ok = ok; p.dash = dash; p.esc = esc;
  };

  /* 取移动向量（已归一化） */
  G.moveVec = function () {
    let x = 0, y = 0;
    if (keys.left) x -= 1;
    if (keys.right) x += 1;
    if (keys.up) y -= 1;
    if (keys.down) y += 1;
    if (G.touch.active) { x += G.touch.jx; y += G.touch.jy; }
    if (G.pad.x || G.pad.y) { x += G.pad.x; y += G.pad.y; }
    const d = Math.hypot(x, y);
    if (d > 1) { x /= d; y /= d; }
    return { x, y, len: Math.min(1, d) };
  };

  G.endFrameInput = function () {
    for (const k in pressed) delete pressed[k];
    for (const k in released) delete released[k];
    G.mouse.clicked = false;
    G.anyKeyThisFrame = false;
  };

  /* ========== 相机 ========== */
  G.camera = {
    x: G.W / 2,
    y: G.H / 2,
    shake: 0,
    shakeT: 0,
    sx: 0,
    sy: 0,
    follow(tx, ty, dt, lerp) {
      const k = 1 - Math.pow(1 - (lerp == null ? 0.18 : lerp), dt * 60);
      this.x += (tx - this.x) * k;
      this.y += (ty - this.y) * k;
    },
    kick(amp, time) {
      this.shake = Math.max(this.shake, amp);
      this.shakeT = Math.max(this.shakeT, time == null ? 0.18 : time);
    },
    update(dt) {
      if (this.shakeT > 0) {
        this.shakeT -= dt;
        const k = Math.max(0, this.shakeT);
        const a = this.shake * Math.min(1, k * 5);
        this.sx = (Math.random() * 2 - 1) * a;
        this.sy = (Math.random() * 2 - 1) * a;
        if (this.shakeT <= 0) { this.shake = 0; this.sx = 0; this.sy = 0; }
      } else { this.sx = 0; this.sy = 0; }
    },
    apply(ctx) {
      ctx.translate(
        Math.round(-this.x + G.W / 2 + this.sx),
        Math.round(-this.y + G.H / 2 + this.sy)
      );
    },
    screenToWorld(sx, sy) {
      return { x: sx + this.x - G.W / 2 - this.sx, y: sy + this.y - G.H / 2 - this.sy };
    },
    worldToScreen(wx, wy) {
      return { x: wx - this.x + G.W / 2 + this.sx, y: wy - this.y + G.H / 2 + this.sy };
    },
    inView(wx, wy, m) {
      m = m == null ? 40 : m;
      return Math.abs(wx - this.x) < G.W / 2 + m && Math.abs(wy - this.y) < G.H / 2 + m;
    },
  };

  /* ========== 数学工具 ========== */
  G.rand = (a, b) => (b == null ? Math.random() * a : a + Math.random() * (b - a));
  G.randi = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
  G.pick = (arr) => arr[(Math.random() * arr.length) | 0];
  G.clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  G.lerp = (a, b, t) => a + (b - a) * t;
  G.dist = (x0, y0, x1, y1) => Math.hypot(x1 - x0, y1 - y0);
  G.angle = (x0, y0, x1, y1) => Math.atan2(y1 - y0, x1 - x0);
  G.chance = (p) => Math.random() < p;
  G.wrapAngle = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
  G.easeOut = (t) => 1 - Math.pow(1 - t, 3);
  G.easeIn = (t) => t * t * t;

  /* ========== 存储 ========== */
  const SAVE_KEY = 'abyss_fall_save_v1';
  G.loadSave = function () {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  };
  G.writeSave = function (obj) {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(obj)); return true; }
    catch (e) { return false; }
  };
  G.clearSave = function () {
    try { localStorage.removeItem(SAVE_KEY); } catch (e) { }
  };

  /* ========== 小工具：圆角矩形 / 文字 ========== */
  G.roundRect = function (ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  };

  // 带描边的文字（UI 层用，清晰字体）
  G.text = function (ctx, str, x, y, opt) {
    const o = opt || {};
    ctx.save();
    ctx.font = (o.bold ? '700 ' : '') + (o.size || 14) + 'px "Microsoft YaHei","PingFang SC",sans-serif';
    ctx.textAlign = o.align || 'left';
    ctx.textBaseline = o.baseline || 'alphabetic';
    if (o.outline) {
      ctx.lineWidth = o.outlineWidth || 3;
      ctx.strokeStyle = o.outline;
      ctx.lineJoin = 'round';
      ctx.strokeText(str, x, y);
    }
    ctx.fillStyle = o.color || '#fff';
    if (o.alpha != null) ctx.globalAlpha = o.alpha;
    ctx.fillText(str, x, y);
    ctx.restore();
  };

  G.measureText = function (ctx, str, size, bold) {
    ctx.save();
    ctx.font = (bold ? '700 ' : '') + size + 'px "Microsoft YaHei","PingFang SC",sans-serif';
    const w = ctx.measureText(str).width;
    ctx.restore();
    return w;
  };

  /* ========== 简单发光（逻辑层） ========== */
  G.glowCircle = function (ctx, x, y, r, color, alpha) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, withAlpha(color, alpha == null ? 0.55 : alpha));
    g.addColorStop(0.5, withAlpha(color, (alpha == null ? 0.55 : alpha) * 0.4));
    g.addColorStop(1, withAlpha(color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    if (typeof ctx.fillStyle === 'string' && ctx.fillStyle.indexOf('rgba') === 0) ctx.fillStyle = '#fff';
  };

  console.log('[core] 就绪');
})();
