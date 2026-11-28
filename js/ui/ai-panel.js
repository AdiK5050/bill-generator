// AI assistant panel for the template editor: a side panel that slides over the code from the
// left, so the preview stays visible. It closes when you click outside it or press Escape.
// The assistant proposes a new version of the template; the editor previews it and the user
// applies or discards it, from the panel or from a bar above the editor. Applied changes can be undone.
import { h, dialog, confirmDialog } from './dom.js';
import { getActiveAi, getAiConfig, setAiConfig, PROVIDERS } from '../ai/config.js';
import { getKeySyncState } from '../ai/key-sync.js';
import { createTemplateAssistant, fieldChanges } from '../ai/template-assistant.js';

const TOOL_DONE = {
  read_template: 'read the template',
  edit_template: 'edited the template',
  write_template: 'wrote a new template',
  check_template: 'checked the template',
};

/**
 * host: {
 *   getHtml(): string             current editor text
 *   setHtml(html): void           replace editor text (and refresh the preview)
 *   preview(html | null): void    preview a proposal, or null to preview the editor again
 * }
 */
export function createAiPanel(host, { placeholder } = {}) {
  let assistant = null;
  let isOpen = false;
  let active = null; // { provider, model, ... } the assistant was made with
  let controller = null;
  let proposal = null; // { html, base }
  let showingProposal = false;
  const undoStack = [];

  const status = h('span', { class: 'muted small ai-model' });
  const log = h('div', { class: 'ai-log', 'aria-live': 'polite' });
  const input = h('textarea', {
    class: 'input ai-input',
    rows: 2,
    placeholder:
      placeholder ||
      'Ask for a change, e.g. "Add a vehicle number field under the invoice date" or "Make the header dark green".',
    'aria-label': 'Message to the AI assistant',
  });
  const sendBtn = h('button', { type: 'button', class: 'btn primary', text: 'Send' });
  const stopBtn = h('button', { type: 'button', class: 'btn', text: 'Stop', hidden: true });
  const undoBtn = h('button', { type: 'button', class: 'btn small ghost', text: 'Undo AI change', hidden: true });

  // The same proposal controls appear in the panel and, while the panel is closed, above the editor.
  const makeBar = (extra) => {
    const text = h('p', { class: 'ai-proposal-text' });
    const toggle = h('button', { type: 'button', class: 'btn small', text: 'Show current', onclick: toggleView });
    const discard = h('button', { type: 'button', class: 'btn small', text: 'Discard', onclick: discardProposal });
    const apply = h('button', { type: 'button', class: 'btn small primary', text: 'Apply', onclick: applyProposal });
    const el = h(
      'div',
      { class: 'ai-proposal', hidden: true },
      text,
      h('div', { class: 'row' }, extra, toggle, discard, apply),
    );
    return { el, text, toggle, apply };
  };
  const panelBar = makeBar(null);
  const editorBar = makeBar(
    h('button', { type: 'button', class: 'btn small ghost', text: 'Open chat', onclick: () => open() }),
  );
  editorBar.el.classList.add('ai-proposal-editor');
  const bars = [panelBar, editorBar];

  const toggleButton = h('button', {
    type: 'button',
    class: 'btn ai-toggle',
    text: 'AI assistant',
    'aria-expanded': 'false',
    onclick: () => (isOpen ? close() : open()),
  });
  const closeBtn = h('button', {
    type: 'button',
    class: 'btn small ghost ai-close',
    text: '✕',
    'aria-label': 'Close the AI assistant',
    onclick: () => close(),
  });

  const setupText = h('p', {
    text: 'To use the assistant, add your own Claude or Gemini API key in Settings.',
  });
  const setupNote = h(
    'div',
    { class: 'ai-setup', hidden: true },
    setupText,
    h('button', {
      type: 'button',
      class: 'btn small primary',
      text: 'Open Settings',
      onclick: async () => {
        if (
          await confirmDialog('Leave the editor?', 'Unsaved changes in the editor will be lost.', { okLabel: 'Leave' })
        )
          location.hash = '#/settings';
      },
    }),
  );
  const composer = h('div', { class: 'ai-composer' }, input, h('div', { class: 'ai-actions' }, sendBtn, stopBtn));

  const el = h(
    'section',
    { class: 'ai-drawer', 'aria-label': 'AI assistant', id: 'ai-drawer' },
    h(
      'div',
      { class: 'ai-head' },
      h('div', { class: 'ai-title' }, h('h3', { text: 'AI assistant' }), status),
      undoBtn,
      closeBtn,
    ),
    setupNote,
    log,
    panelBar.el,
    composer,
  );
  el.inert = true;
  toggleButton.setAttribute('aria-controls', 'ai-drawer');

  function syncUi() {
    for (const bar of bars) {
      bar.el.hidden = !proposal;
      bar.toggle.textContent = showingProposal ? 'Show current' : 'Show proposal';
      bar.apply.disabled = Boolean(controller);
    }
    // Above the editor only while the panel is closed; inside the panel it has its own copy.
    editorBar.el.hidden = !proposal || isOpen;
    toggleButton.classList.toggle('has-news', Boolean(proposal || controller));
  }

  function open() {
    if (isOpen) return;
    isOpen = true;
    el.inert = false;
    el.classList.add('open');
    toggleButton.setAttribute('aria-expanded', 'true');
    syncUi();
    refreshStatus();
    input.focus({ preventScroll: true });
  }

  function close({ restoreFocus = true } = {}) {
    if (!isOpen) return;
    isOpen = false;
    el.classList.remove('open');
    el.inert = true;
    toggleButton.setAttribute('aria-expanded', 'false');
    syncUi();
    if (restoreFocus) toggleButton.focus({ preventScroll: true });
  }

  // Close on a click outside the panel. Dialogs (the notice, confirmations) count as inside,
  // and so does the button that toggles the panel.
  const onPointerDown = (e) => {
    if (!isOpen || !(e.target instanceof Element)) return;
    if (el.contains(e.target) || toggleButton.contains(e.target) || e.target.closest('dialog')) return;
    close({ restoreFocus: false });
  };
  const onKeyDown = (e) => {
    if (e.key === 'Escape' && isOpen && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      close();
    }
  };
  // Clicks inside the bill preview (an iframe) never reach this page; the page loses focus instead.
  const onWindowBlur = () => {
    setTimeout(() => {
      if (isOpen && document.activeElement?.tagName === 'IFRAME' && !el.contains(document.activeElement)) {
        close({ restoreFocus: false });
      }
    });
  };
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('blur', onWindowBlur);

  function addMessage(role, text) {
    const msg = h('div', { class: `ai-msg ${role}` }, h('p', { text }));
    log.append(msg);
    log.hidden = false;
    log.scrollTop = log.scrollHeight;
    return msg;
  }

  async function refreshStatus() {
    const ai = await getActiveAi();
    const changed =
      !active || !ai || ai.provider !== active.provider || ai.model !== active.model || ai.apiKey !== active.apiKey;
    if (changed) {
      // A different provider, model or key starts a new conversation.
      assistant = null;
      active = ai;
    }
    setupNote.hidden = Boolean(ai);
    if (!ai) {
      const [cfg, sync] = await Promise.all([getAiConfig(), getKeySyncState()]);
      setupText.textContent =
        sync.providers.includes(cfg.provider) && !sync.unlocked
          ? 'Your API key is synced from another device. Enter your sync passphrase in Settings > AI assistant to use it here.'
          : 'To use the assistant, add your own Claude or Gemini API key in Settings.';
    }
    composer.hidden = !ai;
    log.hidden = !log.childElementCount;
    if (ai) {
      const model = PROVIDERS[ai.provider].models.find((m) => m.id === ai.model);
      status.textContent = `${PROVIDERS[ai.provider].label}, ${model ? model.label.replace(/ \(.*\)$/, '') : ai.model}`;
    } else {
      status.textContent = '';
    }
  }

  function setBusy(busy) {
    sendBtn.hidden = busy;
    stopBtn.hidden = !busy;
    input.disabled = busy;
    syncUi();
  }

  // base is the editor text the assistant worked from, so edits made while it ran count as
  // edits made after the proposal.
  function showProposal(html, base) {
    proposal = { html, base };
    const { added, removed, valid } = fieldChanges(base, html);
    const bits = [];
    if (!valid) bits.push('The proposal has errors; check the preview before applying.');
    if (added.length) bits.push(`New fields: ${added.join(', ')}.`);
    if (removed.length) bits.push(`Removed fields: ${removed.join(', ')}.`);
    if (!added.length && !removed.length && valid) bits.push('Layout or style changes; no fields added or removed.');
    for (const bar of bars) bar.text.textContent = `Proposed change. ${bits.join(' ')}`;
    showingProposal = true;
    syncUi();
    host.preview(html);
  }

  function clearProposal() {
    proposal = null;
    showingProposal = false;
    syncUi();
    host.preview(null);
  }

  function toggleView() {
    if (!proposal) return;
    showingProposal = !showingProposal;
    syncUi();
    host.preview(showingProposal ? proposal.html : null);
  }

  function discardProposal() {
    clearProposal();
    addMessage('status', 'Proposal discarded.');
  }

  async function applyProposal() {
    if (!proposal || controller) return;
    const current = host.getHtml();
    if (
      current !== proposal.base &&
      !(await confirmDialog(
        'Replace your edits?',
        'You edited the template after the assistant made this proposal. Applying it replaces those edits.',
        { okLabel: 'Apply anyway' },
      ))
    )
      return;
    undoStack.push(current);
    const html = proposal.html;
    clearProposal();
    host.setHtml(html);
    undoBtn.hidden = false;
    addMessage('status', 'Applied to the editor. Press Save to keep it.');
  }

  async function confirmNotice(ai) {
    // Shown once per provider, since what happens to the data differs. (An older version
    // stored a single true for all providers.)
    const seen = ai.config.noticeSeen;
    if (seen === true || seen?.[ai.provider]) return true;
    const gemini = ai.provider === 'gemini';
    const r = await dialog({
      title: 'Before you use the AI assistant',
      body: h(
        'div',
        { class: 'stack' },
        h('p', {
          text: `Your request and the template's HTML are sent to ${gemini ? 'Google (Gemini)' : 'Anthropic (Claude)'} using your API key. Usage is billed to your account with them.`,
        }),
        h('p', {
          text: 'Only the template is sent, never your saved bills or customers. The template preview here uses made-up sample values. Avoid typing personal details into your messages.',
        }),
        gemini
          ? h('p', {
              class: 'warn',
              text: "On Gemini's free tier, Google may use requests to improve its products, and people at Google may read them. Google's terms also allow only paid use in the European Economic Area, Switzerland and the UK.",
            })
          : null,
        h('p', {
          class: 'muted',
          text: 'The assistant only proposes changes. You see them in the preview and choose to apply or discard them.',
        }),
      ),
      buttons: [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Continue', value: 'ok', primary: true },
      ],
    });
    if (r !== 'ok') return false;
    await setAiConfig({ noticeSeen: { ...(typeof seen === 'object' && seen ? seen : {}), [ai.provider]: true } });
    return true;
  }

  async function send() {
    const text = input.value.trim();
    if (!text || controller) return;
    await refreshStatus();
    const ai = active;
    if (!ai) return;
    if (!(await confirmNotice(ai))) return;
    if (proposal) clearProposal(); // a new request replaces a pending proposal
    if (!assistant) assistant = createTemplateAssistant(ai);
    addMessage('user', text);
    input.value = '';
    const working = addMessage('status', 'Working... 0 s');
    // A live timer and the last tool used, so a slow model does not look frozen.
    const started = Date.now();
    let doing = 'Thinking about your request.';
    const tick = () => {
      const secs = Math.round((Date.now() - started) / 1000);
      working.firstChild.textContent = `Working... ${secs} s. ${doing}`;
    };
    tick();
    const timer = setInterval(tick, 1000);
    controller = new AbortController();
    setBusy(true);
    const base = host.getHtml();
    try {
      const res = await assistant.send(text, base, {
        signal: controller.signal,
        onStep: (step, calls) => {
          const did = [...new Set(calls.map((c) => TOOL_DONE[c.name] || 'used a tool'))].join(' and ');
          doing = `It ${did}; now reviewing the result (step ${step + 1}).`;
          tick();
        },
      });
      working.remove();
      addMessage('assistant', res.text || (res.draft ? 'Here is the proposed change.' : 'Done.'));
      if (res.draft) showProposal(res.draft, base);
    } catch (e) {
      working.remove();
      if (e.kind === 'aborted') addMessage('status', 'Stopped.');
      else addMessage('error', e.message);
      if (e.kind === 'auth') setupNote.hidden = false;
    } finally {
      clearInterval(timer);
      controller = null;
      setBusy(false);
      if (isOpen) input.focus({ preventScroll: true });
    }
  }

  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', () => controller?.abort());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  undoBtn.addEventListener('click', () => {
    const prev = undoStack.pop();
    if (prev === undefined) return;
    if (proposal) clearProposal();
    host.setHtml(prev);
    undoBtn.hidden = undoStack.length === 0;
    addMessage('status', 'Undid the last applied change.');
  });

  const onConfigChanged = () => refreshStatus();
  window.addEventListener('ai-config-changed', onConfigChanged);
  refreshStatus();

  return {
    /** The side panel; add it anywhere in the view (it is positioned over the page). */
    el,
    /** Proposal controls shown above the editor while the panel is closed. */
    bar: editorBar.el,
    /** The button that opens and closes the panel. */
    toggleButton,
    open,
    close,
    /** True while a request is running or a proposal waits to be applied. */
    hasPending: () => Boolean(proposal || controller),
    /** Stop any request in flight and remove listeners. Called when the editor closes. */
    destroy() {
      controller?.abort();
      window.removeEventListener('ai-config-changed', onConfigChanged);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', onWindowBlur);
    },
  };
}
