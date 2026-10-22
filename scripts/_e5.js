(async () => {
  const st = await fetch('/api/skin').then((x) => x.json());
  if (!st.enabled) {
    await fetch('/api/features/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'videoBg', enabled: true }),
    });
    await window.__applySkin();
  }
  await new Promise((r) => setTimeout(r, 600));
  document.getElementById('openFeatures').click();
  await new Promise((r) => setTimeout(r, 800));
  const dlg = document.getElementById('featuresDlg');
  const cs = getComputedStyle(dlg);
  return { open: dlg.open, bg: cs.backgroundColor, bodyClass: document.body.className, foot: document.getElementById('featFoot').textContent };
})()
