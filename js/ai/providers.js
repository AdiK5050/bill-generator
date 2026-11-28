// Small connectors for the Claude and Gemini APIs, called straight from the browser with the
// user's own key. Each session keeps the conversation in the provider's own format and runs the
// tool loop: the model asks for a tool, the app runs it locally, and the result goes back.
//
// Messages are passed back exactly as received. Both providers attach data to model turns
// (thinking blocks, thought signatures) that must be returned unchanged.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta';
const ANTHROPIC_VERSION = '2026-10-21';
// Models that accept server-side fallbacks: on a refusal the API retries on another model.
const ANTHROPIC_FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);
const REQUEST_TIMEOUT_MS = 180000;
// Gemini thinks at "medium" or "high" by default, which made a small template edit take
// minutes. Template edits need little reasoning, so ask for the lowest level each model
// supports (from Google's thinking guide). Unknown models keep their default.
const GEMINI_THINKING_LEVEL = {
  'gemini-3.8-flash': 'low',
  'gemini-4-hydrogen': 'low',
  'gemini-3.5-flash-lite': 'minimal',
};

export class AiError extends Error {
  constructor(message, { status = 0, kind = 'error' } = {}) {
    super(message);
    this.status = status;
    this.kind = kind; // 'auth' | 'rate' | 'busy' | 'network' | 'refusal' | 'error'
  }
}

const PROVIDER_NAMES = { anthropic: 'Claude', gemini: 'Gemini' };
// A function, because the adapters are defined further down the file.
const ADAPTERS = () => ({ anthropic: anthropicAdapter, gemini: geminiAdapter });

/**
 * Create a conversation.
 * tools: [{ name, description, schema }] where schema is a JSON Schema object.
 */
export function createSession({ provider, apiKey, model, system, tools, fetchImpl }) {
  const adapter = ADAPTERS()[provider];
  if (!adapter) throw new AiError(`Unknown AI provider: ${provider}`);
  const ctx = {
    provider,
    apiKey,
    model,
    system,
    tools,
    fetch: fetchImpl || globalThis.fetch.bind(globalThis),
  };
  const history = [];
  return {
    /**
     * Send one user turn and run tools until the model finishes.
     * parts: [{ type: 'text', text } | { type: 'image', mediaType, data }] (data is base64).
     * runTool(name, input) returns a string (or throws; the error text goes back to the model).
     * Resolves { text, steps }.
     */
    async run(parts, { runTool, signal, maxSteps = 8, onStep } = {}) {
      const start = history.length;
      try {
        history.push(adapter.userMessage(parts));
        for (let step = 1; step <= maxSteps; step++) {
          const turn = await adapter.call(ctx, history, signal);
          history.push(turn.message);
          if (!turn.toolCalls.length) return { text: turn.text, steps: step };
          onStep?.(step, turn.toolCalls);
          const results = [];
          for (const call of turn.toolCalls) {
            let output;
            let isError = false;
            try {
              output = await runTool(call.name, call.input || {});
            } catch (e) {
              output = `Error: ${e.message}`;
              isError = true;
            }
            results.push({ call, output: String(output), isError });
          }
          history.push(adapter.toolResults(results));
        }
        return {
          text: 'I stopped after several steps without finishing. Try a smaller request.',
          steps: maxSteps,
          stopped: true,
        };
      } catch (e) {
        // Leave the conversation as it was before this turn so the next turn starts clean.
        history.length = start;
        throw e;
      }
    },
    get turns() {
      return history.length;
    },
  };
}

/** Check that a key works for the chosen model without spending tokens. */
export async function testKey({ provider, apiKey, model, fetchImpl }) {
  const f = fetchImpl || globalThis.fetch.bind(globalThis);
  if (provider === 'anthropic') {
    await request(f, 'anthropic', `${ANTHROPIC_URL}/models/${encodeURIComponent(model)}`, {
      method: 'GET',
      headers: anthropicHeaders(apiKey, model, false),
    });
  } else if (provider === 'gemini') {
    await request(f, 'gemini', `${GEMINI_URL}/models/${encodeURIComponent(model)}`, {
      method: 'GET',
      headers: { 'x-goog-api-key': apiKey },
    });
  } else {
    throw new AiError(`Unknown AI provider: ${provider}`);
  }
  return true;
}

