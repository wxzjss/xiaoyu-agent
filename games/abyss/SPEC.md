# 项目：鲸落·深渊（ABYSS FALL）— 像素风 Roguelike 割草

## 0. 铁律（先读这段）

1. **纯浏览器端**，Canvas 2D。不许用 `import` / `export` / `type="module"`，不许用 npm 包、不许联网、不许加载外部图片字体。
   **所有美术都由代码画**（像素点 / 矩形 / 多边形），所有音效都由 Web Audio 现场合成。
2. **不要用 ES5 老写法硬凑**，可以用 `const/let/class/箭头函数/模板字符串/可选链`。但**不要用顶层 `await`**。
3. 每个文件只往全局 `window.G` 上挂东西，**不许覆盖别人挂的东西**。
4. 你的文件**必须能通过 `node --check <你的文件>`**。写完自己跑一遍，不过就修。
5. **只改分配给你的文件**。不要碰 `src/00-core.js`、`src/40-game.js`、`src/50-ui.js`、`build.mjs`、`SPEC.md`。

## 1. 分辨率与像素风

- 逻辑分辨率固定 **640 × 360**（16:9），运行时整数倍放大到窗口（2x / 3x / 4x），
  `ctx.imageSmoothingEnabled = false`。
- 所以：所有坐标单位是"逻辑像素"，一个精灵 12×12 就是屏幕上很小一只。**别画大**。
- 视角：**斜俯视（top-down 略斜）**，就是《吸血鬼幸存者》那种，地面是平面俯视图，
  角色和怪物都画**正面/朝下**的立绘，上下移动靠 Y 轴。

## 2. 统一调色板（**必须用这套颜色**，画面才统一）

```
K0 #05070d  最深底
K1 #0b1020  深底
K2 #141d33  暗蓝
K3 #1e2c4a  深蓝
K4 #2b4066  中蓝
K5 #3f6394  蓝
K6 #5b93c9  亮蓝
K7 #8fd4f0  浅蓝
K8 #cdf1ff  冰蓝
W  #ffffff  白
Y1 #ffe6a3  淡金
Y2 #ffc84a  金
O1 #ff9a3c  橙
R1 #ff5a6e  红
R2 #b02a45  深红
M1 #ff6ec7  品红
P1 #b06cff  紫
P2 #5b2e8f  深紫
G1 #6ee7a0  绿
G2 #2ee6c8  青绿
B1 #a2673f  棕
B2 #5c3a24  深棕
S1 #7b8aa3  灰
S2 #3b4657  深灰
```

> 允许在这些颜色基础上做 `rgba()` 半透明叠加，但**主色不许跑偏**（不要画成粉红泡泡世界）。

## 3. 画笔 API：`G.Px`

这是核心。画像素就用它，**不要直接操作 `ctx.fillRect`**（因为要做预烘焙，直接画 ctx 会丢）。

```js
class Px {
  constructor(w, h)         // 新建一块 w×h 的画布
  px(x, y, c)               // 画一个像素点
  rect(x, y, w, h, c)       // 实心矩形
  line(x0, y0, x1, y1, c)   // 直线（Bresenham）
  circle(cx, cy, r, c)      // 实心圆（整数光栅化）
  ring(cx, cy, r, c)        // 空心圆环（1px 粗）
  ellipse(cx, cy, rx, ry, c)// 实心椭圆
  tri(x0,y0, x1,y1, x2,y2, c)
  poly(pts, c)              // 实心多边形，pts = [[x,y],[x,y],...]
  disc(cx, cy, r, c)        // 同 circle，但边缘带一级降透明（更圆润）
  glow(cx, cy, r, c)        // 柔光：中心到边缘 alpha 渐渐变 0（用 ctx 渐变）
  outline(w, h, c)          // 给不透明区域描 1px 外描边（用于统一暗描边）
  noise(x, y, w, h, colors, seed, density)  // 随机点阵质感
}
```

坐标都是整数，超出边界的点自动裁掉、不报错。

## 4. 你要交的东西长什么样

### 4.1 美术文件（`src/10-art-char.js` / `src/11-art-fx.js`）

往 `G.ART` 上挂精灵。**每个精灵一个对象**：

