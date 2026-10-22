(async () => {
  document.getElementById('openFeatures').click();
  await new Promise((r) => setTimeout(r, 700));
  const findRow = () => [...document.querySelectorAll('#featList .featRow')].find((r) => r.textContent.includes('视频背景'));
  const row = findRow();
  const sw = row?.querySelector('button.switch');
  const swBefore = sw ? { text: sw.textContent, on: sw.dataset.on } : null;
  if (sw) sw.click();
  await new Promise((r) => setTimeout(r, 1500));
  const row2 = findRow();
  const sw2 = row2?.querySelector('button.switch');
  const v = document.getElementById('bgVideo');
  return {
    dlgOpen: document.getElementById('featuresDlg').open,
    rowText: row ? row.innerText.replace(/\n+/g, ' | ') : null,
    swBefore,
    swAfter: sw2 ? { text: sw2.textContent, on: sw2.dataset.on } : null,
    foot: document.getElementById('featFoot').textContent,
    bodyClass: document.body.className,
    src: v.getAttribute('src'),
    readyState: v.readyState,
    playing: !v.paused,
  };
})()
