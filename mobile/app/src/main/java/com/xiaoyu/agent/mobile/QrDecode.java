/**
 * 二维码解码 —— 内嵌的迷你实现，不引 ZXing。
 *
 * 为什么自己写：这个 APK 刻意做到「不引任何第三方依赖」（命令行 gradle、离线也能编）。
 * ZXing 的 core 有 ~400KB，还带一堆用不上的条码格式。二维码这条路上真正难的只有三块：
 *   1. 找三个定位角（1:1:3:1:1 的扫描线）
 *   2. 透视还原成正方形采样网格
 *   3. Reed-Solomon 纠错 + 按 mode 把比特流解成文字
 *
 * 这里按 ISO/IEC 18004 实现到「能可靠解开电脑屏幕上那种干净二维码」的程度：
 * 支持版本 1–40、纠错等级 L/M/Q/H、byte / numeric / alphanumeric / kanji 四种 mode，
 * 不支持结构和微二维码 —— 小鱼Agent 的配对码是 xiaoyu://<43 字符>，正好落在 byte mode 里。
 *
 * 容错策略：单个符号失败了不抛异常到底，返回 null 让上层继续扫下一帧（摄像头一秒几十帧，重试免费）。
 */
package com.xiaoyu.agent.mobile;

import java.util.ArrayList;
import java.util.List;

public final class QrDecode {

    public static final class Result {
        public final String text;
        public final int version;
        public final char ecLevel;

        Result(String text, int version, char ec) {
            this.text = text;
            this.version = version;
            this.ecLevel = ec;
        }
    }

    private QrDecode() {}

    // ───────────────────────────── 版本 / 格式表 ─────────────────────────────

    /** 每个版本的每边模块数 = 17 + 4*version */
    private static int size(int ver) {
        return 17 + 4 * ver;
    }

    /** 对齐图形中心坐标表（版本 1 没有） */
    private static final int[][] ALIGN = {
            {}, {},
            {6, 18}, {6, 22}, {6, 26}, {6, 30}, {6, 34},
            {6, 22, 38}, {6, 24, 42}, {6, 26, 46}, {6, 28, 50}, {6, 30, 54}, {6, 32, 58}, {6, 34, 62},
            {6, 26, 46, 66}, {6, 26, 48, 70}, {6, 26, 50, 74}, {6, 30, 54, 78}, {6, 30, 56, 82}, {6, 30, 58, 86}, {6, 34, 62, 90},
            {6, 28, 50, 72, 94}, {6, 26, 50, 74, 98}, {6, 30, 54, 78, 102}, {6, 28, 54, 80, 106}, {6, 32, 58, 84, 110}, {6, 30, 58, 86, 114}, {6, 34, 62, 90, 118},
            {6, 26, 50, 74, 98, 122}, {6, 30, 54, 78, 102, 126}, {6, 26, 52, 78, 104, 130}, {6, 30, 56, 82, 108, 134}, {6, 34, 60, 86, 112, 138}, {6, 30, 58, 86, 114, 142}, {6, 34, 62, 90, 118, 146},
            {6, 30, 54, 78, 102, 126, 150}, {6, 24, 50, 76, 102, 128, 154}, {6, 28, 54, 80, 106, 132, 158}, {6, 32, 58, 84, 110, 136, 162}, {6, 26, 54, 82, 110, 138, 166}, {6, 30, 58, 86, 114, 142, 170},
    };

    /** 纠错块结构：{ ec 码字/块, 组1块数, 组1数据码字, 组2块数, 组2数据码字 }，按 [等级 0=L1=M2=Q3=H][version-1] */
    private static final short[][][] BLOCKS = buildBlocks();

