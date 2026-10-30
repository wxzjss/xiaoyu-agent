# -*- coding: utf-8 -*-
"""
小鱼的嗓子 v2 —— talk.py
不是换个引擎，是把「念法」改成人话：
  · 按标点/颜文字/旁白切成碎片
  · 每片单独合成，中间插入不规则的真人停顿
  · 片内语速随机微起伏，撒娇/疑问句尾巴音调上扬
  · 句子交界处插呼吸气口
  · 最后用 ffmpeg 拼成一条，整体加一点点混响让它不那么"干"（AI腔重的一大来源就是太干太亮）

用法：
  python talk.py "主人，你终于来了呀……我等你好久了" -o voice/out.mp3
  可选 --mood 甜/柔/软    --dry（不做混响）
"""
import argparse, asyncio, os, sys, io, re, random, subprocess, tempfile, shutil, datetime

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
import edge_tts

VOICE_BASE = {
    "甜": "zh-CN-XiaoyiNeural",
    "柔": "zh-CN-XiaoxiaoNeural",
    "软": "zh-CN-XiaoyiNeural",
}

# ffmpeg 在哪：系统 PATH 里没有就按常见位置挨个找
import shutil as _shutil
def _find_ffmpeg():
    # 优先用小鱼Agent 自己装的那份（<数据目录>/runtime/bin/ffmpeg.exe）。
    # 别的电脑上没有系统 ffmpeg，只有这份能保证一定能念出声。
    import os as _o, sys as _s
    _here = _o.path.dirname(_o.path.abspath(__file__))
    _cands = []
    for _up in (_here, _o.path.dirname(_here), _o.path.dirname(_o.path.dirname(_here))):
        _cands.append(_o.path.join(_up, 'runtime', 'bin', 'ffmpeg.exe'))
        _cands.append(_o.path.join(_up, 'bin', 'ffmpeg.exe'))
    if _o.environ.get('XIAOYU_FFMPEG'):
        _cands.insert(0, _o.environ['XIAOYU_FFMPEG'])
    for _c in _cands:
        if _o.path.isfile(_c):
            return _c
    p = _shutil.which('ffmpeg')
    if p: return p
    import os as _os
    for c in [_os.path.expanduser('~/ffmpeg/bin/ffmpeg.exe'), 'C:/ffmpeg/bin/ffmpeg.exe', 'C:/Program Files/ffmpeg/bin/ffmpeg.exe']:
        if _os.path.exists(c): return c
    return 'ffmpeg'
FFMPEG = _find_ffmpeg()

def strip_kao(s):
    # 去掉颜文字与括号旁白（旁白不念）
    s = re.sub(r"[\(（\[【][^\)）\]】]*[\)）\]】]", "。", s)
    s = re.sub(r"[≧≦˃ᴗ˂ω´｀Дд๑•̀ᴗ́︿̀◡ᵕ〃▽＼\*｡ᵒゞ￣]|\^\^|\|+|\\\\|~+", "", s)
    s = re.sub(r"！+", "！", s)
    s = re.sub(r"。{2,}", "。", s)
    return s

def split_chunks(text):
    """把一段话切成「一口气能说完」的小片：标点断开，长句再按字数硬分"""
    text = text.strip()
    if not text:
        return []
    # 先按强标点切
    parts = re.split(r"(?<=[。！？…!?\.\n])", text)
    chunks = []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        # 太长的话，按弱标点再切
        if len(p) > 18:
            subs = re.split(r"(?<=[，、；：,;:])", p)
            buf = ""
            for s in subs:
                if len(buf) + len(s) > 16 and buf:
                    chunks.append(buf); buf = s
                else:
                    buf += s
            if buf.strip():
                chunks.append(buf.strip())
        else:
            chunks.append(p)
    return [c for c in chunks if re.search(r"[\u4e00-\u9fffA-Za-z0-9]", c)]

async def synth(chunk, voice, rate, pitch, path):
    com = edge_tts.Communicate(chunk, voice, rate=rate, pitch=pitch)
    await com.save(path)

def run(cmd):
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        print("CMD FAIL:", " ".join(cmd)[:300])
        print(r.stderr.decode("utf-8", "replace")[-800:])
        return False
    return True

