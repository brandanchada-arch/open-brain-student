// Light and dark switch. Dark is the default, and the choice is remembered on this device.
// Load this first in <head> so the page never flashes the wrong colors.
(function () {
  var KEY = 'ob-theme';
  var root = document.documentElement;
  // Keep our own reference now: demo mode replaces window.localStorage with a pretend one later.
  var store = null;
  try { store = window.localStorage; } catch (e) { /* private mode: the switch still works for this visit */ }

  function saved() {
    try { return store && store.getItem(KEY); } catch (e) { return null; }
  }
  function current() {
    return root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  var SUN = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var MOON = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

  function paintButton() {
    var b = document.getElementById('themeToggle');
    if (!b) return;
    var dark = current() === 'dark';
    b.innerHTML = dark ? SUN : MOON;
    var label = dark ? 'Switch to light mode' : 'Switch to dark mode';
    b.setAttribute('aria-label', label);
    b.title = label;
  }
  function paintBrowserBar() {
    var m = document.querySelector('meta[name="theme-color"]');
    var c = getComputedStyle(root).getPropertyValue('--bg').trim();
    if (m && c) m.setAttribute('content', c);
  }

  function apply(theme) {
    root.setAttribute('data-theme', theme);
    root.style.colorScheme = theme;
    paintButton();
    if (document.body) paintBrowserBar();
    document.dispatchEvent(new CustomEvent('themechange', { detail: theme }));
  }

  apply(saved() === 'light' ? 'light' : 'dark');

  document.addEventListener('DOMContentLoaded', function () {
    var style = document.createElement('style');
    style.textContent =
      '#themeToggle{position:fixed;z-index:60;top:calc(env(safe-area-inset-top,0px) + var(--toggle-top,4px));right:var(--toggle-right,108px);' +
      'width:44px;height:44px;min-height:44px;padding:0;display:flex;align-items:center;justify-content:center;border-radius:50%;' +
      'background:var(--toggle-bg,transparent);color:var(--toggle-fg,currentColor);border:1px solid var(--toggle-line,transparent);box-shadow:none;cursor:pointer}' +
      '#themeToggle:focus-visible{outline:2px solid currentColor;outline-offset:2px}';
    document.head.appendChild(style);
    var b = document.createElement('button');
    b.id = 'themeToggle';
    b.type = 'button';
    b.addEventListener('click', function () {
      var next = current() === 'dark' ? 'light' : 'dark';
      try { if (store) store.setItem(KEY, next); } catch (e) { /* still switches for this visit */ }
      apply(next);
    });
    document.body.appendChild(b);
    paintButton();
    paintBrowserBar();
  });
})();