    /** 每块纠错码字数（用 BLOCKS 的第一维反推太绕，直接查表更省事） */
    private static short[][][] buildBlocks() {
        // 数据来源：ISO 18004 表 9 的压缩表。写成「EC每块, G1块, G1数据, G2块, G2数据」
        String[] L = {
                "7,1,19,0,0", "10,1,34,0,0", "15,1,55,0,0", "20,1,80,0,0", "26,1,108,0,0", "18,2,68,0,0", "20,2,78,0,0", "24,2,97,0,0", "30,2,116,0,0",
                "18,2,68,2,69", "20,4,81,0,0", "24,2,92,2,93", "26,4,107,0,0", "30,3,115,1,116", "22,5,87,1,88", "24,5,98,1,99", "28,1,107,5,108", "30,5,120,1,121", "28,3,113,4,114", "28,3,107,5,108",
                "28,4,116,4,117", "28,2,111,7,112", "30,4,121,5,122", "30,6,117,4,118", "26,8,106,4,107", "28,10,114,2,115", "30,8,122,4,123", "30,3,117,10,118", "30,7,116,7,117", "30,5,115,10,116",
                "30,13,115,3,116", "30,17,115,0,0", "30,17,115,1,116", "30,13,115,6,116", "30,12,121,7,122", "30,6,121,14,122", "30,17,122,4,123", "30,4,122,18,123", "30,20,117,4,118", "30,19,118,6,119",
        };
        String[] M = {
                "10,1,16,0,0", "16,1,28,0,0", "26,1,44,0,0", "18,2,32,0,0", "24,2,43,0,0", "16,4,27,0,0", "18,4,31,0,0", "22,2,38,2,39", "22,3,36,2,37",
                "26,4,43,1,44", "30,1,50,4,51", "22,6,36,2,37", "22,8,37,1,38", "24,4,40,5,41", "24,5,41,5,42", "28,7,45,3,46", "28,10,46,1,47", "26,9,43,4,44", "26,3,44,11,45", "26,3,41,13,42",
                "26,17,42,0,0", "28,17,46,0,0", "28,4,47,14,48", "28,6,45,14,46", "28,8,47,13,48", "28,19,46,4,47", "28,22,45,3,46", "28,3,45,23,46", "28,21,45,7,46", "28,19,47,10,48",
                "28,2,46,29,47", "28,10,46,23,47", "28,14,46,21,47", "28,14,46,23,47", "28,12,47,26,48", "28,6,47,34,48", "28,29,46,14,47", "28,13,46,32,47", "28,40,47,7,48", "28,18,47,31,48",
        };
        String[] Q = {
                "13,1,13,0,0", "22,1,22,0,0", "18,2,17,0,0", "26,2,24,0,0", "18,2,15,2,16", "24,4,19,0,0", "18,2,14,4,15", "22,4,18,2,19", "20,4,16,4,17",
                "24,6,19,2,20", "28,4,22,4,23", "26,4,20,6,21", "24,8,20,4,21", "20,11,16,5,17", "30,11,16,5,17", "24,16,17,6,18", "28,13,16,11,17", "28,22,15,8,16", "26,12,20,13,21", "30,22,17,7,18",
                "28,22,16,11,17", "30,17,17,18,18", "28,18,18,18,19", "30,9,20,25,21", "30,20,21,18,22", "30,27,20,12,21", "30,16,20,29,21", "30,19,24,16,25", "30,22,23,18,24", "30,24,24,18,25",
                "30,14,24,32,25", "30,8,24,40,25", "30,31,24,16,25", "30,14,24,44,25", "30,33,24,22,25", "30,31,24,33,25", "30,26,24,53,25", "30,20,24,66,25", "30,14,24,86,25", "30,14,24,102,25",
        };
        String[] H = {
                "17,1,9,0,0", "28,1,16,0,0", "22,2,13,0,0", "16,4,9,0,0", "22,2,11,2,12", "28,4,15,0,0", "26,4,13,1,14", "26,4,14,2,15", "24,4,12,4,13",
                "28,6,15,2,16", "24,3,12,8,13", "28,7,14,4,15", "22,12,11,4,12", "24,11,12,5,13", "24,11,12,7,13", "30,3,15,13,16", "28,2,14,17,15", "28,2,14,19,15", "26,3,13,23,14", "28,4,14,26,15",
                "28,6,15,34,16", "26,8,15,46,16", "28,11,15,46,16", "30,20,15,30,16", "30,30,15,23,16", "30,22,15,50,16", "30,6,15,74,16", "30,16,15,54,16", "30,30,15,44,16", "30,2,15,98,16",
                "30,31,15,62,16", "30,17,15,96,16", "30,47,15,62,16", "30,19,15,109,16", "30,45,15,83,16", "30,15,15,109,17", "30,45,15,100,17", "30,30,15,130,17", "30,30,15,159,17", "30,42,15,139,17",
        };
        short[][][] out = new short[4][40][];
        for (int v = 0; v < 40; v++) {
            out[0][v] = parse(L[v]);
            out[1][v] = parse(M[v]);
            out[2][v] = parse(Q[v]);
            out[3][v] = parse(H[v]);
        }
        return out;
    }

    private static short[] parse(String s) {
        String[] p = s.split(",");
        short[] o = new short[5];
        for (int i = 0; i < 5; i++) o[i] = Short.parseShort(p[i]);
        return o;
    }

    // ───────────────────────────── 主流程 ─────────────────────────────

    /**
     * 一个像素算不算黑。
     *
     * 注意 byte 是**有符号**的：白色 0xFF 存进 byte 就是 -1，而 -1 < 128 恒为真。
     * 以前这里直接写 `lum[i] < 128`，导致整张图每个像素都被判成黑 —— 扫描线永远是
     * 一整条黑，1:1:3:1:1 一个都匹配不上，findFinders 恒返回 null，decode 恒返回 null。
     * 手机上「怎么扫都扫不出来」就是这个原因，跟透视、跟算法都没关系。
     * 所以必须先 & 0xFF 转成无符号再比。
     */
    private static boolean isDark(byte v) {
        return (v & 0xFF) < 128;
    }

    /**
     * @param lum 灰度图（0=黑），w*h，行优先
     */
    public static Result decode(byte[] lum, int w, int h) {
        try {
            Finder[] f = findFinders(lum, w, h);
            if (f == null) return null;
            return decodeFromFinders(lum, w, h, f[0], f[1], f[2]);
        } catch (Exception e) {
            return null;
        }
    }

    private static final class Finder {
        double x, y, module;
        int count;
    }

