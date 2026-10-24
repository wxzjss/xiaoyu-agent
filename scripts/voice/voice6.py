# -*- coding: utf-8 -*-
"""
小鱼的嗓子 v6 —— 连起来（v5 的一字一吐，去掉卡顿）
问题出在：每个字之间都插了 45ms 静音 + mp3 编码边界，听着一卡一卡。
这次改成两层：
  1) 每个字单独合成 → 拼成整句 wav
  2) 用 atempo 把整体轻微压缩，同时把字间空隙用「重叠交叉」吃掉：
     关键手法：gain 交叉淡入淡出（acrossfade）太长，改用 asetrate/atempo 并行 +
     直接把字间静音降到 5ms，并给每个字加 8ms 淡入淡出，边界就听不出来了
  3) 字内部用「连」的方式：同一个短语的字，先合成短语、再叠字（避免纯拼接）
"""
import argparse, asyncio, os, sys, io, re, random, subprocess, tempfile, shutil, datetime

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
import edge_tts

# ffmpeg 在哪：系统 PATH 里没有就按常见位置挨个找
import shutil as _shutil
def _find_ffmpeg():
    p = _shutil.which('ffmpeg')
    if p: return p
    import os as _os
    for c in [_os.path.expanduser('~/ffmpeg/bin/ffmpeg.exe'), 'C:/ffmpeg/bin/ffmpeg.exe', 'C:/Program Files/ffmpeg/bin/ffmpeg.exe']:
        if _os.path.exists(c): return c
    return 'ffmpeg'
FFMPEG = _find_ffmpeg()
VOICE = "zh-CN-XiaoyiNeural"

def strip_kao(s):
    s = re.sub(r"[\(（\[【][^\)）\]】]*[\)）\]】]", "。", s)
    s = re.sub(r"[≧≦˃ᴗ˂ω´｀Дд๑•̀ᴗ́︿̀◡ᵕ〃▽＼\*｡ᵒゞ￣]|\^\^|\|+|\\\\|~+", "", s)
    s = re.sub(r"！+", "！", s)
    s = re.sub(r"。{2,}", "。", s)
    return s

def phrases(text):
    """切成一口气短语：标点断开，短语内部是连着的字"""
    parts = re.split(r"([。！？…!?\.，、；：,;:\n])", text)
    out, buf = [], ""
    for p in parts:
        if re.fullmatch(r"[。！？…!?\.，、；：,;:\n]", p or ""):
            if buf.strip():
                out.append((buf.strip(), p))
            buf = ""
        else:
            buf += p or ""
    if buf.strip():
        out.append((buf.strip(), "。"))
    return out

async def synth(text, rate, pitch, path, voice=None):
    com = edge_tts.Communicate(text, voice or VOICE, rate=rate, pitch=pitch)
    await com.save(path)

def run(cmd):
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        print("FAIL:", " ".join(cmd)[:250]); print(r.stderr.decode("utf-8","replace")[-500:])
        return False
    return True

def dur_of(path):
    r = subprocess.run(["ffprobe","-v","error","-show_entries","format=duration",
                        "-of","default=nw=1:nk=1", path], capture_output=True)
    try: return float(r.stdout.decode().strip())
    except: return 0.4

async def build(text, rate=-16, pitch=20, out=None, voice_override=None):
    text = strip_kao(text)
    ph = phrases(text)
    if not ph: print("没东西念"); return None

    tmp = tempfile.mkdtemp(prefix="xy6_")
    pieces, n = [], 0

    V = voice_override or VOICE
    for i, (p, punct) in enumerate(ph):
        # 短语整体念，字跟字天然就是连的
        r = rate + random.uniform(-3, 3)
        pp = pitch + random.uniform(-1.5, 1.5)
        if re.search(r"[？?]", punct):
            pp += 2; r -= 2
        if re.search(r"[！!]", punct):
            pp += 3

        a = os.path.join(tmp, f"p{n:03d}.mp3"); n += 1
        await synth(p, f"{r:+.0f}%", f"{pp:+.0f}Hz", a, V)
        if not os.path.exists(a): continue

        # 每个短语首尾各 12ms 淡入淡出，边界就听不出来
        f = os.path.join(tmp, f"f{n:03d}.wav"); n += 1
        run([FFMPEG,"-y","-i",a,"-ar","24000","-ac","1",
             "-af","afade=t=in:st=0:d=0.012,areverse,afade=t=in:st=0:d=0.012,areverse", f])
        if not os.path.exists(f): f = a
        pieces.append(f)

        # 停顿：只在这几处喘气，字与字之间完全不留
        if re.search(r"[。！？…!?\.]", punct):  gap = random.uniform(0.20, 0.34)
        elif re.search(r"[，、；：,;:]", punct): gap = random.uniform(0.09, 0.16)
        else: gap = 0.0
        if gap > 0:
            s = os.path.join(tmp, f"s{n:03d}.wav"); n += 1
            run([FFMPEG,"-y","-f","lavfi","-i","anullsrc=r=24000:cl=mono",
                 "-t", f"{gap:.3f}", s])
            pieces.append(s)

    lst = os.path.join(tmp,"l.txt")
    with open(lst,"w",encoding="utf-8") as f:
        for s in pieces: f.write("file '%s'\n" % s.replace("\\","/"))

    raw = os.path.join(tmp,"raw.wav")
    if not run([FFMPEG,"-y","-f","concat","-safe","0","-i",lst,"-ar","24000","-ac","1",raw]):
        return None

    os.makedirs("voice", exist_ok=True)
    out = out or os.path.join("voice","xiaoyu_v6_%s.mp3" % datetime.datetime.now().strftime("%H%M%S"))

    af = (
        "highpass=f=95,"
        "equalizer=f=380:t=q:w=1.0:g=1.2,"
        "lowpass=f=6600,"
        "highshelf=f=4300:g=-2,"
        "aecho=0.8:0.4:15:0.12,"
        "loudnorm=I=-18:TP=-3:LRA=6"
    )
    run([FFMPEG,"-y","-i",raw,"-af",af,"-c:a","libmp3lame","-b:a","192k",out])
    if not os.path.exists(out): shutil.copy(raw, out)
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"OK|{out}|{os.path.getsize(out)}|{len(ph)}短语")
    return out

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("text", nargs="?", default="")
    ap.add_argument("--rate","-r", type=int, default=-16)
    ap.add_argument("--pitch","-p", type=int, default=20)
    ap.add_argument("--file","-f")
    ap.add_argument("--out","-o")
    ap.add_argument("--voice","-v", default=None)
    a = ap.parse_args()
    t = a.text
    if a.file:
        with open(a.file, encoding="utf-8") as f: t = f.read()
    if not t.strip(): print("没内容"); sys.exit(2)
    asyncio.run(build(t, a.rate, a.pitch, a.out, a.voice))
