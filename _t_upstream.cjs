import sys, json
sys.path.insert(0, r"C:\Users\35453\AppData\Roaming\小鱼Agent\data\sandbox\mini_ds")
import mini_ds as M

tok = M.read_token()
print("TOKEN:", tok[:12], "...", len(tok))
c = M.DSClient(tok)
sid = c.create_session()
print("SESSION:", sid)
for kind, text in c.chat_stream(sid, "回复两个字：成功", thinking=False):
    print("KIND:", kind, "TEXT:", repr(text[:60]))
print("DONE")
