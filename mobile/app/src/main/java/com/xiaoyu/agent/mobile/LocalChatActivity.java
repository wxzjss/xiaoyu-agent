package com.xiaoyu.agent.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Typeface;
import android.media.MediaPlayer;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.SeekBar;
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

    /** APK 里自带的那段视频，跟连接页共用一份（assets/bg-video.mp4，约 7MB） */
    private static final String ASSET_BUNDLED_VIDEO = "bg-video.mp4";

    private static final String DEFAULT_BASE = "https://api.deepseek.com/v1";
    private static final String DEFAULT_MODEL = "deepseek-chat";

    private SharedPreferences sp;

    private LinearLayout list;          // 消息都挂这儿
    private ScrollView scroll;
    private EditText input;
    private Button sendBtn;
    private TextView subtitle;

    /** 视频背景那三层：画面在最底下，上面盖压暗层，再上面才是聊天内容 */
    private FrameLayout root;
    private SurfaceView videoSurface;
    private MediaPlayer videoMp;
    private View veil;
    /** 聊天内容那一大块（顶栏+消息区+输入条）。它自己是透明的，才透得出下面的画面 */
    private LinearLayout page;

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
        // 根容器换成 FrameLayout：视频背景要垫在最底下，聊天内容压在上面。
        // page 自己不画底色（透明），中间那层压暗由 veil 负责 —— 这样才透得出画面。
        root = new FrameLayout(this);
        root.setBackgroundColor(Ui.BG);

        page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setBackgroundColor(android.graphics.Color.TRANSPARENT);

        // ---- 顶栏 ----
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        int bp = Ui.dp(this, 12);
        bar.setPadding(bp, Ui.dp(this, 10), bp, Ui.dp(this, 10));
        // 顶栏做半透明：全不透明的面板色会把顶上一条视频糊死，看着像 bug
        bar.setBackgroundColor(Ui.panelAlpha(72));

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

        // 外观 / 背景音乐
        Button look = Ui.button(this, "外观", false);
        look.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        look.setMinHeight(Ui.dp(this, 38));
        LinearLayout.LayoutParams lkp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lkp.leftMargin = Ui.dp(this, 8);
        look.setOnClickListener(v -> showLook());
        bar.addView(look, lkp);

        page.addView(bar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

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

        // ---- 输入条 ----
        LinearLayout bar2 = new LinearLayout(this);
        bar2.setOrientation(LinearLayout.HORIZONTAL);
        bar2.setGravity(Gravity.BOTTOM);
        int p2 = Ui.dp(this, 10);
        bar2.setPadding(p2, p2, p2, p2);
        bar2.setBackgroundColor(Ui.panelAlpha(72));

        input = new EditText(this);
        input.setHint("跟小鱼说点什么…");
        input.setHintTextColor(0xFF6b7484);
        input.setTextColor(Ui.TEXT);
        input.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        input.setBackground(Ui.roundStroke(0xCC0b0e13, Ui.LINE, 10, this));
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

        // 组装：视频层 + 压暗层 + 聊天内容，三层从下往上摞
        root.addView(page, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        startVideoBackdrop();   // 它自己会把自己插到 root 的第 0 层（压在 page 底下）
        setContentView(root);
    }

    /** 把一整段对话重画一遍。条数不多（就一段聊天），全量重画最省事也最不容易错。 */
    private void render() {
        list.removeAllViews();

        if (msgs.length() == 0) {
            // 空状态这几行直接压在视频上，字会糊在画面里 —— 套一层半透明底再放
            TextView empty = Ui.text(this,
                    "这里不连电脑，也不会念记忆。\n"
                            + "点右上角「模型设置」填上接口地址、密钥和模型名就能用。\n\n"
                            + "要记忆、要工具、要连着电脑那套会话，回上一页连电脑。",
                    13, 0xFF98a2b3, false);
            empty.setGravity(Gravity.CENTER);
            empty.setLineSpacing(Ui.dp(this, 5), 1f);
            int ep = Ui.dp(this, 20);
            empty.setPadding(ep, Ui.dp(this, 18), ep, Ui.dp(this, 18));
            empty.setBackground(Ui.round(0xB80b0e13, 14, this));

            LinearLayout wrap = new LinearLayout(this);
            wrap.setOrientation(LinearLayout.VERTICAL);
            int wp = Ui.dp(this, 28);
            wrap.setPadding(wp, Ui.dp(this, 40), wp, wp);
            wrap.addView(empty, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            list.addView(wrap);
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
        cvOn.setText("播视频背景");
        cvOn.setTextColor(Ui.TEXT);
        cvOn.setChecked(sp.getBoolean(K_VIDEO_ON, true));
        col.addView(cvOn);

        TextView videoNow = Ui.text(this, "", 12f, Ui.DIM, false);
        videoNow.setLineSpacing(Ui.dp(this, 3), 1f);
        col.addView(videoNow);

        col.addView(label("背景暗度"));
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
            // 删掉自己挑的那段，退回 APK 自带的
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
        String name = TextUtils.isEmpty(f) ? "自带的壁纸视频" : new File(f).getName();
        tv.setText(on ? "现在放的是：" + name : "已关闭。上次放的是：" + name);
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

    /** 现在该播哪个视频文件：自己挑的优先，否则 APK 自带的 */
    private File pickVideoFile() {
        String f = sp.getString(K_VIDEO_FILE, "");
        if (!TextUtils.isEmpty(f)) {
            File mine = new File(f);
            if (mine.exists() && mine.length() > 0) return mine;
            // 挑的那段被删了：悄悄退回自带的，别弹框
        }
        return assetToCache(ASSET_BUNDLED_VIDEO);
    }

    /**
     * 铺上视频背景。以前这里是空的，还留了一句「视频不在手机上」——
     * 那是 0.9.11 之前的事：现在 bg-video.mp4 就打进 APK 里（连接页一直在用），
     * 本地模式当然也该有。原生的 SurfaceView + MediaPlayer，跟连接页同一套写法。
     *
     * 失败一律静默降级成纯色底：背景是装饰，不能因为它崩了聊天。
     */
    private void startVideoBackdrop() {
        stopVideoBackdrop();
        if (!sp.getBoolean(K_VIDEO_ON, true)) return;

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
            // 插到第 0 层：page 早就加进 root 了，不指定 index 的话视频会盖住整个聊天
            root.addView(sv, 0, new FrameLayout.LayoutParams(
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
