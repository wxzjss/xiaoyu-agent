package com.xiaoyu.agent.mobile;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.ImageFormat;
import android.hardware.Camera;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 扫码页：对准电脑上的二维码，扫出配对码。
 *
 * 为什么用 android.hardware.Camera 而不是 CameraX：CameraX 要牵进一堆 AndroidX + 生命周期库，
 * 这个 APK 的目标是「零依赖、命令行 gradle 就能编出来」。Camera 在 API 21 之后标记废弃但仍可用。
 *
 * 解码用自己写的 QrDecode（见那个文件的注释）：预览帧是 NV21，Y 平面就是灰度，
 * 直接把前 w*h 字节当灰度图喂进去，不用再转 Bitmap。
 *
 * 线程：解码放在预览回调所在的线程（相机自己的线程）里跑一帧几十毫秒，
 * 因为它不是主线程，卡一下不影响画面；busy 标记保证同一时间只解一帧。
 */
public class ScanActivity extends Activity implements SurfaceHolder.Callback, Camera.PreviewCallback {

    private static final String TAG = "xiaoyu-scan";

    private SurfaceView preview;
    private Camera camera;
    private TextView hint;
    private final AtomicBoolean busy = new AtomicBoolean(false);
    private final Handler ui = new Handler(Looper.getMainLooper());
    /** 连续解码失败多少帧后提示「光线/对焦」，别让人傻举着 */
    private int tries = 0;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF000000);

        preview = new SurfaceView(this);
        preview.getHolder().addCallback(this);
        root.addView(preview, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        hint = new TextView(this);
        hint.setText("对准电脑上的二维码");
        hint.setTextColor(0xFFFFFFFF);
        hint.setTextSize(15);
        hint.setGravity(Gravity.CENTER);
        hint.setPadding(0, 0, 0, 140);
        FrameLayout.LayoutParams hp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        hint.setLayoutParams(hp);
        root.addView(hint);

        setContentView(root);

        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            Toast.makeText(this, "没有相机权限，扫不了码（也可以手填地址和配对码）", Toast.LENGTH_LONG).show();
            finish();
        }
    }

    @Override
    public void surfaceCreated(SurfaceHolder holder) {
        try {
            camera = Camera.open();
            Camera.Parameters p = camera.getParameters();
            // 预览尺寸别开太大：1280 以内够扫一个二维码，大了每帧解码反而慢
            List<Camera.Size> sizes = p.getSupportedPreviewSizes();
            Camera.Size best = sizes.get(0);
            for (Camera.Size s : sizes) {
                if (s.width <= 1280 && s.height <= 1280 && s.width * s.height > best.width * best.height) best = s;
            }
            p.setPreviewSize(best.width, best.height);
            p.setPreviewFormat(ImageFormat.NV21);
            try {
                p.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
            } catch (Exception ignore) {
            }
            camera.setParameters(p);
            camera.setDisplayOrientation(90);
            camera.setPreviewDisplay(holder);
            camera.setPreviewCallback(this);
            camera.startPreview();
        } catch (Exception e) {
            Log.w(TAG, "camera open failed", e);
            Toast.makeText(this, "相机打不开：" + e.getMessage(), Toast.LENGTH_LONG).show();
            finish();
        }
    }

    @Override
    public void surfaceChanged(SurfaceHolder holder, int f, int w, int h) {
    }

    @Override
    public void surfaceDestroyed(SurfaceHolder holder) {
        releaseCamera();
    }

    private void releaseCamera() {
        if (camera != null) {
            try {
                camera.setPreviewCallback(null);
                camera.stopPreview();
                camera.release();
            } catch (Exception ignore) {
            }
            camera = null;
        }
    }

    @Override
    public void onPreviewFrame(final byte[] data, Camera cam) {
        if (data == null || camera == null) return;
        if (!busy.compareAndSet(false, true)) return;

        final Camera.Size size;
        try {
            size = cam.getParameters().getPreviewSize();
        } catch (Exception e) {
            busy.set(false);
            return;
        }

        String got = null;
        try {
            // NV21 的 Y 平面就在前 w*h 字节，正好是灰度图（0 黑 255 白）
            QrDecode.Result r = QrDecode.decode(data, size.width, size.height);
            got = r == null ? null : r.text;
        } catch (Throwable t) {
            Log.w(TAG, "decode threw", t);
        }

        if (got != null) {
            final String text = got;
            ui.post(() -> {
                Intent out = new Intent();
                out.putExtra("text", text);
                setResult(RESULT_OK, out);
                finish();
            });
            // busy 不放开：已经拿到结果了，别让相机再喂帧进来
            return;
        }

        busy.set(false);
        if (++tries == 90) {
            ui.post(() -> hint.setText("还认不出来 —— 靠近点、对准点，别逆光"));
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        releaseCamera();
    }
}
