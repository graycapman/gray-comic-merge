// Fixed-height virtual list: only visible rows exist in the DOM, so thousands of pages stay fast.

export class VirtualRows {
  /**
   * @param host scroll container (needs a height)
   * @param rowHeight px
   * @param renderRow (index) => HTMLElement   (positioned by this class)
   */
  constructor(host, rowHeight, renderRow) {
    this.host = host;
    this.h = rowHeight;
    this.renderRow = renderRow;
    this.count = 0;
    this.inner = document.createElement('div');
    this.inner.className = 'vr-inner';
    host.append(this.inner);
    this._raf = 0;
    host.addEventListener('scroll', () => this.schedule(), { passive: true });
    new ResizeObserver(() => this.schedule()).observe(host);
  }

  setCount(n) {
    this.count = n;
    this.inner.style.height = `${n * this.h}px`;
    this.draw();
  }

  schedule() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); });
  }

  /** Re-renders visible rows (call after data changes). */
  draw() {
    const top = this.host.scrollTop;
    const view = this.host.clientHeight || 600;
    const first = Math.max(0, Math.floor(top / this.h) - 6);
    const last = Math.min(this.count, Math.ceil((top + view) / this.h) + 6);
    this.first = first;
    this.last = last;
    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) {
      const el = this.renderRow(i);
      el.style.top = `${i * this.h}px`;
      el.style.height = `${this.h}px`;
      el.dataset.index = i;
      frag.append(el);
    }
    // keep overlay children (e.g. drop line) that are marked persistent
    for (const child of [...this.inner.children]) if (!child.dataset.keep) child.remove();
    this.inner.append(frag);
    this.afterDraw?.();
  }

  scrollToIndex(i) {
    const top = i * this.h;
    if (top < this.host.scrollTop) this.host.scrollTop = top;
    else if (top + this.h > this.host.scrollTop + this.host.clientHeight) this.host.scrollTop = top + this.h - this.host.clientHeight;
  }
}
