// Baby Dance Party TV — frontend interactions
(function () {
  'use strict';

  // Theme toggle (dark/light), persisted
  var toggle = document.getElementById('themeToggle');
  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') || 'dark';
  }
  function paintToggle() {
    if (toggle) toggle.textContent = currentTheme() === 'dark' ? '🌙' : '☀️';
  }
  if (toggle) {
    toggle.addEventListener('click', function () {
      var next = currentTheme() === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('bdp-theme', next); } catch (e) {}
      paintToggle();
    });
    paintToggle();
  }

  // Mobile nav
  var menuToggle = document.getElementById('menuToggle');
  var mobileNav = document.getElementById('mobileNav');
  if (menuToggle && mobileNav) {
    menuToggle.addEventListener('click', function () {
      mobileNav.classList.toggle('open');
    });
  }

  // Click tracking for ads / youtube / smartlink (privacy-friendly, no PII)
  function track(kind, label) {
    try {
      fetch('/api/track-click', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: kind, label: label || '' }),
        keepalive: true,
      });
    } catch (e) {}
  }
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-track]');
    if (el) track(el.getAttribute('data-track'), el.getAttribute('data-label') || '');
    var adLink = e.target.closest('.ad-body a');
    if (adLink) track('ad', (adLink.href || '').slice(0, 100));
  });
})();
