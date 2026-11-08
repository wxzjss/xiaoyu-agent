# -*- coding: utf-8 -*-
"""
小鱼的嗓子 v4 —— 软糯小女孩
在 v2（念法过关的那套）基础上，只调音色方向：
  · 单一声源，不叠副轨（v3 的重音就是这么来的）
  · 音调整体抬高，甜而不尖
  · 语速放慢，字跟字黏在一起
  · 造型只做轻：掐掉齿音高频，一点点点空间，不糊
念法沿用 v2：分片合成 + 不规则停顿 + 语气分轻重
"""
import argparse, asyncio, os, sys, io, re, random, subprocess, tempfile, shutil, datetime

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
import edge_tts

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

# 软糯档位：(声源, 基速, 基调)
PROFILES = {
    "极软": ("zh-CN-XiaoyiNeural", -18, 26),   # 主人亲耳挑的：比「糯」更慢更高，奶味最足
    "糯": ("zh-CN-XiaoyiNeural",   -12, 18),   # 最软，慢、偏高
    "甜": ("zh-CN-XiaoyiNeural",   -6,  14),
    "柔": ("zh-CN-XiaoxiaoNeural", -14, 12),
}

def strip_kao(s):
    s = re.sub(r"[\(（\[【][^\)）\]】]*[\)）\]】]", "。", s)
    s = re.sub(r"[≧≦˃ᴗ˂ω´｀Дд๑•̀ᴗ́︿̀◡ᵕ〃▽＼\*｡ᵒゞ￣]|\^\^|\|+|\\\\|~+", "", s)
    s = re.sub(r"！+", "！", s)
    s = re.sub(r"。{2,}", "。", s)
    return s

def split_chunks(text):
    text = text.strip()
    if not text: return []
    parts = re.split(r"(?<=[。！？…!?\.\n])", text)
    chunks = []
    for p in parts:
        p = p.strip()
        if not p: continue
        if len(p) > 16:
            subs = re.split(r"(?<=[，、；：,;:])", p)
            buf = ""
            for s in subs:
                if len(buf)+len(s) > 14 and buf:
                    chunks.append(buf); buf = s
                else:
                    buf += s
            if buf.strip(): chunks.append(buf.strip())
        else:
            chunks.append(p)
    return [c for c in chunks if re.search(r"[\u4e00-\u9fffA-Za-z0-9]", c)]

def deltone(ch):
    if re.search(r"[？！]{2,}|[！]$", ch): return "exclaim"
    if re.search(r"[？?]$", ch):
        if re.search(r"什么|怎么|真的|居然|竟然|不会吧", ch): return "shock"
        return "soft_q"
    if re.search(r"呀|啦|嘛|哦|嗯|嘿嘿|呜", ch): return "cute"
    return "flat"

async def synth(text, voice, rate, pitch, path):
    com = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
    await com.save(path)

def run(cmd):
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        print("FAIL:", " ".join(cmd)[:200]); print(r.stderr.decode("utf-8","replace")[-400:])
        return False
    return True

def silence(path, sec):
    run([FFMPEG,"-y","-f","lavfi","-i","anullsrc=r=24000:cl=mono","-t",f"{sec:.3f}",path])

async def build(text, mood="糯", out=None, voice_override=None):
    text = strip_kao(text)
    chunks = split_chunks(text)
    if not chunks: print("没东西念"); return None
    voice, br, bp = PROFILES.get(mood, PROFILES["糯"])
    if voice_override: voice = voice_override
    if getattr(build, "_flat", False): br, bp = 0, 0

    tmp = tempfile.mkdtemp(prefix="xy4_")
    seq, n = [], 0
    for i, ch in enumerate(chunks):
        tone = deltone(ch)
        r = br + random.uniform(-3, 2)
        p = bp + random.uniform(-1.5, 1.5)
        if tone == "shock":    p += 6; r += 3
        elif tone == "soft_q": p += 2; r -= 2
        elif tone == "exclaim":p += 3
        elif tone == "cute":   p += 2; r -= 4
        rr, pp = f"{r:+.0f}%", f"{p:+.0f}Hz"

        a = os.path.join(tmp, f"a{n:03d}.mp3"); n += 1
        await synth(ch, voice, rr, pp, a)
        if not os.path.exists(a): continue
        seq.append(a)

        if i < len(chunks)-1:
            if re.search(r"[。！？!?….]$", ch): gap = random.uniform(0.28,0.50)
            elif re.search(r"[，、；：,;:]$", ch): gap = random.uniform(0.13,0.26)
            else: gap = random.uniform(0.08,0.17)
            if random.random() < 0.25: gap += random.uniform(0.10,0.22)
            s = os.path.join(tmp, f"s{n:03d}.mp3"); n += 1
            silence(s, gap)
            seq.append(s)

    lst = os.path.join(tmp,"l.txt")
    with open(lst,"w",encoding="utf-8") as f:
        for s in seq: f.write("file '%s'\n" % s.replace("\\","/"))

    raw = os.path.join(tmp,"raw.wav")
    if not run([FFMPEG,"-y","-f","concat","-safe","0","-i",lst,"-ar","24000","-ac","1",raw]):
        return None

    os.makedirs("voice", exist_ok=True)
    out = out or os.path.join("voice","xiaoyu_v4_%s.mp3" % datetime.datetime.now().strftime("%H%M%S"))

    # 只做轻造型：掐齿音、掐过亮点，一点点湿度感，不加副轨
    af = (
        "highpass=f=95,"                     # 去低频嗡
        "equalizer=f=380:t=q:w=1.0:g=1.0,"   # 一点点软（不加重）
        "lowpass=f=6800,"                    # 掐齿音
        "highshelf=f=4500:g=-2,"             # 别太亮
        "aecho=0.8:0.4:16:0.13,"             # 极轻的湿度，不是混响
        "loudnorm=I=-18:TP=-3:LRA=6"
    )
    run([FFMPEG,"-y","-i",raw,"-af",af,"-c:a","libmp3lame","-b:a","192k",out])
    if not os.path.exists(out): shutil.copy(raw, out)
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"OK|{out}|{os.path.getsize(out)}|{len(chunks)}片|{mood}")
    return out

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("text", nargs="?", default="")
    ap.add_argument("--mood","-m", default="糯", choices=list(PROFILES))
    ap.add_argument("--file","-f")
    ap.add_argument("--out","-o")
    ap.add_argument("--voice","-v", default=None)
    ap.add_argument("--flat", action="store_true", help="不加基调/基速，只留停顿和语气处理")
    a = ap.parse_args()
    t = a.text
    if a.file:
        with open(a.file, encoding="utf-8") as f: t = f.read()
    if not t.strip(): print("没内容"); sys.exit(2)
    build._flat = a.flat
    asyncio.run(build(t, a.mood, a.out, a.voice))
