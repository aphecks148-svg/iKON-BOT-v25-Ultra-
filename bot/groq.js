'use strict';

/**
 * Groq client — the one place that talks to api.groq.com.
 *
 * This replaces bot/gemini.js outright. Groq is the only AI provider this bot
 * uses: there is one client, one key, one model ladder, and no transport that
 * silently switches to a second vendor.
 *
 * GROQ'S CONTRACT, AND WHY EACH PIECE IS HERE
 *
 * - Endpoint. `POST https://api.groq.com/openai/v1/chat/completions`, OpenAI
 *   wire-compatible. Verified against the Groq API reference, not assumed.
 *
 * - Auth. `Authorization: Bearer gsk_...`. Groq keys carry the `gsk_` prefix and
 *   are rejected by Google's native `generativelanguage` route, which is the
 *   point of the swap: a leftover Gemini key now fails loudly instead of
 *   half-working. Nothing here validates the prefix — the API is the authority,
 *   and a future key format must not be rejected by a regex.
 *
 * - Token cap. `max_tokens` is DEPRECATED in favour of `max_completion_tokens`,
 *   so this sends the new name. The cap counts REASONING tokens on the gpt-oss
 *   family, so a cap that looks generous for the answer alone can be spent
 *   entirely on thinking and come back empty. The default covers both, and an
 *   empty answer reports its finish_reason so the cause is legible rather than
 *   reading as a key fault.
 *
 * - Reasoning. Every model on the ladder is a reasoning model, and Groq returns
 *   the deliberation in a separate `reasoning` field. extractText reads only
 *   `content`, so none of it reaches the chat — a command that regexes the output
 *   or drops it into an image prompt would otherwise ship the model's scratchpad.
 *   For the same reason the persona is passed as a `system` message only when
 *   there is one, and never as a preamble glued to the user's words.
 *
 * - No thinking config. Gemini's `thinkingLevel`/`thinkingBudget` do not exist
 *   here and are rejected with a 400. Reasoning is reached by picking the model
 *   and `reasoning_effort`, not by a Gemini-shaped config block.
 *
 * - Errors. Groq answers `{"error": {"message", "type", "code"}}`. A 400/401/
 *   403/404 is about this key or this model and is worth trying another model
 *   for; a 429 is a rate limit and a 5xx is Groq's problem, so neither walks
 *   the fallback ladder — retrying four models just burns the quota faster.
 *
 * Every function resolves rather than throws: an AI command that cannot reach
 * Groq must still send the user something.
 */

const axios = require('axios');
const config = require('../config');

const { log, error } = require('./helpers');

const BASE = 'https://api.groq.com/openai/v1';

/**
 * Tried in order when GROQ_MODEL is not set, and after a 400/401/403/404 that
 * means "this model is not available to your key". The first that answers wins
 * and is cached for the rest of the process.
 *
 * THIS LIST IS A LIVING THING. Groq retires models on a schedule and the
 * shutdown returns an error to every request — it does not warn you at runtime.
 *
 * It already did once. This ladder used to start at `llama-3.3-70b-versatile`
 * with `llama-3.1-8b-instant` second, and Groq retired BOTH on 16 Aug 2026 for
 * free and developer tiers — which is exactly the tier a Render free service
 * runs on (console.groq.com/docs/deprecations). Since the retired pair held the
 * first two rungs, every single AI command opened with two doomed round trips
 * before reaching a live model. It still answered, because the third rung
 * existed, so nothing looked broken. Groq's own replacements are the two gpt-oss
 * models, so the ladder is those, in quality-then-speed order.
 *
 * Rung order, and why:
 *   1. openai/gpt-oss-120b — production, ~500 tok/s, the best answer available
 *      here. Groq named it the replacement for the 70B.
 *   2. openai/gpt-oss-20b  — production, ~1000 tok/s, half the price, and the
 *      named replacement for the retired 8B. This is the emergency rung: it
 *      still answers when the big model is rate limited.
 *   3. qwen/qwen3.8-27b    — a preview model from a different family. Included
 *      deliberately: if both gpt-oss models are withdrawn in one go, a third
 *      family is the only thing that keeps the bot talking. Preview means it can
 *      be discontinued at short notice, which is why it is last.
 *
 * When you replace a rung here, check console.groq.com/docs/deprecations first.
 */
const FALLBACK_MODELS = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'qwen/qwen3.8-27b',
];

/**
 * Reasoning models score best around 0.6, and Groq documents 0.5–0.7 for the
 * gpt-oss family; 1.0 makes them repeat themselves. Every model on the ladder is
 * a reasoning model, so this is sent unless a caller overrides it.
 *
 * @see https://console.groq.com/docs/reasoning
 */
const DEFAULT_TEMPERATURE = 0.6;

const TIMEOUT_MS = 25000;

let resolvedModel = null;
let lastError = '';

/** The configured model, or the first of the fallbacks. */
function preferredModel() {
  const configured = String(config.GROQ_MODEL || '').trim();
  return configured || FALLBACK_MODELS[0];
}

/** Is a key configured? Checks presence only, never the prefix. */
function available() {
  return Boolean(String(config.GROQ_API_KEY || '').trim());
}

