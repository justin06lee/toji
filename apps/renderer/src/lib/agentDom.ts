// Injected scripts the web agent runs inside a <webview> (via executeJavaScript).
// They are plain strings so they can be evaluated in the guest page. Kept dependency-free.

export interface AgentElement {
  i: number;
  tag: string;
  role: string;
  name: string;
  value: string;
  rect: { x: number; y: number; w: number; h: number };
}

export interface AgentSnapshot {
  url: string;
  title: string;
  scrollY: number;
  maxScroll: number;
  elements: AgentElement[];
}

export type AgentAction =
  | { action: 'click'; index: number; reason?: string }
  | { action: 'type'; index: number; text: string; reason?: string }
  | { action: 'scroll'; direction: 'down' | 'up'; reason?: string }
  | { action: 'navigate'; url: string; reason?: string }
  | { action: 'done'; reason?: string };

/** What the /api/agent/step endpoint returns. */
export interface AgentStepResult {
  action: 'click' | 'type' | 'scroll' | 'navigate' | 'clickAt' | 'drag' | 'runJS' | 'research' | 'ask' | 'wait' | 'screenshot' | 'uploadFile' | 'remember' | 'done';
  index?: number;
  text?: string;
  url?: string;
  direction?: 'up' | 'down';
  /** For "ask": a question for the USER; the run pauses until they answer in the spotlight. */
  question?: string;
  /** For "runJS": JavaScript to evaluate in the page; its return value comes back as an observation. */
  code?: string;
  /** For "research": a question for the research sub-agent; its answer comes back as an observation. */
  query?: string;
  /** For "wait": how long to pause (ms) before re-checking the page. */
  ms?: number;
  /** For "clickAt": absolute viewport pixel where the click lands. */
  x?: number;
  y?: number;
  /** For "drag": press at (fromX,fromY) and release at (toX,toY), in absolute pixels. */
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
  /** For "drag": use an element index as the exact source/destination instead of pixels. */
  fromIndex?: number;
  toIndex?: number;
  /** For "drag" on a labeled board: source/destination square refs, e.g. "e2" → "e4". */
  fromCell?: string;
  toCell?: string;
  /** For "cell": the numbered grid cell (from the board/canvas overlay) to click. */
  cellId?: number;
  /** For "uploadFile": which dropped file (its index from the FILES list) to upload. */
  fileIndex?: number;
  done?: boolean;
  reason?: string;
  /** The model returned prose/refused instead of a JSON action; the loop counts these to stop a spin. */
  error?: boolean;
}

/** Returns an AgentSnapshot of the page's visible, interactive elements (tagged for later actions). */
export const SNAPSHOT_JS = `(() => {
  const sel = 'a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=switch], [onclick], summary, label';
  const out = [];
  let i = 0;
  for (const el of Array.from(document.querySelectorAll(sel))) {
    const r = el.getBoundingClientRect();
    if (r.width < 3 || r.height < 3) continue;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) continue;
    if (r.bottom < -200 || r.top > innerHeight + 800) continue;
    const tag = el.tagName.toLowerCase();
    const aria = el.getAttribute('aria-label') || '';
    const name = (el.innerText || el.value || el.placeholder || el.getAttribute('alt') || aria || el.getAttribute('title') || el.name || '')
      .toString().trim().replace(/\\s+/g, ' ').slice(0, 140);
    if (!name && tag !== 'input' && tag !== 'textarea' && tag !== 'select') continue;
    el.setAttribute('data-toji-ai', String(i));
    out.push({
      i, tag,
      role: el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag === 'input' ? (el.getAttribute('type') || 'text') : tag),
      name,
      value: ((el.type === 'password' || el.autocomplete === 'current-password' || el.autocomplete === 'new-password' || el.autocomplete === 'one-time-code') ? '' : (el.value || '')).toString().slice(0, 80),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    });
    if (++i >= 60) break;
  }
  return { url: location.href, title: document.title, scrollY: Math.round(scrollY), maxScroll: Math.round(Math.max(0, document.body.scrollHeight - innerHeight)), elements: out };
})()`;

