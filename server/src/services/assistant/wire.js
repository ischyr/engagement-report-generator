/**
 * How a prompt actually leaves this machine.
 *
 * The same seam as the mail transports: one lookup, three entries, and nothing above this file
 * knows which one ran. `anthropic` speaks the Messages API through the official SDK; `openai`
 * speaks the chat-completions shape that Ollama, vLLM, LM Studio, llama.cpp, OpenRouter, Azure and
 * OpenAI itself all answer to; `capture` sends nothing and remembers everything, which is what the
 * assistant test suite runs against.
 *
 * Two wire shapes rather than one because the requirement is that a self-hosted model works. A
 * base URL alone does not deliver that — a local runtime does not speak the Anthropic wire — so the
 * shape is chosen beside the endpoint, and the endpoint defaults per preset. Anything that answers
 * either of these two shapes at a URL is supported, which is very nearly everything.
 *
 * Everything here throws `AssistantError` and nothing here retries beyond the SDK's own single
 * retry. The caller is a person waiting with a dialog open; a request that is going to fail should
 * fail while they are still looking at it, and the reason it gives them is the provider's own words
 * rather than a sentence we made up about what probably went wrong.
 */
import Anthropic from '@anthropic-ai/sdk';

/** What went wrong, at which stage, in whose words. */
export class AssistantError extends Error {
  constructor(message, { stage = 'request', status = 0, detail = '' } = {}) {
    super(message);
    this.name = 'AssistantError';
    /** `config` | `connect` | `auth` | `rate-limit` | `request` | `refusal` | `budget` | `empty` */
    this.stage = stage;
    this.status = status;
    /** The provider's own message, verbatim, for the test button to print. */
    this.detail = detail;
  }
}

/**
 * Room for the model to think in, on top of the job's own answer budget.
 *
 * `max_tokens` counts *everything the model generates*, and on a reasoning model that includes the
 * thinking nobody ever sees — DeepSeek says so outright, and Claude's adaptive thinking is billed
 * the same way. So a job that asks for one sentence and caps the request at 200 tokens does not get
 * a short answer from a reasoning model: it gets an empty one, because the budget was spent before
 * the answer began. That is not a hypothetical; it is what shipped, and what this constant fixes.
 *
 * Free where it is not needed. `max_tokens` is a ceiling, not a target: a model that is not thinking
 * stops when it has finished and is billed for what it wrote, so a larger ceiling costs those
 * instances nothing at all. What actually governs the spend on a model that *does* think is how
 * hard it is asked to think — see `body` on the presets in `index.js`, which is where that is set.
 */
const THINKING_HEADROOM = 4000;

/**
 * Why an answer stopped early, in words somebody can act on.
 *
 * "The endpoint answered, but with no text" is true and useless. These three cases are each a
 * different afternoon: a ceiling that was too low, a model that thought until the budget was gone,
 * and an endpoint that genuinely returned nothing.
 */
function emptyAnswer({ finishReason, reasoning, raw }) {
  if (reasoning && (finishReason === 'length' || finishReason === 'max_tokens')) {
    return new AssistantError(
      'The model spent its whole token budget thinking and had none left to answer.',
      {
        stage: 'budget',
        detail:
          'It is a reasoning model, and reasoning is charged against the same budget as the answer. ' +
          'Ask it to think less — or pick the faster model — under Settings → Assistant.',
      }
    );
  }
  if (finishReason === 'length' || finishReason === 'max_tokens') {
    return new AssistantError('The answer was cut off before it started.', {
      stage: 'budget',
      detail: 'The request hit its token ceiling with nothing written.',
    });
  }
  return new AssistantError('The endpoint answered, but with no text.', {
    stage: 'empty',
    detail: String(raw ?? '').slice(0, 400),
  });
}

/** What a `capture` wire has been asked, newest last, and what it should answer. Tests only. */
export const captured = [];
let captureReply = 'A captured reply.';
export const setCaptureReply = (text) => {
  captureReply = text;
};

