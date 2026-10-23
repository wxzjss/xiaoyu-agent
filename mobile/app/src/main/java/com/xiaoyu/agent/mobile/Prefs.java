package com.xiaoyu.agent.mobile;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * 一对一记住「连哪台电脑」。
 *
 * 存两样：
 *  - base  ：页面地址，形如 http://192.168.1.100:8787
 *  - token ：配对码（电脑端「设置 → 手机连接」里那一串）
 *
 * token 为什么不塞进 URL 里来回传：URL 会进历史记录、WebView 的缓存键、崩溃日志。
 * 所以走 x-mobile-token 请求头（服务端 extractToken 认得），URL 里只留 ?mobile=1 做标记。
 */
final class Prefs {
    private static final String FILE = "xiaoyu";
    private static final String K_BASE = "base";
    private static final String K_TOKEN = "token";
    private static final String K_LABEL = "label";

    static SharedPreferences sp(Context c) {
        return c.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    static String base(Context c) {
        return sp(c).getString(K_BASE, "");
    }

    static String token(Context c) {
        return sp(c).getString(K_TOKEN, "");
    }

    static String label(Context c) {
        return sp(c).getString(K_LABEL, "");
    }

    static void save(Context c, String base, String token, String label) {
        sp(c).edit()
                .putString(K_BASE, base)
                .putString(K_TOKEN, token)
                .putString(K_LABEL, label == null ? "" : label)
                .apply();
    }

    static void clear(Context c) {
        sp(c).edit().remove(K_BASE).remove(K_TOKEN).remove(K_LABEL).apply();
    }

    /** "192.168.1.100:8787" → "http://192.168.1.100:8787"；顺手把结尾的斜杠去掉 */
    static String normalize(String raw) {
        if (raw == null) return "";
        String s = raw.trim();
        if (s.isEmpty()) return "";
        // 粘贴整条 URL 的情况：把协议和路径都裁掉，只留 host:port
        int i = s.indexOf("://");
        if (i >= 0) s = s.substring(i + 3);
        int slash = s.indexOf('/');
        if (slash >= 0) s = s.substring(0, slash);
        if (s.isEmpty()) return "";
        if (!s.contains(":")) s = s + ":8787"; // 电脑端默认端口
        return "http://" + s;
    }

    /** xiaoyu://Xy7k2p...  →  配对码；不是这个 scheme 就返回 null */
    static String tokenFromUri(String text) {
        if (text == null) return null;
        String s = text.trim();
        if (!s.startsWith("xiaoyu://")) return null;
        String body = s.substring("xiaoyu://".length());
        int q = body.indexOf('?');
        if (q >= 0) body = body.substring(0, q);
        int slash = body.indexOf('/');
        if (slash >= 0) body = body.substring(0, slash);
        return body.isEmpty() ? null : body;
    }
}
