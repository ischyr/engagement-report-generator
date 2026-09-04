/**
 * The optional assistant: one door, off by default, and absent unless somebody fills it in.
 *
 * This is the first thing in the app that sends a client's material to a computer we do not run,
 * so the whole design is arranged around that one sentence rather than around what a model can do.
 *
 * **It is off.** A fresh instance has no endpoint, no key and no assistant. Nothing calls out,
 * nothing is slower, and every page behaves exactly as it did before this file existed — the four
 * buttons are not disabled, they are not rendered, because a greyed-out button is an advertisement
 * and this is not one. `GET /assistant` answers `available: false` and the client draws nothing.
 *
 * **It is configured like the mail server**, deliberately: an endpoint, a model and a key in
 * Settings, the key held under the same vault as an SMTP password with an environment variable
 * that overrides it, and a test button that reports the provider's own refusal rather than a
 * sentence we invented about what probably went wrong. That shape was already proved once here and
 * there is no reason for a second one.
 *
 * **It is not required to be Anthropic.** The wire shape sits beside the endpoint, so a model
 * running on the same machine — Ollama, vLLM, LM Studio — is a preset rather than a fork. For a
 * team whose engagements may not leave the building, that is the difference between a feature they
 * can switch on and a feature they must refuse.
 *
 * **It never writes.** Every job returns a suggestion; a person reads it and clicks. No route here
 * touches an engagement, which is why none of them needs to reason about locks, conflicts or the
 * review state — the save that follows goes through the ordinary endpoint with the ordinary rules.
 *
 * **It sends less than you would expect.** The proof of concept is never sent at all, screenshots
 * are never sent, and everything that is sent goes through `redact.js` first. What was removed is
 * counted and shown to the person who asked.
 */
import { Settings } from '../../models/settings.model.js';
import { decryptSecret, vaultEnabled } from '../vault.service.js';
import { log } from '../../utils/logger.js';
import { JOBS } from './jobs.js';
import { AssistantError, captured, WIRES } from './wire.js';

/**
 * The providers people actually point this at, and what each one needs.
 *
 * Presets rather than a wizard, for the same reason the mail form has them: nobody should have to
 * remember a base URL. `note` is served with them because for most of these the real obstacle is
 * not the URL — it is where the key comes from, which model name to use, or that a local runtime
 * wants no key at all.
 *
 * `model` is filled in only where the provider publishes a *stable alias* — a name that keeps
 * pointing at the current version, like `claude-opus-5` or `deepseek-v4-pro`. Everywhere else it is
 * left empty on purpose: a dated snapshot id printed here would be out of date within months and
 * would be read as a recommendation, so the note says where to find the one this account has.
 */
