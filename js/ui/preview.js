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
const AUTO_PAGE_STYLE_ID = 'bill-auto-page-size';
// Extra height on a fitted page, so rounding never pushes the last line onto a second page.
const AUTO_PAGE_SLACK_MM = 2;

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
    if (this.pageSize.autoHeight) {
      this.fitAutoHeight();
      return;
    }
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

  /**
   * A page as long as the bill ("size: 80mm auto"): measure the bill at the page width, set
   * the page height to match with an @page rule inside the bill, and fit the preview to the
   * pane's width (a long receipt scrolls instead of shrinking).
   */
  fitAutoHeight() {
    const pageW = this.pageSize.widthMm * MM_TO_PX;
    this.frame.style.width = `${pageW}px`;
    // The root's scrollHeight is never less than the frame's height, so shrink it first.
    this.frame.style.height = '0px';
    let contentH = 0;
    try {
      const doc = this.frame.contentDocument;
      if (doc && doc.documentElement && doc.head) {
        contentH = doc.documentElement.scrollHeight;
        const heightMm = Math.ceil(contentH / MM_TO_PX) + AUTO_PAGE_SLACK_MM;
        let style = doc.getElementById(AUTO_PAGE_STYLE_ID);
        if (!style) {
          style = doc.createElement('style');
          style.id = AUTO_PAGE_STYLE_ID;
          doc.head.append(style); // last, so it wins over the template's own @page rule
        }
        // Margin 0: the measured height is the whole page, so page margins would not fit.
        style.textContent = `@page { size: ${this.pageSize.widthMm}mm ${heightMm}mm; margin: 0; }`;
      }
    } catch {
      /* not ready */
    }
    contentH = Math.max(contentH, 100);
    const availableW = Math.max(100, this.viewport.clientWidth - PAD * 2);
    const scale = Math.min(1.25, availableW / pageW);
    this.frame.style.height = `${contentH}px`;
    this.frame.style.transform = `scale(${scale})`;
    this.stage.style.width = `${pageW * scale}px`;
    this.stage.style.height = `${contentH * scale}px`;
  }

  /** Print only the bill, at the template's page size. Resolves once the dialog was opened. */
  async print() {
    const win = this.frame.contentWindow;
    if (!win) throw new Error('Preview is not ready yet.');
    if (this.pageSize.autoHeight) this.fitAutoHeight(); // the page height matches the bill as it is now
    win.focus();
    win.print();
  }
}
