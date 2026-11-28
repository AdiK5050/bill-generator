// AI assistant settings. Kept in the local-only store: API keys never sync to a server
// and are never written to backup files.
import { getLocal, setLocal } from '../storage.js';

export const PROVIDERS = {
  anthropic: {
    label: 'Claude (Anthropic)',
    keyHint: 'Create a key in the Claude Console at platform.claude.com. Usage is billed to your Anthropic account.',
    models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (best results)' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (faster, cheaper)' },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (fastest, cheapest)' },
    ],
  },
  gemini: {
    label: 'Gemini (Google)',
    keyHint:
      'Create a key in Google AI Studio at aistudio.google.com. The free tier works, but Google may use free-tier requests to improve its products.',
    models: [
      // Flash-Lite first: in testing the larger models often took minutes per step.
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite (fastest, recommended)' },
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash (slower)' },
      { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen (slowest)' },
    ],
  },
};

const DEFAULT_CONFIG = {
  provider: 'anthropic',
  keys: { anthropic: '', gemini: '' },
  models: { anthropic: PROVIDERS.anthropic.models[0].id, gemini: PROVIDERS.gemini.models[0].id },
  noticeSeen: false,
};

export async function getAiConfig() {
  const saved = (await getLocal('aiConfig')) || {};
  const cfg = {
    ...DEFAULT_CONFIG,
    ...saved,
    keys: { ...DEFAULT_CONFIG.keys, ...(saved.keys || {}) },
    models: { ...DEFAULT_CONFIG.models, ...(saved.models || {}) },
  };
  if (!PROVIDERS[cfg.provider]) cfg.provider = DEFAULT_CONFIG.provider;
  return cfg;
}

export async function setAiConfig(patch) {
  const cfg = { ...(await getAiConfig()), ...patch };
  await setLocal('aiConfig', cfg);
  window.dispatchEvent(new CustomEvent('ai-config-changed'));
  return cfg;
}

/** The provider, key and model to use now, or null when no key is set for the chosen provider. */
export async function getActiveAi() {
  const cfg = await getAiConfig();
  const apiKey = cfg.keys[cfg.provider];
  if (!apiKey) return null;
  return { provider: cfg.provider, apiKey, model: cfg.models[cfg.provider], config: cfg };
}