export const ASSISTANT_PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    wire: 'anthropic',
    endpoint: '',
    model: 'claude-opus-5',
    keyRequired: true,
    note: 'A key from console.anthropic.com. Leave the endpoint empty for the API itself, or set it to a gateway or proxy that speaks the Messages API.',
  },
  openai: {
    label: 'OpenAI',
    wire: 'openai',
    endpoint: 'https://api.openai.com/v1',
    model: '',
    keyRequired: true,
    note: 'A key from the provider, and the model id exactly as they write it. Any service that answers the chat-completions shape at a base URL works here — Azure, OpenRouter, Together, and the rest.',
  },
  deepseek: {
    label: 'DeepSeek',
    /*
     * The chat-completions shape, at the bare host — the request is a POST to
     * `https://api.deepseek.com/chat/completions`, with no version segment.
     *
     * DeepSeek also publishes an Anthropic-compatible surface at
     * `https://api.deepseek.com/anthropic`, which this app can speak too: choose the Messages API
     * wire and put that URL here instead. Same key, same models, same answers — it exists so that
     * tools written against the Anthropic SDK work unchanged, and this is one of them. Either is
     * fine; the one below is the shorter path to the same place.
     */
    wire: 'openai',
    endpoint: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    keyRequired: true,
    /*
     * Think, but briefly.
     *
     * Both of these models reason before answering, and reasoning is charged against the same
     * `max_tokens` as the answer — so the default effort of `high` will happily spend thousands of
     * tokens deciding how to write one sentence about an nmap run, and bill for every one of them.
     *
     * Left enabled rather than switched off: on the two jobs that are actually judgement — which
     * library entry is the same weakness, what the findings mean for the business — the thinking
     * earns its keep. `low` is the setting that keeps it proportionate to a paragraph.
     *
     * Both parameters are top level and are sent together in DeepSeek's own example.
     */
    body: { thinking: { type: 'enabled' }, reasoning_effort: 'low' },
    note: 'A key from platform.deepseek.com. `deepseek-v4-pro` is the capable one and the default here; `deepseek-v4-flash` is faster and cheaper, which suits the one-line enumeration summaries. Both think before answering, and this app asks them to do so briefly — reasoning is billed against the same budget as the answer. Both names track the current version rather than a dated snapshot.',
  },
  ollama: {
    label: 'Ollama, on this machine',
    wire: 'openai',
    endpoint: 'http://127.0.0.1:11434/v1',
    model: '',
    keyRequired: false,
    note: 'Nothing leaves the machine. No key is needed. The model is whatever `ollama list` shows — pull one first. Anything else that serves an OpenAI-compatible endpoint locally (vLLM, LM Studio, llama.cpp) works the same way; change the port.',
  },
  custom: {
    label: 'Something else',
    wire: 'openai',
    endpoint: '',
    model: '',
    keyRequired: false,
    note: 'Give the base URL up to and including the version segment — the request is a POST to /chat/completions or /v1/messages beneath it, depending on which wire shape you choose.',
  },
};

/** Every job, off individually. The keys are the ones `jobs.js` registers. */
export const JOB_KEYS = Object.keys(JOBS);

export const providerPreset = (key) => ASSISTANT_PROVIDERS[key] ?? ASSISTANT_PROVIDERS.custom;

/**
 * The instance's assistant configuration, resolved and ready to use.
 *
 * Returns `enabled: false` with a `reason` in every case where it cannot work, and never throws.
 * The reason is shown to the person who pressed the button, so each one names the thing to fix.
 */
export async function assistantConfig(settingsDoc = null) {
  const settings = settingsDoc ?? (await Settings.getSettings());
  const assistant = settings.assistant ?? {};
  const preset = providerPreset(assistant.provider);

  const config = {
    enabled: Boolean(assistant.enabled),
    provider: assistant.provider || 'anthropic',
    /* The environment can force the test wire, which is how the suite runs with no key. */
    wire: process.env.ASSISTANT_WIRE || assistant.wire || preset.wire,
    endpoint: String(assistant.endpoint ?? '').trim() || preset.endpoint,
    model: String(assistant.model ?? '').trim() || preset.model,
    key: readKey(assistant),
    /**
     * Anything this provider needs beyond the common request shape, from its preset.
     *
     * From the preset alone and not from the form: it is the one field here whose contents are a
     * provider's own vocabulary rather than a setting, and a text box for arbitrary JSON that is
     * merged into every outbound request is a footgun in exchange for a case nobody has yet.
     */
    body: preset.body ?? {},
    timeoutMs: Math.min(Math.max(Number(assistant.timeoutSeconds) || 60, 5), 300) * 1000,
    houseStyle: String(assistant.houseStyle ?? '').trim(),
    /** Which of the four are switched on. Absent means on, so a new job is not silently off. */
    jobs: Object.fromEntries(JOB_KEYS.map((key) => [key, assistant.jobs?.[key] !== false])),
    /**
     * Whether a restricted engagement may be sent at all.
     *
     * Off by default and separate from everything else. "Restricted" already means the material is
     * handled more carefully than the rest — shorter retention in the trash, a banner on the page —
     * and it would be a strange instance that marked an engagement that way and then posted its
     * findings to a third party because a general setting happened to be on.
     */
    allowRestricted: Boolean(assistant.allowRestricted),
  };

  if (!config.enabled) return { ...config, reason: 'The assistant is switched off in Settings.' };
  if (!WIRES[config.wire]) {
    return { ...config, enabled: false, reason: `There is no "${config.wire}" wire shape.` };
  }
  if (config.wire !== 'capture') {
    if (!config.model) {
      return { ...config, enabled: false, reason: 'No model is configured for the assistant.' };
    }
    if (config.wire === 'openai' && !config.endpoint) {
      return { ...config, enabled: false, reason: 'No endpoint is configured for the assistant.' };
    }
    if (preset.keyRequired && !config.key) {
      return { ...config, enabled: false, reason: 'No API key is configured for the assistant.' };
    }
  }
  return config;
}

