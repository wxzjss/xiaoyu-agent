(async () => {
  const feats = await fetch('/api/features').then((r) => r.json());
  const skin = await fetch('/api/skin').then((r) => r.json());
  return {
    readyState: document.readyState,
    hasApplySkin: typeof window.__applySkin,
    skinStateVar: typeof skinState === 'object' ? skinState : String(skinState),
    bodyClass: document.body.className,
    videoBgFlag: feats.features.find((f) => f.id === 'videoBg'),
    skinApi: skin,
  };
})()
