// 화면 모드(흰 바탕·모눈 노트·어둡게). 고른 모드는 이 브라우저에만 기억한다. 기본은 흰 바탕.
(function () {
  'use strict';
  var THEMES = ['white', 'grid', 'dark'];
  var KEY = 'pds-note-theme';
  function saved() {
    try { var t = localStorage.getItem(KEY); return THEMES.indexOf(t) >= 0 ? t : 'white'; } catch (e) { return 'white'; }
  }
  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var buttons = document.querySelectorAll('[data-theme-choice]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute('aria-pressed', String(buttons[i].getAttribute('data-theme-choice') === theme));
    }
  }
  apply(saved());
  document.addEventListener('DOMContentLoaded', function () {
    apply(saved());
    document.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('[data-theme-choice]');
      if (!btn) return;
      var theme = btn.getAttribute('data-theme-choice');
      try { localStorage.setItem(KEY, theme); } catch (err) { /* 저장 못 해도 지금 화면에는 적용 */ }
      apply(theme);
    });
  });
})();
