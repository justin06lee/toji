// Injected into each <webview> page. Detects a two-finger horizontal trackpad
// swipe at the page's scroll edge, shows a macOS-style edge arrow, and navigates
// the page's history (back on swipe-right, forward on swipe-left). Self-contained
// so it needs no IPC; re-run on each document load (a guard prevents duplicates).
export const SWIPE_NAV_JS = `(() => {
  if (window.__tojiSwipe) return; window.__tojiSwipe = true;
  const make = (side) => {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;top:50%;' + side + ':0;transform:translateY(-50%) translateX(' + (side==='left'?'-72px':'72px') + ');width:60px;height:60px;border-radius:50%;background:rgba(18,18,20,0.82);color:#fff;display:flex;align-items:center;justify-content:center;z-index:2147483647;opacity:0;transition:transform .1s ease,opacity .1s ease;pointer-events:none;box-shadow:0 8px 30px rgba(0,0,0,.35);';
    d.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' + (side==='left'?'<path d="M15 18l-6-6 6-6"/>':'<path d="M9 18l6-6-6-6"/>') + '</svg>';
    (document.body || document.documentElement).appendChild(d);
    return d;
  };
  let leftEl, rightEl, accum = 0, lastT = 0, fired = false, resetTimer;
  const ensure = () => { if (!leftEl) { leftEl = make('left'); rightEl = make('right'); } };
  const reset = () => {
    accum = 0; fired = false;
    if (leftEl) { leftEl.style.opacity = '0'; leftEl.style.transform = 'translateY(-50%) translateX(-72px)'; }
    if (rightEl) { rightEl.style.opacity = '0'; rightEl.style.transform = 'translateY(-50%) translateX(72px)'; }
  };
  window.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 1.2) return; // not a horizontal swipe
    const se = document.scrollingElement || document.documentElement;
    const maxX = se.scrollWidth - se.clientWidth;
    const goingBack = e.deltaX < 0;               // swipe right → back
    if (goingBack && se.scrollLeft > 0) return;   // only overscroll at the edge
    if (!goingBack && se.scrollLeft < maxX - 1) return;
    const now = Date.now(); if (now - lastT > 220) reset(); lastT = now;
    ensure();
    accum += e.deltaX;
    const prog = Math.min(1, Math.abs(accum) / 130);
    const el = goingBack ? leftEl : rightEl;
    const shift = (goingBack ? -72 : 72) * (1 - prog);
    el.style.opacity = String(0.2 + prog * 0.8);
    el.style.transform = 'translateY(-50%) translateX(' + shift + 'px) scale(' + (0.8 + prog * 0.2) + ')';
    clearTimeout(resetTimer); resetTimer = setTimeout(reset, 170);
    if (!fired && Math.abs(accum) > 130) {
      fired = true;
      el.style.opacity = '1';
      el.style.transform = 'translateY(-50%) translateX(0) scale(1.06)';
      setTimeout(() => { reset(); if (goingBack) history.back(); else history.forward(); }, 120);
    }
  }, { passive: true });
})()`;