/**
 * Pull the answer out of a chat completion.
 *
 * Reasoning models can put their scratchpad in a separate field. It must be
 * dropped: a command that regexes the output (or drops it into an image prompt)
 * would otherwise ship the model's deliberation to the chat.
 *
 * @param {object} data response body
 * @returns {string} the answer, or '' when there is none
 */
function extractText(data) {
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  const content = choice && choice.message && choice.message.content;

  if (typeof content === 'string') return content.trim();

  // Some OpenAI-compatible servers return content as a part array. Handle it
  // rather than assuming the string form, so a shape change does not read as
  // "the model refused to answer" across every AI command.
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && (p.type === 'text' || typeof p.text === 'string') && !p.reasoning)
      .map((p) => p.text)
      .join('')
      .trim();
  }

  return '';
}

/** The API's error message, which is far more useful than axios's "status 404". */
function apiErrorMessage(err) {
  const data = err && err.response && err.response.data;
  return String(
    (data && (data.error && data.error.message || data.message)) || (err && err.message) || 'unknown error',
  ).slice(0, 300);
}

/**
 * One chat completion against one model.
 *
 * @param {string} model
 * @param {string} prompt fully assembled prompt including persona
 * @param {{maxTokens?:number, system?:string, temperature?:number}} opts
 * @returns {Promise<string>} answer text, '' when empty
 * @throws on transport or API error so the caller can decide to try another model
 */
async function callModel(model, prompt, opts = {}) {
  // The key goes in an Authorization header, not a query string, so it stays
  // out of proxy and access logs.
  const res = await axios.post(
    `${BASE}/chat/completions`,
    {
      model,
      messages: [
        ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
        { role: 'user', content: prompt },
      ],
      // max_completion_tokens, not the deprecated max_tokens. Reasoning tokens
      // are drawn from this same budget, so it has to cover thinking AND the
      // answer — a cap sized for the answer alone is tight enough that a hard
      // question comes back with an empty content and finish_reason "length".
      max_completion_tokens: opts.maxTokens || 4096,
      // Every model on the ladder reasons, and the documented sweet spot for the
      // gpt-oss family is 0.5–0.7; at the 1.0 default they repeat themselves.
      // Only overridden when a caller actually asks for something.
      temperature: opts.temperature === undefined ? DEFAULT_TEMPERATURE : opts.temperature,
    },
    {
      timeout: TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${String(config.GROQ_API_KEY)}`,
        'Content-Type': 'application/json',
      },
    },
  );

  const text = extractText(res && res.data);
  if (!text) {
    // A model that hit the token cap can return no content at all. Say why,
    // because "empty response" alone sends the reader hunting for a key fault.
    const choice = res && res.data && Array.isArray(res.data.choices) ? res.data.choices[0] : null;
    const reason = choice && (choice.finish_reason || choice.finishReason);
    throw new Error(`empty response${reason ? ` (finish_reason: ${reason})` : ''}`);
  }
  return text;
}

/**
 * Ask Groq a question. Never throws.
 *
 * @param {string} prompt user-facing question, already worded
 * @param {{system?:string, style?:string, maxTokens?:number, maxOutputTokens?:number, temperature?:number}} [opts]
 *   `style` is appended to `system`; both are optional.
 * @returns {Promise<string>} the answer, or '' when Groq could not be reached.
 *   Callers decide what to show; an empty string means "no real answer".
 */
async function ask(prompt, opts = {}) {
  const text = String(prompt || '').trim();
  if (!text || !available()) return '';

  const system = [opts.system, opts.style].filter(Boolean).join('\n');

  // maxTokens is the Groq name; maxOutputTokens is accepted so callers written
  // against the old client's option keep working unchanged.
  const call = {
    system,
    maxTokens: opts.maxTokens || opts.maxOutputTokens || 4096,
    temperature: opts.temperature,
  };

  // Try the resolved model, then the fallbacks, so one unavailable model does
  // not take out all 35 AI commands.
  const tried = [];
  const head = resolvedModel || preferredModel();
  const models = [head, ...FALLBACK_MODELS.filter((m) => m !== head)];

  for (const model of models) {
    try {
      const answer = await callModel(model, text, call);
      if (model !== resolvedModel) {
        resolvedModel = model;
        log(`[GROQ] using ${model}`);
      }
      lastError = '';
      return answer;
    } catch (err) {
      const status = err && err.response && err.response.status;
      tried.push(`${model}: ${apiErrorMessage(err)}`);
      lastError = apiErrorMessage(err);
      // 400/401/403/404 are about this key or this model. Retrying the same
      // model will not help, but another model may still be available.
      if (![400, 401, 403, 404].includes(status)) {
        error(`[GROQ] request failed: ${lastError}`);
        return '';
      }
    }
  }

  error(`[GROQ] no model answered — ${tried.join(' | ')}`);
  return '';
}

/** Which model the client settled on, for !botstatus. */
function activeModel() {
  return resolvedModel || preferredModel();
}

/**
 * Why the last ask() failed, for the user-facing message. Empty when the last
 * call worked, so a command never blames the key for an unrelated error.
 *
 * @returns {string}
 */
function lastErrorMessage() {
  return lastError;
}

/** Test seam: forget the cached model and any recorded error. */
function _reset() {
  resolvedModel = null;
  lastError = '';
}

module.exports = {
  ask,
  available,
  activeModel,
  lastErrorMessage,
  extractText,
  preferredModel,
  FALLBACK_MODELS,
  _reset,
};