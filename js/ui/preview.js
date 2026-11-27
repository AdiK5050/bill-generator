// Live preview in a sandboxed iframe, scaled to fit, plus printing.
//
// sandbox="allow-same-origin allow-modals": no allow-scripts, so nothing in the bill can run.
// allow-same-origin lets the app measure the page height and call print() on the frame;
// it is safe only because scripts are disabled. allow-modals is required for print().
import { h } from './dom.js';

const MM_TO_PX = 96 / 25.4;
// The exact opposite of the "(max-width: 900px)" phone/tablet query in app.css, so the two
// can never both miss (e.g. at 900.5px when zoomed). Outside it, the pane has a fixed height.
const FIXED_HEIGHT_PANE = 'not all and (max-width: 900px)';
const PAD = 16;

export class Preview {
  constructor(container) {
    this.container = container;
    this.stage = h('div', { class: 'preview-stage' });
    this.frame = h('iframe', {
      class: 'preview-frame',
      title: 'Bill preview',
      sandbox: 'allow-same-origin allow-modals',
      referrerpolicy: 'no-referrer',
      tabindex: '-1',
      // The frame is sized to the whole bill and scaled to fit, so it never needs its own
      // scrollbar. This attribute does not affect printing (unlike overflow: hidden on the bill).
      scrolling: 'no',
    });
    this.stage.append(this.frame);
    container.append(this.stage);
    this.pageSize = { widthMm: 210, heightMm: 297 };
    // The pane around the preview sets the space the bill is scaled into.
    this.viewport = container.parentElement || container;
    this.fixedHeight = window.matchMedia(FIXED_HEIGHT_PANE);
    this.frame.addEventListener('load', () => this.fit());
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(this.viewport);
    this.onMediaChange = () => this.fit();
    this.fixedHeight.addEventListener('change', this.onMediaChange);
  }

  /** Stop watching sizes. Call when the preview is removed from the page. */
  destroy() {
    this.resizeObserver.disconnect();
    this.fixedHeight.removeEventListener('change', this.onMediaChange);
  }

  /** Show a rendered bill document. */
  show(html, pageSize) {
    this.pageSize = pageSize || this.pageSize;
    this.frame.srcdoc = html;
  }

  fit() {
    const pageW = this.pageSize.widthMm * MM_TO_PX;
    const pageH = this.pageSize.heightMm * MM_TO_PX;
    let contentH = pageH;
    // The root's scrollHeight is never less than the frame's own height, so reset the frame to
    // one page before measuring; otherwise a bill that got shorter would keep its old height.
    this.frame.style.height = `${pageH}px`;
    try {
      const doc = this.frame.contentDocument;
      if (doc && doc.documentElement) contentH = Math.max(pageH, doc.documentElement.scrollHeight);
    } catch {
      /* not ready */
    }
    // Fit one whole page: by width and height when the pane has a fixed height (desktop),
    // by width only on phones, where the pane grows with the bill and the page scrolls.
    // A bill longer than one page keeps that size and the pane scrolls to the next pages,
    // instead of shrinking until the text is unreadable.
    const availableW = Math.max(100, this.viewport.clientWidth - PAD * 2);
    let scale = Math.min(1.25, availableW / pageW);
    if (this.fixedHeight.matches) {
      const availableH = Math.max(100, this.viewport.clientHeight - PAD * 2);
      scale = Math.min(scale, availableH / pageH);
    }
    this.frame.style.width = `${pageW}px`;
    this.frame.style.height = `${contentH}px`;
    this.frame.style.transform = `scale(${scale})`;
    this.stage.style.width = `${pageW * scale}px`;
    this.stage.style.height = `${contentH * scale}px`;
  }

  /** Print only the bill, at the template's page size. Resolves once the dialog was opened. */
  async print() {
    const win = this.frame.contentWindow;
    if (!win) throw new Error('Preview is not ready yet.');
    win.focus();
    win.print();
  }
}
