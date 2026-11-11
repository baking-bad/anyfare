// Lists every table that is wider than its box. At 1440 px and 1024 px no table scrolls sideways: the number
// columns are in view, and a long host or path is cut inside its cell. (On a phone a table may scroll in its box.)
//
// Run it in the page, at the width to check, with the browser's own session:
//   agent-browser set viewport 1440 900
//   agent-browser open <url>
//   agent-browser eval --stdin < tests/support/tableFit.js
// It evaluates to a JSON string: `{"tables":2,"offenders":[]}` when every table fits. A host or a path that the
// table shows in full, wider than the half of its box, is listed too.
(() => {
  const offenders = [];
  const boxes = document.querySelectorAll('.table-scroll');
  for (const box of boxes) {
    const table = box.querySelector('table');
    if (table === null)
      continue;
    const label = box.getAttribute('aria-label') || 'table';
    if (box.scrollWidth > box.clientWidth + 1)
      offenders.push({ table: label, why: 'wider than its box', table_width: Math.round(table.getBoundingClientRect().width), box: Math.round(box.clientWidth) });
    for (const cell of table.querySelectorAll('td:not(.state-cell)')) {
      const width = cell.getBoundingClientRect().width;
      if (width > box.clientWidth * 0.6)
        offenders.push({ table: label, why: 'a cell takes more than 60% of the box', width: Math.round(width), text: (cell.textContent || '').trim().slice(0, 30) });
    }
  }

  return JSON.stringify({ tables: boxes.length, offenders: offenders.slice(0, 40) });
})()