// ---------- HTTP ----------

async function request(f, provider, url, { method = 'POST', headers, body, signal } = {}) {
  const name = PROVIDER_NAMES[provider];
  // An abort listener added to an already aborted signal never fires, so check first: Stop
  // pressed between two steps of a turn must still stop the next request.
  if (signal?.aborted) throw new AiError('Stopped.', { kind: 'aborted' });
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => timeout.abort();
  signal?.addEventListener('abort', onAbort);
  let res;
  let data;
  try {
    res = await f(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: timeout.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    // Read the body while Stop and the timeout still apply.
    // Error bodies are usually JSON, but a proxy or outage page may not be.
    data = await res.json().catch(() => null);
  } catch (e) {
    if (signal?.aborted) throw new AiError('Stopped.', { kind: 'aborted' });
    if (timeout.signal.aborted) throw new AiError(`${name} took too long to answer. Try again.`, { kind: 'busy' });
    throw new AiError(`Could not reach ${name}. Check your internet connection. (${e.message})`, { kind: 'network' });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  // An abort while the body was read ends up in the json() catch above.
  if (signal?.aborted) throw new AiError('Stopped.', { kind: 'aborted' });
  if (timeout.signal.aborted) throw new AiError(`${name} took too long to answer. Try again.`, { kind: 'busy' });
  if (!res.ok) throw httpError(provider, res.status, data);
  return data;
}

function httpError(provider, status, data) {
  const name = PROVIDER_NAMES[provider];
  // Both APIs put a readable message in error.message.
  const detail = String(data?.error?.message || '').slice(0, 300);
  const keyProblem = /api[ _-]?key/i.test(detail) && /invalid|not valid|expired|missing/i.test(detail);
  if (status === 401 || status === 403 || keyProblem) {
    return new AiError(
      `${name} rejected the API key. Check the key in Settings > AI assistant.${detail ? ` (${detail})` : ''}`,
      { status, kind: 'auth' },
    );
  }
  if (status === 429) {
    return new AiError(
      `${name} says you have hit a usage or rate limit. Wait a little, or check your plan and credits.${detail ? ` (${detail})` : ''}`,
      { status, kind: 'rate' },
    );
  }
  if (status === 404) {
    return new AiError(`${name} could not find that model. Choose another model in Settings > AI assistant.`, {
      status,
      kind: 'error',
    });
  }
  if (status >= 500) {
    return new AiError(`${name} is busy or having problems right now. Try again in a minute.`, {
      status,
      kind: 'busy',
    });
  }
  return new AiError(`${name} returned an error (${status}).${detail ? ` ${detail}` : ''}`, { status });
}

// ---------- Claude ----------

function anthropicHeaders(apiKey, model, withFallback) {
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    // Required for calls made directly from a browser (CORS).
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  if (withFallback && ANTHROPIC_FALLBACK_MODELS.has(model))
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  return headers;
}

const anthropicAdapter = {
  userMessage(parts) {
    return {
      role: 'user',
      content: parts.map((p) =>
        p.type === 'image'
          ? { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } }
          : { type: 'text', text: p.text },
      ),
    };
  },

  toolResults(results) {
    return {
      role: 'user',
      content: results.map(({ call, output, isError }) => ({
        type: 'tool_result',
        tool_use_id: call.id,
        content: output,
        ...(isError ? { is_error: true } : {}),
      })),
    };
  },

  async call(ctx, history, signal) {
    const body = {
      model: ctx.model,
      max_tokens: 16000,
      // Tools and the system prompt never change during a session, so they are cached.
      system: [{ type: 'text', text: ctx.system, cache_control: { type: 'ephemeral' } }],
      tools: ctx.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema, strict: true })),
      messages: history,
      cache_control: { type: 'ephemeral' },
      output_config: { effort: 'medium' },
    };
    if (ANTHROPIC_FALLBACK_MODELS.has(ctx.model)) body.fallbacks = 'default';
    const data = await request(ctx.fetch, 'anthropic', `${ANTHROPIC_URL}/messages`, {
      headers: anthropicHeaders(ctx.apiKey, ctx.model, true),
      body,
      signal,
    });
    if (!data || !Array.isArray(data.content)) throw new AiError('Claude sent an unexpected response.');
    if (data.stop_reason === 'refusal') {
      throw new AiError('Claude declined this request. Try describing the change differently.', { kind: 'refusal' });
    }
    const toolCalls = data.content
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));
    if (data.stop_reason === 'max_tokens' && !toolCalls.length) {
      throw new AiError('The answer was too long and got cut off. Try a smaller change.');
    }
    const text = data.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return { message: { role: 'assistant', content: data.content }, toolCalls, text };
  },
};

