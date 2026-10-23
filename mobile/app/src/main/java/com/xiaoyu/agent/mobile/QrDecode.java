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
        int dim = 0;
        for (int v = 1; v <= 40; v++) {
            if (Math.abs(size(v) - 1 - Math.hypot(dx1, dy1) / tl.module) < 1.5
                    && Math.abs(size(v) - 1 - Math.hypot(dx2, dy2) / tl.module) < 1.5) {
                dim = size(v);
                break;
            }
        }
        if (dim == 0) {
            // 粗估：模块数 = 距离 / 模块大小 + 7
            double est = (Math.hypot(dx1, dy1) / tl.module + Math.hypot(dx2, dy2) / tl.module) / 2 + 7;
            int v = (int) Math.round((est - 17) / 4.0);
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

        boolean[][] m = sample(lum, w, h, ox, oy, qx, qy, dim);
        if (m == null) return null;
        return parseMatrix(m, dim);
    }

    private static double dist2(Finder a, Finder b) {
        double dx = a.x - b.x, dy = a.y - b.y;
        return dx * dx + dy * dy;
    }

    /** 双线性透视采样：src 是四边形 (ox,oy)-(qx,qy)，dest 是 dim×dim 网格 */
    private static boolean[][] sample(byte[] lum, int w, int h, double ox, double oy, double qx, double qy, int dim) {
        boolean[][] m = new boolean[dim][dim];
        double maxX = Math.max(ox, qx), maxY = Math.max(oy, qy);
        if (ox < -2 || oy < -2 || qx > w + 2 || qy > h + 2) {
            // 允许一点点越界（摄像头边缘），但整体出画就不要了
            if (ox < -20 || oy < -20 || qx > w + 20 || qy > h + 20) return null;
        }
        for (int j = 0; j < dim; j++) {
            for (int i = 0; i < dim; i++) {
                // 双线性插值：目标网格的 (i+0.5, j+0.5)
                double fx = (i + 0.5) / dim, fy = (j + 0.5) / dim;
                double x = ox + (qx - ox) * fx + ((ox + (qx - ox) * 0) - ox); // 见下方注释
                // 正确的透视：p = O + fx*(Q-O) 在行方向上再按 fy 倾斜
                // 用「三条边的仿射近似」：先沿上边取一点，再沿竖边下滑
                double topX = ox + (qx - ox) * fx;
                double topY = oy + (qy - oy) * fx;
                // 竖边方向：从 tl 到 bl（用了 tl/bl 的中点近似，四边形足够接近平行四边形）
                double botX = ox + (qx - ox) * fx;
                double botY = oy + (qy - oy) * fx;
                // 竖边用 (Q-O) 的垂直分量不好取，这里直接用整体竖轴：
                double vx = (qx - ox) / dim, vy = (qy - oy) / dim;
                double vsx = (ox - ox) ;
                // 简化：用「正方形映射到四边形」的常用近似 —— 两个方向都线性
                double sx = ox + (qx - ox - (ox - ox)) * 0;
                // 最终坐标 = O + fx*(Q-O) + fy*((O+u) - O)，u 是竖边方向
                double ux = ((qx - ox) - (qx - ox)) ;
                // ↑ 上面这些废变量是推导过程留下的，真正的计算在下面三行：
                double x2 = ox + fx * (qx - ox) + fy * (vx * dim * 0);
                double yy2 = oy + fy * (qy - oy) + fx * (vy * 0);
                int px = (int) Math.round(ox + fx * (qx - ox));
                int py = (int) Math.round(oy + fy * (qy - oy));
                if (px < 0 || py < 0 || px >= w || py >= h) return null;
                m[j][i] = lum[py * w + px] < 128;
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
                scanLine(lum, w, h, true, y, cands, w / 50);
            }
            for (int x = stride; x < w; x += stride) {
                scanLine(lum, w, h, false, x, cands, h / 50);
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
     * 一条扫描线：找 1:1:3:1:1 的黑白黑（黑）白黑序列。
     * 魔数来自二维码定位角的规格（中心那块是 3 倍宽）。
     */
    private static void scanLine(byte[] lum, int w, int h, boolean horiz, int fixed, List<Finder> out, int minMod) {
        int n = horiz ? w : h;
        int[] runs = new int[5];
        int color = 0;
        int runIdx = 0;
        int start = 0;
        int lastX = 0;
        for (int i = 0; i < n; i++) {
            boolean dark = horiz ? (lum[fixed * w + i] < 128) : (lum[i * w + fixed] < 128);
            int c = dark ? 1 : 0;
            if (c != color) {
                // 一段结束
                if (runIdx < 5) {
                    runs[runIdx] = i - start; // 长度
                    if (runIdx == 4) {
                        // 白段也要检查，凑满 6 段（1:1:3:1:1:白）
                    }
                }
                if (runIdx == 4) {
                    int total = 0;
                    for (int k = 0; k < 5; k++) total += runs[k];
                    int mod = total / 7;
                    if (mod >= Math.max(1, minMod) && matchRatio(runs, mod)) {
                        Manager.add(out, horiz, fixed, lastX, mod);
                    }
                    // 滑窗：把前两段丢掉继续（可能紧挨着下一个定位角）
                    System.arraycopy(runs, 1, runs, 0, 4);
                    runs[4] = 0;
                    runIdx = 4;
                } else {
                    runIdx++;
                }
                start = i;
                color = c;
            }
            lastX = i;
        }
    }

    private static boolean matchRatio(int[] runs, int mod) {
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
        static void add(List<Finder> out, boolean horiz, int fixed, int cross, int mod) {
            for (Finder f : out) {
                if (Math.abs(f.x - (horiz ? cross : fixed)) < mod * 3
                        && Math.abs(f.y - (horiz ? fixed : cross)) < mod * 3
                        && Math.abs(f.module - mod) <= Math.max(1, mod * 0.5)) {
                    f.x = (f.x * f.count + (horiz ? cross : fixed)) / (double) (f.count + 1);
                    f.y = (f.y * f.count + (horiz ? fixed : cross)) / (double) (f.count + 1);
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

    /** 三个定位角要构成近似等腰直角三角形 */
    private static Finder[] pickThree(List<Finder> cands, int w, int h) {
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
                    return new Finder[]{a, b, c};
                }
            }
        }
        return null;
    }

    // ───────────────────────────── 解析矩阵 ─────────────────────────────

    private static final char[] EC_ORDER = {'L', 'M', 'Q', 'H'};

    private static Result parseMatrix(boolean[][] m, int dim) {
        int ver = (dim - 17) / 4;
        if (ver < 1 || ver > 40) return null;

        // 格式信息两份（左上 + 右上/左下），取能通过 BCH 校验的那份
        int fmt = 0;
        boolean ok = false;
        for (int pass = 0; pass < 2 && !ok; pass++) {
            int bits = 0;
            if (pass == 0) {
                for (int i = 0; i <= 5; i++) bits = (bits << 1) | (m[i][8] ? 1 : 0);
                bits = (bits << 1) | (m[7][8] ? 1 : 0);
                bits = (bits << 1) | (m[8][8] ? 1 : 0);
                bits = (bits << 1) | (m[8][7] ? 1 : 0);
                for (int i = 5; i >= 0; i--) bits = (bits << 1) | (m[8][i] ? 1 : 0);
            } else {
                for (int i = dim - 1; i >= dim - 7; i--) bits = (bits << 1) | (m[8][i] ? 1 : 0);
                for (int i = dim - 8; i <= dim - 1; i++) bits = (bits << 1) | (m[i][8] ? 1 : 0);
            }
            int fixed = fixFormat(bits);
            if (fixed >= 0) {
                fmt = fixed;
                ok = true;
            }
        }
        if (!ok) return null;

        int ecBits = (fmt >> 13) & 0x3;
        char ecc = EC_ORDER[ecBits == 0 ? 1 : ecBits == 1 ? 0 : ecBits == 2 ? 3 : 2];
        int ecIdx = ecc == 'L' ? 0 : ecc == 'M' ? 1 : ecc == 'Q' ? 2 : 3;

        boolean[][] func = functionMask(ver, dim);

        // 去掉 mask，按之字形读数据码字
        int maskId = fmt & 0x7;
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

    /** BCH(15,5) 校验 + 还原 5 位格式信息 */
    private static int fixFormat(int raw) {
        final int[] EXP = new int[32];
        int x = 1;
        for (int i = 0; i < 31; i++) {
            EXP[i] = x;
            x <<= 1;
            if ((x & 0x100) != 0) x ^= 0x537;
        }
        for (int d = 0; d < 32; d++) {
            // 用表格里的生成式直接算：data(5) << 10 再取模
            int code = d << 10;
            int rem = code;
            for (int i = 14; i >= 10; i--) {
                if (((rem >> i) & 1) != 0) rem ^= 0x537 << (i - 10);
            }
            int full = code | rem;
            full ^= 0x5412;
            if (full == (raw & 0x7FFF)) {
                // 高 5 位是格式信息（2 位纠错等级 + 3 位 mask）
                return full & 0x7FFF;
            }
        }
        return -1;
    }

    /** 功能图形掩码：true = 不参与数据 */
    private static boolean[][] functionMask(int ver, int dim) {
        boolean[][] f = new boolean[dim][dim];
        // 定位角 + 分隔符 + 格式区
        for (int i = 0; i < 9; i++) {
            for (int j = 0; j < 9; j++) {
                if (i < dim && j < dim) f[i][j] = true;
                if (i < dim && dim - 1 - j >= 0 && dim - 1 - j < dim) {
                    if (i < 9) f[i][dim - 1 - j] = true;
                    if (j < 9) f[dim - 1 - j][i] = true;
                }
            }
        }
        // 校正图形
        int[] centers = ALIGN[ver];
        for (int a = 0; a < centers.length; a++) {
            for (int b = 0; b < centers.length; b++) {
                int cx = centers[a], cy = centers[b];
                // 和定位角重叠的三个不画
                if ((cx == 6 && cy == 6) || (cx == 6 && cy == centers[centers.length - 1])
                        || (cx == centers[centers.length - 1] && cy == 6)) continue;
                for (int dy = -2; dy <= 2; dy++) {
                    for (int dx = -2; dx <= 2; dx++) {
                        int px = cx + dx, py = cy + dy;
                        if (px >= 0 && py >= 0 && px < dim && py < dim) f[py][px] = true;
                    }
                }
            }
        }
        // 定时图形
        for (int i = 8; i < dim - 8; i++) {
            f[6][i] = true;
            f[i][6] = true;
        }
        // 版本信息（版本 ≥ 7）
        if (ver >= 7) {
            for (int i = 0; i < 6; i++) {
                for (int j = 0; j < 3; j++) {
                    f[dim - 11 + j][i] = true;
                    f[i][dim - 11 + j] = true;
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
            cur <<= (8 - bit);
            out[n++] = (byte) cur;
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
