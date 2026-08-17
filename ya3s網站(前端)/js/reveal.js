/* =====================================================================
   YA3S — 進場動畫（與既有 index.js 完全獨立）
   .product-card / .brand-card / .trust-row article 等元素在進入
   視窗時淡入上移。列表重新渲染或頁面切換時會自動重新掃描。
   尊重 prefers-reduced-motion。
===================================================================== */
(function () {
  'use strict';

  var prefersReducedMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (prefersReducedMotion) return;

  var SELECTORS = [
    '.product-card',
    '.brand-card',
    '.trust-row article',
    '.detail-layout > *'
  ];

  var io = null;

  if ('IntersectionObserver' in window) {
    io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in-view');
          io.unobserve(entry.target);
        }
      });
    }, {
      threshold: 0.1,
      rootMargin: '0px 0px -6% 0px'
    });
  }

  function scan() {
    if (!io) return;
    SELECTORS.forEach(function (selector) {
      var nodes = document.querySelectorAll(selector + ':not(.reveal):not(.in-view)');
      nodes.forEach(function (el) {
        el.classList.add('reveal');
        io.observe(el);
      });
    });
  }

  function boot() {
    scan();

    // 商品卡 / 品牌牆會由 index.js 重新渲染，監聽 DOM 變化後重新掃描
    if (window.MutationObserver) {
      new MutationObserver(function () { scan(); })
        .observe(document.body, { childList: true, subtree: true });
    }

    // 頁面切換（list/detail/member/store）依 hidden 屬性，也需重新掃描
    if (window.MutationObserver) {
      ['pageList', 'pageDetail', 'pageMember', 'pageStore'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) {
          new MutationObserver(function () { scan(); })
            .observe(el, { attributes: true, attributeFilter: ['hidden'] });
        }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
