(async () => {
  const before = { bodyClass: document.body.className, src: document.getElementById('bgVideo').getAttribute('src') };
  await fetch('/api/features/set', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'videoBg', enabled: false }),
  });
  await window.__applySkin();
  await new Promise((r) => setTimeout(r, 400));
  const v = document.getElementById('bgVideo');
  const after = {
    bodyClass: document.body.className,
    src: v.getAttribute('src'),
    paused: v.paused,
    knob: getComputedStyle(document.getElementById('skinKnob')).display,
    logBg: getComputedStyle(document.getElementById('log')).backgroundColor,
  };
  const st = await fetch('/api/skin').then((x) => x.json());
  return { before, after, enabledNow: st.enabled };
})()
