/**
 * Svelte action: lets a sideways-scrolling row be scrolled with a mouse.
 *
 *   <div use:dragScroll> ... </div>
 *
 * - The mouse wheel scrolls it sideways (while there is room to go that
 *   way; at either end the page scrolls as normal).
 * - Click and drag scrolls it. A drag doesn't count as a click on the
 *   chip it started on.
 * Touch and pen are left to the browser, which already swipes these.
 */
const DRAG_THRESHOLD = 5; // px moved before a press becomes a drag

export function dragScroll(node) {
  const canScroll = () => node.scrollWidth > node.clientWidth + 1;

  function onWheel(e) {
    if (!canScroll() || e.ctrlKey) return;
    // A trackpad's sideways swipe already works; only turn up/down into sideways.
    if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    // deltaMode 1 = lines (Firefox with a mouse wheel), 0 = pixels.
    const dy = e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY;
    const max = node.scrollWidth - node.clientWidth;
    if ((dy < 0 && node.scrollLeft <= 0) || (dy > 0 && node.scrollLeft >= max - 1)) return;
    e.preventDefault();
    node.scrollLeft += dy;
  }

  let startX = 0, startLeft = 0, pointerId = null, dragging = false;

  function onPointerDown(e) {
    if (e.pointerType !== 'mouse' || e.button !== 0 || !canScroll()) return;
    pointerId = e.pointerId;
    startX = e.clientX;
    startLeft = node.scrollLeft;
    dragging = false;
  }
  function onPointerMove(e) {
    if (e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    if (!dragging && Math.abs(dx) < DRAG_THRESHOLD) return;
    if (!dragging) {
      dragging = true;
      node.setPointerCapture?.(pointerId);
      node.classList.add('drag-scrolling');
    }
    node.scrollLeft = startLeft - dx;
  }
  function onPointerUp(e) {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    if (!dragging) return;
    node.classList.remove('drag-scrolling');
    // Swallow the click that follows the drag so the chip under the
    // mouse doesn't get picked.
    const swallow = ev => { ev.stopPropagation(); ev.preventDefault(); };
    node.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => node.removeEventListener('click', swallow, { capture: true }), 0);
    dragging = false;
  }

  node.addEventListener('wheel', onWheel, { passive: false });
  node.addEventListener('pointerdown', onPointerDown);
  node.addEventListener('pointermove', onPointerMove);
  node.addEventListener('pointerup', onPointerUp);
  node.addEventListener('pointercancel', onPointerUp);
  return {
    destroy() {
      node.removeEventListener('wheel', onWheel);
      node.removeEventListener('pointerdown', onPointerDown);
      node.removeEventListener('pointermove', onPointerMove);
      node.removeEventListener('pointerup', onPointerUp);
      node.removeEventListener('pointercancel', onPointerUp);
    },
  };
}
