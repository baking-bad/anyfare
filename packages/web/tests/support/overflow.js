// Lists what sticks out of the page or out of its box: the page's own width against the window's, every
// element that reaches past the window's right edge, and every element that reaches past the box of its parent
// when that box neither scrolls nor clips, and every box whose text is wider than itself. Text that is too long for its box must wrap or be cut inside it.
//
// Run it in the page, at the width to check (360 px), with the browser's own session:
//   agent-browser set viewport 360 800
//   agent-browser open <url>
//   agent-browser eval --stdin < tests/support/overflow.js
// It evaluates to a JSON string: `{"page":false,"offenders":[]}` when nothing sticks out. `page` is true when
// the page is wider than the window.
(() => {
  const root = document.documentElement;
  const clips = style => ['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX);
  const name = el => el.tagName.toLowerCase() + '.' + String(el.getAttribute('class') || '').split(' ')[0];
  const scrolls = el => {
    for (let up = el.parentElement; up !== null && up !== document.body && up !== root; up = up.parentElement) {
      if (clips(getComputedStyle(up)))
        return true;
    }

    return false;
  };
  const offenders = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('svg') !== null && el.tagName.toLowerCase() !== 'svg')
      continue;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.position === 'fixed' || style.position === 'absolute' || el.closest('.sr-only, [hidden]') !== null)
      continue;
    const box = el.getBoundingClientRect();
    if (box.width === 0 && box.height === 0)
      continue;
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30);
    if (box.right > innerWidth + 1 && !scrolls(el)) {
      offenders.push({ el: name(el), why: 'past the window', right: Math.round(box.right), text });
      continue;
    }
    // Text that reaches past its own box and is not cut by it: the box fits, its text doesn't
    if (style.overflowX === 'visible' && style.display !== 'inline' && !scrolls(el)) {
      let right = -Infinity;
      for (const node of el.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE || (node.textContent || '').trim() === '')
          continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const line of range.getClientRects())
          right = Math.max(right, line.right);
      }
      if (right > box.right + 1) {
        offenders.push({ el: name(el), why: 'its text reaches past its box', over: Math.round(right - box.right), text });
        continue;
      }
    }
    const parent = el.parentElement;
    if (parent === null || parent === document.body || parent === root)
      continue;
    const parentStyle = getComputedStyle(parent);
    if ((parent !== document.body && clips(parentStyle)) || parentStyle.display === 'contents' || parentStyle.display === 'inline')
      continue;
    const outer = parent.getBoundingClientRect();
    if (outer.width > 0 && box.right > outer.right + 1 && style.display !== 'inline' && !scrolls(el))
      offenders.push({ el: name(el), why: 'past its parent ' + name(parent), over: Math.round(box.right - outer.right), text });
  }

  return JSON.stringify({ page: root.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth, scrollWidth: root.scrollWidth, innerWidth, offenders: offenders.slice(0, 40) });
})()
