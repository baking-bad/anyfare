// Runs inline in <head> before the first paint, with the request's nonce: it puts the `light` or `dark`
// class on <html> from the saved choice, or from the system when there is none, and marks the Agent
// view when the visitor chose it, so neither flashes. Plain ES5, written as a string.
export const themeScript = `(function () {
  var root = document.documentElement;
  var t = null, v = null;
  try { t = localStorage.getItem('anyfare-theme'); v = localStorage.getItem('anyfare-view'); } catch (e) {}
  if (t !== 'light' && t !== 'dark') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  root.classList.remove('light', 'dark');
  root.classList.add(t);
  if (v === 'agent') root.setAttribute('data-view', 'agent');
})();`;
