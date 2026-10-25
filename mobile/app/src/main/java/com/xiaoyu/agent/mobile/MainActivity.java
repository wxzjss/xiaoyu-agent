package com.xiaoyu.agent.mobile;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import com.xiaoyu.agent.mobile.ui.Ui;

/**
 * 小鱼Agent 手机端。
 *
 * 设计上只有一层：WebView 里跑的就是电脑端那个界面。
 * 这样电脑上改了界面、加了功能，手机上刷新一下就跟上了，不用维护两套 UI。
 * 壳自己负责三件事：记住连哪台电脑、把配对码塞进请求头、断线了给个能重试的提示页。
 */
public class MainActivity extends Activity {

    private static final String URL_PAGE = "/?mobile=1";
    /** 手机端是单手竖屏，给电脑端页面塞个标记，方便以后按需微调（不塞也不影响） */
    private WebView web;
    private FrameLayout root;
    private View errorView;
    private TextView errorText;
    private boolean loadedOnce = false;
    private String lastError = "";
    /**
     * 页面还活着、只是被从屏幕上摘下来时置 true。
     *
     * 为什么要有这个：以前按返回键回连接页会直接 web.destroy()，
     * 页面的 JS 连同正在读的那条 fetch 流一起没了——电脑那边还在跑，
     * 手机上却已经断了，回来只能重新加载，看着就像「一切换就中断」。
     * 现在改成只 detach（removeView），WebView 连同它的 JS 环境留在内存里，
     * 回来的时候原样挂上去：正在跑的那一轮继续跑，滚动位置和输入框内容也都还在。
     */
    private boolean webParked = false;

    private ValueCallback<Uri[]> fileCallback;
    private static final int REQ_FILE = 4242;
    private static final int REQ_CAMERA = 4243;

    // ── 连接页自己的背景 ──────────────────────────────────────────────
    /**
     * 这三个是连接页的背景，素材都打在 APK 里，联网前后都在，不依赖电脑。
     *
     * 以前连接页就是一块纯深灰 —— 明明音乐都打进包了，一打开却是「没做完的半成品」。
     * 现在跟聊天界面一样有动着的背景，只是画的人不一样：
     *   连接页 → 这里的 SurfaceView + MediaPlayer（原生）
     *   聊天页 → 网页自己那套（跟电脑端同步的那个视频和音乐）
     * 进网页前一定要 stopPageBackdrop()，否则两边会一起响。
     *
     * 为什么不用 VideoView：它读不了 assets/ 里的文件。
     * setVideoURI("file:///android_asset/...") 会直接
     * `Unable to open content` → `IOException: setDataSource failed`，
     * 表面上看是「背景没出来」，其实一个字节都没读到。
     * 只有 SurfaceView + MediaPlayer.setDataSource(fd, offset, length) 这条路能读 assets。
     */
    private SurfaceView backSurface = null;
    private MediaPlayer backVideoMp = null;
    private MediaPlayer backMusic = null;
    /** backMusic 是否已经 onPrepared —— 没准备好的播放器不能 start，会报 -38 */
    private boolean backMusicReady = false;

    private static final String ASSET_BG_VIDEO = "bg-video.mp4";
    private static final String ASSET_BG_MUSIC = "bg-music.m4a";

