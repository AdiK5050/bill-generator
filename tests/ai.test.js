// AI assistant tests. The provider APIs are replaced by a fake fetch, so no key or network is used.
import { createSession, testKey, AiError } from '../js/ai/providers.js';
import {
  getKeySyncState,
  createPassphrase,
  unlock,
  lockDevice,
  saveSyncedKey,
  readSyncedKey,
  removeSyncedKey,
  PassphraseError,
} from '../js/ai/key-sync.js';
import { getActiveAi, setAiConfig } from '../js/ai/config.js';
import { getKv, setKv, exportBackup, importBackup } from '../js/storage.js';
import {
  runTemplateTool,
  fieldChanges,
  createTemplateAssistant,
  checkReport,
  TOOLS,
} from '../js/ai/template-assistant.js';

const TEMPLATE = `<!doctype html><html><head><title>T</title><style>@page { size: A4; margin: 0; }</style></head>
<body><h1>{{business_name}}</h1><p>Date: {{invoice_date}}</p>
<table><tr data-repeat="items"><td>{{item.description}}</td><td>{{item.total}}</td></tr></table>
<p>Total: {{grand_total}}</p></body></html>`;

/** A fake fetch that answers with queued responses and records every request. */
function fakeFetch(responses) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const r = responses.shift();
    if (!r) throw new Error('no more fake responses');
    if (r.networkError) throw new TypeError('Failed to fetch');
    return {
      ok: (r.status || 200) < 400,
      status: r.status || 200,
      json: async () => r.body,
    };
  };
  f.calls = calls;
  return f;
}