/** Scroll an element into view and return its viewport rect (for real-mouse clicking). */
export function locateScript(index: number): string {
  return `(() => { const el = document.querySelector('[data-toji-ai="${index}"]'); if (!el) return { ok:false }; el.scrollIntoView({ block:'center', inline:'center' }); const r = el.getBoundingClientRect(); return { ok:true, rect:{ x:r.x, y:r.y, w:r.width, h:r.height }, tag: el.tagName.toLowerCase() }; })()`;
}

/** Scroll the page up or down (returns the new page signature so progress can be checked). */
export function scrollScript(direction: 'up' | 'down'): string {
  const amount = direction === 'up' ? '-(innerHeight*0.8)' : '(innerHeight*0.8)';
  return `(() => { window.scrollBy({ top:${amount}, behavior:'smooth' }); return { ok:true }; })()`;
}

/** A cheap signature of the page state, to detect whether an action changed anything. */
export const PAGE_SIGNATURE_JS = `(location.href + '||' + document.title + '||' + Array.from(document.querySelectorAll('a,button,input,[role=button]')).slice(0,40).map(e => (e.innerText||e.value||'').trim().slice(0,24)).join('~'))`;

/** One labeled square of a board surface — ref is e.g. "e4"; center is exact guest CSS px. */
export interface AgentCell {
  ref: string;
  cx: number;
  cy: number;
}

/**
 * Set-of-Marks snapshot: detects the same interactive elements as SNAPSHOT_JS, but ALSO
 * (1) draws a numbered badge on each element and (2) finds the largest board/canvas
 * surface and overlays an NxN labeled grid on it. The badges/grid are captured into the
 * screenshot so the model can ground a click to a *discrete label* (an element index or a
 * grid cell) instead of guessing raw pixel coordinates. Returns the element list plus the
 * grid cells (with exact centers) so the client can click precisely. Call CLEAR_MARKS_JS
 * right after capturing to remove the overlay.
 */
