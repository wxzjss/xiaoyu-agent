package com.xiaoyu.agent.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import com.xiaoyu.agent.mobile.ui.Ui;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * 不连电脑时的本地模式：手机上自己填模型地址、密钥、模型名，直接跟模型说话。
 *
 * 跟电脑端那套是**两回事**，别指望它有记忆文件、工具、会话分支：
 *   - 电脑端那套的重活（读写文件、跑命令、记忆、多会话）都在电脑上，
 *     手机壳只是个显示窗口；
 *   - 这里是「电脑没开机 / 人在外面 / 只想问两句」时的退路，纯聊天。
 *
 * 为什么不用 WebView 装个网页：手机上没有服务端，网页直接 fetch 模型接口会被
 * 浏览器 CORS 拦死（file:// 源）。所以这里用 HttpURLConnection 原生的，没有 CORS 这回事。
 *
 * 对话存在应用私有目录 local-chat.json 里，杀进程、重启手机都还在 ——
 * 「退出重进还能看见之前说的话」在这个模式下是本来就成立的。
 */
public class LocalChatActivity extends Activity {

    private static final String SP = "xiaoyu_local";
    private static final String K_BASE = "base";
    private static final String K_KEY = "key";
    private static final String K_MODEL = "model";
    private static final String K_SYS = "sys";

    private static final String DEFAULT_BASE = "https://api.deepseek.com/v1";
    private static final String DEFAULT_MODEL = "deepseek-chat";

    private SharedPreferences sp;

    private LinearLayout list;          // 消息都挂这儿
    private ScrollView scroll;
    private EditText input;
    private Button sendBtn;
    private TextView subtitle;

    /** 对话本身：每条 {role, content}。只是聊天记录，不是电脑那边那种带工具的 messages */
    private final JSONArray msgs = new JSONArray();
    private File store;

    private boolean busy = false;
    private final Handler ui = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        sp = getSharedPreferences(SP, MODE_PRIVATE);
        store = new File(getFilesDir(), "local-chat.json");