export const WIRES = {
  /**
   * The Messages API, through the official SDK.
   *
   * `baseURL` is passed straight through, so a gateway, a proxy or an Anthropic-compatible
   * self-hosted endpoint is a settings change rather than a code change.
   *
   * Nothing about thinking is sent unless a preset asks for it. This wire is pointed at whatever
   * model an administrator typed into a form — possibly a small one, possibly through a proxy that
   * forwards a subset of the parameters — and a request that 400s on an unsupported field is a worse
   * outcome than a draft written without extended thinking. On a model where thinking is on by
   * default it stays on, paid for out of the headroom above; where a provider wants it tuned, that
   * goes in `body` on its preset, next to the endpoint it applies to.
   */
  async anthropic(prompt, config) {
    const client = new Anthropic({
      apiKey: config.key || 'missing',
      ...(config.endpoint ? { baseURL: config.endpoint } : {}),
      timeout: config.timeoutMs,
      /* One retry, not the default two: somebody is watching a spinner. */
      maxRetries: 1,
    });

    let message;
    try {
      message = await client.messages.create({
        model: config.model,
        max_tokens: prompt.maxTokens + THINKING_HEADROOM,
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
        ...(config.body ?? {}),
      });
    } catch (error) {
      throw fromAnthropicError(error);
    }

    /*
     * A policy decline is an answer, not a failure — HTTP 200 with `stop_reason: "refusal"` — and
     * it is exactly the case the test button exists to make legible. A security report is a
     * plausible thing for a safety classifier to hesitate over, and "the assistant did not
     * respond" would send somebody hunting for a network problem that is not there.
     */
    if (message.stop_reason === 'refusal') {
      const category = message.stop_details?.category ?? '';
      throw new AssistantError(
        `The provider declined this request${category ? ` (${category})` : ''}.`,
        {
          stage: 'refusal',
          detail: message.stop_details?.explanation ?? '',
        }
      );
    }

    const text = (message.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    if (!text) {
      throw emptyAnswer({
        finishReason: message.stop_reason,
        /* Thinking blocks come back empty by default, so their presence is the signal. */
        reasoning: (message.content ?? []).some((block) => block.type === 'thinking'),
        raw: JSON.stringify(message).slice(0, 400),
      });
    }

    return {
      text,
      model: message.model ?? config.model,
      stopReason: message.stop_reason ?? '',
      /** True when the ceiling stopped it mid-sentence, so the dialog can say so. */
      cut: message.stop_reason === 'max_tokens',
      usage: {
        input: message.usage?.input_tokens ?? 0,
        output: message.usage?.output_tokens ?? 0,
      },
    };
  },

  /**
   * The chat-completions shape, over plain HTTP.
   *
   * Not the OpenAI SDK: this endpoint is far more often Ollama on the same machine than it is
   * OpenAI, the request is one POST of one JSON object, and a second vendor SDK to send it would
   * be a dependency in exchange for nothing. The reply shape is the same everywhere that claims
   * to speak it, and where it is not, the error below quotes what did come back.
   */
  async openai(prompt, config) {
    const url = `${String(config.endpoint || '').replace(/\/+$/, '')}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          /* A local runtime usually wants no key at all, and objects to an empty one. */
          ...(config.key ? { authorization: `Bearer ${config.key}` } : {}),
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: prompt.maxTokens + THINKING_HEADROOM,
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
          /*
           * Whatever this provider needs beyond the common shape, from its preset — for a
           * reasoning model, how hard to think. Spread last so a preset can correct anything
           * above it, and empty for every provider that needs nothing.
           */
          ...(config.body ?? {}),
        }),
      });
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      throw new AssistantError(
        aborted
          ? `The endpoint did not answer within ${Math.round(config.timeoutMs / 1000)} seconds.`
          : `Could not reach ${url}.`,
        { stage: 'connect', detail: aborted ? '' : (error?.message ?? '') }
      );
    } finally {
      clearTimeout(timer);
    }

    const raw = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      /* Left null: an endpoint that answered with HTML is described by its body, below. */
    }

    if (!response.ok) {
      const detail = payload?.error?.message ?? payload?.message ?? raw.slice(0, 400);
      throw new AssistantError(`The endpoint refused the request (HTTP ${response.status}).`, {
        stage: response.status === 401 || response.status === 403 ? 'auth' : 'request',
        status: response.status,
        detail,
      });
    }

    const choice = payload?.choices?.[0];
    const text = String(choice?.message?.content ?? '').trim();
    if (!text) {
      throw emptyAnswer({
        finishReason: choice?.finish_reason,
        /*
         * The reasoning, which this app never reads and never shows.
         *
         * It is the model's own working, it is not the answer, and on the one occasion it matters —
         * an empty answer — its presence is what tells us the budget went on thinking rather than
         * the endpoint being broken.
         */
        reasoning: Boolean(choice?.message?.reasoning_content),
        raw,
      });
    }

    return {
      text,
      model: payload?.model ?? config.model,
      stopReason: choice?.finish_reason ?? '',
      cut: choice?.finish_reason === 'length',
      usage: {
        input: payload?.usage?.prompt_tokens ?? 0,
        output: payload?.usage?.completion_tokens ?? 0,
      },
    };
  },

  /** Sends nothing, keeps the prompt. The wire the assistant test runs against. */
  async capture(prompt, config) {
    captured.push({ ...prompt, model: config.model, wire: 'capture' });
    return {
      text: captureReply,
      model: config.model,
      stopReason: 'end_turn',
      usage: { input: 0, output: 0 },
    };
  },
};

/**
 * The SDK's typed errors, turned into ours.
 *
 * Most specific first, and the provider's own message is carried through untouched in `detail` —
 * "credit balance is too low" and "model: claude-oops-5 not found" are each one line that says
 * exactly what is wrong, and replacing them with "the request failed" is how an afternoon goes.
 */
function fromAnthropicError(error) {
  if (error instanceof Anthropic.AuthenticationError) {
    return new AssistantError('The provider rejected the API key.', {
      stage: 'auth',
      status: error.status,
      detail: error.message,
    });
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new AssistantError('The provider is rate limiting this key.', {
      stage: 'rate-limit',
      status: error.status,
      detail: error.message,
    });
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new AssistantError('Could not reach the endpoint.', {
      stage: 'connect',
      detail: error.message,
    });
  }
  if (error instanceof Anthropic.APIError) {
    return new AssistantError(`The provider refused the request (HTTP ${error.status}).`, {
      stage: error.status === 400 ? 'config' : 'request',
      status: error.status ?? 0,
      detail: error.message,
    });
  }
  return new AssistantError('The request failed.', { detail: error?.message ?? '' });
}

export default WIRES;