    private final Handler ui = new Handler(Looper.getMainLooper());

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window w = getWindow();
        w.setStatusBarColor(Ui.BG);
        w.setNavigationBarColor(Ui.BG);
        w.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);

        root = new FrameLayout(this);
        root.setBackgroundColor(Ui.BG);
        setContentView(root);

        showConnectScreen(false);
    }

    // ────────────────────────────── 连接页 ──────────────────────────────

    /**
     * 连接页。first=false 时顶部加一行「换个地址」，不吓人。
     */
    private void showConnectScreen(boolean first) {
        // 回到连接页 = 一定要把网页那套背景停掉，不然它还在后台放音乐，
        // 跟下面新起的原生背景撞在一起。
        stopWebBackdrop();
        root.removeAllViews();
        parkWeb();

        // 先铺背景层（视频 + 一层压暗），再把表单盖在最上面。
        // 顺序很重要：FrameLayout 后加的在上层。
        startPageBackdrop();

        LinearLayout col = Ui.column(this, 0);
        col.setGravity(Gravity.CENTER_HORIZONTAL);

        TextView title = Ui.text(this, "小鱼Agent", 30, Ui.TEXT, true);
        title.setGravity(Gravity.CENTER);
        col.addView(title);

        TextView sub = Ui.text(this, "连电脑上那一台，会话、记忆、模型都是那边的", 13.5f, Ui.DIM, false);
        sub.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        sp.topMargin = Ui.dp(this, 8);
        col.addView(sub, sp);

        col.addView(Ui.spacer(this, 26));

        TextView labAddr = Ui.text(this, "电脑地址", 12.5f, Ui.DIM, true);
        col.addView(labAddr);
        final EditText addr = Ui.input(this, "192.168.1.5:8787", true);
        addr.setText(Prefs.base(this).replace("http://", "").replace("https://", ""));
        LinearLayout.LayoutParams ap = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        ap.topMargin = Ui.dp(this, 6);
        col.addView(addr, ap);

        col.addView(Ui.spacer(this, 14));

        TextView labTok = Ui.text(this, "配对码", 12.5f, Ui.DIM, true);
        col.addView(labTok);
        final EditText tok = Ui.input(this, "电脑上【设置 → 手机连接】里那串", true);
        tok.setText(Prefs.token(this));
        LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tp.topMargin = Ui.dp(this, 6);
        col.addView(tok, tp);

        col.addView(Ui.spacer(this, 10));

        TextView scan = Ui.text(this, "有二维码的话点这里扫一下，两样都自动填", 13, Ui.ACCENT, true);
        scan.setPadding(0, Ui.dp(this, 6), 0, Ui.dp(this, 6));
        scan.setOnClickListener(v -> startScan(addr, tok));
        col.addView(scan);

        col.addView(Ui.spacer(this, 18));

        final ButtonHolder bh = new ButtonHolder();
        bh.btn = Ui.button(this, "连上", true);
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        col.addView(bh.btn, bp);

        final TextView status = Ui.text(this, "", 12.5f, Ui.DIM, false);
        status.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams stp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        stp.topMargin = Ui.dp(this, 14);
        col.addView(status, stp);

        bh.btn.setOnClickListener(v -> {
            final String base = Prefs.normalize(addr.getText().toString());
            final String token = tok.getText().toString().trim();
            if (base.isEmpty()) {
                status.setTextColor(Ui.RED);
                status.setText("先填电脑地址");
                return;
            }
            bh.btn.setEnabled(false);
            bh.btn.setText("正在连…");
            status.setTextColor(Ui.DIM);
            status.setText("问一下 " + base);
            Probe.run(base, token, (ok, msg, guessToken) -> {
                bh.btn.setEnabled(true);
                bh.btn.setText("连上");
                if (ok) {
                    Prefs.save(this, base, token, msg);
                    status.setTextColor(0xFF7fd18b);
                    status.setText("连上了 · " + msg);
                    openChat();
                } else {
                    status.setTextColor(Ui.RED);
                    status.setText(msg);
                }
            });
        });

        // 回车就直接连，省得还要伸手点按钮
        addr.setOnEditorActionListener((v, actionId, ev) -> {
            if (ev != null && ev.getKeyCode() == KeyEvent.KEYCODE_ENTER) {
                bh.btn.performClick();
                return true;
            }
            return false;
        });

        TextView tip = Ui.text(this,
                "电脑端：设置 → 手机连接 → 开启局域网。\n"
                        + "手机和电脑同一个 Wi-Fi 能连；两边都开着 Radmin 这类组网工具，出门用流量也能连。",
                12, 0xFF6b7484, false);
        tip.setGravity(Gravity.CENTER);
        tip.setLineSpacing(Ui.dp(this, 3), 1f);
        LinearLayout.LayoutParams ttp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        ttp.topMargin = Ui.dp(this, 28);
        col.addView(tip, ttp);

        /**
         * 不连电脑的入口。
         *
         * 电脑没开机、人在外面、或者只是想拿手机问两句的时候，别逼着先去配电脑——
         * 这里进去自己填模型地址和密钥，直接用手机跟模型说话。
         */
        col.addView(Ui.spacer(this, 22));
        Button localBtn = Ui.button(this, "不连电脑，手机上直接用", false);
        LinearLayout.LayoutParams lbp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        col.addView(localBtn, lbp);
        localBtn.setOnClickListener(v -> {
            try {
                startActivity(new Intent(this, LocalChatActivity.class));
            } catch (Exception e) {
                Toast.makeText(this, "打不开本地模式：" + e.getMessage(), Toast.LENGTH_LONG).show();
            }
        });

        // 连接页这一层必须**透明**：Ui.scroll() 默认刷的是不透明的 BG，
        // 而它铺满整屏、又盖在背景视频和压暗层上面 —— 之前背景明明在放
        // （dumpsys media.player 里能看到 mime(video/avc) state(5) looping(1)），
        // 屏幕上却一片黑，就是被这层死板的底色挡死了。
        // 透明之后画面才透得上来；字能不能看清交给下面那块半透明卡片。
        ScrollView page = Ui.scroll(this, col, false);
        page.setBackgroundColor(0x00000000);
        // 表单本身垫一层半透明深色卡片，保证任何背景下字都读得清
        col.setBackgroundColor(0x660b0e13);
        int cardPad = Ui.dp(this, 18);
        col.setPadding(cardPad, cardPad, cardPad, cardPad);
        root.addView(page,
                new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    // ────────────────────── 连接页背景（视频 + 音乐） ──────────────────────
    /**
     * 起连接页的背景：底层一段循环视频，上面压一层半透明深色（保证字看得清），
     * 再来一首背景音乐。
     *
     * 两边都出错就静默退化成纯色底 —— 不能让「背景播不了」把登录这件事也拖下水。
     */
    /**
     * 把 assets 里的大媒体文件摊到缓存目录，返回那个真实文件的路径（失败了返回 null）。
     *
     * 为什么非得走这一步：
     *   1) VideoView.setVideoURI("file:///android_asset/x.mp4") 读不了 assets，
     *      日志里是 `Unable to open content ... setDataSource failed`。
     *   2) MediaPlayer.setDataSource(fd, offset, length) 理论可行，但 aapt 打包时
     *      assets 里的文件**可能被压缩**，那时 offset/length 指向的是压缩流，
     *      MediaPlayer 解出来是乱码，报 `error (-38, 0)`（MEDIA_ERROR_UNKNOWN）。
     *      .mp4 虽然一般在 aapt 的白名单里不压，但依赖这个默认值不稳。
     *   3) 摊成真实文件之后就是普通文件路径，任何播放器都认，一次解决三条路。
     * 文件已经摊过且字节数对得上就直接复用，不重复拷 7MB。
     */
    private java.io.File assetToCache(String name) {
        try {
            java.io.File dir = new java.io.File(getCacheDir(), "bg");
            if (!dir.exists() && !dir.mkdirs()) return null;
            java.io.File out = new java.io.File(dir, name);
            long assetLen = -1;
            try {
                android.content.res.AssetFileDescriptor afd = getAssets().openFd(name);
                assetLen = afd.getLength();
                afd.close();
            } catch (Throwable ignored) {}
            if (out.exists() && out.length() > 0 && (assetLen <= 0 || out.length() == assetLen)) {
                return out;   // 已经摊好了，直接用
            }
            java.io.InputStream in = getAssets().open(name);
            java.io.FileOutputStream fos = new java.io.FileOutputStream(out);
            byte[] buf = new byte[64 * 1024];
            int n;
            long total = 0;
            while ((n = in.read(buf)) > 0) {
                fos.write(buf, 0, n);
                total += n;
            }
            fos.flush();
            fos.close();
            in.close();
            // 拷完核一下字节数，短了就是坏文件，别拿去播
            if (total <= 0 || (assetLen > 0 && total != assetLen)) {
                out.delete();
                return null;
            }
            return out;
        } catch (Throwable e) {
            return null;
        }
    }

    private void startPageBackdrop() {
        // 视频层：SurfaceView + MediaPlayer，播缓存目录里的真实文件（见 assetToCache 的注释）
        try {
            final java.io.File vfile = assetToCache(ASSET_BG_VIDEO);
            if (vfile == null) {
                // 摊不出来就干脆不画，别留一块黑
                backSurface = null;
                backVideoMp = null;
            } else {
                SurfaceView sv = new SurfaceView(this);
                sv.setLayoutParams(new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                final MediaPlayer mp = new MediaPlayer();
                final SurfaceHolder holder = sv.getHolder();
                holder.addCallback(new SurfaceHolder.Callback() {
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
                            } catch (Throwable ignored) {}
                            mp.setOnPreparedListener(m -> {
                                try { m.setVolume(0f, 0f); m.start(); } catch (Throwable ignored) {}
                            });
                            mp.setOnErrorListener((m, what, extra) -> {
                                // 解不了就把画面层藏掉，只留压暗底色，别让登录跟着挂
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
                        try { if (mp.isPlaying()) mp.pause(); } catch (Throwable ignored) {}
                    }
                });
                backSurface = sv;
                backVideoMp = mp;
                root.addView(sv);
            }
        } catch (Throwable e) {
            backSurface = null;
            backVideoMp = null;
        }

        // 压暗层：视频在下面动，字在上面看清楚（45% 不透明）
        View veil = new View(this);
        veil.setBackgroundColor(0x730b0e13);
        veil.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(veil);

        // 音乐：同样摊成真实文件再播
        try {
            java.io.File mfile = assetToCache(ASSET_BG_MUSIC);
            if (mfile == null) {
                backMusic = null;
                backMusicReady = false;
            } else {
                MediaPlayer mp = new MediaPlayer();
                mp.setDataSource(mfile.getAbsolutePath());
                mp.setLooping(true);
                float vol = 0.4f;
                try {
                    String pref = getSharedPreferences("xiaoyu_local", android.content.Context.MODE_PRIVATE)
                            .getString("musicVolume", null);
                    if (pref != null) vol = Float.parseFloat(pref);
                } catch (Throwable ignored) {}
                mp.setVolume(vol, vol);
                mp.setOnPreparedListener(m -> {
                    backMusicReady = true;
                    try { m.start(); } catch (Throwable ignored) {}
                });
                mp.setOnErrorListener((m, what, extra) -> true);
                backMusic = mp;
                backMusicReady = false;
                mp.prepareAsync();
            }
        } catch (Throwable e) {
            backMusic = null;
            backMusicReady = false;
        }
    }
    /** 连接页背景收工：离开连接页、或者 Activity 不可见时都得调。 */
    private void stopPageBackdrop() {
        if (backVideoMp != null) {
            try { backVideoMp.stop(); } catch (Throwable ignored) {}
            try { backVideoMp.release(); } catch (Throwable ignored) {}
            backVideoMp = null;
        }
        if (backSurface != null) {
            try {
                ViewGroup parent = (ViewGroup) backSurface.getParent();
                if (parent != null) parent.removeView(backSurface);
            } catch (Throwable ignored) {}
            backSurface = null;
        }
        if (backMusic != null) {
            try { if (backMusicReady && backMusic.isPlaying()) backMusic.pause(); } catch (Throwable ignored) {}
            try { backMusic.release(); } catch (Throwable ignored) {}
            backMusic = null;
        }
        backMusicReady = false;
    }
    /** 网页（聊天界面）那套背景用的是网页里的 video/audio，原生管不着它的开关；
     *  离开网页时至少得让它把声音停掉，否则回到连接页会两首一起响。 */
    private void stopWebBackdrop() {
        if (web == null) return;
        try {
            web.evaluateJavascript(
                    "(function(){try{var a=document.getElementById('bgMusic');if(a){a.pause();}var v=document.getElementById('bgVideo');if(v){v.pause();}}catch(e){}})();",
                    null);
        } catch (Throwable ignored) {}
    }

    private static class ButtonHolder {
        android.widget.Button btn;
    }

    private void startScan(EditText addr, EditText tok) {
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA);
            Toast.makeText(this, "给了相机权限再点一次", Toast.LENGTH_SHORT).show();
            return;
        }
        String why = null;
        try {
            Intent i = new Intent(this, ScanActivity.class);
            startActivityForResult(i, REQ_SCAN);
        } catch (Throwable e) {
            // 以前这里把真实原因吞了，只说「没有可用的扫码界面」，
            // 结果真正的毛病（AndroidManifest 里漏声明 ScanActivity）查了很久。
            why = e.getClass().getSimpleName() + (e.getMessage() == null ? "" : "：" + e.getMessage());
            Log.w("xiaoyu", "打不开扫码界面", e);
            Toast.makeText(this, "打不开扫码界面：" + why + "\n可以直接手填地址和配对码",
                    Toast.LENGTH_LONG).show();
        }
    }

    private static final int REQ_SCAN = 4244;

    // ────────────────────────────── 聊天 ──────────────────────────────

    private void openChat() {
        String base = Prefs.base(this);
        String token = Prefs.token(this);
        if (base.isEmpty()) {
            showConnectScreen(true);
            return;
        }

        // 进网页之前先把连接页那套原生背景停掉：视频一帧都不想多解，
        // 音乐更是必须停 —— 不然它会和网页里那首一起响。
        stopPageBackdrop();

        /**
         * 有留着的页面就直接挂回来，别重建。
         *
         * 从连接页点「连上」回来时，页面还活着——正在跑的那一轮、滚动位置、
         * 输入框里打的半句话全都在。重建等于把这一切扔掉再 loadUrl 一次，
         * 手机会重新拉一遍 index.html，看着就是「一回来就白屏转圈」。
         */
        if (web != null && webParked) {
            String curUrl = web.getUrl();
            // 还是同一台电脑 -> 直接挂回来（页面里那一轮、输入框、滚动位置都还在）
            if (curUrl != null && curUrl.startsWith(base)) {
                resumeWeb();
                return;
            }
            detachWeb();   // 换了电脑，旧页面没用了
        }
        root.removeAllViews();

        web = new WebView(this);
        web.setBackgroundColor(Ui.BG);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        // 调试开关：连着 adb 时可以 chrome://inspect 看页面、抓 JS 报错。正式版也不碍事。
        WebView.setWebContentsDebuggingEnabled(true);
        s.setDomStorageEnabled(true);           // 会话列表、滚动位置都靠 localStorage
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(false);            // 手机上看桌面版布局会缩放得太小，这里让页面自己适配
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " XiaoyuMobile/0.8");
        if (Build.VERSION.SDK_INT >= 26) s.setSafeBrowsingEnabled(false);

        /**
         * 配对码既放请求头，也放进 URL 的 ?token= 。
         *
         * 为什么非得放进 URL：loadUrl(url, Map) 的请求头**只对主框架那一个请求生效**，
         * 页面自己发的 fetch('/api/sessions') 一个都带不上。以前只靠 onPageFinished 里
         * 包 window.fetch 补救，可那是页面脚本全跑完之后才执行的 —— 页面一启动的那批请求
         * （sessions / sessions/select / chat/live）全部 401，表现就是「进得去但一片空白、
         * 或者只剩下自己发过的话」。
         *
         * 放进 query 就不一样了：页面用的是相对路径，浏览器发子请求时会自动继承当前文档的
         * query，所以 /api/xxx 天然带着 ?token=…，服务端 extractToken 认得（见 src/mobile.mjs）。
         * 代价是地址栏（手机上没有地址栏）和 server 日志里会有 token，这一台自建内网服务可以接受。
         */
        final String pairToken = token;
        final String pageUrl = token.isEmpty()
                ? base + URL_PAGE
                : base + URL_PAGE + "&token=" + android.net.Uri.encode(token);
        if (!token.isEmpty()) {
            web.loadUrl(pageUrl, java.util.Collections.singletonMap("x-mobile-token", token));
        } else {
            web.loadUrl(pageUrl);
        }

        web.setWebViewClient(new WebViewClient() {
            /**
             * 页面里所有发往这台电脑的请求都在这里补配对码。
             *
             * loadUrl(…, Map) 只对首个请求生效，页面自己 fetch('/api/chat') 是带不上的，
             * 光靠它手机连上后每条消息都会被拒绝。WebView 不允许直接改 fetch 的请求头，
             * 所以在 onPageStarted 里注入一段包装：同源请求统一加 x-mobile-token。
             * 唯一带不上的是 EventSource（它不接受自定义头），所以手机端不用它。
             */
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                String u = r.getUrl().toString();
                // 页面里有外链（比如 README、GitHub）：交给系统浏览器，别在壳里跑丢
                if (!u.startsWith(base)) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, r.getUrl()));
                    } catch (Exception ignore) {
                    }
                    return true;
                }
                return false;
            }

            /**
             * 配对码要在页面脚本开始跑之前就装上。
             *
             * onPageFinished 是「页面全部跑完」才来的，那时候页面启动要拉的那批数据
             * （sessions / sessions/select / chat/live）早就发出去了，全部 401。
             * onPageStarted 只出现在新文档开始时，evaluateJavascript 会排在该文档的脚本之前执行，
             * 正好赶上。URL 里也带了 ?token=（见 openChat），这两条路互为保险。
             */
            @Override
            public void onPageStarted(WebView v, String url, android.graphics.Bitmap favicon) {
                super.onPageStarted(v, url, favicon);
                injectToken(v, pairToken);
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                loadedOnce = true;
                lastError = "";
                notifBridge(v);
                // 再注入一次只是兜底：页面若有二次导航 / 软路由，早点晚点都得有。
                // injectToken 里有 __xyWrapped 幂等标记，重复调用是空的。
                injectToken(v, pairToken);
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (!r.isForMainFrame()) return;
                lastError = String.valueOf(e.getDescription());
                showOffline(lastError);
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            /** 页面里的 console 和 JS 异常转到 logcat —— 手机上没有控制台，只能靠这个看。 */
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage m) {
                android.util.Log.i("XyWeb", m.messageLevel() + " @" + m.lineNumber() + ": " + m.message());
                return true;
            }
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                // 电脑端页面的「＋ → 文件/图片」走的就是这里
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                try {
                    Intent i = params.createIntent();
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    startActivityForResult(i, REQ_FILE);
                    return true;
                } catch (Exception ex) {
                    fileCallback = null;
                    return false;
                }
            }

            /**
             * 放行媒体权限请求。
             *
             * 手机 WebView 里带声音的 <video>/<audio> 有时候会先问一次权限，
             * 不 grant 的话就永远不播（表现为「背景音乐点了没反应」）。
             * 这里是自己的页面，直接全放。
             */
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            request.grant(request.getResources());
                        } catch (Exception e) {
                            try {
                                request.deny();
                            } catch (Exception ignored) {
                            }
                        }
                    }
                });
            }
        });

        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    /**
     * 给网页补配对码。
     *
     * 电脑端页面并不认识手机壳，它所有的 fetch/XMLHttpRequest 都是裸调的。
     * 这里在页面加载完成后把 window.fetch 包一层：同源请求补上 x-mobile-token 头，
     * 其它请求原样放行。只改这一个函数，页面代码一个字都不用动。
     *
     * 注意：注入会随每次页面加载重新执行，所以用 __xyWrapped 做个幂等标记。
     * EventSource 不支持自定义头 —— 电脑端页面的流式对话走的是 fetch 读流，不是 EventSource，
     * 所以这里不用管；将来真加了 EventSource，改成 ?token= 查询串即可。
     */
    private void injectToken(WebView v, String token) {
        if (token == null || token.isEmpty()) return;
        String js =
                "(function(){"
                        + "if(window.__xyWrapped)return;window.__xyWrapped=1;"
                        + "var T=" + jsStr(token) + ";"
                        + "var origin=location.origin;"
                        + "var of=window.fetch;"
                        + "window.fetch=function(input,init){"
                        + "  try{"
                        + "    var u=(typeof input==='string')?input:(input&&input.url)||'';"
                        + "    var abs=new URL(u,location.href);"
                        + "    if(abs.origin===origin){"
                        + "      init=init||{};"
                        + "      var h=new Headers(init.headers||(typeof input!=='string'&&input.headers)||{});"
                        + "      if(!h.has('x-mobile-token'))h.set('x-mobile-token',T);"
                        + "      init.headers=h;"
                        + "      if(typeof input!=='string'&&input&&input.url)init.method=init.method||input.method;"
                        + "      return of.call(this,(typeof input==='string')?input:input.url,init);"
                        + "    }"
                        + "  }catch(e){}"
                        + "  return of.apply(this,arguments);"
                        + "};"
                        + "var oo=XMLHttpRequest.prototype.open;"
                        + "XMLHttpRequest.prototype.open=function(m,u){"
                        + "  this.__xyU=u;"
                        + "  var r=oo.apply(this,arguments);"
                        + "  try{"
                        + "    var abs=new URL(u,location.href);"
                        + "    if(abs.origin===origin)this.setRequestHeader('x-mobile-token',T);"
                        + "  }catch(e){}"
                        + "  return r;"
                        + "};"
                        + "})();";
        try {
            v.evaluateJavascript(js, null);
        } catch (Exception ignore) {
        }
    }

    /** 把字符串安全地塞进 JS 字面量（配对码是 base64url，理论上没有引号，但还是转义一遍）。 */
    private static String jsStr(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"' || c == '\\') b.append('\\').append(c);
            else if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
            else b.append(c);
        }
        return b.append('"').toString();
    }

    /**
     * 给网页里挂一个最薄的原生桥：只暴露「重新配对 / 这是什么设备」。
     * 不开别的口子 —— 这个 WebView 里的 JS 就是主人自己的页面，但能少一个通道就少一个。
     */
    private void notifBridge(WebView v) {
        try {
            v.addJavascriptInterface(new Object() {
                @JavascriptInterface
                public String device() {
                    return Build.MANUFACTURER + " " + Build.MODEL;
                }

                @JavascriptInterface
                public void rePair() {
                    ui.post(() -> showConnectScreen(false));
                }
            }, "XiaoyuMobile");
        } catch (Exception ignore) {
        }
    }

    /** 断线页：一句话说清 + 重试 + 换地址。手机上最常见的就是「换了 Wi-Fi」和「电脑没开」。 */
    private void showOffline(String why) {
        if (errorView != null) {
            errorText.setText(why);
            return;
        }
        root.removeAllViews();
        detachWeb();

        LinearLayout col = Ui.column(this, 0);
        col.setGravity(Gravity.CENTER_HORIZONTAL);
        TextView t = Ui.text(this, "连不上了", 24, Ui.TEXT, true);
        col.addView(t);
        col.addView(Ui.spacer(this, 10));
        errorText = Ui.text(this, why == null ? "" : why, 12.5f, Ui.DIM, false);
        errorText.setGravity(Gravity.CENTER);
        col.addView(errorText);
        col.addView(Ui.spacer(this, 6));
        TextView hint = Ui.text(this, "最常有的两种：电脑关了 / 换了 Wi-Fi 不是同一个网", 12.5f, 0xFF6b7484, false);
        hint.setGravity(Gravity.CENTER);
        col.addView(hint);

        col.addView(Ui.spacer(this, 24));
        android.widget.Button retry = Ui.button(this, "重试", true);
        col.addView(retry, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        retry.setOnClickListener(v -> {
            errorView = null;
            openChat();
        });

        col.addView(Ui.spacer(this, 10));
        android.widget.Button re = Ui.button(this, "换个地址 / 重新配对", false);
        col.addView(re, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        re.setOnClickListener(v -> {
            errorView = null;
            showConnectScreen(false);
        });

        errorView = Ui.scroll(this, col, true);
        root.addView(errorView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void detachWeb() {
        if (web != null) {
            try {
                root.removeView(web);
                web.destroy();
            } catch (Exception ignore) {
            }
            web = null;
        }
        webParked = false;
    }

    /**
     * 把页面从屏幕上摘下来，但**不销毁**。
     *
     * 正在读的 fetch 流、定时器、WebSocket 都不受影响，回来一挂就好。
     * 只对「同一次运行里来回切页面」有效；真退出 App 还是走 detachWeb()。
     */
    private void parkWeb() {
        if (web == null) return;
        try {
            root.removeView(web);
            webParked = true;
        } catch (Exception ignore) {
        }
    }

    /**
     * 回来时把留着的那一份挂回去。
     *
     * @return true 表示挂上了（调用方就不用重新 openChat）
     */
    private boolean resumeWeb() {
        if (web == null || !webParked) return false;
        webParked = false;
        try {
            root.removeAllViews();
            root.addView(web, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            // 页面里 pause/resume 会停掉 requestAnimationFrame 之类，恢复一下
            web.onResume();
            web.resumeTimers();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    // ────────────────────────────── 返回键 / 生命周期 ──────────────────────────────

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        // 在聊天页按返回 = 回连接页（不是退出 App）——手机上一不小心就退出会很烦
        if (web != null) {
            showConnectScreen(false);
            return;
        }
        super.onBackPressed();
    }

    /**
     * 退到后台时别把页面掐死。
     *
     * WebView 默认会暂停定时器、可能冻结 JS，正在跑的对话会卡在那不动，
     * 回来一看像断线了。这里只暂停「渲染」，定时器和网络继续。
     */
    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) {
            web.onPause();
            web.resumeTimers();   // 关键：定时器留着，流式输出才不会停
        }
        // 退到后台就停掉连接页的背景：视频不必在后台解，音乐也不该在别人打电话时响。
        if (backVideoMp != null) {
            try { if (backVideoMp.isPlaying()) backVideoMp.pause(); } catch (Throwable ignored) {}
        }
        if (backMusic != null && backMusicReady) {
            try { if (backMusic.isPlaying()) backMusic.pause(); } catch (Throwable ignored) {}
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) {
            web.onResume();
            web.resumeTimers();
        }
        // 回到前台，连接页还在的话接着放（网页在的时候就不管，它自己会管）
        if (web == null || webParked) {
            if (backVideoMp != null) {
                try { if (!backVideoMp.isPlaying()) backVideoMp.start(); } catch (Throwable ignored) {}
            }
            if (backMusic != null && backMusicReady) {
                try { if (!backMusic.isPlaying()) backMusic.start(); } catch (Throwable ignored) {}
            }
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_FILE) {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res, data));
                fileCallback = null;
            }
            return;
        }
        if (req == REQ_SCAN && res == RESULT_OK && data != null) {
            String text = data.getStringExtra("text");
            applyPairingText(text);
        }
    }

    /** 扫码结果：要么是整条 http://host:port/?token=xxx，要么是 xiaoyu://token */
    private void applyPairingText(String text) {
        if (text == null || text.isEmpty()) return;
        String token = null;
        String base = null;
        String t = text.trim();
        if (t.startsWith("xiaoyu://")) {
            token = Prefs.tokenFromUri(t);
        } else if (t.startsWith("http")) {
            base = Prefs.normalize(t);
            try {
                android.net.Uri u = android.net.Uri.parse(t);
                token = u.getQueryParameter("token");
            } catch (Exception ignore) {
            }
        }
        if (base == null && token == null) {
            Toast.makeText(this, "没认出这个码", Toast.LENGTH_SHORT).show();
            return;
        }
        if (token != null) Prefs.save(this, base != null ? base : Prefs.base(this), token, "");
        if (base != null) Prefs.save(this, base, token != null ? token : Prefs.token(this), "");
        Toast.makeText(this, "填好了，点「连上」", Toast.LENGTH_SHORT).show();
        showConnectScreen(false);
    }

    @Override
    protected void onDestroy() {
        stopPageBackdrop();   // 背景的 MediaPlayer 不解会漏，Activity 走了就收工
        detachWeb();
        super.onDestroy();
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] p, int[] g) {
        super.onRequestPermissionsResult(req, p, g);
        if (req == REQ_CAMERA && g.length > 0 && g[0] == PackageManager.PERMISSION_GRANTED) {
            Toast.makeText(this, "再点一次「扫一下」", Toast.LENGTH_SHORT).show();
        }
    }
}
