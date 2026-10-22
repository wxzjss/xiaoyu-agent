(async () => {
  const k = document.getElementById('skinKnob');
  k.click();
  const p = document.getElementById('skinPanel');
  const shownAfterClick = getComputedStyle(p).display;
  const sv = document.getElementById('skSurface');
  const vv = document.getElementById('skVeil');
  sv.value = '60';
  sv.dispatchEvent(new Event('input', { bubbles: true }));
  sv.dispatchEvent(new Event('change', { bubbles: true }));
  vv.value = '0';
  vv.dispatchEvent(new Event('input', { bubbles: true }));
  vv.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 900));
  const saved = await fetch('/api/skin').then((x) => x.json());
  const b = p.getBoundingClientRect();
  return {
    shownAfterClick,
    surfaceVar: getComputedStyle(document.body).getPropertyValue('--surface').trim(),
    veilVar: getComputedStyle(document.body).getPropertyValue('--veil').trim(),
    valText: document.getElementById('skVal').textContent,
    saved: saved.settings,
    knobOpacity: getComputedStyle(k).opacity,
    panel: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)],
  };
})()