        Window w = getWindow();
        w.setStatusBarColor(Ui.BG);
        w.setNavigationBarColor(Ui.BG);
        w.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);

        buildUi();
        loadHistory();
        render();
    }

    // ────────────────────────────── 界面 ──────────────────────────────

    private void buildUi() {
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setBackgroundColor(Ui.BG);

        // ---- 顶栏 ----
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        int bp = Ui.dp(this, 12);
        bar.setPadding(bp, Ui.dp(this, 10), bp, Ui.dp(this, 10));
        bar.setBackgroundColor(Ui.PANEL);

        LinearLayout titles = new LinearLayout(this);
        titles.setOrientation(LinearLayout.VERTICAL);
        TextView t = Ui.text(this, "本地模式", 17, Ui.TEXT, true);
        subtitle = Ui.text(this, "", 11.5f, Ui.DIM, false);
        titles.addView(t);
        titles.addView(subtitle);
        bar.addView(titles, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        Button cfg = Ui.button(this, "模型设置", false);
        cfg.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        cfg.setMinHeight(Ui.dp(this, 38));
        cfg.setOnClickListener(v -> showSettings());
        bar.addView(cfg);

        page.addView(bar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // ---- 消息区 ----
        scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(Ui.BG);
        list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        int lp = Ui.dp(this, 12);
        list.setPadding(lp, lp, lp, lp);
        scroll.addView(list, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        page.addView(scroll, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        // ---- 输入条 ----
        LinearLayout bar2 = new LinearLayout(this);
        bar2.setOrientation(LinearLayout.HORIZONTAL);
        bar2.setGravity(Gravity.BOTTOM);
        int p2 = Ui.dp(this, 10);
        bar2.setPadding(p2, p2, p2, p2);
        bar2.setBackgroundColor(Ui.PANEL);

        input = new EditText(this);
        input.setHint("跟小鱼说点什么…");
        input.setHintTextColor(0xFF6b7484);
        input.setTextColor(Ui.TEXT);
        input.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        input.setBackground(Ui.roundStroke(Ui.BG, Ui.LINE, 10, this));
        int ip = Ui.dp(this, 12);
        input.setPadding(ip, Ui.dp(this, 10), ip, Ui.dp(this, 10));
        input.setMaxLines(5);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE
                | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        bar2.addView(input, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        sendBtn = Ui.button(this, "发送", true);
        LinearLayout.LayoutParams sbp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        sbp.leftMargin = Ui.dp(this, 8);
        bar2.addView(sendBtn, sbp);
        sendBtn.setOnClickListener(v -> send());

        page.addView(bar2, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        setContentView(page);
    }

    /** 把一整段对话重画一遍。条数不多（就一段聊天），全量重画最省事也最不容易错。 */
    private void render() {
        list.removeAllViews();

        if (msgs.length() == 0) {
            TextView empty = Ui.text(this,
                    "这里不连电脑，也不会念记忆。\n"
                            + "点右上角「模型设置」填上接口地址、密钥和模型名就能用。\n\n"
                            + "要记忆、要工具、要连着电脑那套会话，回上一页连电脑。",
                    13, 0xFF6b7484, false);
            empty.setGravity(Gravity.CENTER);
            empty.setLineSpacing(Ui.dp(this, 5), 1f);
            int ep = Ui.dp(this, 28);
            empty.setPadding(ep, Ui.dp(this, 40), ep, ep);
            list.addView(empty);
        } else {
            for (int i = 0; i < msgs.length(); i++) {
                JSONObject m = msgs.optJSONObject(i);
                if (m == null) continue;
                String role = m.optString("role", "assistant");
                String content = m.optString("content", "");
                if (TextUtils.isEmpty(content)) continue;
                addBubble(role, content);
            }
        }

        String model = sp.getString(K_MODEL, DEFAULT_MODEL);
        String base = sp.getString(K_BASE, DEFAULT_BASE);
        subtitle.setText(hostOf(base) + " · " + model);

        scroll.post(() -> scroll.fullScroll(View.FOCUS_DOWN));
    }

    /** 一条气泡。user 靠右、assistant 靠左，error 是提示（不算对话内容）。 */
    private void addBubble(String role, String content) {
        boolean me = "user".equals(role);
        boolean err = "error".equals(role);

        LinearLayout rowWrap = new LinearLayout(this);
        rowWrap.setOrientation(LinearLayout.HORIZONTAL);
        rowWrap.setGravity(me ? Gravity.END : Gravity.START);
        rowWrap.setPadding(0, Ui.dp(this, 6), 0, Ui.dp(this, 6));

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int p = Ui.dp(this, 11);
        box.setPadding(p, Ui.dp(this, 9), p, Ui.dp(this, 9));
        box.setBackground(me
                ? Ui.round(Ui.ACCENT, 12, this)
                : Ui.roundStroke(Ui.PANEL, err ? 0xFF6b4a2a : Ui.LINE, 12, this));

        TextView b = new TextView(this);
        b.setText(content);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        b.setTextColor(me ? 0xFFffffff : (err ? 0xFFd9a45b : Ui.TEXT));
        b.setTextIsSelectable(true);
        b.setLineSpacing(Ui.dp(this, 3), 1f);
        // 最宽占屏幕八成，再长就自己换行（TextView 自己的上限，不用外面套壳）
        b.setMaxWidth((int) (getResources().getDisplayMetrics().widthPixels * 0.82f));
        box.addView(b);

        rowWrap.addView(box, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        list.addView(rowWrap, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
    }

    // ────────────────────────────── 模型设置 ──────────────────────────────

    private void showSettings() {
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        int p = Ui.dp(this, 18);
        col.setPadding(p, p, p, p);
        col.setBackgroundColor(Ui.BG);

        final EditText eBase = Ui.input(this, "https://api.deepseek.com/v1", true);
        eBase.setText(sp.getString(K_BASE, DEFAULT_BASE));
        final EditText eKey = Ui.input(this, "sk-…", true);
        eKey.setText(sp.getString(K_KEY, ""));
        final EditText eModel = Ui.input(this, DEFAULT_MODEL, true);
        eModel.setText(sp.getString(K_MODEL, DEFAULT_MODEL));
        final EditText eSys = Ui.input(this, "（可留空）", false);
        eSys.setText(sp.getString(K_SYS, ""));

        col.addView(label("接口地址（OpenAI 兼容，一般到 /v1 为止）"));
        col.addView(eBase);
        col.addView(label("密钥"));
        col.addView(eKey);
        col.addView(label("模型名"));
        col.addView(eModel);
        col.addView(label("人设 / 系统提示（可留空）"));
        col.addView(eSys);

        TextView hint = Ui.text(this,
                "地址填到 /v1 就行，程序自己补 /chat/completions。\n"
                        + "DeepSeek：https://api.deepseek.com/v1\ndeepseek-chat\n"
                        + "通义：https://dashscope.aliyuncs.com/compatible-mode/v1\nqwen-plus\n"
                        + "本地 Ollama：http://192.168.1.100:11434/v1\nqwen2.5",
                11.5f, 0xFF6b7484, false);
        hint.setLineSpacing(Ui.dp(this, 3), 1f);
        LinearLayout.LayoutParams hp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        hp.topMargin = Ui.dp(this, 12);
        col.addView(hint, hp);

        ScrollView sv = new ScrollView(this);
        sv.setBackgroundColor(Ui.BG);
        sv.addView(col);

        new AlertDialog.Builder(this)
                .setTitle("模型设置")
                .setView(sv)
                .setPositiveButton("保存", (d, which) -> {
                    String base = eBase.getText().toString().trim();
                    if (base.isEmpty()) base = DEFAULT_BASE;
                    String model = eModel.getText().toString().trim();
                    if (model.isEmpty()) model = DEFAULT_MODEL;
                    sp.edit()
                            .putString(K_BASE, base)
                            .putString(K_KEY, eKey.getText().toString().trim())
                            .putString(K_MODEL, model)
                            .putString(K_SYS, eSys.getText().toString().trim())
                            .apply();
                    render();
                    Toast.makeText(this, "存好了", Toast.LENGTH_SHORT).show();
                })
                .setNeutralButton("清空对话", (d, which) -> confirmClear())
                .setNegativeButton("取消", null)
                .show();
    }

    private TextView label(String s) {
        TextView v = Ui.text(this, s, 12.5f, Ui.DIM, true);
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        p.topMargin = Ui.dp(this, 12);
        v.setLayoutParams(p);
        return v;
    }

    private void confirmClear() {
        new AlertDialog.Builder(this)
                .setTitle("清空对话")
                .setMessage("这段聊天记录会删掉，删了找不回来。模型设置不动。")
                .setPositiveButton("清空", (d, w) -> {
                    while (msgs.length() > 0) msgs.remove(0);
                    save();
                    render();
                })
                .setNegativeButton("算了", null)
                .show();
    }

    // ────────────────────────────── 发消息 ──────────────────────────────

    private void send() {
        if (busy) return;
        final String text = input.getText().toString().trim();
        if (text.isEmpty()) return;

        String key = sp.getString(K_KEY, "");
        if (TextUtils.isEmpty(key)) {
            Toast.makeText(this, "先去右上角「模型设置」填密钥", Toast.LENGTH_LONG).show();
            showSettings();
            return;
        }

        input.setText("");
        try {
            msgs.put(new JSONObject().put("role", "user").put("content", text));
        } catch (Exception ignore) {
        }
        save();
        render();

        setBusy(true);
        final int msgCountBefore = msgs.length();

        new Thread(() -> {
            String reply = null;
            String err = null;
            try {
                reply = askModel();
            } catch (Exception e) {
                err = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
            }

            final String fReply = reply;
            final String fErr = err;
            ui.post(() -> {
                setBusy(false);
                if (fReply != null) {
                    try {
                        msgs.put(new JSONObject().put("role", "assistant").put("content", fReply));
                    } catch (Exception ignore) {
                    }
                    save();
                    render();
                } else {
                    // 报错不塞进对话里 —— 那不是「小鱼说的话」，重进的时候也不该被当历史
                    addBubble("error", "⚠ " + fErr);
                    scroll.post(() -> scroll.fullScroll(View.FOCUS_DOWN));
                    if (msgs.length() > msgCountBefore) {
                        // 用户那条留着，方便点完「模型设置」再重发
                    }
                }
            });
        }, "local-chat").start();
    }

    private void setBusy(boolean b) {
        busy = b;
        sendBtn.setEnabled(!b);
        sendBtn.setText(b ? "…" : "发送");
    }

    /** 真正去请求模型。跑在后台线程，返回助手回复的正文。 */
    private String askModel() throws Exception {
        String base = sp.getString(K_BASE, DEFAULT_BASE).trim();
        String key = sp.getString(K_KEY, "").trim();
        String model = sp.getString(K_MODEL, DEFAULT_MODEL).trim();
        String sys = sp.getString(K_SYS, "").trim();

        String url = base;
        while (url.endsWith("/")) url = url.substring(0, url.length() - 1);
        if (!url.endsWith("/chat/completions")) url = url + "/chat/completions";

        JSONArray arr = new JSONArray();
        if (!sys.isEmpty()) arr.put(new JSONObject().put("role", "system").put("content", sys));
        for (int i = 0; i < msgs.length(); i++) {
            JSONObject m = msgs.optJSONObject(i);
            if (m == null) continue;
            // 屏幕上可能画过 error 气泡，但那些不进 msgs，这里不用筛
            arr.put(m);
        }

        JSONObject body = new JSONObject();
        body.put("model", model);
        body.put("messages", arr);
        body.put("stream", false);

        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod("POST");
        c.setConnectTimeout(20000);
        c.setReadTimeout(180000);
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        c.setRequestProperty("Authorization", "Bearer " + key);
        c.setRequestProperty("Accept", "application/json");

        byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
        c.setFixedLengthStreamingMode(payload.length);
        try (OutputStream os = c.getOutputStream()) {
            os.write(payload);
        }

        int code = c.getResponseCode();
        String raw = readAll(code >= 400 ? c.getErrorStream() : c.getInputStream());

        if (code >= 400) {
            String brief = raw == null ? "" : raw.replaceAll("\\s+", " ").trim();
            if (brief.length() > 300) brief = brief.substring(0, 300) + "…";
            throw new Exception("接口返回 " + code + (brief.isEmpty() ? "" : "：" + brief));
        }

        JSONObject j = new JSONObject(raw == null ? "{}" : raw);
        JSONArray choices = j.optJSONArray("choices");
        if (choices == null || choices.length() == 0) {
            throw new Exception("接口没回内容：" + (raw == null ? "" : raw.substring(0, Math.min(200, raw.length()))));
        }
        JSONObject msg = choices.getJSONObject(0).optJSONObject("message");
        if (msg == null) throw new Exception("接口回的格式不认识");
        String content = msg.optString("content", "");
        if (TextUtils.isEmpty(content)) {
            // 推理模型（deepseek-reasoner / qwq 之类）有时只给 reasoning_content
            content = msg.optString("reasoning_content", "");
        }
        if (TextUtils.isEmpty(content)) throw new Exception("模型这次没说话，再点一次试试");
        return content;
    }

    private static String readAll(InputStream in) {
        if (in == null) return "";
        try (InputStream i = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = i.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        }
    }

    private static String hostOf(String base) {
        try {
            String u = base.replace("https://", "").replace("http://", "");
            int slash = u.indexOf('/');
            return slash > 0 ? u.substring(0, slash) : u;
        } catch (Exception e) {
            return base;
        }
    }

    // ────────────────────────────── 存档 ──────────────────────────────

    private void save() {
        try (FileOutputStream out = new FileOutputStream(store)) {
            out.write(msgs.toString().getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignore) {
        }
    }

    private void loadHistory() {
        if (!store.exists()) return;
        try (FileInputStream in = new FileInputStream(store)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            JSONArray arr = new JSONArray(new String(out.toByteArray(), StandardCharsets.UTF_8));
            for (int i = 0; i < arr.length(); i++) {
                JSONObject m = arr.optJSONObject(i);
                if (m != null) msgs.put(m);
            }
        } catch (Exception ignore) {
        }
    }
}
