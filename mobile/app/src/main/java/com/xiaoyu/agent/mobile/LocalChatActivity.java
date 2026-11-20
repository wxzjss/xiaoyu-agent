package com.xiaoyu.agent.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.text.TextUtils;
import android.util.AtomicFile;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.TextView;
import android.widget.Toast;

import com.xiaoyu.agent.mobile.ui.Ui;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.function.Consumer;

/**
 * 不连电脑时的本地模式：手机上自己填模型地址、密钥、模型名，直接跟模型说话。
 *
 * 本地模式保存手机里的聊天会话和手动填写的本机记忆，不读取电脑端的记忆文件、工具或会话分支。
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
    private static final String K_LOCAL_MEMORY = "localMemory";
    private static final String K_SEND_LOCAL_MEMORY = "sendLocalMemory";
    private static final int LOCAL_MEMORY_LIMIT = 4000;
    /** 外观：面板不透明度（0 最透、100 最实）。跟电脑端那个 --surface 是一个意思 */
    private static final String K_SURFACE = "surface";
    /** 背景音乐：开没开、音量、哪首（空 = 内置那首，也就是电脑端默认的壁纸音乐） */
    private static final String K_MUSIC_ON = "musicOn";
    private static final String K_MUSIC_VOL = "musicVol";
    private static final String K_MUSIC_FILE = "musicFile";
    /** 视频背景：开没开、压多暗（0 最透、100 最实）、自己挑的那段视频（空 = APK 自带那段） */
    private static final String K_VIDEO_ON = "videoOn";
    private static final String K_VEIL = "veil";
    private static final String K_VIDEO_FILE = "videoFile";

    private static final String DEFAULT_BASE = "https://api.deepseek.com/v1";
    private static final String DEFAULT_MODEL = "deepseek-chat";

    private SharedPreferences sp;

    private LinearLayout list;          // 消息都挂这儿
    private ScrollView scroll;
    private EditText input;
    private Button sendBtn;
    private Button sessionsBtn;
    private Button modelBtn;
    private Button thinkingBtn;
    private TextView subtitle;

    /** 视频背景那三层：画面在最底下，上面盖压暗层，再上面才是聊天内容 */
    private FrameLayout root;
    private ImageView whaleBg;
    private SurfaceView videoSurface;
    private MediaPlayer videoMp;
    private View veil;
    /** 聊天内容那一大块（顶栏+消息区+输入条）。它自己是透明的，才透得出下面的画面 */
    private LinearLayout page;

    private static final int STORE_VERSION = 1;

    private static final class Session {
        final String id;
        JSONArray messages;
        String modelOverride = "";
        ThinkingLevel thinking = ThinkingLevel.DEFAULT;

        Session(String id, JSONArray messages) {
            this.id = id;
            this.messages = messages;
        }
    }

    private enum ThinkingLevel {
        DEFAULT("default", "模型默认"),
        OFF("off", "关");

        final String id;
        final String label;

        ThinkingLevel(String id, String label) {
            this.id = id;
            this.label = label;
        }

        static ThinkingLevel fromId(String id) {
            for (ThinkingLevel level : values()) {
                if (level.id.equals(id)) return level;
            }
            return DEFAULT;
        }
    }

    private enum ThinkingSupport {
        NONE,
        DEEPSEEK(ThinkingLevel.OFF);

        final ThinkingLevel[] options;

        ThinkingSupport(ThinkingLevel... options) {
            this.options = options;
        }

        ThinkingLevel validate(ThinkingLevel selected) {
            for (ThinkingLevel option : options) {
                if (option == selected) return selected;
            }
            return ThinkingLevel.DEFAULT;
        }
    }

    private final List<Session> sessions = new ArrayList<>();
    private Session activeSession;
    private AtomicFile store;
    private boolean storeReadOnly;

    private static final class Turn {
        final Session session;
        final String url;
        final String key;
        final byte[] payload;
        volatile HttpURLConnection connection;
        volatile boolean cancelled;
        TextView bubble;

        Turn(Session session, String url, String key, byte[] payload) {
            this.session = session;
            this.url = url;
            this.key = key;
            this.payload = payload;
        }

        void throwIfCancelled() throws IOException {
            if (cancelled) throw new IOException("请求已取消");
        }
    }

    private Turn activeTurn;
    private final Handler ui = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        sp = getSharedPreferences(SP, MODE_PRIVATE);
        store = new AtomicFile(new File(getFilesDir(), "local-chat.json"));

        Window w = getWindow();
        /**
         * 【2026-11-11 加】安全区（跟 MainActivity 同一套）：
         * API 30+ edge-to-edge 后状态栏/手势条会压住顶栏和输入框，把 inset 作为 root 的
         * padding；ime 参与底边（decorFits(false) 之后 adjustResize 不再生效）。
         * API 30 以下维持原来的着色方案。零 AndroidX，全平台 API。
         */
        if (Build.VERSION.SDK_INT >= 30) {
            w.setDecorFitsSystemWindows(false);
        } else {
            w.setStatusBarColor(Ui.BG);
            w.setNavigationBarColor(Ui.BG);
        }
        w.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);

        buildUi();
        // root 在 buildUi() 里创建，listener 只能建完再挂
        if (Build.VERSION.SDK_INT >= 30) {
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                Insets bars = insets.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                Insets ime = insets.getInsets(WindowInsets.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
                return WindowInsets.CONSUMED;
            });
        }
        loadHistory();
        if (savedInstanceState != null) {
            String pending = savedInstanceState.getString(STATE_TEXT_PICKER_SESSION);
            if (activeSession.id.equals(pending)) {
                textImportTarget = activeSession;
                textPickerOpen = true;
            }
        }
        render();
    }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        if (textPickerOpen && textImportTarget != null) {
            state.putString(STATE_TEXT_PICKER_SESSION, textImportTarget.id);
        }
    }

    // ────────────────────────────── 界面 ──────────────────────────────

    private void buildUi() {
        // 根容器换成 FrameLayout：视频背景要垫在最底下，聊天内容压在上面。
        // page 自己不画底色（透明），中间那层压暗由 veil 负责 —— 这样才透得出画面。
        root = new FrameLayout(this);
        root.setBackgroundColor(Ui.BG);
        whaleBg = new ImageView(this);
        whaleBg.setImageResource(R.drawable.whale_muse_bg);
        whaleBg.setScaleType(ImageView.ScaleType.FIT_CENTER);
        whaleBg.setAlpha(0.46f);
        whaleBg.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        root.addView(whaleBg, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setBackgroundColor(android.graphics.Color.TRANSPARENT);

        // ---- 顶栏 ----
        int bp = Ui.dp(this, 14);
        LinearLayout bar = Ui.row(this);
        bar.setPadding(bp, Ui.dp(this, 6), bp, Ui.dp(this, 6));
        bar.setBackgroundColor(Ui.bgAlpha(88));

        LinearLayout identity = Ui.column(this, 0);
        TextView title = Ui.text(this, "小鱼", 22, Ui.TEXT, true);
        title.setTypeface(Typeface.create("serif", Typeface.BOLD));
        identity.addView(title);
        subtitle = Ui.text(this, "本机独立聊天", 12, Ui.DIM, false);
        identity.addView(subtitle);
        bar.addView(identity, Ui.lp(0, ViewGroup.LayoutParams.WRAP_CONTENT, 2));

        sessionsBtn = compactButton("会话");
        sessionsBtn.setOnClickListener(v -> showSessions());
        LinearLayout.LayoutParams sessionParams = Ui.lp(0, ViewGroup.LayoutParams.WRAP_CONTENT, 3);
        sessionParams.leftMargin = Ui.dp(this, 8);
        bar.addView(sessionsBtn, sessionParams);
        page.addView(bar, Ui.lp(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, 0));

        LinearLayout modelBar = Ui.row(this);
        modelBar.setPadding(bp, 0, bp, Ui.dp(this, 7));
        modelBar.setBackgroundColor(Ui.bgAlpha(88));
        modelBtn = compactButton("模型");
        modelBtn.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        modelBtn.setOnClickListener(v -> showSessionModel());
        modelBar.addView(modelBtn, Ui.lp(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));

        thinkingBtn = compactButton("思考");
        thinkingBtn.setOnClickListener(v -> showSessionThinking());
        LinearLayout.LayoutParams thinkParams = Ui.lp(ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT, 0);
        thinkParams.leftMargin = Ui.dp(this, 8);
        modelBar.addView(thinkingBtn, thinkParams);
        page.addView(modelBar, Ui.lp(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT, 0));

        // ---- 消息区 ----
        scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        // 透明：以前这里是 Ui.BG，会把整块视频盖掉
        scroll.setBackgroundColor(android.graphics.Color.TRANSPARENT);
        list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        int lp = Ui.dp(this, 12);
        list.setPadding(lp, lp, lp, lp);
        scroll.addView(list, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        page.addView(scroll, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        // ---- 输入区与快捷入口 ----
        LinearLayout composer = Ui.column(this, 0);
        composer.setPadding(bp, Ui.dp(this, 8), bp, Ui.dp(this, 6));
        composer.setBackgroundColor(Ui.bgAlpha(94));
        LinearLayout bar2 = Ui.row(this);
        bar2.setGravity(Gravity.BOTTOM);

        input = new EditText(this);
        input.setHint("跟小鱼说点什么…");
        input.setHintTextColor(Ui.DIM);
        input.setTextColor(Ui.TEXT);
        input.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        input.setBackground(Ui.roundStroke(Ui.PANEL, Ui.LINE, 14, this));
        int ip = Ui.dp(this, 14);
        input.setPadding(ip, Ui.dp(this, 12), ip, Ui.dp(this, 12));
        input.setMinHeight(Ui.dp(this, 50));
        input.setMaxLines(5);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE
                | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        bar2.addView(input, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        sendBtn = Ui.button(this, "发送", true);
        sendBtn.setMinHeight(Ui.dp(this, 50));
        sendBtn.setMinWidth(Ui.dp(this, 66));
        LinearLayout.LayoutParams sbp = Ui.lp(ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT, 0);
        sbp.leftMargin = Ui.dp(this, 8);
        bar2.addView(sendBtn, sbp);
        sendBtn.setOnClickListener(v -> {
            if (activeTurn == null) send();
            else stopTurn();
        });
        composer.addView(bar2, Ui.lp(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, 0));

        LinearLayout shortcuts = Ui.row(this);
        addShortcut(shortcuts, "导入文本", this::pickTextDocument);
        addShortcut(shortcuts, "工具", this::showLocalTools);
        addShortcut(shortcuts, "设置", this::showLocalSettings);
        addShortcut(shortcuts, "连接电脑", this::connectDesktop);
        LinearLayout.LayoutParams shortcutParams = Ui.lp(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT, 0);
        shortcutParams.topMargin = Ui.dp(this, 5);
        composer.addView(shortcuts, shortcutParams);
        page.addView(composer, Ui.lp(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, 0));

        // 组装：视频层 + 压暗层 + 聊天内容，三层从下往上摞
        root.addView(page, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        startVideoBackdrop();
        setContentView(root);
    }

    private Button compactButton(String text) {
        Button button = Ui.button(this, text, false);
        button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        button.setMinWidth(0);
        button.setMinHeight(Ui.dp(this, 44));
        button.setPadding(Ui.dp(this, 9), Ui.dp(this, 6), Ui.dp(this, 9), Ui.dp(this, 6));
        button.setSingleLine(true);
        button.setEllipsize(TextUtils.TruncateAt.END);
        return button;
    }

    private void addShortcut(LinearLayout row, String label, Runnable action) {
        Button button = compactButton(label);
        button.setSingleLine(false);
        button.setMaxLines(2);
        button.setPadding(Ui.dp(this, 2), Ui.dp(this, 4), Ui.dp(this, 2), Ui.dp(this, 4));
        button.setBackground(Ui.round(Ui.bgAlpha(70), 8, this));
        button.setOnClickListener(v -> action.run());
        row.addView(button, Ui.lp(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
    }

    /** 切换会话时重画历史，流式回复只更新自己的气泡。 */
    private void render() {
        list.removeAllViews();
        JSONArray msgs = activeSession.messages;

        if (msgs.length() == 0) {
            boolean needsKey = sp.getString(K_KEY, "").trim().isEmpty();
            LinearLayout empty = Ui.column(this, 16);
            empty.setBackground(Ui.round(Ui.bgAlpha(82), 16, this));
            TextView headline = Ui.text(this, needsKey ? "先配置聊天模型" : "开启对话", 19, Ui.TEXT, true);
            empty.addView(headline);
            TextView guidance = Ui.text(this, needsKey ? "添加接口地址和密钥后即可聊天。"
                    : "在下方输入消息，或导入文本。", 14, Ui.DIM, false);
            guidance.setPadding(0, Ui.dp(this, 5), 0, 0);
            empty.addView(guidance);
            if (needsKey) {
                Button configure = compactButton("模型设置");
                configure.setOnClickListener(v -> showSettings());
                empty.addView(configure, Ui.lpMT(ViewGroup.LayoutParams.WRAP_CONTENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT, 10, this));
            }
            list.addView(empty, Ui.lpMT(ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT, 16, this));
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

        updateHeader();
        scroll.post(() -> scroll.fullScroll(View.FOCUS_DOWN));
    }

    private void updateHeader() {
        String label = sessionLabel(activeSession, sessions.indexOf(activeSession));
        sessionsBtn.setText(label.startsWith("会话 ") ? label + " ▾" : "会话 · " + label + " ▾");
        sessionsBtn.setContentDescription("切换会话，当前：" + label);
        String model = modelFor(activeSession);
        String base = sp.getString(K_BASE, DEFAULT_BASE);
        ThinkingSupport support = thinkingSupport(base, model);
        ThinkingLevel thinking = support.validate(activeSession.thinking);
        subtitle.setText(storeReadOnly ? "存档只读" : "本机独立聊天");
        subtitle.setContentDescription(storeReadOnly ? "旧存档无法读取，本次聊天不会覆盖它"
                : "本机独立聊天，模型接口 " + hostOf(base));
        modelBtn.setText("模型 · " + model + " ▾");
        modelBtn.setContentDescription("切换当前会话模型，当前：" + model);
        thinkingBtn.setVisibility(support == ThinkingSupport.NONE ? View.GONE : View.VISIBLE);
        thinkingBtn.setText("思考 · " + thinking.label + " ▾");
        thinkingBtn.setContentDescription("切换当前会话思考档位，当前：" + thinking.label);
    }

    private static String sessionLabel(Session session, int index) {
        for (int i = 0; i < session.messages.length(); i++) {
            JSONObject message = session.messages.optJSONObject(i);
            if (message == null || !"user".equals(message.optString("role"))) continue;
            String text = message.optString("content", "").replaceAll("\\s+", " ").trim();
            if (text.isEmpty()) continue;
            int limit = Math.min(24, text.codePointCount(0, text.length()));
            int end = text.offsetByCodePoints(0, limit);
            return end == text.length() ? text : text.substring(0, end) + "…";
        }
        return "会话 " + (index + 1);
    }

    private void showSessions() {
        if (activeTurn != null) return;
        String[] labels = new String[sessions.size()];
        for (int i = 0; i < labels.length; i++) labels[i] = sessionLabel(sessions.get(i), i);
        new AlertDialog.Builder(this)
                .setTitle("本地会话")
                .setSingleChoiceItems(labels, sessions.indexOf(activeSession), (d, index) -> {
                    d.dismiss();
                    if (activeTurn == null) selectSession(sessions.get(index));
                })
                .setPositiveButton("新建", (d, w) -> {
                    if (activeTurn != null) return;
                    Session session = new Session(UUID.randomUUID().toString(), new JSONArray());
                    sessions.add(session);
                    selectSession(session);
                })
                .setNeutralButton("清空当前", (d, w) -> confirmClear())
                .setNegativeButton("取消", null)
                .show();
    }

    private void selectSession(Session session) {
        if (session == activeSession) return;
        activeSession = session;
        input.setText("");
        save();
        render();
    }

    /** 一条气泡。user 靠右、assistant 靠左，error 是提示（不算对话内容）。 */
    private TextView addBubble(String role, String content) {
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
                ? Ui.round(0xE64d8dff, 12, this)
                : Ui.roundStroke(err ? 0xD0151a22 : 0xD0151a22, err ? 0xFF6b4a2a : Ui.LINE, 12, this));

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
        return b;
    }

    // ────────────────────────────── 模型设置 ──────────────────────────────

    private String defaultModel() {
        String model = sp.getString(K_MODEL, DEFAULT_MODEL).trim();
        return model.isEmpty() ? DEFAULT_MODEL : model;
    }

    private String modelFor(Session session) {
        return session.modelOverride.isEmpty() ? defaultModel() : session.modelOverride;
    }

    private void showSessionModel() {
        if (activeTurn != null) return;
        Session target = activeSession;
        EditText field = Ui.input(this, defaultModel(), true);
        field.setText(target.modelOverride);
        field.setSelectAllOnFocus(true);
        LinearLayout form = Ui.column(this, 18);
        form.addView(field, Ui.lp(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT, 0));
        new AlertDialog.Builder(this)
                .setTitle("当前会话模型")
                .setMessage("填写当前接口支持的模型 ID。留空时跟随默认模型。")
                .setView(form)
                .setPositiveButton("保存", (d, w) -> setSessionModel(target, field.getText().toString().trim()))
                .setNeutralButton("用默认模型", (d, w) -> setSessionModel(target, ""))
                .setNegativeButton("取消", null)
                .show();
    }

    private void setSessionModel(Session target, String modelOverride) {
        if (activeTurn != null || activeSession != target || target.modelOverride.equals(modelOverride)) return;
        String previousModel = modelFor(target);
        target.modelOverride = modelOverride;
        if (!previousModel.equals(modelFor(target))) target.thinking = ThinkingLevel.DEFAULT;
        save();
        updateHeader();
    }

    private void showSessionThinking() {
        if (activeTurn != null) return;
        Session target = activeSession;
        String base = sp.getString(K_BASE, DEFAULT_BASE);
        String model = modelFor(target);
        ThinkingSupport support = thinkingSupport(base, model);
        if (support == ThinkingSupport.NONE) return;
        ThinkingLevel current = support.validate(target.thinking);
        String[] labels = new String[support.options.length + 1];
        labels[0] = ThinkingLevel.DEFAULT.label;
        int selected = 0;
        for (int i = 0; i < support.options.length; i++) {
            ThinkingLevel option = support.options[i];
            labels[i + 1] = option.label;
            if (option == current) selected = i + 1;
        }
        new AlertDialog.Builder(this)
                .setTitle("当前会话思考档位")
                .setSingleChoiceItems(labels, selected, (d, index) -> {
                    d.dismiss();
                    if (activeTurn != null || activeSession != target) return;
                    target.thinking = index == 0 ? ThinkingLevel.DEFAULT : support.options[index - 1];
                    save();
                    updateHeader();
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private void showLocalTools() {
        new AlertDialog.Builder(this)
                .setTitle("本机工具")
                .setItems(new CharSequence[]{"本机记忆", "导入文本"}, (dialog, which) -> {
                    if (which == 0) showLocalMemory();
                    else pickTextDocument();
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private void showLocalSettings() {
        new AlertDialog.Builder(this)
                .setTitle("设置")
                .setItems(new CharSequence[]{"模型设置", "外观与背景"}, (dialog, which) -> {
                    if (which == 0) showSettings();
                    else showLook();
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private void connectDesktop() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.putExtra(MainActivity.EXTRA_CONNECT_FROM_LOCAL, true);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(intent);
    }

    private void showLocalMemory() {
        EditText note = new EditText(this);
        note.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        note.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(LOCAL_MEMORY_LIMIT)});
        note.setMinLines(4);
        note.setGravity(Gravity.TOP);
        note.setHint("写下希望小鱼记住的偏好或背景");
        note.setText(sp.getString(K_LOCAL_MEMORY, ""));
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        int pad = Ui.dp(this, 20);
        form.setPadding(pad, 0, pad, 0);
        form.addView(note, new LinearLayout.LayoutParams(-1, -2));
        CheckBox sendMemory = new CheckBox(this);
        sendMemory.setText("随消息发给当前模型");
        sendMemory.setChecked(sp.getBoolean(K_SEND_LOCAL_MEMORY, false));
        form.addView(sendMemory);
        new AlertDialog.Builder(this)
                .setTitle("本机记忆")
                .setMessage("独立会话共用。默认不发送给模型，但可能随系统备份或迁移。勾选后会随每轮消息发给当前配置的模型。留空保存即可清空，请勿填写密钥。")
                .setView(form)
                .setNegativeButton("取消", null)
                .setPositiveButton("保存", (dialog, which) -> sp.edit()
                        .putString(K_LOCAL_MEMORY, note.getText().toString().trim())
                        .putBoolean(K_SEND_LOCAL_MEMORY, sendMemory.isChecked()).apply())
                .show();
    }

    private void showSettings() {
        if (activeTurn != null) return;
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
        col.addView(label("默认模型名"));
        col.addView(eModel);
        col.addView(label("人设 / 系统提示（可留空）"));
        col.addView(eSys);

        TextView hint = Ui.text(this,
                "地址填到 /v1 就行，程序自己补 /chat/completions。\n"
                        + "DeepSeek：https://api.deepseek.com/v1\ndeepseek-chat\n"
                        + "通义：https://dashscope.aliyuncs.com/compatible-mode/v1\nqwen-plus\n"
                        + "本地 Ollama：http://192.168.1.5:11434/v1\nqwen2.5",
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
                    boolean endpointChanged = !chatUrl(base).equals(chatUrl(sp.getString(K_BASE, DEFAULT_BASE)));
                    boolean defaultChanged = !model.equals(defaultModel());
                    boolean resetThinking = false;
                    for (Session session : sessions) {
                        if (session.thinking != ThinkingLevel.DEFAULT
                                && (endpointChanged || (defaultChanged && session.modelOverride.isEmpty()))) {
                            session.thinking = ThinkingLevel.DEFAULT;
                            resetThinking = true;
                        }
                    }
                    if (resetThinking) save();
                    sp.edit()
                            .putString(K_BASE, base)
                            .putString(K_KEY, eKey.getText().toString().trim())
                            .putString(K_MODEL, model)
                            .putString(K_SYS, eSys.getText().toString().trim())
                            .apply();
                    if (activeSession.messages.length() == 0) render();
                    else updateHeader();
                    Toast.makeText(this, "存好了", Toast.LENGTH_SHORT).show();
                })
                .setNegativeButton("取消", null)
                .show();
    }

    // ────────────────────────────── 外观 / 背景音乐 ──────────────────────────────

    /**
     * 外观面板。
     *
     * 比电脑端简化的理由：手机屏幕小，塞不下「面板暗度 / 蒙版 / 原色 / 均衡 / 透明」
     * 那一整套。只留最有感知的几样 —— 视频背景开关、背景暗度、背景音乐开关和音量。
     *
     * 视频背景跟连接页共用 APK 里那段 bg-video.mp4。以前这里写着「视频不在手机上」，
     * 那是 0.9.11 之前的事了：文件一直都在，只是本地模式这层没人去铺。
     */
    private void showLook() {
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        int p = Ui.dp(this, 18);
        col.setPadding(p, p, p, p);
        col.setBackgroundColor(Ui.BG);

        // ---- 视频背景 ----
        final CheckBox cvOn = new CheckBox(this);
        cvOn.setText("显示聊天背景");
        cvOn.setTextColor(Ui.TEXT);
        cvOn.setChecked(sp.getBoolean(K_VIDEO_ON, true));
        col.addView(cvOn);

        TextView videoNow = Ui.text(this, "", 12f, Ui.DIM, false);
        videoNow.setLineSpacing(Ui.dp(this, 3), 1f);
        col.addView(videoNow);

        col.addView(label("自选视频暗度"));
        final SeekBar veilBar = new SeekBar(this);
        veilBar.setMax(100);
        veilBar.setProgress(sp.getInt(K_VEIL, 85));
        col.addView(veilBar);
        final TextView veilNote = Ui.text(this, "", 11.5f, 0xFF6b7484, false);
        col.addView(veilNote);

        LinearLayout vbtns = new LinearLayout(this);
        vbtns.setOrientation(LinearLayout.HORIZONTAL);

        Button pickV = Ui.button(this, "选本地视频", false);
        pickV.setOnClickListener(v -> pickVideo());
        vbtns.addView(pickV);

        Button defV = Ui.button(this, "恢复默认", false);
        LinearLayout.LayoutParams dvp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        dvp.leftMargin = Ui.dp(this, 8);
        defV.setOnClickListener(v -> {
            // 退出自选视频，恢复默认的鲸鱼娘立绘。
            String old = sp.getString(K_VIDEO_FILE, "");
            if (!TextUtils.isEmpty(old)) {
                try {
                    new File(old).delete();
                } catch (Throwable ignored) {
                }
            }
            sp.edit().putString(K_VIDEO_FILE, "").putBoolean(K_VIDEO_ON, true)
                    .putInt(K_VEIL, 85).apply();
            refreshVideoNote(videoNow);
            veilBar.setProgress(85);
            veilNote.setText("暗度 85%");
            startVideoBackdrop();
        });
        vbtns.addView(defV, dvp);
        LinearLayout.LayoutParams vbp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        vbp.topMargin = Ui.dp(this, 10);
        col.addView(vbtns, vbp);

        // ---- 分隔 ----
        View hr = new View(this);
        hr.setBackgroundColor(Ui.LINE);
        LinearLayout.LayoutParams hrp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, Ui.dp(this, 0.7f)));
        hrp.topMargin = Ui.dp(this, 16);
        col.addView(hr, hrp);

        final CheckBox cOn = new CheckBox(this);
        cOn.setText("播背景音乐");
        cOn.setTextColor(Ui.TEXT);
        cOn.setChecked(sp.getBoolean(K_MUSIC_ON, true));
        col.addView(cOn);

        TextView musicNow = Ui.text(this, "", 12f, Ui.DIM, false);
        musicNow.setLineSpacing(Ui.dp(this, 3), 1f);
        col.addView(musicNow);

        col.addView(label("音量"));
        final SeekBar vol = new SeekBar(this);
        vol.setMax(100);
        vol.setProgress(sp.getInt(K_MUSIC_VOL, 40));
        col.addView(vol);

        LinearLayout btns = new LinearLayout(this);
        btns.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        bp.topMargin = Ui.dp(this, 10);

        Button pick = Ui.button(this, "选本地音乐", false);
        pick.setOnClickListener(v -> pickMusic());
        btns.addView(pick);

        Button def = Ui.button(this, "恢复默认", false);
        LinearLayout.LayoutParams dp2 = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        dp2.leftMargin = Ui.dp(this, 8);
        def.setOnClickListener(v -> {
            sp.edit().putString(K_MUSIC_FILE, "").putBoolean(K_MUSIC_ON, true).apply();
            refreshMusicNote(musicNow);
            restartMusic();
        });
        btns.addView(def, dp2);
        col.addView(btns, bp);

        TextView tip = Ui.text(this,
                "默认的影音都是电脑端壁纸那套，已经打进 App 里了 —— 不连电脑也有。\n"
                        + "想用自己的就点「选本地视频 / 选本地音乐」，会拷进 App 私有目录，之后离线也能放。\n"
                        + "切到别的 App 时视频和音乐都会停，省电。",
                11.5f, 0xFF6b7484, false);
        tip.setLineSpacing(Ui.dp(this, 3), 1f);
        LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tp.topMargin = Ui.dp(this, 12);
        col.addView(tip, tp);

        refreshMusicNote(musicNow);
        refreshVideoNote(videoNow);
        veilNote.setText("暗度 " + veilBar.getProgress() + "%");

        // 拖滑杆即时生效（只改压暗层颜色，不重启视频，不然每次拖都 prepare 一遍会顿）
        veilBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar sb, int v, boolean fromUser) {
                sp.edit().putInt(K_VEIL, v).apply();
                veilNote.setText("暗度 " + v + "%");
                applyVeil();
            }

            @Override
            public void onStartTrackingTouch(SeekBar sb) {
            }

            @Override
            public void onStopTrackingTouch(SeekBar sb) {
            }
        });

        ScrollView sv = new ScrollView(this);
        sv.setBackgroundColor(Ui.BG);
        sv.addView(col);

        new AlertDialog.Builder(this)
                .setTitle("外观 / 视频 / 背景音乐")
                .setView(sv)
                .setPositiveButton("保存", (d, which) -> {
                    boolean wantVideo = cvOn.isChecked();
                    boolean hadVideo = sp.getBoolean(K_VIDEO_ON, true);
                    sp.edit()
                            .putBoolean(K_VIDEO_ON, wantVideo)
                            .putInt(K_VEIL, veilBar.getProgress())
                            .putBoolean(K_MUSIC_ON, cOn.isChecked())
                            .putInt(K_MUSIC_VOL, vol.getProgress())
                            .apply();
                    // 开关状态变了才重铺视频；只是拖了暗度的话视频不用动
                    if (wantVideo != hadVideo) startVideoBackdrop();
                    else if (wantVideo) applyVeil();
                    restartMusic();
                })
                .setNegativeButton("取消", null)
                .show();

        vol.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar sb, int v, boolean fromUser) {
                sp.edit().putInt(K_MUSIC_VOL, v).apply();
                applyMusicVolume();
            }

            @Override
            public void onStartTrackingTouch(SeekBar sb) {
            }

            @Override
            public void onStopTrackingTouch(SeekBar sb) {
            }
        });
    }

    /** 面板上那行「现在放的是…」 */
    private void refreshMusicNote(TextView tv) {
        if (tv == null) return;
        String f = sp.getString(K_MUSIC_FILE, "");
        boolean on = sp.getBoolean(K_MUSIC_ON, true);
        String name = TextUtils.isEmpty(f) ? "自带的壁纸音乐" : new File(f).getName();
        tv.setText(on ? "现在放的是：" + name : "已关闭。上次放的是：" + name);
    }

    /** 视频那行「现在放的是…」 */
    private void refreshVideoNote(TextView tv) {
        if (tv == null) return;
        String f = sp.getString(K_VIDEO_FILE, "");
        boolean on = sp.getBoolean(K_VIDEO_ON, true);
        File custom = TextUtils.isEmpty(f) ? null : new File(f);
        String name = custom != null && custom.isFile() && custom.length() > 0 ? custom.getName() : "鲸鱼娘";
        tv.setText(on ? "当前背景：" + name : "背景已关闭");
    }

    /**
     * 「默认那首」= APK 里自带的那段音频（assets/bg-music.m4a，约 2MB）。
     *
     * 以前这里写的是 http://<电脑IP>:8787/api/skin/music，两个毛病：
     *   1. 本地模式本来就不连电脑，等于一开机就放不出来；
     *   2. 那个 IP 是我编的占位符，永远连不上。
     * 现在打进 APK，离线也有声音。要换的话，走「选本地音乐」。
     */
    private static final String ASSET_BUNDLED_MUSIC = "bg-music.m4a";

    private MediaPlayer player;

    private void applyMusicVolume() {
        if (player != null) {
            try {
                player.setVolume(v01(), v01());
            } catch (Exception ignored) {
            }
        }
    }

    private float v01() {
        return Math.max(0f, Math.min(1f, sp.getInt(K_MUSIC_VOL, 40) / 100f));
    }

    private void restartMusic() {
        stopMusic();
        if (!sp.getBoolean(K_MUSIC_ON, true)) return;
        String f = sp.getString(K_MUSIC_FILE, "");
        try {
            player = new MediaPlayer();
            player.setLooping(true);
            if (TextUtils.isEmpty(f)) {
                // 用 AssetFileDescriptor 喂进 MediaPlayer，省得先拷一份到内部存储
                android.content.res.AssetFileDescriptor afd = getAssets().openFd(ASSET_BUNDLED_MUSIC);
                player.setDataSource(afd.getFileDescriptor(), afd.getStartOffset(), afd.getLength());
                afd.close();
            } else {
                player.setDataSource(f);
            }
            player.setVolume(v01(), v01());
            player.setOnPreparedListener(mp -> {
                try {
                    mp.start();
                } catch (Exception ignored) {
                }
            });
            player.setOnErrorListener((mp, what, extra) -> {
                // 自己选的音乐被删了、格式不认，都会走这儿：静音就行，别弹框烦人
                stopMusic();
                return true;
            });
            player.prepareAsync();
        } catch (Exception e) {
            stopMusic();
        }
    }

    private void stopMusic() {
        if (player != null) {
            try {
                if (player.isPlaying()) player.stop();
            } catch (Exception ignored) {
            }
            try {
                player.release();
            } catch (Exception ignored) {
            }
            player = null;
        }
    }

    // ────────────────────────────── 视频背景 ──────────────────────────────

    /**
     * 把 assets 里那段 7MB 的视频摊到缓存目录，返回真实文件路径（失败返回 null）。
     *
     * 为什么不能直接播 assets：跟连接页撞的是同一个坑，那段详情写在
     * MainActivity.assetToCache 的注释里，这里只说结论 ——
     *   MediaPlayer.setDataSource(fd, offset, length) 读 assets 会报 error (-38, 0)，
     *   VideoView 的 file:///android_asset/ 根本打不开。
     * 摊成真实文件一次解决两条路。已经摊过且字节数对得上就复用，不重复拷 7MB。
     */
    private File assetToCache(String name) {
        try {
            File dir = new File(getCacheDir(), "bg");
            if (!dir.exists() && !dir.mkdirs()) return null;
            File out = new File(dir, name);

            // 已经摊好了？（长度对得上就当没坏）
            if (out.exists() && out.length() > 0) {
                long expect = -1;
                try {
                    android.content.res.AssetFileDescriptor afd = getAssets().openFd(name);
                    expect = afd.getLength();
                    afd.close();
                } catch (Throwable ignored) {
                }
                if (expect <= 0 || out.length() == expect) return out;
            }

            long expect = -1;
            try {
                android.content.res.AssetFileDescriptor afd = getAssets().openFd(name);
                expect = afd.getLength();
                afd.close();
            } catch (Throwable ignored) {
            }

            InputStream in = getAssets().open(name);
            OutputStream os = new FileOutputStream(out);
            byte[] buf = new byte[64 * 1024];
            int n;
            long total = 0;
            while ((n = in.read(buf)) > 0) {
                os.write(buf, 0, n);
                total += n;
            }
            os.flush();
            os.close();
            in.close();
            // 拷完核一下字节数，短了就是坏文件，别拿去播
            if (total <= 0 || (expect > 0 && total != expect)) {
                out.delete();
                return null;
            }
            return out;
        } catch (Throwable e) {
            return null;
        }
    }

    /** 自选视频不存在时，显示内置鲸鱼娘立绘。 */
    private File pickVideoFile() {
        String path = sp.getString(K_VIDEO_FILE, "");
        if (TextUtils.isEmpty(path)) return null;
        File file = new File(path);
        return file.isFile() && file.length() > 0 ? file : null;
    }

    /** 背景默认使用立绘，用户选过视频时再启动播放器。 */
    private void startVideoBackdrop() {
        stopVideoBackdrop();
        boolean backgroundOn = sp.getBoolean(K_VIDEO_ON, true);
        whaleBg.setVisibility(backgroundOn ? View.VISIBLE : View.GONE);
        if (!backgroundOn) return;

        try {
            final File vfile = pickVideoFile();
            if (vfile == null) return;   // 摊不出来就干脆不画，别留一块黑

            SurfaceView sv = new SurfaceView(this);
            sv.setLayoutParams(new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            final MediaPlayer mp = new MediaPlayer();

            sv.getHolder().addCallback(new SurfaceHolder.Callback() {
                @Override
                public void surfaceCreated(SurfaceHolder h) {
                    // 画面到手了才喂数据：没有 Surface 时 setDisplay 会抛错
                    try {
                        mp.setDisplay(h);
                        mp.setDataSource(vfile.getAbsolutePath());
                        mp.setLooping(true);
                        mp.setVolume(0f, 0f);   // 画面归画面，声音交给音乐那一路，免得两条音轨叠着响
                        try {
                            mp.setVideoScalingMode(MediaPlayer.VIDEO_SCALING_MODE_SCALE_TO_FIT_WITH_CROPPING);
                        } catch (Throwable ignored) {
                        }
                        mp.setOnPreparedListener(m -> {
                            try {
                                m.setVolume(0f, 0f);
                                m.start();
                            } catch (Throwable ignored) {
                            }
                        });
                        mp.setOnErrorListener((m, what, extra) -> {
                            // 解不了就把画面层藏掉，只留压暗底色，别让聊天跟着挂
                            sv.setVisibility(View.GONE);
                            return true;
                        });
                        mp.prepareAsync();
                    } catch (Throwable e) {
                        sv.setVisibility(View.GONE);
                    }
                }

                @Override
                public void surfaceChanged(SurfaceHolder h, int fmt, int w, int hh) {
                }

                @Override
                public void surfaceDestroyed(SurfaceHolder h) {
                    try {
                        if (mp.isPlaying()) mp.pause();
                    } catch (Throwable ignored) {
                    }
                }
            });

            videoSurface = sv;
            videoMp = mp;
            // 自选视频盖住默认立绘，聊天内容仍在最上层。
            root.addView(sv, 1, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        } catch (Throwable e) {
            videoSurface = null;
            videoMp = null;
        }

        // 压暗层：垫在视频和字之间。滑杆调的就是它的不透明度。
        // 直接 addView 就是加在最上面 —— 所以加完必须把 page 提回最前，
        // 顺序是：videoSurface(0) → veil(1) → page(2)。
        veil = new View(this);
        veil.setBackgroundColor(Ui.bgAlpha(sp.getInt(K_VEIL, 85)));
        veil.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(veil);
        page.bringToFront();
    }

    /** 视频层收工。不解会漏 MediaPlayer，Activity 走了必须调。 */
    private void stopVideoBackdrop() {
        if (videoMp != null) {
            try {
                videoMp.stop();
            } catch (Throwable ignored) {
            }
            try {
                videoMp.release();
            } catch (Throwable ignored) {
            }
            videoMp = null;
        }
        if (videoSurface != null) {
            try {
                ViewGroup parent = (ViewGroup) videoSurface.getParent();
                if (parent != null) parent.removeView(videoSurface);
            } catch (Throwable ignored) {
            }
            videoSurface = null;
        }
        if (veil != null) {
            try {
                ViewGroup parent = (ViewGroup) veil.getParent();
                if (parent != null) parent.removeView(veil);
            } catch (Throwable ignored) {
            }
            veil = null;
        }
    }

    /** 只调压暗层的不透明度，不重启视频（拖滑杆时用，重启一次要重新 prepare，会顿） */
    private void applyVeil() {
        if (veil == null) return;
        veil.setBackgroundColor(Ui.bgAlpha(sp.getInt(K_VEIL, 85)));
    }

    private static final int REQ_VIDEO = 4302;

    /** 选一段手机里的视频当背景，拷进 App 私有目录（卸载才没） */
    private void pickVideo() {
        Intent i = new Intent(Intent.ACTION_GET_CONTENT);
        i.setType("video/*");
        i.addCategory(Intent.CATEGORY_OPENABLE);
        try {
            startActivityForResult(i, REQ_VIDEO);
        } catch (Exception e) {
            Toast.makeText(this, "这台手机没有可用的选视频界面", Toast.LENGTH_SHORT).show();
        }
    }

    private void onPickedVideo(Intent data) {
        try (InputStream in = getContentResolver().openInputStream(data.getData())) {
            File dir = new File(getFilesDir(), "video");
            if (!dir.exists()) dir.mkdirs();
            File dest = new File(dir, "bg-" + System.currentTimeMillis() + ".mp4");
            try (FileOutputStream out = new FileOutputStream(dest)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
            // 换了新的就把上一段删掉，不然私有目录里越攒越大
            String old = sp.getString(K_VIDEO_FILE, "");
            if (!TextUtils.isEmpty(old)) {
                try {
                    File o = new File(old);
                    if (o.exists() && !o.getAbsolutePath().equals(dest.getAbsolutePath())) o.delete();
                } catch (Throwable ignored) {
                }
            }
            sp.edit().putString(K_VIDEO_FILE, dest.getAbsolutePath())
                    .putBoolean(K_VIDEO_ON, true).apply();
            startVideoBackdrop();
            Toast.makeText(this, "换好了", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "这段视频读不出来：" + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private static final int REQ_MUSIC = 4301;
    private static final int REQ_TEXT = 4303;
    private static final int IMPORT_LIMIT_BYTES = 32 * 1024;
    private static final String STATE_TEXT_PICKER_SESSION = "textPickerSession";
    private Session textImportTarget;
    private boolean textPickerOpen;
    private TextImport textImport;
    private static final int TEXT_IMPORT_TIMEOUT_MS = 20_000;
    private static final java.util.concurrent.ExecutorService TEXT_IMPORT_READERS =
            new java.util.concurrent.ThreadPoolExecutor(0, 2, 30, java.util.concurrent.TimeUnit.SECONDS,
                    new java.util.concurrent.SynchronousQueue<>());

    private static final class TextImport {
        java.util.concurrent.Future<?> reader;
        AlertDialog dialog;
        Runnable timeout;
    }

    private void pickTextDocument() {
        if (activeTurn != null || textImportTarget != null) {
            Toast.makeText(this, "请等当前操作结束后再导入", Toast.LENGTH_SHORT).show();
            return;
        }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("text/*");
        textImportTarget = activeSession;
        textPickerOpen = true;
        try {
            startActivityForResult(intent, REQ_TEXT);
        } catch (android.content.ActivityNotFoundException | SecurityException e) {
            textPickerOpen = false;
            textImportTarget = null;
            Toast.makeText(this, "无法打开系统文件选择器", Toast.LENGTH_SHORT).show();
        }
    }

    static String readImportedText(InputStream in) throws IOException {
        if (in == null) throw new IOException("文件无法打开");
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        byte[] chunk = new byte[4096];
        for (int count; (count = in.read(chunk)) != -1; ) {
            if (count > IMPORT_LIMIT_BYTES - bytes.size()) throw new IOException("文件超过 32 KiB");
            bytes.write(chunk, 0, count);
        }
        String text = StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes.toByteArray())).toString();
        if (text.startsWith("\uFEFF")) text = text.substring(1);
        if (text.indexOf('\0') >= 0 || text.trim().isEmpty()) throw new IOException("文件为空或不是有效文本");
        return text;
    }

    private void importText(android.net.Uri uri, Session target) {
        TextImport job = new TextImport();
        textImport = job;
        job.timeout = () -> {
            if (finishTextImport(job, true)) {
                Toast.makeText(this, "读取超时，请重试或选择本地文件", Toast.LENGTH_LONG).show();
            }
        };
        job.dialog = new AlertDialog.Builder(this)
                .setTitle("正在读取文本")
                .setNegativeButton("取消", (dialog, which) -> finishTextImport(job, true))
                .setOnCancelListener(dialog -> finishTextImport(job, true))
                .show();
        ui.postDelayed(job.timeout, TEXT_IMPORT_TIMEOUT_MS);
        android.content.ContentResolver resolver = getContentResolver();
        try {
            job.reader = TEXT_IMPORT_READERS.submit(() -> {
                String text;
                try (InputStream in = resolver.openInputStream(uri)) {
                    text = readImportedText(in);
                } catch (IOException | RuntimeException e) {
                    ui.post(() -> {
                        if (!finishTextImport(job, false) || isFinishing() || isDestroyed()
                                || activeSession != target) return;
                        String hint = e instanceof java.nio.charset.CharacterCodingException
                                ? "只支持 UTF-8 文本" : (e instanceof SecurityException ? "没有读取权限" : e.getMessage());
                        Toast.makeText(this, "导入失败：" + (hint == null ? "文件无法读取" : hint), Toast.LENGTH_LONG).show();
                    });
                    return;
                }
                ui.post(() -> {
                    if (finishTextImport(job, false)) previewImportedText(target, text);
                });
            });
        } catch (java.util.concurrent.RejectedExecutionException busy) {
            finishTextImport(job, false);
            Toast.makeText(this, "文件提供方仍在读取，请稍后重试", Toast.LENGTH_LONG).show();
        }
    }

    private boolean finishTextImport(TextImport job, boolean cancel) {
        if (job == null || textImport != job) return false;
        textImport = null;
        textImportTarget = null;
        ui.removeCallbacks(job.timeout);
        if (cancel && job.reader != null) job.reader.cancel(true);
        job.dialog.dismiss();
        return true;
    }

    private void previewImportedText(Session target, String text) {
        if (isFinishing() || isDestroyed() || target != activeSession || activeTurn != null) return;
        int end = text.offsetByCodePoints(0, Math.min(600, text.codePointCount(0, text.length())));
        new AlertDialog.Builder(this)
                .setTitle("导入文本预览")
                .setMessage(text.substring(0, end) + (end < text.length() ? "\n…（仅显示开头）" : "")
                        + "\n\n插入后可以编辑。只有点发送，文本才会随消息发送给当前模型。")
                .setNegativeButton("取消", null)
                .setPositiveButton("插入草稿", (dialog, which) -> {
                    if (target != activeSession || activeTurn != null) return;
                    if (input.length() > 0) input.append("\n\n");
                    input.append(text);
                    input.setSelection(input.length());
                }).show();
    }

    /** 选一首手机里的歌，拷进 App 私有目录再播（换了手机也还在，除非卸载） */
    private void pickMusic() {
        Intent i = new Intent(Intent.ACTION_GET_CONTENT);
        i.setType("audio/*");
        i.addCategory(Intent.CATEGORY_OPENABLE);
        try {
            startActivityForResult(i, REQ_MUSIC);
        } catch (Exception e) {
            Toast.makeText(this, "这台手机没有可用的选歌界面", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_TEXT) {
            textPickerOpen = false;
            Session target = textImportTarget;
            if (res == RESULT_OK && target != null && target == activeSession
                    && data != null && data.getData() != null) {
                importText(data.getData(), target);
            } else {
                textImportTarget = null;
                if (res == RESULT_OK) {
                    Toast.makeText(this, "无法确认导入目标，请重新选择文件", Toast.LENGTH_SHORT).show();
                }
            }
            return;
        }
        if (res != RESULT_OK || data == null || data.getData() == null) return;
        if (req == REQ_VIDEO) {
            onPickedVideo(data);
            return;
        }
        if (req != REQ_MUSIC) return;
        try (InputStream in = getContentResolver().openInputStream(data.getData())) {
            File dir = new File(getFilesDir(), "music");
            if (!dir.exists()) dir.mkdirs();
            File dest = new File(dir, "bg-" + System.currentTimeMillis() + ".m4a");
            try (java.io.FileOutputStream out = new java.io.FileOutputStream(dest)) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
            sp.edit().putString(K_MUSIC_FILE, dest.getAbsolutePath()).putBoolean(K_MUSIC_ON, true).apply();
            restartMusic();
            Toast.makeText(this, "换好了", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "这首读不出来：" + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (player == null) restartMusic();
        // 视频回来：onPause 时画面被 pause 了，这里得重新铺（Surface 也重建了）
        if (videoMp == null) startVideoBackdrop();
    }

    @Override
    protected void onPause() {
        super.onPause();
        // 切出去就停，别在后台一直响
        stopMusic();
        // 视频也收：MediaPlayer 在后台解 7MB 的 H.264 是纯耗电
        stopVideoBackdrop();
    }

    @Override
    protected void onDestroy() {
        finishTextImport(textImport, true);
        cancelActiveTurn();
        ui.removeCallbacksAndMessages(null);
        stopMusic();
        stopVideoBackdrop();
        super.onDestroy();
    }

    private TextView label(String s) {
        TextView v = Ui.text(this, s, 12.5f, Ui.DIM, true);
        LinearLayout.LayoutParams lp2 = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp2.topMargin = Ui.dp(this, 12);
        v.setLayoutParams(lp2);
        return v;
    }

    private void confirmClear() {
        if (activeTurn != null) return;
        Session target = activeSession;
        new AlertDialog.Builder(this)
                .setTitle("清空当前会话")
                .setMessage("只清空这个会话的聊天记录；其他会话和模型设置不受影响。")
                .setPositiveButton("清空", (d, w) -> {
                    if (activeTurn != null || activeSession != target) return;
                    target.messages = new JSONArray();
                    save();
                    render();
                })
                .setNegativeButton("算了", null)
                .show();
    }

    // ────────────────────────────── 发消息 ──────────────────────────────

    private void send() {
        if (activeTurn != null) return;
        String text = input.getText().toString().trim();
        if (text.isEmpty()) return;

        String key = sp.getString(K_KEY, "").trim();
        if (key.isEmpty()) {
            Toast.makeText(this, "请先填写模型密钥", Toast.LENGTH_LONG).show();
            showSettings();
            return;
        }

        String base = sp.getString(K_BASE, DEFAULT_BASE);
        String url = chatUrl(base);
        String sys = sp.getString(K_SYS, "").trim();
        Session target = activeSession;
        String model = modelFor(target);
        ThinkingSupport support = thinkingSupport(base, model);
        Turn turn;
        try {
            JSONArray requestMessages = new JSONArray();
            String memory = sp.getBoolean(K_SEND_LOCAL_MEMORY, false)
                    ? sp.getString(K_LOCAL_MEMORY, "").trim() : "";
            String systemContext = sys;
            if (!memory.isEmpty()) {
                systemContext += (systemContext.isEmpty() ? "" : "\n\n") + "用户手动填写的本机记忆：\n" + memory;
            }
            if (!systemContext.isEmpty()) {
                requestMessages.put(new JSONObject().put("role", "system").put("content", systemContext));
            }
            for (int i = 0; i < target.messages.length(); i++) requestMessages.put(target.messages.getJSONObject(i));
            JSONObject user = new JSONObject().put("role", "user").put("content", text);
            requestMessages.put(user);
            JSONObject body = new JSONObject().put("model", model).put("messages", requestMessages).put("stream", true);
            applyThinking(body, support, target.thinking);
            turn = new Turn(target, url, key, body.toString().getBytes(StandardCharsets.UTF_8));
            target.messages.put(user);
        } catch (JSONException e) {
            Toast.makeText(this, "无法组装聊天请求", Toast.LENGTH_LONG).show();
            return;
        }

        activeTurn = turn;
        setBusy(true);
        input.setText("");
        save();
        render();
        turn.bubble = addBubble("assistant", "正在等待回复…");
        new Thread(() -> runTurn(turn), "local-chat").start();
    }

    private void setBusy(boolean busy) {
        sendBtn.setText(busy ? "停止" : "发送");
        input.setEnabled(!busy);
        sessionsBtn.setEnabled(!busy);
        modelBtn.setEnabled(!busy);
        thinkingBtn.setEnabled(!busy);
    }

    private void stopTurn() {
        Turn turn = cancelActiveTurn();
        if (turn == null) return;
        removeReplyBubble(turn);
        setBusy(false);
    }

    private Turn cancelActiveTurn() {
        Turn turn = activeTurn;
        if (turn == null) return null;
        turn.cancelled = true;
        activeTurn = null;
        HttpURLConnection connection = turn.connection;
        if (connection != null) {
            // disconnect 可能等待网络流关闭，不能阻塞界面线程。
            new Thread(connection::disconnect, "local-chat-cancel").start();
        }
        return turn;
    }

    private boolean isCurrentTurn(Turn turn) {
        return !turn.cancelled && activeTurn == turn && activeSession == turn.session && !isFinishing();
    }

    private void updateReply(Turn turn, String reply) {
        boolean atBottom = !scroll.canScrollVertically(1);
        turn.bubble.setText(reply);
        if (atBottom) scroll.post(() -> {
            if (!turn.cancelled && activeSession == turn.session) scroll.fullScroll(View.FOCUS_DOWN);
        });
    }

    private void removeReplyBubble(Turn turn) {
        View bubbleRow = (View) turn.bubble.getParent().getParent();
        list.removeView(bubbleRow);
    }

    private void runTurn(Turn turn) {
        String reply = null;
        String error = null;
        try {
            reply = askModel(turn, new Consumer<CharSequence>() {
                private long lastUpdate;

                @Override
                public void accept(CharSequence text) {
                    long now = System.nanoTime();
                    if (turn.cancelled || (lastUpdate != 0 && now - lastUpdate < 40_000_000L)) return;
                    lastUpdate = now;
                    String snapshot = text.toString();
                    ui.post(() -> {
                        if (isCurrentTurn(turn)) updateReply(turn, snapshot);
                    });
                }
            });
        } catch (Exception e) {
            error = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
        }
        if (turn.cancelled) return;
        String finalReply = reply;
        String finalError = error;
        ui.post(() -> finishTurn(turn, finalReply, finalError));
    }

    private void finishTurn(Turn turn, String reply, String error) {
        if (!isCurrentTurn(turn)) return;
        activeTurn = null;
        setBusy(false);
        if (reply != null) {
            try {
                turn.session.messages.put(new JSONObject().put("role", "assistant").put("content", reply));
                updateReply(turn, reply);
                save();
                return;
            } catch (JSONException e) {
                error = "无法保存模型回复";
            }
        }
        // 未完成的回复不进入历史或下一次模型上下文。
        boolean atBottom = !scroll.canScrollVertically(1);
        removeReplyBubble(turn);
        addBubble("error", "回复未完成：" + error);
        if (atBottom) scroll.post(() -> scroll.fullScroll(View.FOCUS_DOWN));
    }

    private static String askModel(Turn turn, Consumer<CharSequence> progress) throws Exception {
        turn.throwIfCancelled();
        HttpURLConnection c = (HttpURLConnection) new URL(turn.url).openConnection();
        turn.connection = c;
        try {
            turn.throwIfCancelled();
            c.setRequestMethod("POST");
            c.setConnectTimeout(20000);
            c.setReadTimeout(180000);
            c.setInstanceFollowRedirects(false);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            c.setRequestProperty("Authorization", "Bearer " + turn.key);
            c.setRequestProperty("Accept", "text/event-stream, application/json");
            c.setFixedLengthStreamingMode(turn.payload.length);
            turn.throwIfCancelled();
            try (OutputStream os = c.getOutputStream()) {
                turn.throwIfCancelled();
                os.write(turn.payload);
            }

            turn.throwIfCancelled();
            int code = c.getResponseCode();
            turn.throwIfCancelled();
            if (code < 200 || code >= 300) {
                String brief = "";
                InputStream err = c.getErrorStream();
                if (err != null) {
                    try (InputStreamReader reader = new InputStreamReader(err, StandardCharsets.UTF_8)) {
                        char[] buffer = new char[300];
                        int count = reader.read(buffer);
                        if (count > 0) brief = new String(buffer, 0, count).replaceAll("\\s+", " ").trim();
                    }
                }
                throw new IOException("接口返回 " + code + (brief.isEmpty() ? "" : "：" + brief));
            }
            try (InputStream in = c.getInputStream()) {
                return readReply(turn, in, progress);
            }
        } finally {
            c.disconnect();
            turn.connection = null;
        }
    }

    private static String readReply(Turn turn, InputStream in, Consumer<CharSequence> progress) throws Exception {
        BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
        String line = readReplyLine(turn, reader);
        if (line != null && line.startsWith("\uFEFF")) line = line.substring(1);
        while (line != null && line.trim().isEmpty()) line = readReplyLine(turn, reader);
        if (line == null) throw new IOException("接口没有返回内容");
        if (line.trim().startsWith("{")) {
            StringBuilder json = new StringBuilder(line);
            while ((line = readReplyLine(turn, reader)) != null) json.append('\n').append(line);
            JSONObject choice = firstChoice(new JSONObject(json.toString()));
            JSONObject message = choice == null ? null : choice.optJSONObject("message");
            String content = messageText(message, "content");
            return requireReply(content.isEmpty() ? messageText(message, "reasoning_content") : content);
        }

        StringBuilder data = new StringBuilder();
        StringBuilder content = new StringBuilder();
        StringBuilder reasoning = new StringBuilder();
        while (true) {
            if (line == null || line.isEmpty()) {
                if (data.length() > 0) {
                    if ("[DONE]".equals(data.toString().trim())) break;
                    JSONObject choice = firstChoice(new JSONObject(data.toString()));
                    if (choice != null) {
                        JSONObject delta = choice.optJSONObject("delta");
                        String part = messageText(delta, "content");
                        String thought = messageText(delta, "reasoning_content");
                        if (!part.isEmpty()) {
                            content.append(part);
                            progress.accept(content);
                        } else if (content.length() == 0 && !thought.isEmpty()) {
                            reasoning.append(thought);
                            progress.accept(reasoning);
                        }
                        if (!messageText(choice, "finish_reason").isEmpty()) break;
                    }
                    data.setLength(0);
                }
                if (line == null) throw new IOException("连接在回复结束前断开，未保存这次回复");
            } else if (line.equals("data") || line.startsWith("data:")) {
                String value = line.equals("data") ? "" : line.substring(5);
                if (value.startsWith(" ")) value = value.substring(1);
                data.append(value).append('\n');
            }
            line = readReplyLine(turn, reader);
        }
        return requireReply((content.length() > 0 ? content : reasoning).toString());
    }

    private static String readReplyLine(Turn turn, BufferedReader reader) throws IOException {
        turn.throwIfCancelled();
        return reader.readLine();
    }

    private static JSONObject firstChoice(JSONObject event) throws IOException {
        Object error = event.opt("error");
        if (error != null && error != JSONObject.NULL) {
            String message = error instanceof JSONObject ? messageText((JSONObject) error, "message") : String.valueOf(error);
            throw new IOException(message.isEmpty() ? "模型接口返回了错误" : message.substring(0, Math.min(300, message.length())));
        }
        JSONArray choices = event.optJSONArray("choices");
        return choices == null ? null : choices.optJSONObject(0);
    }

    private static String messageText(JSONObject object, String field) {
        Object value = object == null ? null : object.opt(field);
        return value instanceof String ? (String) value : "";
    }

    private static String requireReply(String text) throws IOException {
        if (text.isEmpty()) throw new IOException("模型这次没有返回可显示的内容");
        return text;
    }

    private static String chatUrl(String base) {
        String url = base.trim();
        while (url.endsWith("/")) url = url.substring(0, url.length() - 1);
        return url.endsWith("/chat/completions") ? url : url + "/chat/completions";
    }

    private static ThinkingSupport thinkingSupport(String base, String model) {
        // 与桌面实测映射一致，只在官方端点的这个模型上提供关闭选项。
        try {
            URI endpoint = new URI(base.trim());
            if ("https".equalsIgnoreCase(endpoint.getScheme())
                    && "api.deepseek.com".equalsIgnoreCase(endpoint.getHost())
                    && (endpoint.getPort() == -1 || endpoint.getPort() == 443)
                    && "deepseek-flash".equals(model)) {
                return ThinkingSupport.DEEPSEEK;
            }
        } catch (URISyntaxException ignored) {
            return ThinkingSupport.NONE;
        }
        return ThinkingSupport.NONE;
    }

    private static void applyThinking(JSONObject body, ThinkingSupport support, ThinkingLevel selection)
            throws JSONException {
        if (support.validate(selection) == ThinkingLevel.OFF) {
            body.put("thinking", new JSONObject().put("type", "disabled"));
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
        if (storeReadOnly) return;
        FileOutputStream out = null;
        try {
            JSONArray entries = new JSONArray();
            for (Session session : sessions) {
                JSONObject entry = new JSONObject().put("id", session.id).put("messages", session.messages);
                if (!session.modelOverride.isEmpty()) entry.put("modelOverride", session.modelOverride);
                if (session.thinking != ThinkingLevel.DEFAULT) entry.put("thinking", session.thinking.id);
                entries.put(entry);
            }
            JSONObject data = new JSONObject().put("version", STORE_VERSION)
                    .put("activeSessionId", activeSession.id).put("sessions", entries);
            out = store.startWrite();
            out.write(data.toString().getBytes(StandardCharsets.UTF_8));
            store.finishWrite(out);
        } catch (Exception e) {
            if (out != null) store.failWrite(out);
            Toast.makeText(this, "聊天存档写入失败", Toast.LENGTH_LONG).show();
        }
    }

    private void loadHistory() {
        try {
            String raw = StandardCharsets.UTF_8.newDecoder()
                    .decode(ByteBuffer.wrap(store.readFully())).toString();
            JSONTokener input = new JSONTokener(raw);
            Object data = input.nextValue();
            if (input.nextClean() != 0 || input.more() || raw.indexOf('\0') >= 0) {
                throw new JSONException("存档含无效内容");
            }
            if (data instanceof JSONArray) {
                JSONArray messages = validateMessages((JSONArray) data);
                activeSession = new Session(UUID.randomUUID().toString(), messages);
                sessions.add(activeSession);
                save();
                return;
            }
            if (!(data instanceof JSONObject)) throw new JSONException("未知的存档格式");
            JSONObject root = (JSONObject) data;
            if (!Integer.valueOf(STORE_VERSION).equals(root.opt("version"))) {
                throw new JSONException("未知的存档版本");
            }
            Object activeId = root.opt("activeSessionId");
            JSONArray entries = root.getJSONArray("sessions");
            List<Session> loaded = new ArrayList<>();
            Set<String> ids = new HashSet<>();
            Session selected = null;
            for (int i = 0; i < entries.length(); i++) {
                JSONObject entry = entries.getJSONObject(i);
                Object id = entry.opt("id");
                if (!(id instanceof String) || ((String) id).isEmpty() || !ids.add((String) id)) {
                    throw new JSONException("无效或重复的会话编号");
                }
                Session session = new Session((String) id, validateMessages(entry.getJSONArray("messages")));
                session.modelOverride = messageText(entry, "modelOverride").trim();
                session.thinking = ThinkingLevel.fromId(messageText(entry, "thinking"));
                loaded.add(session);
                if (session.id.equals(activeId)) selected = session;
            }
            if (loaded.isEmpty()) throw new JSONException("存档没有会话");
            sessions.addAll(loaded);
            activeSession = selected != null ? selected : loaded.get(0);
            return;
        } catch (FileNotFoundException e) {
            File base = store.getBaseFile();
            storeReadOnly = base.exists() || new File(base.getPath() + ".bak").exists();
        } catch (Exception e) {
            storeReadOnly = true;
        }
        activeSession = new Session(UUID.randomUUID().toString(), new JSONArray());
        sessions.add(activeSession);
        // Persist the first session before an external picker can recreate this Activity.
        if (!storeReadOnly) save();
    }

    private static JSONArray validateMessages(JSONArray messages) throws JSONException {
        for (int i = 0; i < messages.length(); i++) {
            JSONObject message = messages.getJSONObject(i);
            Object role = message.opt("role");
            if ((!"user".equals(role) && !"assistant".equals(role))
                    || !(message.opt("content") instanceof String)) {
                throw new JSONException("无效的聊天消息");
            }
        }
        return messages;
    }
}