```js
G.ART['jelly'] = {
  w: 12, h: 12,        // 画布尺寸（逻辑像素）
  frames: 2,           // 帧数，默认 1。引擎会按 8fps 循环播放
  ax: 6, ay: 6,        // 锚点（脚底中心/身体中心），默认 w/2, h/2
  draw(p, f) {
    // p 是 Px 画笔，f 是当前帧号 0..frames-1
    // 在这里画。左上角是 (0,0)
  }
};
```

引擎会预烘焙成离屏画布，运行时只负责 blit。**`draw()` 里不许有随机性依赖外部状态**（可用固定的 `Math.random` 但每次重开游戏重烘一次，也行——但最好用固定值，画面才稳定）。

**统一风格要求（非常重要）：**
- 每只怪都要有 **1px 深色描边**（用 `K0`），才能从深色地面里"跳"出来。
- 主体用 2~3 档明暗（暗部 + 主色 + 高光）。
- 眼睛用 `W` 或 `Y2` 点 1~2 个像素，**有眼睛才可怕/可爱**。
- 不要写文字、不要用外部字体。
- 底部可加一点点 `rgba(0,0,0,0.25)` 的椭圆影子（引擎也会画，但你自己加的更贴合）。
- 每个精灵**朝下（面朝观众）**画；引擎需要时会水平翻转。

### 4.2 武器文件（`src/20-weapons.js`）

```js
G.WEAPONS.push({
  id: 'harpoon',            // 唯一 id
  name: '鱼叉',              // 显示名（中文，2~4 字）
  desc: '朝最近的敌人投出鱼叉，穿透 2 个。',  // 一句话描述
  icon: 'w_harpoon',        // G.ART 里的图标 id（16×16）
  rarity: 1,                // 1 普通 / 2 稀有 / 3 传说（影响出卡权重）
  maxLv: 8,
  evo: { need: 'p_power', with: 'harpoon_evo' },  // 见 4.5 进化
  // 每一级的属性（数组长度 = maxLv，索引 0 对应 Lv1）
  levels: [
    { dmg: 12, cd: 0.9, speed: 340, pierce: 2, count: 1 },
    ...
  ],
  // 开火逻辑：引擎每帧在武器冷却好了的时候调用 tie 一次
  fire(self, lv, api) { ... },
  // 可选：每帧调用（光环类、持续类武器用）
  tick(self, lv, api, dt) { ... },
  // 可选：敌人被打中时的额外效果
  onHit(self, lv, enemy, api) { ... }
});
```

`api` 是引擎给的"手"，见第 5 节。

### 4.3 敌人文件（`src/21-enemies.js`）

```js
G.ENEMIES.push({
  id: 'jelly',
  name: '幽光水母',
  art: 'jelly',            // G.ART 里的精灵 id
  hp: 18,                   // 基础血量（引擎会按时间缩放）
  speed: 28,                // 像素/秒
  dmg: 6,                   // 撞到玩家伤害
  xp: 2,                    // 掉落经验
  r: 5,                     // 碰撞半径
  tier: 1,                  // 1 杂兵 / 2 精英 / 3 Boss
  minWave: 0,               // 第几波（分钟）开始出现
  weight: 10,               // 随机权重
  hpMul: 1, speedMul: 1, dmgMul: 1,  // 个体随机倍率（0.9~1.1 之类）
  behavior: (e, api, dt) => { ... },  // 每帧 AI
  onDeath(e, api) { ... },            // 可选
  onSpawn(e, api) { ... }             // 可选
});
```

### 4.4 被动道具（`src/22-passives.js`）

```js
G.PASSIVES.push({
  id: 'p_power',
  name: '鲸骨护符',
  desc: '伤害 +12%',
  icon: 'i_power',          // 16×16 图标
  rarity: 1,
  maxLv: 5,
  apply(p, lv) { p.mul.dmg += 0.12; },   // 每次升级加一次（累加式）
  // 注意：apply 是"再叠一层"，不是重算。所以 Lv3 会调 3 次。
});
```

### 4.5 音效文件（`src/30-audio.js`）

```js
G.AUDIO = {
  init(),                  // 首次用户点击后调用一次，创建 AudioContext
  sfx(name, opts),         // name: 见下面清单
  music(stage),            // stage: 0/1/2/3，切背景音乐（0 = 关）
  setVolume(master),       // 0..1
  ready: false
};
```