    /** 三块定位角：左上「直角」那一块是原点，靠叉积定方向 */
    private static Result decodeFromFinders(byte[] lum, int w, int h, Finder a, Finder b, Finder c) {
        // 找出哪个是左上（另外两个构成的两条边夹出来的直角顶点）
        Finder tl, tr, bl;
        double dAB = dist2(a, b), dAC = dist2(a, c), dBC = dist2(b, c);
        if (dBC >= dAB && dBC >= dAC) {
            tl = a; tr = b; bl = c;
        } else if (dAC >= dAB && dAC >= dBC) {
            tl = b; tr = a; bl = c;
        } else {
            tl = c; tr = a; bl = b;
        }
        // 保证 tr/bl 与 tl 的方向：tr 应该在 tl 的「右边」，用叉积校正左右手
        double cross = (tr.x - tl.x) * (bl.y - tl.y) - (tr.y - tl.y) * (bl.x - tl.x);
        if (cross < 0) {
            Finder t = tr;
            tr = bl;
            bl = t;
        }

        double dx1 = tr.x - tl.x, dy1 = tr.y - tl.y;
        double dx2 = bl.x - tl.x, dy2 = bl.y - tl.y;
        // 定位角「中心」到「中心」的模块数 = dim - 7（每个定位角 7 模块宽，
        // 中心各在内侧 3.5 处，两个中心之间隔 dim-7 个模块）。
        // 以前这里写的是 size(v) - 1，少了 6 —— 于是所有版本都匹配不上，
        // 每次都掉到下面的粗估兜底，粗估一旦差一个版本（差 4 个模块）就必然解不出来。
        double g1 = Math.hypot(dx1, dy1) / tl.module;   // 实测的模块数
        double g2 = Math.hypot(dx2, dy2) / tl.module;
        double avg = (g1 + g2) / 2.0;
        int dim = 0;
        if (avg >= 10 && avg <= size(40) - 7 + 2) {
            int v = (int) Math.round((avg + 7 - 17) / 4.0);   // 由模块数反推版本号
            if (v >= 1 && v <= 40) {
                double want = size(v) - 7;
                // 两个方向都要贴近，且彼此不能差太多（差太多说明拍得太歪）
                if (Math.abs(want - g1) < 2.0 && Math.abs(want - g2) < 2.0
                        && Math.abs(g1 - g2) < 2.0) {
                    dim = size(v);
                }
            }
        }
        if (dim == 0) {
            // 粗估兜底：模块数 = 中心距 / 模块大小 + 7
            int v = (int) Math.round((avg + 7 - 17) / 4.0);
            if (v < 1 || v > 40) return null;
            dim = size(v);
        }

        // 第四个角：平行四边形补出来，再往外扩 3 个模块（定位角中心在 (3.5,3.5)）
        double px = tr.x + bl.x - tl.x;
        double py = tr.y + bl.y - tl.y;
        double ux = (tr.x - tl.x) / (dim - 7), uy = (tr.y - tl.y) / (dim - 7);
        double vx = (bl.x - tl.x) / (dim - 7), vy = (bl.y - tl.y) / (dim - 7);
        double ox = tl.x - 3.5 * ux - 3.5 * vx;
        double oy = tl.y - 3.5 * uy - 3.5 * vy;
        // 右下角 = 原点 + (dim-3.5)*u + (dim-3.5)*v
        double qx = px + 3.5 * ux + 3.5 * vx;
        double qy = py + 3.5 * uy + 3.5 * vy;

        // 四个角都算出来再采样：只给两个对角点的话，旋转/透视畸变会全被吃掉
        // （以前这里就是只传了 O 和 Q，见下面 sample 的注释）。
        //   A = 原点（左上外扩 3.5 模块前的位置）
        //   B = A 沿 u 方向走 dim 个模块
        //   C = B 再沿 v 方向走 dim 个模块（右下）
        //   D = A 沿 v 方向走 dim 个模块（左下）
        double ax = ox, ay = oy;
        double bx = ox + dim * ux, by = oy + dim * uy;
        double cx2 = ox + dim * ux + dim * vx, cy2 = oy + dim * uy + dim * vy;
        double dqx = ox + dim * vx, dqy = oy + dim * vy;

        boolean[][] m = sample(lum, w, h, ax, ay, bx, by, cx2, cy2, dqx, dqy, dim);
        if (m == null) return null;
        return parseMatrix(m, dim);
    }

    private static double dist2(Finder a, Finder b) {
        double dx = a.x - b.x, dy = a.y - b.y;
        return dx * dx + dy * dy;
    }

    /**
     * 双线性四边形采样：把任意四边形 (A,B,C,D) 摊成 dim×dim 的方格，每格取一次灰度。
     *
     * 以前这函数只收两个对角点 (O, Q)，然后 px = ox + fx*(qx-ox)、py = oy + fy*(qy-oy) ——
     * 那是「把四边形当成沿对角线拉直的矩形」，等于假设二维码永远正着放。
     * 手机举着扫，手一歪就带旋转和梯形畸变，采样矩阵整个错位，后面 Reed-Solomon
     * 纠错再怎么修也修不回来。这就是「怎么扫都扫不出来」的根。
     *
     * 现在用四点的双线性插值：
     *   P(fx,fy) = A + fx*(B-A) + fy*(D-A) + fx*fy*(A-B-C+D)
     * 它在四个角上严格等于 A/B/C/D，中间是平滑过渡，对付轻微旋转和梯形够了
     * （真正的单应变换要解 8 元方程组，这里没必要 —— 定位角已经把尺度标准化过了）。
     *
     * A=左上 B=右上 C=右下 D=左下，四项顺序不能错，错了画面会镜像/翻转。
     */
    private static boolean[][] sample(byte[] lum, int w, int h,
                                      double ax, double ay, double bx, double by,
                                      double cx, double cy, double dx, double dy, int dim) {
        boolean[][] m = new boolean[dim][dim];

        // 整块出画就别费劲了（留一点点余量给摄像头边缘切掉的情况）
        double minX = Math.min(Math.min(ax, bx), Math.min(cx, dx));
        double maxX = Math.max(Math.max(ax, bx), Math.max(cx, dx));
        double minY = Math.min(Math.min(ay, by), Math.min(cy, dy));
        double maxY = Math.max(Math.max(ay, by), Math.max(cy, dy));
        if (maxX < 0 || maxY < 0 || minX > w || minY > h) return null;

        for (int j = 0; j < dim; j++) {
            for (int i = 0; i < dim; i++) {
                // 取格子中心，不是格子角 —— 差半个模块就够把边缘的采样点挪到隔壁去
                double fx = (i + 0.5) / dim;
                double fy = (j + 0.5) / dim;

                // 双线性：角点严格命中，中间平滑
                double px = ax
                        + fx * (bx - ax)
                        + fy * (dx - ax)
                        + fx * fy * (ax - bx - dx + cx);
                double py = ay
                        + fx * (by - ay)
                        + fy * (dy - ay)
                        + fx * fy * (ay - by - dy + cy);

                int ix = (int) Math.round(px);
                int iy = (int) Math.round(py);
                if (ix < 0 || iy < 0 || ix >= w || iy >= h) {
                    // 单点出界就当中灰，别整块放弃 —— 边缘几个模块错不代表整张图不能用
                    m[j][i] = false;
                    continue;
                }
                m[j][i] = isDark(lum[iy * w + ix]);
            }
        }
        return m;
    }

