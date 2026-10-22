(() => {
  const v = document.getElementById('bgVideo');
  const k = document.getElementById('skinKnob');
  const p = document.getElementById('skinPanel');
  return {
    bodyClass: document.body.className,
    skin: (typeof skinState === 'object' && skinState) || null,
    video: v
      ? {
          src: v.getAttribute('src'),
          readyState: v.readyState,
          vw: v.videoWidth,
          vh: v.videoHeight,
          t: Number(v.currentTime.toFixed(2)),
          paused: v.paused,
          err: v.error ? v.error.code + ':' + v.error.message : null,
        }
      : null,
    knob: k ? getComputedStyle(k).display : null,
    panel: p ? getComputedStyle(p).display : null,
    surface: getComputedStyle(document.body).getPropertyValue('--surface').trim(),
    veil: getComputedStyle(document.body).getPropertyValue('--veil').trim(),
    bodyBg: getComputedStyle(document.body).backgroundColor,
  };
})()