必须支持的 sfx 名：
`shoot, hit, kill, explode, pickup, gem, levelup, chest, evolve, hurt, death, boss, dodge, freeze, heal, ui, ui_bad`

音乐要求：3 段（`stage 1/2/3`），用振荡器 + 滤波 + 噪声做的**深海氛围 loop**，能无缝循环，音量别吵。

### 4.6 图标（`src/11-art-fx.js` 里一起做）

`w_harpoon` 之类武器图标、`i_power` 之类被动图标，统一 **16×16**，暗底 + 亮物体，一眼能认出是什么。

## 5. 引擎给 `fire/tick/behavior` 的 `api`（契约！）

**所有 API 只能通过传进来的 `api` 对象用，不许直接摸 `window` 里的游戏内部变量。**

### 5.1 读状态

```js
api.t          // 已经过了多少秒（局内时间）
api.dt         // 这一帧的秒数
api.player     // { x, y, vx, vy, hp, maxHp, r, stats, facing, hurtT }
api.enemies    // 活着的敌人数组（不要修改，只读）
api.projectiles// 子弹数组（不要修改）
api.mul        // 玩家属性倍率对象 { dmg, area, speed, cd, amount, duration, magnet, ... }
```

### 5.2 动手（都用这些，别自己 push）

```js
api.spawnBullet({ x, y, vx, vy, dmg, r, life, pierce, art, color, trail, homing, onHit, knock, crit, scale })
api.spawnEnemy(id, x, y, opts)   // 用敌人 id 生成；opts 可覆盖 hp/speed 等
api.explode(x, y, radius, dmg, opts)  // 范围伤害 + 特效
api.ring(x, y, radius, color, life)   // 纯特效圈
api.slash(x, y, angle, len, width, color, life) // 近战扇形特效
api.particle(x, y, { vx, vy, life, color, r, gravity, fade })
api.damage(enemy, amount, opts)   // 直接对某个敌人造成伤害（会走暴击/加成）
api.heal(amount)
api.shake(amount)                 // 屏幕震动强度（像素）
api.hitstop(seconds)              // 顿帧
api.flash(x, y, r, color)         // 一次性闪光
api.sfx(name)
api.text(x, y, str, color)        // 飘字
api.nearestEnemy(x, y, maxDist)   // 返回最近的敌人，没有返回 null
api.randomEnemyInRange(x, y, range) // 随机一个范围内的
api.enemiesInRange(x, y, range)   // 数组
api.setBuff(key, value, seconds)  // 临时增益，如 setBuff('invuln', 1, 2)
api.rnd(a, b)                     // 随机小数
api.rndi(a, b)                    // 随机整数（含两端）
api.pick(arr)                     // 随机取一个
```

### 5.3 敌人 behavior 里的 `e`

```js
e.x, e.y, e.vx, e.vy, e.hp, e.maxHp, e.r, e.t   // t = 这怪出生到现在几秒
e.def                // 敌人定义
e.state              // 你自己用的状态对象（随便塞）
e.flash              // 被打中后的白闪计时，只读
e.setVel(x, y)       // 设置速度（像素/秒）
e.moveTo(tx, ty, speed)
e.distToPlayer()     // 到玩家距离
e.angleToPlayer()    // 弧度
```

> 不给 `e.x += ...` 之外的移动 API 也没关系：**直接改 `e.vx / e.vy` 就是移动**。
> 引擎会做 `e.x += e.vx * dt`。速度单位是"像素/秒"。

## 6. 现有目录

```
games/abyss/
  SPEC.md             ← 你正在读的
  src/00-core.js      ← 引擎（别人写，别动）
  src/10-art-char.js  ← 【A 负责】主角 + 全部敌人精灵
  src/11-art-fx.js    ← 【B 负责】Boss + 道具 + 场景装饰 + 武器/被动图标
  src/20-weapons.js   ← 【C 负责】全部武器
  src/21-enemies.js   ← 【D 负责】全部敌人逻辑
  src/22-passives.js  ← 【E 负责】全部被动道具
  src/30-audio.js     ← 【F 负责】音效 + 音乐
  src/40-game.js      ← 主逻辑（别人写，别动）
  src/50-ui.js        ← 界面（别人写，别动）
  build.mjs           ← 打包（别人写，别动）
```