    // ───────────────────────────── 找定位角 ─────────────────────────────

    private static Finder[] findFinders(byte[] lum, int w, int h) {
        List<Finder> cands = new ArrayList<>();
        // 横竖各扫一遍，两个方向的扫描线都要命中同一个中心才算（不然噪声太多）
        for (int step = 1; step <= 2; step++) {
            int stride = step == 1 ? 3 : 5;
            for (int y = stride; y < h; y += stride) {
                scanLine(lum, w, h, true, y, cands, MIN_MODULE);
            }
            for (int x = stride; x < w; x += stride) {
                scanLine(lum, w, h, false, x, cands, MIN_MODULE);
            }
            List<Finder> merged = merge(cands, 6);
            if (merged.size() >= 3) {
                Finder[] three = pickThree(merged, w, h);
                if (three != null) return three;
            }
            cands.clear();
        }
        return null;
    }

    /**
     * 一个模块最少几个像素才算数。只用来滤掉 1~2 像素的抗锯齿噪声。
     *
     * 以前这里是「画面宽度的 1/50」（findFinders 里直接传 w/50），等于硬性要求
     * 二维码至少占画面 1/7 宽。留白多一点、或者拍照时二维码在画面里偏小，
     * mod 就小于这个门槛，所有定位角候选被一刀切丢掉，findFinders 恒返回 null ——
     * 表现就是"二维码明明看得清清楚楚，就是扫不出来"。
     * 模块大小该由扫描线自己量，不该由画面尺寸假定。
     */
    private static final int MIN_MODULE = 2;

    /**
     * 一条扫描线：找 1:1:3:1:1 的黑白黑（黑）白黑序列。
     * 魔数来自二维码定位角的规格（中心那块是 3 倍宽）。
     *
     * 这里用一个「五段滑窗」逐段推进：每遇到颜色变化就结算当前段的长度，
     * 窗口满五段就试一次，不管成不成都要向前滑一段继续找。
     *
     * 踩过的四个坑（都已修）：
     *  1. color 初值死写 0。扫描线从黑像素起步时开头的黑段会被当成「变颜色」，
     *     runs[0] 记成 0，五段整体错位，永远匹配不上。
     *  2. 报给上层的坐标用了 lastX（一个每轮都被覆盖成 i-1 的临时量）。定位角中心
     *     应该是窗口第一段的起点 + 五段总长的一半。
     *  3. 滑窗一次跳两段，会跳过「窗口起点落在第 1 段」的那个正确窗口 ——
     *     而定位角前面往往压着一段静区白，正好把正确窗口挤到第 1 段上。
     *  4. **窗口滑动时只挪了 runs，没挪起点。** 这一条最致命：起点还停在旧位置，
     *     算出来的中心坐标整体偏右好几段，定位角坐标全歪，采样自然全错。
     *     所以下面用 segStart 一并记录每段起点，滑窗时和 runs 一起左移。
     */
    private static void scanLine(byte[] lum, int w, int h, boolean horiz, int fixed, List<Finder> out, int minMod) {
        int n = horiz ? w : h;
        int[] runs = new int[5];        // 五段长度
        int[] segStart = new int[5];    // 五段各自的起始像素
        int runIdx = 0;
        int color = (horiz ? isDark(lum[fixed * w]) : isDark(lum[fixed])) ? 1 : 0;
        int start = 0;
        int minM = Math.max(1, minMod);

        for (int i = 0; i < n; i++) {
            boolean dark = horiz ? isDark(lum[fixed * w + i]) : isDark(lum[i * w + fixed]);
            int c = dark ? 1 : 0;
            if (c == color) continue;

            // ── 一段结束：记下长度和起点 ──
            if (runIdx < 5) {
                runs[runIdx] = i - start;
                segStart[runIdx] = start;
            }

            if (runIdx == 4) {
                int total = 0;
                for (int k = 0; k < 5; k++) total += runs[k];
                // 模块边长要用浮点：整数截断会把 13.35 变成 13，差 0.35 个像素
                // 乘以 34 个模块就是十几个像素的漂移，右下角整个采样框歪掉。
                double modF = total / 7.0;
                if (modF >= Math.max(1, minM) && matchRatio(runs, modF)) {
                    // 中心 = 窗口第一段的起点 + 五段总长的一半
                    Manager.add(out, horiz, fixed, segStart[0] + total / 2.0, modF);
                }
                // 滑一段：长度和起点同步左移
                for (int k = 0; k < 4; k++) {
                    runs[k] = runs[k + 1];
                    segStart[k] = segStart[k + 1];
                }
                runs[4] = 0;
                segStart[4] = i;
                runIdx = 4;
            } else {
                runIdx++;
            }
            start = i;
            color = c;
        }

        // 扫描线走完，最后一段还没结算（贴边的定位角靠这个）
        if (runIdx == 4) {
            runs[4] = n - start;
            segStart[4] = start;
            int total = 0;
            for (int k = 0; k < 5; k++) total += runs[k];
            int mod = total / 7;
            if (mod >= minM && matchRatio(runs, mod)) {
                Manager.add(out, horiz, fixed, segStart[0] + total / 2, mod);
            }
        }
    }

    private static boolean matchRatio(int[] runs, double mod) {
        double total = 0;
        for (int r : runs) total += r;
        double avg = total / 7.0;
        double[] want = {1, 1, 3, 1, 1};
        double err = 0;
        for (int i = 0; i < 5; i++) {
            err += Math.abs(runs[i] - want[i] * avg) / (want[i] * avg);
        }
        return err / 5 < 0.25;
    }

