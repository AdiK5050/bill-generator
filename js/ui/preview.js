// Live preview in a sandboxed iframe, scaled to fit, plus printing.
//
// sandbox="allow-same-origin allow-modals": no allow-scripts, so nothing in the bill can run.
// allow-same-origin lets the app measure the page height and call print() on the frame;
// it is safe only because scripts are disabled. allow-modals is required for print().
import { h } from './dom.js';

const MM_TO_PX = 96 / 25.4;

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
    });
    this.stage.append(this.frame);
    container.append(this.stage);
    this.pageSize = { widthMm: 210, heightMm: 297 };
    this.frame.addEventListener('load', () => this.fit());
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(container);
  }

  /** Show a rendered bill document. */
  show(html, pageSize) {
    this.pageSize = pageSize || this.pageSize;
    const scrollTop = this.container.scrollTop;
    this.frame.srcdoc = html;
    this.frame.addEventListener(
      'load',
      () => {
        this.container.scrollTop = scrollTop;
      },
      { once: true },
    );
  }

  fit() {
    const pageW = this.pageSize.widthMm * MM_TO_PX;
    const pageH = this.pageSize.heightMm * MM_TO_PX;
    let contentH = pageH;
    try {
      const doc = this.frame.contentDocument;
      if (doc && doc.documentElement) contentH = Math.max(pageH, doc.documentElement.scrollHeight);
    } catch {
      /* not ready */
    }
    const available = Math.max(200, this.container.clientWidth - 32);
    const scale = Math.min(1.25, available / pageW);
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