/**
 * The key, from the environment or from the vault.
 *
 * A stored key that cannot be decrypted returns empty rather than throwing, exactly as the SMTP
 * password does: a rotated `VAULT_KEY` should make the assistant unavailable and say so, not make
 * the findings page throw.
 */
function readKey(assistant) {
  const fromEnv = String(process.env.ASSISTANT_API_KEY ?? '').trim();
  if (fromEnv) return fromEnv;
  if (!assistant?.secret?.data || !vaultEnabled()) return '';
  try {
    return decryptSecret(assistant.secret);
  } catch {
    log.warn('The stored assistant API key cannot be decrypted with the current VAULT_KEY.');
    return '';
  }
}

/**
 * Asks one question, or explains why it did not.
 *
 * Never throws for a configuration or provider problem. Every caller is a person mid-sentence in a
 * report, and an endpoint that is down must not become an error page in the middle of writing up a
 * finding — it becomes a line of text in a dialog they close.
 *
 * @param {{job:string, system:string, user:string, maxTokens:number, redacted?:number}} prompt
 * @returns {Promise<{ok:boolean, text?:string, reason?:string, stage?:string, detail?:string,
 *   model?:string, usage?:object, ms?:number}>}
 */
export async function askAssistant(prompt, { settings = null, config = null } = {}) {
  const resolved = config ?? (await assistantConfig(settings));
  if (!resolved.enabled) {
    return { ok: false, reason: resolved.reason ?? 'The assistant is not configured.', stage: 'config' };
  }
  if (prompt.job && resolved.jobs[prompt.job] === false) {
    return {
      ok: false,
      stage: 'config',
      reason: `“${JOBS[prompt.job]?.label ?? prompt.job}” is switched off in Settings.`,
    };
  }

  const started = Date.now();
  try {
    const answer = await WIRES[resolved.wire](prompt, resolved);
    if (!answer.text) {
      return { ok: false, stage: 'empty', reason: 'The provider answered with no text.' };
    }
    return {
      ok: true,
      text: answer.text,
      model: answer.model,
      stopReason: answer.stopReason,
      /** The ceiling stopped it mid-sentence — shown to the reader rather than passed off. */
      cut: Boolean(answer.cut),
      usage: answer.usage,
      ms: Date.now() - started,
      redacted: prompt.redacted ?? 0,
      truncated: Boolean(prompt.truncated),
    };
  } catch (error) {
    /*
     * Logged without the prompt.
     *
     * The prompt holds the client's material, and a log file is the one place nobody remembers to
     * treat as containing it. What is useful in a log is which job, which stage and what the
     * provider said — all three of which are about the plumbing rather than the engagement.
     */
    const wrapped =
      error instanceof AssistantError ? error : new AssistantError(error?.message ?? 'The request failed.');
    log.warn(`Assistant ${prompt.job ?? 'request'} failed at ${wrapped.stage}: ${wrapped.message}`);
    return {
      ok: false,
      reason: wrapped.message,
      stage: wrapped.stage,
      status: wrapped.status,
      detail: wrapped.detail,
      ms: Date.now() - started,
    };
  }
}

export { captured, JOBS };
export default { askAssistant, assistantConfig, ASSISTANT_PROVIDERS, providerPreset, JOB_KEYS };