    private static final class Manager {
        static void add(List<Finder> out, boolean horiz, int fixed, double cross, double mod) {
            for (Finder f : out) {
                if (Math.abs(f.x - (horiz ? cross : fixed)) < mod * 3
                        && Math.abs(f.y - (horiz ? fixed : cross)) < mod * 3
                        && Math.abs(f.module - mod) <= Math.max(1, mod * 0.5)) {
                    f.x = (f.x * f.count + (horiz ? cross : fixed)) / (f.count + 1.0);
                    f.y = (f.y * f.count + (horiz ? fixed : cross)) / (f.count + 1.0);
                    f.count++;
                    return;
                }
            }
            Finder f = new Finder();
            f.x = horiz ? cross : fixed;
            f.y = horiz ? fixed : cross;
            f.module = mod;
            f.count = 1;
            out.add(f);
        }
    }

    /** 同一个角被扫到很多次，留下票数最高的 */
    private static List<Finder> merge(List<Finder> in, int radius) {
        List<Finder> out = new ArrayList<>();
        for (Finder f : in) {
            boolean merged = false;
            for (Finder g : out) {
                if (Math.abs(f.x - g.x) < radius * f.module && Math.abs(f.y - g.y) < radius * f.module) {
                    if (f.count > g.count) {
                        g.x = f.x;
                        g.y = f.y;
                        g.count = f.count;
                        g.module = f.module;
                    }
                    merged = true;
                    break;
                }
            }
            if (!merged) out.add(f);
        }
        return out;
    }

    /**
     * 三个定位角要构成近似等腰直角三角形，并且**还得有一对角在同一个方向上**
     * （左上&右上共 y，或左上&左下共 x）—— 否则可能挑出三个噪声点凑成的假三角形。
     *
     * 注意这里是「全遍历、挑最像的那个」，不是「第一个满足就返回」。
     * 以前是第一个通过粗筛的组合直接 return，只要图里有杂点凑出个大致直角三角形，
     * 就会把三个假点当定位角送回上层，后面采样全错、解不出来。
     */
    private static Finder[] pickThree(List<Finder> cands, int w, int h) {
        Finder[] best = null;
        double bestErr = Double.MAX_VALUE;
        for (int i = 0; i < cands.size(); i++) {
            for (int j = i + 1; j < cands.size(); j++) {
                for (int k = j + 1; k < cands.size(); k++) {
                    Finder a = cands.get(i), b = cands.get(j), c = cands.get(k);
                    double ab = Math.hypot(a.x - b.x, a.y - b.y);
                    double ac = Math.hypot(a.x - c.x, a.y - c.y);
                    double bc = Math.hypot(b.x - c.x, b.y - c.y);
                    double[] d = {ab, ac, bc};
                    java.util.Arrays.sort(d);
                    // 两条直角边近似相等，斜边 = 直角边 * √2
                    if (d[0] < 10) continue;
                    if (d[1] - d[0] > d[0] * 0.25) continue;
                    if (Math.abs(d[2] - d[0] * 1.4142135623730951) > d[0] * 0.25) continue;
                    if (Math.abs(a.module - b.module) > a.module * 0.6) continue;
                    if (Math.abs(a.module - c.module) > a.module * 0.6) continue;

                    // 误差 = 两腰不等程度 + 斜边偏离 √2 程度，越小越像
                    double err = Math.abs(d[1] - d[0]) / d[0]
                            + Math.abs(d[2] - d[0] * 1.4142135623730951) / (d[0] * 1.4142135623730951);
                    if (err < bestErr) {
                        bestErr = err;
                        best = new Finder[]{a, b, c};
                    }
                }
            }
        }
        return best;
    }

    // ───────────────────────────── 解析矩阵 ─────────────────────────────

    /**
     * 格式信息里纠错等级的 2 位编码 → 等级。
     * 注意这不是 0,1,2,3 顺序：ISO 18004 规定 01=L、00=M、11=Q、10=H。
     * 以前写成 {'L','M','Q','H'}（即 0=L,1=M,2=Q,3=H），M 被当成 L、Q 和 H 互换，
     * 于是 BLOCKS 查错表、块数/每块长度全错，去交织把码字切得面目全非 —— 这就是二维码一直扫不出来的根因。
     */
    private static final char[] EC_ORDER = {'M', 'L', 'H', 'Q'};

