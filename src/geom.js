// Bildschirm-Koordinaten in Seiten-Koordinaten umrechnen, auch wenn die Ansicht gedreht ist.
// Die Seite (.page) steckt in einem .page-slot und wird per CSS gedreht (data-rot = 0/90/180/270).

export function localPoint(pageEl, cx, cy) {
  const rot = Number(pageEl.dataset.rot || 0);
  const ref = rot ? pageEl.parentElement : pageEl;
  const r = ref.getBoundingClientRect();
  const dx = cx - r.left, dy = cy - r.top;
  const w = pageEl.offsetWidth, h = pageEl.offsetHeight;
  switch (rot) {
    case 90: return [dy, h - dx];
    case 180: return [w - dx, h - dy];
    case 270: return [w - dy, dx];
    default: return [dx, dy];
  }
}

export function localRect(pageEl, r) {
  const [x1, y1] = localPoint(pageEl, r.left, r.top);
  const [x2, y2] = localPoint(pageEl, r.right, r.bottom);
  return { l: Math.min(x1, x2), t: Math.min(y1, y2), r: Math.max(x1, x2), b: Math.max(y1, y2) };
}

export function screenBox(pageEl) {
  const rot = Number(pageEl.dataset.rot || 0);
  return (rot ? pageEl.parentElement : pageEl).getBoundingClientRect();
}
