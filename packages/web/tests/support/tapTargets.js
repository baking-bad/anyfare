// Lists every link, button, select, input and summary on the open page whose tap area is under 44 by 44 px.
// A tap area is the element's own box, plus the boxes of its `::before` and `::after` when they are
// positioned (an invisible extension), plus the whole box of the nearest positioned ancestor when the
// element's pseudo-element covers it (a table row that is a link). A target also fails when another
// control covers the middle of one of its sides, so a bigger area never steals a neighbour's tap.
//
// Run it in the page, at the width to check (390 px), with the browser's own session:
//   agent-browser set viewport 390 844
//   agent-browser open <url>
//   agent-browser eval --stdin < tests/support/tapTargets.js
// It evaluates to a JSON string: `[]` when every target is big enough, otherwise one entry per failing
// target with its tag, class, text, own size, tap area and the reason.
(() => {
  const minimum = 44;
  const selector = 'a[href], button, select, input:not([type="hidden"]), textarea, summary, [role="button"], [role="tab"], [role="link"], [role="menuitem"], [tabindex]:not([tabindex="-1"])';
  const px = value => Number.parseFloat(value) || 0;
  const visible = el => {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none')
      return false;
    for (let up = el.parentElement; up !== null; up = up.parentElement) {
      if (getComputedStyle(up).display === 'none' || up.hidden)
        return false;
    }
    const box = el.getBoundingClientRect();

    return box.width > 0 && box.height > 0;
  };
  // The box a positioned pseudo-element is placed against: the nearest positioned ancestor, or the element itself
  const placedAgainst = el => {
    for (let node = el; node !== null; node = node.parentElement) {
      if (getComputedStyle(node).position !== 'static')
        return node;
    }

    return document.documentElement;
  };
  const rects = el => {
    // A link that wraps onto lines has one box for each: the tap area starts from its largest
    const boxes = [...el.getClientRects()].map(box => ({ left: box.left, top: box.top, right: box.right, bottom: box.bottom }));
    const own = [boxes.reduce((best, box) => (box.right - box.left) * (box.bottom - box.top) > (best.right - best.left) * (best.bottom - best.top) ? box : best)];
    const extra = [];
    for (const which of ['::before', '::after']) {
      const style = getComputedStyle(el, which);
      if (style.content === 'none' || style.content === 'normal' || style.display === 'none' || style.position !== 'absolute')
        continue;
      const against = placedAgainst(el);
      const base = against.getBoundingClientRect();
      const inner = getComputedStyle(against);
      const left = base.left + px(inner.borderLeftWidth);
      const top = base.top + px(inner.borderTopWidth);
      const width = px(style.width);
      const height = px(style.height);
      let x = left + px(style.left);
      let y = top + px(style.top);
      // A transform that only shifts, such as translateY(-50%), moves the box
      const matrix = style.transform === 'none' ? null : new DOMMatrix(style.transform);
      if (matrix !== null) {
        x += matrix.m41;
        y += matrix.m42;
      }
      extra.push({ left: x, top: y, right: x + width, bottom: y + height });
    }

    return [...own, ...extra];
  };
  const union = list => ({
    left: Math.min(...list.map(box => box.left)), top: Math.min(...list.map(box => box.top)),
    right: Math.max(...list.map(box => box.right)), bottom: Math.max(...list.map(box => box.bottom)),
  });
  const owner = hit => hit === null ? null : hit.closest(selector);
  const failures = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(selector)) {
    if (seen.has(el) || !visible(el))
      continue;
    seen.add(el);
    if (el.matches(':disabled'))
      continue;
    // Brought to the middle of the screen, so the sticky header covers nothing and every point can be asked
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const own = el.getBoundingClientRect();
    const area = union(rects(el));
    const width = Math.round(area.right - area.left);
    const height = Math.round(area.bottom - area.top);
    let reason = '';
    if (width < minimum || height < minimum)
      reason = 'small';
    else {
      // The middle of each side of the area, one pixel inside it, must reach this control
      const points = [
        [area.left + 1, (area.top + area.bottom) / 2], [area.right - 1, (area.top + area.bottom) / 2],
        [(area.left + area.right) / 2, area.top + 1], [(area.left + area.right) / 2, area.bottom - 1],
      ];
      for (const [x, y] of points) {
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight)
          continue;
        const hit = owner(document.elementFromPoint(x, y));
        if (hit !== null && hit !== el && !el.contains(hit) && !hit.contains(el)) {
          reason = 'covered by ' + hit.tagName.toLowerCase() + '.' + String(hit.getAttribute('class') || '').split(' ')[0];
          break;
        }
      }
    }
    if (reason !== '') {
      failures.push({
        tag: el.tagName.toLowerCase(), class: String(el.getAttribute('class') || '').split(' ')[0],
        text: (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 40),
        own: Math.round(own.width) + 'x' + Math.round(own.height), area: width + 'x' + height, at: Math.round(own.left) + ',' + Math.round(own.top + scrollY), reason,
      });
    }
  }

  return JSON.stringify(failures);
})()