export function marksScript(gridN = 8): string {
  return `(() => {
    const old = document.getElementById('toji-marks'); if (old) old.remove();
    const layer = document.createElement('div');
    layer.id = 'toji-marks';
    layer.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;font:700 11px/1.1 ui-monospace,SFMono-Regular,monospace;';
    const badge = (x, y, text, bg) => {
      const b = document.createElement('div');
      b.textContent = text;
      b.style.cssText = 'position:fixed;left:' + x + 'px;top:' + y + 'px;transform:translate(-1px,-1px);padding:0 3px;border-radius:3px;color:#fff;background:' + bg + ';box-shadow:0 0 0 1px rgba(0,0,0,.45);white-space:nowrap;';
      layer.appendChild(b);
    };
    const out = [];
    let i = 0;
    const tagged = new Set();
    const push = (el, r, role, name, skipBadge) => {
      el.setAttribute('data-toji-ai', String(i));
      tagged.add(el);
      out.push({ i, tag: el.tagName.toLowerCase(), role, name, value: ((el.type === 'password' || el.autocomplete === 'current-password' || el.autocomplete === 'new-password' || el.autocomplete === 'one-time-code') ? '' : (el.value || '')).toString().slice(0, 80), rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } });
      if (!skipBadge && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth) {
        badge(Math.max(0, Math.round(r.x)), Math.max(0, Math.round(r.y)), String(i), '#2563eb');
      }
      i += 1;
    };
    // 1) Standard interactive elements (+ draggable / focusable / editable custom controls).
    const sel = 'a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=switch], [onclick], summary, label, [draggable="true"], [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
    for (const el of Array.from(document.querySelectorAll(sel))) {
      if (i >= 40) break;
      if (tagged.has(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 3 || r.height < 3) continue;
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) continue;
      if (r.bottom < -200 || r.top > innerHeight + 800) continue;
      const tag = el.tagName.toLowerCase();
      const aria = el.getAttribute('aria-label') || '';
      const name = (el.innerText || el.value || el.placeholder || el.getAttribute('alt') || aria || el.getAttribute('title') || el.name || '')
        .toString().trim().replace(/\\s+/g, ' ').slice(0, 140);
      if (!name && tag !== 'input' && tag !== 'textarea' && tag !== 'select' && el.draggable !== true) continue;
      push(el, r, el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag === 'input' ? (el.getAttribute('type') || 'text') : tag), name);
    }
    // 2) Detect an interactive BOARD/canvas surface. Prefer a real board element (it holds the
    // pieces); otherwise a squarish element that actually contains several clickable children, so
    // we don't mistakenly pick the page wrapper / navbar.
    const childClickables = (el, cap) => {
      let n = 0;
      for (const c of el.querySelectorAll('*')) {
        const cs = getComputedStyle(c);
        if (c.draggable === true || cs.cursor === 'pointer' || cs.cursor === 'grab' || cs.cursor === 'grabbing') { if (++n >= cap) break; }
      }
      return n;
    };
    let surf = null;
    const preferred = document.querySelector('cg-board, wc-chess-board, [class*="chessboard" i]');
    if (preferred) { const r = preferred.getBoundingClientRect(); if (r.width >= 160 && r.height >= 160) surf = { el: preferred, r }; }
    if (!surf) {
      const cands = Array.from(document.querySelectorAll('canvas, svg, [role=grid], [class*="board" i], [class*="canvas" i]'))
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter((o) => o.r.width >= 160 && o.r.height >= 160 && o.r.width <= innerWidth * 0.96 && o.r.height <= innerHeight * 0.98 && o.r.bottom > 0 && o.r.top < innerHeight && o.r.right > 0 && o.r.left < innerWidth && childClickables(o.el, 4) >= 4)
        .sort((a, b) => { const q = (r) => (Math.min(r.width, r.height) / Math.max(r.width, r.height)) * r.width * r.height; return q(b.r) - q(a.r); });
      surf = cands[0] || null;
    }
    const cells = [];
    if (surf) {
      // Grid grounding (general — works for any board/tile game, not just chess): fit a centered
      // NxN grid over the surface, label each cell (e.g. "e4"), and tag each clickable child with
      // its cell + identity. The model expresses moves as cell refs which map to exact coords.
      const side = Math.min(surf.r.width, surf.r.height);
      const ox = surf.r.left + (surf.r.width - side) / 2;
      const oy = surf.r.top + (surf.r.height - side) / 2;
      // Infer grid size from the typical clickable-child (tile/piece) size rather than hardcoding
      // 8 — so it fits chess (8), checkers (8), go (19), sudoku (9), etc. Falls back to 8.
      const kidW = [];
      for (const k of surf.el.querySelectorAll('*')) { const kr = k.getBoundingClientRect(); if (kr.width >= side * 0.03 && kr.width <= side * 0.5) kidW.push(kr.width); }
      kidW.sort((a, b) => a - b);
      const cell = kidW.length ? kidW[Math.floor(kidW.length / 2)] : side / 8;
      let N = Math.round(side / cell);
      if (!(N >= 2 && N <= 26)) N = 8;
      const cw = side / N, ch = side / N;
      const refOf = (col, row) => String.fromCharCode(97 + col) + (N - row); // a..h left→right, rank N(top)→1(bottom)
      const g = document.createElement('div');
      g.style.cssText = 'position:fixed;left:' + ox + 'px;top:' + oy + 'px;width:' + side + 'px;height:' + side + 'px;background-image:repeating-linear-gradient(to right,rgba(220,38,38,.3) 0 1px,transparent 1px ' + cw + 'px),repeating-linear-gradient(to bottom,rgba(220,38,38,.3) 0 1px,transparent 1px ' + ch + 'px);';
      layer.appendChild(g);
      for (let row = 0; row < N; row++) {
        for (let col = 0; col < N; col++) {
          const cx = Math.round(ox + cw * (col + 0.5)), cy = Math.round(oy + ch * (row + 0.5));
          const ref = refOf(col, row);
          cells.push({ ref, cx, cy });
          badge(Math.round(ox + cw * col + 1), Math.round(oy + ch * row + 1), ref, 'rgba(220,38,38,.72)');
        }
      }
      let scanned = 0;
      for (const el of surf.el.querySelectorAll('*')) {
        if (i >= 80 || scanned > 2500) break;
        scanned += 1;
        if (tagged.has(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < side * 0.04 || r.height < side * 0.04 || r.width > side * 0.5 || r.height > side * 0.5) continue;
        const s = getComputedStyle(el);
        if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) continue;
        if (el.draggable !== true && s.cursor !== 'pointer' && s.cursor !== 'grab' && s.cursor !== 'grabbing') continue;
        const ccx = r.x + r.width / 2, ccy = r.y + r.height / 2;
        const col = Math.max(0, Math.min(N - 1, Math.floor((ccx - ox) / cw)));
        const row = Math.max(0, Math.min(N - 1, Math.floor((ccy - oy) / ch)));
        const cls = (el.getAttribute('class') || el.getAttribute('aria-label') || el.tagName.toLowerCase()).toString().trim().replace(/\\s+/g, ' ').slice(0, 32);
        push(el, r, 'piece', cls + ' @' + refOf(col, row), true);
      }
    } else {
      // No board: general viewport pixel grid (model uses clickAt with absolute pixels). Every
      // intersection is labeled with its exact pixel coordinate so any visual target has a reference.
      const W = innerWidth, H = innerHeight;
      const divX = Math.max(8, Math.min(14, Math.round(W / 150)));
      const divY = Math.max(6, Math.min(12, Math.round(H / 150)));
      const grid = document.createElement('div');
      grid.style.cssText = 'position:fixed;inset:0;background-image:'
        + 'repeating-linear-gradient(to right,rgba(220,38,38,.18) 0 1px,transparent 1px ' + (W / divX) + 'px),'
        + 'repeating-linear-gradient(to bottom,rgba(220,38,38,.18) 0 1px,transparent 1px ' + (H / divY) + 'px);';
      layer.appendChild(grid);
      for (let gx = 0; gx <= divX; gx++) {
        for (let gy = 0; gy <= divY; gy++) {
          const x = Math.round((W * gx) / divX), y = Math.round((H * gy) / divY);
          const lx = Math.min(W - 32, x), ly = Math.min(H - 9, y);
          const b = document.createElement('div');
          b.textContent = x + ',' + y;
          b.style.cssText = 'position:fixed;left:' + lx + 'px;top:' + ly + 'px;transform:translate(1px,1px);padding:0 2px;border-radius:2px;color:#fff;background:rgba(0,0,0,.6);font:600 9px/1.35 ui-monospace,monospace;white-space:nowrap;';
          layer.appendChild(b);
        }
      }
    }
    document.documentElement.appendChild(layer);
    return { url: location.href, title: document.title, scrollY: Math.round(scrollY), maxScroll: Math.round(Math.max(0, document.body.scrollHeight - innerHeight)), elements: out, cells };
  })()`;
}