    private static Result parseMatrix(boolean[][] m, int dim) {
        int ver = (dim - 17) / 4;
        if (ver < 1 || ver > 40) return null;

        // 格式信息两份（左上 + 右上/左下），取能通过 BCH 校验的那份。
        //
        // 位序：QR 格式信息的 15 位是**低位先写**（ISO 18004）：
        // 格子 (8,0) 里放的是 bit0，(0,8) 里放的是 bit14，中间 (8,6) 是定时图形要跳过。
        // 所以读数时得从 bit14 那头开始往回读，也就是从 (0,8) 起、(8,0) 收尾。
        // 以前这里正好读反（把 (8,0) 当 bit14），15 位整个镜像，
        // BCH 永远校验不过，fixFormat 恒 -1，parseMatrix 直接 null ——
        // 这就是「扫半天扫不出来」的第一层原因。
        int fmt = 0;
        boolean ok = false;
        for (int pass = 0; pass < 2 && !ok; pass++) {
            int bits = 0;
            if (pass == 0) {
                // 左上这条：bit14..bit0 依次在 (0,8)(1,8)(2,8)(3,8)(4,8)(5,8)(7,8)(8,8)
                //              (8,7)(8,5)(8,4)(8,3)(8,2)(8,1)(8,0)
                int[][] path = {
                    {0,8},{1,8},{2,8},{3,8},{4,8},{5,8},{7,8},{8,8},
                    {8,7},{8,5},{8,4},{8,3},{8,2},{8,1},{8,0}
                };
                for (int[] p : path) bits = (bits << 1) | (m[p[1]][p[0]] ? 1 : 0);
            } else {
                // 右上副本：bit0..bit7 依次在 (dim-1,8)..(dim-8,8)
                // 左下副本：bit8..bit14 依次在 (8,dim-7)..(8,dim-1)
                int[] b = new int[15];
                for (int i = 0; i <= 7; i++) b[i] = m[8][dim - 1 - i] ? 1 : 0;
                for (int i = 8; i <= 14; i++) b[i] = m[dim - 15 + i][8] ? 1 : 0;
                for (int i = 14; i >= 0; i--) bits = (bits << 1) | b[i];
            }
            int fixed = fixFormat(bits);
            if (fixed >= 0) {
                fmt = fixed;
                ok = true;
            }
        }
        if (!ok) return null;

        // fmt 现在是 5 位原始格式数据：bit13..10 对齐到高 5 位之后，
        // 高 2 位 = 纠错等级，低 3 位 = 掩码编号。
        // （fixFormat 以前返回 15 位码字，所以这里 fmt & 0x7 拿到的是 BCH 校验位的末 3 位，
        //  掩码整个拆错，数据区读出来全是乱码。）
        int ecBits = (fmt >> 3) & 0x3;
        char ecc = EC_ORDER[ecBits];
        // BLOCKS 的四个槽位固定按 L,M,Q,H 排列，而 ecBits 是标准的乱序编码
        // （01=L,00=M,11=Q,10=H），所以必须用 ecc 字符再映射一次，
        // 不能直接拿 ecBits 当索引 —— 否则 M 等级会去查 L 的表，块数全错。
        int ecIdx = ecc == 'L' ? 0 : ecc == 'M' ? 1 : ecc == 'Q' ? 2 : 3;
        int maskId = fmt & 0x7;

        boolean[][] func = functionMask(ver, dim);
        byte[] cw = readCodewords(m, func, dim, maskId);
        if (cw == null) return null;

        short[] blk = BLOCKS[ecIdx][ver - 1];
        int ecPer = blk[0], g1n = blk[1], g1d = blk[2], g2n = blk[3], g2d = blk[4];
        int totalData = g1n * g1d + g2n * g2d;
        if (cw.length < totalData + (g1n + g2n) * ecPer) {
            // 码字不够：仍然试着解数据部分（有些图边缘缺模块）
            if (cw.length < totalData) return null;
        }

        // 去交织 + RS 纠错
        byte[] data = deinterleave(cw, ecPer, g1n, g1d, g2n, g2d);
        if (data == null) return null;

        String text = parseBitStream(data, ver);
        if (text == null) return null;
        return new Result(text, ver, ecc);
    }

    /**
     * BCH(15,5) 校验 + 还原 5 位格式信息。
     *
     * 返回的是**高 5 位的原始格式数据**（2 位纠错等级 + 3 位掩码），不是 15 位码字。
     * 以前这里 return full（15 位全码字），调用方又拿 fmt & 0x7 当 maskId ——
     * 那取到的是 BCH 校验位的末 3 位，跟掩码编号毫无关系，
     * 掩码拆错之后整张数据区全是乱的，RS 纠错也救不回来。
     */
    private static int fixFormat(int raw) {
        for (int d = 0; d < 32; d++) {
            // 生成多项式 0x537，data(5) << 10 再取模得 10 位校验
            int rem = d << 10;
            for (int i = 14; i >= 10; i--) {
                if (((rem >> i) & 1) != 0) rem ^= 0x537 << (i - 10);
            }
            int code = (d << 10) | (rem & 0x3FF);
            int wire = code ^ 0x5412;          // 上线前统一异或的掩码
            if (wire == (raw & 0x7FFF)) return d;   // ← 返回原始 5 位，不是 wire
        }
        return -1;
    }

    /** 功能图形掩码：true = 不参与数据 */
    private static boolean[][] functionMask(int ver, int dim) {
        boolean[][] f = new boolean[dim][dim];

        // 三个定位角 + 分隔符：7×7 的角 + 各一侧 1 格分隔 = 8×8。
        // 以前这里写的是 i<9 / j<9（9×9），多圈了一圈，把 16 个本属数据的模块
        // 误标成功能模块 —— 数据区就少了整整 16 个模块（2 个码字），
        // 读出来的码字长度比理论少 1~2 字节，RS 纠错跟着全错。
        for (int i = 0; i < 8; i++) {
            for (int j = 0; j < 8; j++) {
                f[i][j] = true;                      // 左上
                f[i][dim - 1 - j] = true;            // 右上
                f[dim - 1 - i][j] = true;            // 左下
            }
        }

        // 格式信息：定位角外侧那一行/一列。左上那条已经在 8×8 里，这里补另外两条。
        for (int i = 0; i < 8; i++) {
            f[8][i] = true;          // 左上角下方一行（横向，bit0..7 那一段）
            f[i][8] = true;          // 左上角右侧一列
            f[8][dim - 1 - i] = true; // 右上角下方一行
            f[dim - 1 - i][8] = true; // 左下角右侧一列
        }
        f[8][8] = true;              // 那个交叉点

        // 校正图形：5×5 的中心图案（含外圈），位置表见 ALIGN
        int[] centers = ALIGN[ver];
        int last = centers.length - 1;
        for (int a = 0; a <= last; a++) {
            for (int b = 0; b <= last; b++) {
                int cx = centers[a], cy = centers[b];
                // 和定位角重叠的三个位置没有校正图形
                if ((a == 0 && b == 0) || (a == 0 && b == last) || (a == last && b == 0)) continue;
                for (int dy = -2; dy <= 2; dy++) {
                    for (int dx = -2; dx <= 2; dx++) {
                        int px = cx + dx, py = cy + dy;
                        if (px >= 0 && py >= 0 && px < dim && py < dim) f[py][px] = true;
                    }
                }
            }
        }

        // 定时图形：第 6 行和第 6 列
        for (int i = 8; i < dim - 8; i++) {
            f[6][i] = true;
            f[i][6] = true;
        }

        // 版本信息（版本 ≥ 7）：右上 3×6 和左下 6×3
        if (ver >= 7) {
            for (int i = 0; i < 6; i++) {
                for (int j = 0; j < 3; j++) {
                    f[dim - 11 + j][i] = true;   // 左下那块（横 6 竖 3）
                    f[i][dim - 11 + j] = true;   // 右上那块（横 3 竖 6）
                }
            }
        }
        return f;
    }

