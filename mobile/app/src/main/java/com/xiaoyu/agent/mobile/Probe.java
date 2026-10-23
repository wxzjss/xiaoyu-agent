package com.xiaoyu.agent.mobile;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * 连之前先问一句「那边有人吗」。
 *
 * 打 /api/mobile/ping（服务端刻意放行、不含隐私）。三件事一次问清：
 *  1. 地址打不打得通（打不通 = 手机和电脑不在同一个 Wi-Fi，或者电脑端没开局域网）
 *  2. 是不是小鱼Agent（免得连到家里路由器后台那种 80 端口）
 *  3. 要不要配对码（服务端返回 needToken）
 *
 * 为什么不用 WebView 探：WebView 报错信息是给人看的，程序拿不到；而且探失败还得重载页面，闪一下。
 */
final class Probe {
    interface Cb {
        /** ok=false 时 guess 可能是 token 过期，调用方据此给不同提示 */
        void onResult(boolean ok, String message, boolean guessToken);
    }

    private static final String TAG = "xiaoyu-probe";

    static void run(String base, String token, Cb cb) {
        Handler main = new Handler(Looper.getMainLooper());
        new Thread(() -> {
            HttpURLConnection c = null;
            try {
                URL u = new URL(base + "/api/mobile/ping");
                c = (HttpURLConnection) u.openConnection();
                c.setConnectTimeout(4000);
                c.setReadTimeout(4000);
                c.setRequestMethod("GET");
                c.setRequestProperty("Accept", "application/json");
                if (token != null && !token.isEmpty()) {
                    c.setRequestProperty("Authorization", "Bearer " + token);
                }
                int code = c.getResponseCode();
                InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
                String body = read(in);
                if (code == 401) {
                    main.post(() -> cb.onResult(false, "配对码不对（电脑上重新扫一下码）", true));
                    return;
                }
                if (code != 200) {
                    main.post(() -> cb.onResult(false, "电脑那边回了 " + code, false));
                    return;
                }
                JSONObject o = new JSONObject(body);
                if (!"xiaoyu-agent".equals(o.optString("app"))) {
                    main.post(() -> cb.onResult(false, "这个地址不是小鱼Agent", false));
                    return;
                }
                boolean need = o.optBoolean("needToken", false);
                if (need && (token == null || token.isEmpty())) {
                    main.post(() -> cb.onResult(false, "电脑上开着局域网，要配对码才能进", true));
                    return;
                }
                String v = o.optString("version", "");
                main.post(() -> cb.onResult(true, "电脑端 " + v, false));
            } catch (Exception e) {
                Log.w(TAG, "probe failed: " + e);
                main.post(() -> cb.onResult(false, "连不上 " + base + "（同一个 Wi-Fi？电脑端开了手机连接？）", false));
            } finally {
                if (c != null) c.disconnect();
            }
        }, "probe").start();
    }

    static String read(InputStream in) {
        if (in == null) return "";
        try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) sb.append(line).append('\n');
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }
}
