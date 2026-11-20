// WAW inline icons (stroke icons drawn with currentColor, so they follow the
// button's text colour in every skin and state).
(function () {
  "use strict";
  const svg = (body, { fill = false, vb = 24 } = {}) =>
    `<svg class="wi" viewBox="0 0 ${vb} ${vb}" width="12" height="12" aria-hidden="true" fill="${fill ? "currentColor" : "none"}" stroke="${fill ? "none" : "currentColor"}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  window.WAWIcons = {
    record: svg('<circle cx="12" cy="12" r="7"/>', { fill: true }),
    monitor: svg('<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="5" height="7" rx="1.5"/><rect x="16" y="14" width="5" height="7" rx="1.5"/>'),
    automation: svg('<path d="M3 17c3 0 4-10 7-10s3 10 7 10 3-6 4-6"/><circle cx="3" cy="17" r="1.6" fill="currentColor"/><circle cx="21" cy="11" r="1.6" fill="currentColor"/>'),
    tempo: svg('<path d="M9 3h6l4 18H5z"/><path d="M12 17 17 7"/><path d="M8 17h8"/>'),
    meter: svg('<text x="12" y="10.5" text-anchor="middle" font-size="10" font-weight="700" font-family="system-ui,sans-serif" fill="currentColor" stroke="none">4</text><path d="M6 12.5h12"/><text x="12" y="22.5" text-anchor="middle" font-size="10" font-weight="700" font-family="system-ui,sans-serif" fill="currentColor" stroke="none">4</text>'),
    marker: svg('<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>'),
    plus: svg('<path d="M12 6v12M6 12h12"/>'),
    zoomIn: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.8-4.8M10.5 7.5v6M7.5 10.5h6"/>'),
    zoomOut: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.8-4.8M7.5 10.5h6"/>'),
    fit: svg('<path d="M3 8V4h4M21 8V4h-4M3 16v4h4M21 16v4h-4M7 12h10M9 9.5 6.5 12 9 14.5M15 9.5l2.5 2.5-2.5 2.5"/>'),
    rowsLess: svg('<rect x="3" y="5" width="18" height="4" rx="1"/><rect x="3" y="11" width="18" height="4" rx="1"/><rect x="3" y="17" width="18" height="3" rx="1"/>'),
    rowsMore: svg('<rect x="3" y="3" width="18" height="8" rx="1.5"/><rect x="3" y="13" width="18" height="8" rx="1.5"/>'),
  };
})();