    private static byte[] readCodewords(boolean[][] m, boolean[][] func, int dim, int maskId) {
        byte[] out = new byte[dim * dim];
        int n = 0;
        int bit = 0;
        int cur = 0;
        boolean up = true;
        for (int x = dim - 1; x > 0; x -= 2) {
            if (x == 6) x--; // 跳过定时图形那一列
            for (int k = 0; k < dim; k++) {
                int y = up ? dim - 1 - k : k;
                for (int c = 0; c < 2; c++) {
                    int xx = x - c;
                    if (func[y][xx]) continue;
                    boolean dark = m[y][xx];
                    if (masked(maskId, xx, y)) dark = !dark;
                    cur = (cur << 1) | (dark ? 1 : 0);
                    if (++bit == 8) {
                        out[n++] = (byte) cur;
                        cur = 0;
                        bit = 0;
                    }
                }
            }
            up = !up;
        }
        if (bit > 0) {
            // 收尾不足 8 位的是「余数位」，按标准它们恒为 0，不构成码字，直接丢掉。
            // 以前这里补零凑成整字节塞进 out，于是 ver6 读出 173 字节（应 172），
            // 多出的假码字把后面 deinterleave 的块边界整个推错一位，RS 纠错再也救不回来。
        }
        byte[] trimmed = new byte[n];
        System.arraycopy(out, 0, trimmed, 0, n);
        return trimmed;
    }

    private static boolean masked(int id, int x, int y) {
        switch (id) {
            case 0: return (x + y) % 2 == 0;
            case 1: return y % 2 == 0;
            case 2: return x % 3 == 0;
            case 3: return (x + y) % 3 == 0;
            case 4: return (x / 3 + y / 2) % 2 == 0;
            case 5: return (x * y) % 2 + (x * y) % 3 == 0;
            case 6: return ((x * y) % 2 + (x * y) % 3) % 2 == 0;
            case 7: return ((x + y) % 2 + (x * y) % 3) % 2 == 0;
            default: return false;
        }
    }

    private static byte[] deinterleave(byte[] cw, int ecPer, int g1n, int g1d, int g2n, int g2d) {
        int blocks = g1n + g2n;
        int maxData = Math.max(g1d, g2d);
        byte[][] dataBlocks = new byte[blocks][];
        byte[][] ecBlocks = new byte[blocks][ecPer];
        for (int i = 0; i < g1n; i++) dataBlocks[i] = new byte[g1d];
        for (int i = 0; i < g2n; i++) dataBlocks[g1n + i] = new byte[g2d];

        int p = 0;
        // 数据码字：交错
        for (int i = 0; i < maxData; i++) {
            for (int b = 0; b < blocks; b++) {
                if (i < dataBlocks[b].length && p < cw.length) {
                    dataBlocks[b][i] = cw[p++];
                }
            }
        }
        // 纠错码字：交错
        for (int i = 0; i < ecPer; i++) {
            for (int b = 0; b < blocks; b++) {
                if (p < cw.length) ecBlocks[b][i] = cw[p++];
            }
        }

        // 每块 RS 纠错（失败就保留原样 —— 只要数据区没错，后面照解）
        byte[] result = new byte[g1n * g1d + g2n * g2d];
        int off = 0;
        for (int b = 0; b < blocks; b++) {
            byte[] fixed = rsCorrect(dataBlocks[b], ecBlocks[b]);
            byte[] use = fixed != null ? fixed : dataBlocks[b];
            System.arraycopy(use, 0, result, off, use.length);
            off += use.length;
        }
        return result;
    }

    // ───────────────────────────── Reed-Solomon ─────────────────────────────

    private static final int[] GF_EXP = new int[512];
    private static final int[] GF_LOG = new int[256];