/** Remove the Set-of-Marks overlay (run immediately after capturing the screenshot). */
export const CLEAR_MARKS_JS = `(() => { const m = document.getElementById('toji-marks'); if (m) m.remove(); return true; })()`;

/** JS that performs one action in the guest page; returns { ok, rect? } so the UI can animate a cursor. */
export function actionScript(action: AgentAction): string {
  if (action.action === 'click') {
    return `(() => { const el = document.querySelector('[data-toji-ai="${action.index}"]'); if (!el) return { ok:false }; el.scrollIntoView({ block:'center', inline:'center' }); const r = el.getBoundingClientRect(); try { el.click(); } catch(e) {} return { ok:true, rect:{ x:Math.round(r.x), y:Math.round(r.y), w:Math.round(r.width), h:Math.round(r.height) } }; })()`;
  }
  if (action.action === 'type') {
    const text = JSON.stringify(action.text);
    return `(() => { const el = document.querySelector('[data-toji-ai="${action.index}"]'); if (!el) return { ok:false }; el.scrollIntoView({ block:'center' }); const r = el.getBoundingClientRect(); el.focus(); try { el.value = ${text}; } catch(e) {} el.dispatchEvent(new Event('input',{ bubbles:true })); el.dispatchEvent(new Event('change',{ bubbles:true })); return { ok:true, rect:{ x:Math.round(r.x), y:Math.round(r.y), w:Math.round(r.width), h:Math.round(r.height) } }; })()`;
  }
  if (action.action === 'scroll') {
    const amount = action.direction === 'up' ? '-(innerHeight*0.8)' : '(innerHeight*0.8)';
    return `(() => { window.scrollBy({ top:${amount}, behavior:'smooth' }); return { ok:true }; })()`;
  }
  return `(() => ({ ok:true }))()`;
}
