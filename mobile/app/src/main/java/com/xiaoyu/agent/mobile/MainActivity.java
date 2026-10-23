package com.xiaoyu.agent.mobile;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.KeyEvent;
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
        root.removeAllViews();
        parkWeb();

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
        final EditText addr = Ui.input(this, "192.168.1.100:8787", true);
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

        root.addView(Ui.scroll(this, col, false),
                new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
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
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) {
            web.onResume();
            web.resumeTimers();
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