export async function runAiTests() {
  const results = [];
  const t = async (name, fn) => {
    try {
      await fn();
      results.push(['PASS', `ai: ${name}`]);
    } catch (e) {
      results.push(['FAIL', `ai: ${name}`, e.message]);
    }
  };
  const eq = (a, b, msg = '') => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${msg} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
  };
  const ok = (c, msg) => {
    if (!c) throw new Error(msg || 'assertion failed');
  };
  const rejects = async (p, check) => {
    try {
      await p;
    } catch (e) {
      check(e);
      return;
    }
    throw new Error('expected an error');
  };

  // ---------- Template tools ----------

  await t('edit applies in order', () => {
    const r = runTemplateTool(
      'edit_template',
      {
        edits: [
          { find: '<p>Date: {{invoice_date}}</p>', replace: '<p>Date: {{invoice_date}}</p><p>{{vehicle_number}}</p>' },
          { find: '{{vehicle_number}}', replace: 'Vehicle: {{vehicle_number}}' },
        ],
      },
      TEMPLATE,
    );
    ok(r.draft.includes('<p>Vehicle: {{vehicle_number}}</p>'), r.draft);
    ok(r.output.includes('vehicle_number: text'), r.output);
  });

  await t('edit is all or nothing', () => {
    let msg = '';
    try {
      runTemplateTool(
        'edit_template',
        {
          edits: [
            { find: '{{business_name}}', replace: 'X' },
            { find: 'not in the template', replace: 'Y' },
          ],
        },
        TEMPLATE,
      );
    } catch (e) {
      msg = e.message;
    }
    ok(/Edit 2: the find text was not found/.test(msg), msg);
  });

  await t('edit rejects ambiguous find', () => {
    let msg = '';
    try {
      runTemplateTool('edit_template', { edits: [{ find: '<p>', replace: '<div>' }] }, TEMPLATE);
    } catch (e) {
      msg = e.message;
    }
    ok(/more than once/.test(msg), msg);
  });

  await t('edit with $ in replacement is literal', () => {
    const r = runTemplateTool('edit_template', { edits: [{ find: 'Total:', replace: "Total ($&$'):" }] }, TEMPLATE);
    ok(r.draft.includes("Total ($&$'):"), r.draft);
  });

  await t('write and read', () => {
    const r = runTemplateTool('write_template', { html: TEMPLATE.replace('T</title>', 'New</title>') }, '');
    eq(runTemplateTool('read_template', {}, r.draft).output, r.draft);
    ok(/Template loads/.test(r.output), r.output);
  });

  await t('report lists what the security filter removed', () => {
    const out = checkReport(
      TEMPLATE.replace('</body>', '<script>alert(1)</script><img src="https://x.test/a.png"></body>'),
    );
    ok(/Removed by the security filter:\n- (?!none)/.test(out), out);
  });

  await t('unknown tool and bad input', () => {
    let a = '';
    let b = '';
    try {
      runTemplateTool('delete_everything', {}, TEMPLATE);
    } catch (e) {
      a = e.message;
    }
    try {
      runTemplateTool('write_template', { html: '' }, TEMPLATE);
    } catch (e) {
      b = e.message;
    }
    ok(/Unknown tool/.test(a) && /complete template/.test(b), `${a} / ${b}`);
  });

  await t('field changes', () => {
    const after = TEMPLATE.replace('{{invoice_date}}', '{{invoice_due_date}}');
    eq(fieldChanges(TEMPLATE, after), { added: ['invoice_due_date'], removed: ['invoice_date'], valid: true });
  });

  await t('tool schemas are strict-ready', () => {
    const walk = (s) => {
      if (s.type === 'object') {
        ok(s.additionalProperties === false, 'additionalProperties');
        eq([...s.required].sort(), Object.keys(s.properties).sort(), 'required');
        Object.values(s.properties).forEach(walk);
      }
      if (s.type === 'array') walk(s.items);
    };
    TOOLS.forEach((tool) => walk(tool.schema));
  });

  // ---------- Claude connector ----------

  await t('claude: request shape and tool loop', async () => {
    const f = fakeFetch([
      {
        body: {
          stop_reason: 'tool_use',
          content: [
            { type: 'thinking', thinking: '', signature: 'sig1' },
            { type: 'tool_use', id: 'toolu_1', name: 'check_template', input: {} },
          ],
        },
      },
      { body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'All good.' }] } },
    ]);
    const s = createSession({
      provider: 'anthropic',
      apiKey: 'sk-test',
      model: 'claude-opus-5-5',
      system: 'SYS',
      tools: TOOLS,
      fetchImpl: f,
    });
    const seen = [];
    const res = await s.run([{ type: 'text', text: 'hi' }], {
      runTool: (name) => {
        seen.push(name);
        return 'report';
      },
    });
    eq(res.text, 'All good.');
    eq(seen, ['check_template']);
    const [first, second] = f.calls;
    eq(first.url, 'https://api.anthropic.com/v1/messages');
    const hd = first.init.headers;
    eq(hd['x-api-key'], 'sk-test');
    eq(hd['anthropic-version'], '2026-10-21');
    eq(hd['anthropic-dangerous-direct-browser-access'], 'true');
    eq(hd['anthropic-beta'], 'server-side-fallback-2026-07-01');
    eq(first.init.credentials, 'omit');
    eq(first.body.model, 'claude-opus-5-5');
    eq(first.body.fallbacks, 'default');
    eq(first.body.system[0].text, 'SYS');
    ok(
      first.body.tools.every((tl) => tl.strict === true && tl.input_schema),
      'tools',
    );
    ok(!('thinking' in first.body) && !('temperature' in first.body), 'no thinking/temperature params');
    // The assistant turn goes back unchanged, then the tool result.
    eq(second.body.messages[1].content[0], { type: 'thinking', thinking: '', signature: 'sig1' });
    eq(second.body.messages[2].content[0], { type: 'tool_result', tool_use_id: 'toolu_1', content: 'report' });
  });

  await t('claude: haiku has no fallback', async () => {
    const f = fakeFetch([{ body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }] } }]);
    const s = createSession({
      provider: 'anthropic',
      apiKey: 'k',
      model: 'claude-haiku-5-5',
      system: 'S',
      tools: TOOLS,
      fetchImpl: f,
    });
    await s.run([{ type: 'text', text: 'hi' }], { runTool: () => '' });
    ok(!('fallbacks' in f.calls[0].body) && !f.calls[0].init.headers['anthropic-beta'], 'no fallback');
  });

  await t('claude: tool errors go back as is_error', async () => {
    const f = fakeFetch([
      {
        body: {
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 't1', name: 'edit_template', input: { edits: [] } }],
        },
      },
      { body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } },
    ]);
    const s = createSession({
      provider: 'anthropic',
      apiKey: 'k',
      model: 'claude-opus-5-5',
      system: 'S',
      tools: TOOLS,
      fetchImpl: f,
    });
    await s.run([{ type: 'text', text: 'hi' }], {
      runTool: () => {
        throw new Error('bad edit');
      },
    });
    eq(f.calls[1].body.messages[2].content[0], {
      type: 'tool_result',
      tool_use_id: 't1',
      content: 'Error: bad edit',
      is_error: true,
    });
  });

  await t('claude: errors and rollback', async () => {
    const f = fakeFetch([
      { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } },
      { body: { stop_reason: 'refusal', content: [] } },
      { networkError: true },
      { status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } },
      { body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'fine' }] } },
    ]);
    const s = createSession({
      provider: 'anthropic',
      apiKey: 'k',
      model: 'claude-opus-5-5',
      system: 'S',
      tools: TOOLS,
      fetchImpl: f,
    });
    const go = () => s.run([{ type: 'text', text: 'hi' }], { runTool: () => '' });
    await rejects(go(), (e) => ok(e instanceof AiError && e.kind === 'auth', e.message));
    await rejects(go(), (e) => ok(e.kind === 'refusal', e.message));
    await rejects(go(), (e) => ok(e.kind === 'network', e.message));
    await rejects(go(), (e) => ok(e.kind === 'busy', e.message));
    eq(s.turns, 0, 'failed turns are rolled back');
    await go();
    eq(f.calls[4].body.messages.length, 1, 'only the new turn is sent');
  });

  await t('claude: step limit', async () => {
    const loop = () => ({
      body: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x', name: 'check_template', input: {} }] },
    });
    const f = fakeFetch([loop(), loop(), loop()]);
    const s = createSession({
      provider: 'anthropic',
      apiKey: 'k',
      model: 'claude-opus-5-5',
      system: 'S',
      tools: TOOLS,
      fetchImpl: f,
    });
    const res = await s.run([{ type: 'text', text: 'hi' }], { runTool: () => 'r', maxSteps: 3 });
    ok(res.stopped && f.calls.length === 3, 'stopped after 3');
  });

  await t('claude: stop', async () => {
    const controller = new AbortController();
    const f = async (url, init) =>
      new Promise((_, reject) =>
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
      );
    const s = createSession({
      provider: 'anthropic',
      apiKey: 'k',
      model: 'claude-opus-5-5',
      system: 'S',
      tools: TOOLS,
      fetchImpl: f,
    });
    const p = s.run([{ type: 'text', text: 'hi' }], { runTool: () => '', signal: controller.signal });
    controller.abort();
    await rejects(p, (e) => eq(e.kind, 'aborted'));
  });

  // ---------- Gemini connector ----------

  await t('gemini: request shape, signatures and function responses', async () => {
    const modelTurn = {
      role: 'model',
      parts: [
        { functionCall: { id: 'c1', name: 'write_template', args: { html: '<p>x</p>' } }, thoughtSignature: 'SIG' },
      ],
    };
    const f = fakeFetch([
      { body: { candidates: [{ content: modelTurn, finishReason: 'STOP' }] } },
      { body: { candidates: [{ content: { role: 'model', parts: [{ text: 'Done.', thoughtSignature: 'S2' }] } }] } },
    ]);
    const s = createSession({
      provider: 'gemini',
      apiKey: 'AIza-test',
      model: 'gemini-3.8-flash',
      system: 'SYS',
      tools: TOOLS,
      fetchImpl: f,
    });
    let gotInput = null;
    const res = await s.run([{ type: 'text', text: 'hi' }], {
      runTool: (name, input) => {
        gotInput = input;
        return 'report';
      },
    });
    eq(res.text, 'Done.');
    eq(gotInput, { html: '<p>x</p>' });
    const [first, second] = f.calls;
    eq(first.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    eq(first.init.headers['x-goog-api-key'], 'AIza-test');
    eq(first.body.systemInstruction, { parts: [{ text: 'SYS' }] });
    eq(first.body.generationConfig, { thinkingConfig: { thinkingLevel: 'low' } });
    const decls = first.body.tools[0].functionDeclarations;
    ok(!JSON.stringify(decls).includes('additionalProperties'), 'no additionalProperties');
    ok(!('parameters' in decls.find((d) => d.name === 'read_template')), 'no-input tool has no parameters');
    ok(
      decls.find((d) => d.name === 'edit_template').parameters.properties.edits.items.properties.find,
      'nested schema',
    );
    eq(second.body.contents[1], modelTurn, 'model turn returned unchanged');
    eq(second.body.contents[2], {
      role: 'user',
      parts: [{ functionResponse: { name: 'write_template', id: 'c1', response: { result: 'report' } } }],
    });
  });

  await t('gemini: blocked, empty and key errors', async () => {
    const f = fakeFetch([
      { body: { promptFeedback: { blockReason: 'SAFETY' } } },
      { body: { candidates: [{ finishReason: 'MAX_TOKENS', content: { role: 'model', parts: [] } }] } },
      {
        status: 400,
        body: {
          error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' },
        },
      },
      {
        status: 429,
        body: { error: { code: 429, message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED' } },
      },
    ]);
    const s = createSession({
      provider: 'gemini',
      apiKey: 'k',
      model: 'gemini-3.8-flash',
      system: 'S',
      tools: TOOLS,
      fetchImpl: f,
    });
    const go = () => s.run([{ type: 'text', text: 'hi' }], { runTool: () => '' });
    await rejects(go(), (e) => ok(e.kind === 'refusal' && /SAFETY/.test(e.message), e.message));
    await rejects(go(), (e) => ok(/cut off/.test(e.message), e.message));
    await rejects(go(), (e) => eq(e.kind, 'auth'));
    await rejects(go(), (e) => eq(e.kind, 'rate'));
  });

  await t('test key endpoints', async () => {
    const f = fakeFetch([{ body: { id: 'claude-opus-5-5' } }, { body: { name: 'models/gemini-3.8-flash' } }]);
    await testKey({ provider: 'anthropic', apiKey: 'k1', model: 'claude-opus-5-5', fetchImpl: f });
    await testKey({ provider: 'gemini', apiKey: 'k2', model: 'gemini-3.8-flash', fetchImpl: f });
    eq(f.calls[0].url, 'https://api.anthropic.com/v1/models/claude-opus-5-5');
    eq(f.calls[0].init.method, 'GET');
    eq(f.calls[1].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash');
    eq(f.calls[1].init.headers['x-goog-api-key'], 'k2');
  });

  // ---------- Synced API keys (end-to-end encrypted) ----------

  await t('key sync: passphrase, encrypt, lock and unlock', async () => {
    eq(await getKeySyncState(), { exists: false, unlocked: false, providers: [] });
    await rejects(createPassphrase('short'), (e) => ok(e instanceof PassphraseError, e.message));
    // Fewer PBKDF2 iterations keep the test fast; the app uses 600,000.
    await createPassphrase('correct horse battery', { iterations: 1000 });
    await rejects(createPassphrase('another passphrase', { iterations: 1000 }), (e) =>
      ok(/already set/.test(e.message)),
    );
    await saveSyncedKey('anthropic', 'sk-ant-secret-1234');
    eq(await getKeySyncState(), { exists: true, unlocked: true, providers: ['anthropic'] });
    eq(await readSyncedKey('anthropic'), 'sk-ant-secret-1234');
    const stored = JSON.stringify(await getKv('aiKeys'));
    ok(!stored.includes('sk-ant') && !stored.includes('secret') && !stored.includes('correct horse'), stored);
    await lockDevice();
    eq(await readSyncedKey('anthropic'), null, 'locked device cannot read');
    await rejects(saveSyncedKey('gemini', 'x'), (e) => ok(e instanceof PassphraseError));
    await rejects(unlock('wrong passphrase!'), (e) => ok(/not right/.test(e.message), e.message));
    await unlock('correct horse battery');
    eq(await readSyncedKey('anthropic'), 'sk-ant-secret-1234');
  });

  await t('key sync: a key cannot be moved to another provider', async () => {
    const rec = await getKv('aiKeys');
    await setKv('aiKeys', { ...rec, keys: { ...rec.keys, gemini: rec.keys.anthropic } });
    eq(await readSyncedKey('gemini'), null);
    await setKv('aiKeys', rec);
  });

  await t('key sync: used by the assistant, a device key wins', async () => {
    await setAiConfig({ provider: 'anthropic', keys: { anthropic: '', gemini: '' } });
    eq((await getActiveAi()).apiKey, 'sk-ant-secret-1234', 'synced key used');
    await setAiConfig({ keys: { anthropic: 'sk-device-only', gemini: '' } });
    eq((await getActiveAi()).apiKey, 'sk-device-only', 'device key wins');
    await setAiConfig({ keys: { anthropic: '', gemini: '' } });
  });

  await t('key sync: never in backups', async () => {
    const backup = await exportBackup();
    ok(!backup.data.kv.some((r) => r.id === 'aiKeys'), 'exported');
    const before = JSON.stringify(await getKv('aiKeys'));
    const evil = { id: 'aiKeys', updatedAt: Date.now() + 1e9, value: { v: 1, salt: 'AAAA', verifier: {}, keys: {} } };
    await importBackup({ app: 'bill-generator', data: { kv: [evil] } });
    eq(JSON.stringify(await getKv('aiKeys')), before, 'import ignored it');
  });

  await t('key sync: removing the last key clears the passphrase', async () => {
    await removeSyncedKey('anthropic');
    eq(await getKeySyncState(), { exists: false, unlocked: false, providers: [] });
  });

  // ---------- Template assistant ----------

  await t('assistant: proposes a draft, sends the template only when it changed', async () => {
    const f = fakeFetch([
      {
        body: {
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'a',
              name: 'edit_template',
              input: { edits: [{ find: '<h1>', replace: '<h1 style="color:green">' }] },
            },
          ],
        },
      },
      { body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Made the name green.' }] } },
      { body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Nothing to change.' }] } },
      { body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Seen it.' }] } },
    ]);
    const a = createTemplateAssistant({ provider: 'anthropic', apiKey: 'k', model: 'claude-opus-5-5', fetchImpl: f });
    const r1 = await a.send('make the name green', TEMPLATE);
    eq(r1.text, 'Made the name green.');
    ok(r1.draft && r1.draft.includes('<h1 style="color:green">'), 'draft');
    ok(f.calls[0].body.messages[0].content[0].text.includes('<current_template>'), 'template sent first');
    // The user applied the draft, so the editor matches what the model last saw.
    const r2 = await a.send('anything else?', r1.draft);
    eq(r2.draft, null);
    eq(f.calls[2].body.messages.at(-1).content.length, 1, 'template not re-sent');
    // The user discarded and edited by hand: the template is sent again.
    await a.send('look again', TEMPLATE + '\n');
    ok(f.calls[3].body.messages.at(-1).content[0].text.includes('has changed'), 're-sent');
  });

  return results;
}