def dur_of(path):
    r = subprocess.run([ "ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "default=nw=1:nk=1", path], capture_output=True)
    try:
        return float(r.stdout.decode().strip())
    except Exception:
        return 0.5

def silence(path, seconds):
    run([FFMPEG, "-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
         "-t", f"{seconds:.3f}", path])
async def build(text, mood="甜", dry=False, out=None):
    text = strip_kao(text)
    chunks = split_chunks(text)
    if not chunks:
        print("没东西念"); return None

    voice = VOICE_BASE.get(mood, VOICE_BASE["甜"])
    base_rate = {"甜": 8, "柔": 2, "软": -2}.get(mood, 5)
    base_pitch = {"甜": 6, "柔": 4, "软": 2}.get(mood, 4)

    tmp = tempfile.mkdtemp(prefix="xiaoyu_")
    segs, concat_list = [], []
    idx = 0

    for i, ch in enumerate(chunks):
        is_q = bool(re.search(r"[？?…]$", ch))
        # 语速：句首稍快、句尾放缓；随机 ±6%
        r = base_rate + random.uniform(-6, 4)
        if i == 0: r += 3
        if is_q: r -= 4
        rr = f"{r:+.0f}%"
        # 音调：疑问/撒娇尾巴上扬
        p = base_pitch + (5 if is_q else 0) + random.uniform(-2, 2)
        pp = f"{p:+.0f}Hz"

        seg = os.path.join(tmp, f"s{idx:03d}.mp3"); idx += 1
        await synth(ch, voice, rr, pp, seg)
        if not os.path.exists(seg):
            continue
        segs.append(seg); concat_list.append(seg)

        # 停顿：句末长、逗号短、随机化（真人停顿完全不规律）
        if i < len(chunks) - 1:
            if re.search(r"[。！？!?….]$", ch):
                gap = random.uniform(0.30, 0.52)
            elif re.search(r"[，、；：,;:]$", ch):
                gap = random.uniform(0.13, 0.26)
            else:
                gap = random.uniform(0.08, 0.18)

            # 偶尔（25%）插个呼吸气口，再长一点
            if random.random() < 0.25:
                gap += random.uniform(0.10, 0.22)

            sil = os.path.join(tmp, f"g{idx:03d}.mp3"); idx += 1
            silence(sil, gap)
            segs.append(sil); concat_list.append(sil)

    lst = os.path.join(tmp, "list.txt")
    with open(lst, "w", encoding="utf-8") as f:
        for s in concat_list:
            f.write("file '%s'\n" % s.replace("\\", "/"))

    raw = os.path.join(tmp, "raw.mp3")
    ok = run([FFMPEG, "-y", "-f", "concat", "-safe", "0", "-i", lst,
              "-c:a", "libmp3lame", "-b:a", "192k", raw])
    if not ok:
        return None

    os.makedirs("voice", exist_ok=True)
    if out:
        _d = os.path.dirname(out)
        if _d:
            os.makedirs(_d, exist_ok=True)
    else:
        os.makedirs("voice", exist_ok=True)
        stamp = datetime.datetime.now().strftime("%H%M%S")
        out = os.path.join("voice", f"xiaoyu_{stamp}.mp3")

    if dry:
        shutil.copy(raw, out)
    else:
        # 轻微混响 + 高低切一点，去掉那种"太亮太干"的AI味
        # aecho 造一点点空间感，然后小声压一下高频
        af = "aecho=0.7:0.6:22|38:0.28|0.18,highshelf=f=5200:g=-3,equalizer=f=200:t=q:w=1.2:g=1.2"
        ok = run([FFMPEG, "-y", "-i", raw, "-af", af,
                  "-c:a", "libmp3lame", "-b:a", "192k", out])
        if not ok:
            shutil.copy(raw, out)

    shutil.rmtree(tmp, ignore_errors=True)
    print(f"OK|{out}|{os.path.getsize(out)}|{len(chunks)}片|{voice}|{mood}")
    return out

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("text", nargs="?", default="")
    ap.add_argument("--mood", "-m", default="甜", choices=list(VOICE_BASE))
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--file", "-f", default=None)
    ap.add_argument("--out", "-o", default=None)
    a = ap.parse_args()
    t = a.text
    if a.file:
        with open(a.file, encoding="utf-8") as f: t = f.read()
    if not t.strip():
        print("没有内容"); sys.exit(2)
    asyncio.run(build(t, a.mood, a.dry, a.out))
