package com.xiaoyu.agent.mobile.ui;

import android.content.Context;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * 所有界面都是手搓的 —— 不引 AndroidX、不写 XML 布局，
 * 因为这台机器上 gradle 拉依赖不一定通，纯 SDK 的 View 写死了就能编。
 */
public final class Ui {
    private Ui() {}

    public static final int BG = 0xFF0b0e13;
    public static final int PANEL = 0xFF151a22;
    public static final int LINE = 0xFF232936;
    public static final int TEXT = 0xFFe6eaf2;
    public static final int DIM = 0xFF98a2b3;
    public static final int ACCENT = 0xFF4d8dff;
    public static final int RED = 0xFFe2564a;

    public static int dp(Context c, float v) {
        return (int) (v * c.getResources().getDisplayMetrics().density + 0.5f);
    }

    public static GradientDrawable round(int color, float radiusDp, Context c) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(dp(c, radiusDp));
        return d;
    }

    public static GradientDrawable roundStroke(int color, int strokeColor, float radiusDp, Context c) {
        GradientDrawable d = round(color, radiusDp, c);
        d.setStroke(dp(c, 1), strokeColor);
        return d;
    }

    public static TextView text(Context c, String s, float sp, int color, boolean bold) {
        TextView t = new TextView(c);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return t;
    }

    public static Button button(Context c, String label, boolean primary) {
        Button b = new Button(c);
        b.setText(label);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        b.setAllCaps(false);
        b.setTextColor(primary ? 0xFFffffff : TEXT);
        b.setBackground(primary ? round(ACCENT, 10, c) : roundStroke(PANEL, LINE, 10, c));
        int px = dp(c, 14);
        b.setPadding(px, dp(c, 10), px, dp(c, 10));
        b.setMinHeight(dp(c, 46));
        return b;
    }

    public static EditText input(Context c, String hint, boolean mono) {
        EditText e = new EditText(c);
        e.setHint(hint);
        e.setHintTextColor(0xFF6b7484);
        e.setTextColor(TEXT);
        e.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        e.setBackground(roundStroke(PANEL, LINE, 10, c));
        int px = dp(c, 12);
        e.setPadding(px, dp(c, 10), px, dp(c, 10));
        e.setSingleLine(true);
        e.setImeOptions(EditorInfo.IME_ACTION_DONE);
        e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        if (mono) e.setTypeface(Typeface.MONOSPACE);
        return e;
    }

    /** 竖着的普通容器 */
    public static LinearLayout column(Context c, int padDp) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        int p = dp(c, padDp);
        l.setPadding(p, p, p, p);
        return l;
    }

    /** 横排、居中的一行按钮 */
    public static LinearLayout row(Context c) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.HORIZONTAL);
        l.setGravity(Gravity.CENTER_VERTICAL);
        return l;
    }

    public static LinearLayout.LayoutParams lp(int w, int h, int weight) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(w, h);
        p.weight = weight;
        return p;
    }

    public static LinearLayout.LayoutParams lpMT(int w, int h, int topDp, Context c) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(w, h);
        p.topMargin = dp(c, topDp);
        return p;
    }

    public static View spacer(Context c, int h) {
        View v = new View(c);
        v.setLayoutParams(new LinearLayout.LayoutParams(1, dp(c, h)));
        return v;
    }

    public static View divider(Context c) {
        View v = new View(c);
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, dp(c, 1)));
        p.topMargin = dp(c, 12);
        p.bottomMargin = dp(c, 12);
        v.setLayoutParams(p);
        v.setBackgroundColor(LINE);
        return v;
    }

    /** 把内容装进可滚动的 FrameLayout，外面套顶部/底部内边距 */
    public static ScrollView scroll(Context c, View child, boolean bottomPad) {
        ScrollView s = new ScrollView(c);
        s.setFillViewport(true);
        s.setBackgroundColor(BG);
        FrameLayout wrap = new FrameLayout(c);
        int p = dp(c, 22);
        wrap.setPadding(p, dp(c, 40), p, bottomPad ? dp(c, 120) : p);
        wrap.addView(child, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        s.addView(wrap, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return s;
    }
}