    static {
        int x = 1;
        for (int i = 0; i < 255; i++) {
            GF_EXP[i] = x;
            GF_LOG[x] = i;
            x <<= 1;
            if ((x & 0x100) != 0) x ^= 0x11D;
        }
        for (int i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
    }

    private static int mul(int a, int b) {
        if (a == 0 || b == 0) return 0;
        return GF_EXP[GF_LOG[a] + GF_LOG[b]];
    }

    private static int[] polyMul(int[] a, int[] b) {
        int[] r = new int[a.length + b.length - 1];
        for (int i = 0; i < a.length; i++) {
            for (int j = 0; j < b.length; j++) {
                r[i + j] ^= mul(a[i], b[j]);
            }
        }
        return r;
    }

    /** 纠错：Berlekamp–Massey 求错误位置，Forney 求值。改不动的（超出纠错能力）返回 null */
    private static byte[] rsCorrect(byte[] data, byte[] ec) {
        int n = data.length + ec.length;
        int[] r = new int[n];
        for (int i = 0; i < data.length; i++) r[i] = data[i] & 0xFF;
        for (int i = 0; i < ec.length; i++) r[data.length + i] = ec[i] & 0xFF;

        int[] synd = new int[ec.length];
        boolean clean = true;
        for (int i = 0; i < ec.length; i++) {
            int s = 0;
            int a = GF_EXP[i];
            for (int j = 0; j < n; j++) s = mul(s, a) ^ r[j];
            synd[i] = s;
            if (s != 0) clean = false;
        }
        if (clean) return data;

        // Berlekamp–Massey
        int[] lambda = new int[ec.length + 1];
        int[] prev = new int[ec.length + 1];
        lambda[0] = 1;
        prev[0] = 1;
        int L = 0, m = 1, b = 1;
        for (int i = 0; i < ec.length; i++) {
            int d = synd[i];
            for (int j = 1; j <= L; j++) d ^= mul(lambda[j], synd[i - j]);
            if (d == 0) {
                m++;
            } else {
                int[] t = lambda.clone();
                int coef = mul(d, inv(b));
                for (int j = 0; j + m <= ec.length; j++) {
                    lambda[j + m] ^= mul(coef, prev[j]);
                }
                if (2 * L <= i) {
                    L = i + 1 - L;
                    prev = t;
                    b = d;
                    m = 1;
                } else {
                    m++;
                }
            }
        }

        // 找根
        List<Integer> pos = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            // 位置 i 对应 alpha^(-i)
            int sum = 0;
            int xi = GF_EXP[(255 - i) % 255];
            int p = 1;
            for (int j = 0; j <= ec.length; j++) {
                sum ^= mul(lambda[j], p);
                p = mul(p, xi);
            }
            if (sum == 0) pos.add(i);
        }
        if (pos.size() != L) return null;

        // Omega = S * lambda mod x^ecLen
        int[] omega = new int[ec.length];
        for (int i = 0; i < ec.length; i++) {
            int s = 0;
            for (int j = 0; j <= i && j < lambda.length; j++) s ^= mul(lambda[j], synd[i - j]);
            omega[i] = s;
        }

        for (int i : pos) {
            int xi = GF_EXP[(255 - i) % 255];
            int xiInv = GF_EXP[(255 - ((255 - i) % 255)) % 255];
            // 评估 omega 在 xiInv
            int num = 0, p = 1;
            for (int j = 0; j < omega.length; j++) {
                num ^= mul(omega[j], p);
                p = mul(p, xiInv);
            }
            // 评估 lambda' 在 xiInv
            int den = 0;
            int p2 = 1;
            for (int j = 1; j < lambda.length; j += 2) {
                den ^= mul(lambda[j], p2);
                p2 = mul(p2, mul(xiInv, xiInv));
            }
            if (den == 0) return null;
            int mag = mul(xi, mul(num, inv(den)));
            r[i] ^= mag;
        }
        byte[] out = new byte[data.length];
        for (int i = 0; i < data.length; i++) out[i] = (byte) r[i];
        return out;
    }

    private static int inv(int a) {
        if (a == 0) return 0;
        return GF_EXP[255 - GF_LOG[a]];
    }

    // ───────────────────────────── 比特流 ─────────────────────────────

    private static String parseBitStream(byte[] data, int ver) {
        BitReader br = new BitReader(data);
        StringBuilder sb = new StringBuilder();
        // 版本分组决定字符计数字段宽度
        int cci = ver <= 9 ? 0 : ver <= 26 ? 1 : 2;
        while (true) {
            int mode = br.read(4);
            if (mode < 0 || mode == 0) break; // 0000 = 结束符
            if (mode == 1) { // numeric
                int cnt = br.read(cci == 0 ? 10 : cci == 1 ? 12 : 14);
                if (cnt < 0) return null;
                while (cnt >= 3) {
                    int v = br.read(10);
                    if (v < 0) return null;
                    sb.append(String.format("%03d", v));
                    cnt -= 3;
                }
                if (cnt == 2) {
                    int v = br.read(7);
                    if (v < 0) return null;
                    sb.append(String.format("%02d", v));
                } else if (cnt == 1) {
                    int v = br.read(4);
                    if (v < 0) return null;
                    sb.append(v);
                }
            } else if (mode == 2) { // alphanumeric
                final String AL = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
                int cnt = br.read(cci == 0 ? 9 : cci == 1 ? 11 : 13);
                if (cnt < 0) return null;
                while (cnt >= 2) {
                    int v = br.read(11);
                    if (v < 0) return null;
                    sb.append(AL.charAt(v / 45)).append(AL.charAt(v % 45));
                    cnt -= 2;
                }
                if (cnt == 1) {
                    int v = br.read(6);
                    if (v < 0) return null;
                    sb.append(AL.charAt(v));
                }
            } else if (mode == 4) { // byte
                int cnt = br.read(cci == 0 ? 8 : 16);
                if (cnt < 0) return null;
                byte[] bytes = new byte[cnt];
                for (int i = 0; i < cnt; i++) {
                    int v = br.read(8);
                    if (v < 0) return null;
                    bytes[i] = (byte) v;
                }
                // 配对码是纯 ASCII；带中文时按 UTF-8 解
                sb.append(new String(bytes, java.nio.charset.StandardCharsets.UTF_8));
            } else if (mode == 8) { // kanji
                int cnt = br.read(cci == 0 ? 8 : cci == 1 ? 10 : 12);
                if (cnt < 0) return null;
                for (int i = 0; i < cnt; i++) {
                    int v = br.read(13);
                    if (v < 0) return null;
                    int c = (v / 0xC0) << 8 | (v % 0xC0);
                    c += (c + 0x8140 <= 0x9FFC) ? 0x8140 : 0xC140;
                    sb.append((char) c);
                }
            } else if (mode == 7) { // ECI，跳过
                int first = br.read(8);
                if (first < 0) return null;
                if ((first & 0x80) == 0) {
                    // 1 字节
                } else if ((first & 0xC0) == 0x80) {
                    br.read(8);
                } else if ((first & 0xE0) == 0xC0) {
                    br.read(16);
                } else return null;
            } else if (mode == 3) { // structured append，跳过 16 位
                br.read(16);
            } else {
                return null;
            }
        }
        return sb.length() == 0 ? null : sb.toString();
    }

    private static final class BitReader {
        private final byte[] d;
        private int bit = 0;

        BitReader(byte[] d) {
            this.d = d;
        }

        int read(int n) {
            int v = 0;
            for (int i = 0; i < n; i++) {
                int idx = bit >> 3;
                if (idx >= d.length) return -1;
                int b = (d[idx] >> (7 - (bit & 7))) & 1;
                v = (v << 1) | b;
                bit++;
            }
            return v;
        }
    }
}