// ---------- Gemini ----------

/** Gemini takes a subset of JSON Schema; drop keywords it does not list. */
function geminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'additionalProperties') continue;
    out[k] =
      k === 'properties'
        ? Object.fromEntries(Object.entries(v).map(([p, s]) => [p, geminiSchema(s)]))
        : geminiSchema(v);
  }
  return out;
}

const geminiAdapter = {
  userMessage(parts) {
    return {
      role: 'user',
      parts: parts.map((p) =>
        p.type === 'image' ? { inlineData: { mimeType: p.mediaType, data: p.data } } : { text: p.text },
      ),
    };
  },

  toolResults(results) {
    return {
      role: 'user',
      parts: results.map(({ call, output, isError }) => ({
        functionResponse: {
          name: call.name,
          ...(call.id ? { id: call.id } : {}),
          response: isError ? { error: output } : { result: output },
        },
      })),
    };
  },

  async call(ctx, history, signal) {
    const body = {
      systemInstruction: { parts: [{ text: ctx.system }] },
      contents: history,
      tools: [
        {
          functionDeclarations: ctx.tools.map((t) => ({
            name: t.name,
            description: t.description,
            // A tool without inputs is declared without parameters.
            ...(Object.keys(t.schema.properties || {}).length ? { parameters: geminiSchema(t.schema) } : {}),
          })),
        },
      ],
    };
    const thinkingLevel = GEMINI_THINKING_LEVEL[ctx.model];
    if (thinkingLevel) body.generationConfig = { thinkingConfig: { thinkingLevel } };
    const data = await request(
      ctx.fetch,
      'gemini',
      `${GEMINI_URL}/models/${encodeURIComponent(ctx.model)}:generateContent`,
      { headers: { 'content-type': 'application/json', 'x-goog-api-key': ctx.apiKey }, body, signal },
    );
    const candidate = data?.candidates?.[0];
    if (!candidate) {
      const reason = data?.promptFeedback?.blockReason;
      throw new AiError(
        reason
          ? `Gemini blocked this request (${reason}). Try describing the change differently.`
          : 'Gemini sent an empty response.',
        { kind: reason ? 'refusal' : 'error' },
      );
    }
    const parts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
    const toolCalls = parts
      .filter((p) => p.functionCall)
      .map((p) => ({ id: p.functionCall.id, name: p.functionCall.name, input: p.functionCall.args }));
    const text = parts
      .filter((p) => typeof p.text === 'string' && !p.thought)
      .map((p) => p.text)
      .join('')
      .trim();
    if (!toolCalls.length && !text) {
      const reason = candidate.finishReason;
      if (reason === 'MAX_TOKENS') throw new AiError('The answer was too long and got cut off. Try a smaller change.');
      throw new AiError(
        reason && reason !== 'STOP'
          ? `Gemini stopped without an answer (${reason}). Try describing the change differently.`
          : 'Gemini sent an empty response.',
        { kind: reason === 'SAFETY' ? 'refusal' : 'error' },
      );
    }
    // Keep the model turn exactly as received (it can carry thought signatures).
    return { message: { ...candidate.content, role: 'model' }, toolCalls, text };
  },
};
