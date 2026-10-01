'use strict';

/**
 * Gemini client — the one place that talks to generativelanguage.googleapis.com.
 *
 * Both the engine integration point (ws3-fca.js) and the 35 AI commands in
 * commands/cmds_8.js used to carry their own copy of this request. They had
 * drifted, and both were pinned to `gemini-1.5-flash`, which Google has fully
 * shut down: every AI command answered with the offline placeholder while the
 * reaction ack worked fine, because the placeholder is returned rather than
 * thrown.
 *
 * WHAT CHANGED FOR THE CURRENT API
 *
 * - Model. `gemini-1.5-flash` is shut down, so every call 404s. The default is
 *   now `gemini-3.8-flash`, overridable with GEMINI_MODEL. If a model is not
 *   available to the key's project the client walks a fallback list rather
 *   than leaving 35 commands dead.
 *
 * - Auth. Keys moved from `AIza...` to `AQ...` Auth keys. An AQ key works on
 *   this native route (header or `?key=`) but is rejected by OpenAI-compatible
 *   routes with a misleading "invalid_api_key", so this stays on the native
 *   endpoint and never switches transports. Nothing here validates the key's
 *   prefix: both formats are accepted, and the API is the only authority.
 *
 * - generationConfig. `temperature`, `top_p` and `top_k` are removed. Gemini 3.x
 *   ignores them and misbehaves when they are set. `thinkingLevel` replaces
 *   `thinkingBudget`; `minimal` is rejected by 3.8 Flash, so this uses `low` to
 *   keep chat latency down.
 *
 * - maxOutputTokens counts THINKING tokens too. A small cap makes a thinking
 *   model spend the whole budget reasoning and return an empty string, so the
 *   default is deliberately generous for a chat reply.
 *
 * Every function here resolves instead of throwing: an AI command that cannot
 * reach Gemini must still send the user something.
 */

const axios = require('axios');
const config = require('../config');

const { log, error } = require('./helpers');

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Tried in order when GEMINI_MODEL is not explicitly set, and on a 404/403 that
 * means "this model is not available to your project". The first that answers
 * wins and is cached for the rest of the process.
 */
const FALLBACK_MODELS = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-2.5-flash'];

const TIMEOUT_MS = 25000;

let resolvedModel = null;
let lastError = '';

/** The configured model, or the first of the fallbacks. */
function preferredModel() {
  const configured = String(config.GEMINI_MODEL || '').trim();
  if (configured && configured !== 'gemini-1.5-flash') return configured;
  // A stale GEMINI_MODEL pointing at the shut-down 1.5 family must not win.
  if (configured) return FALLBACK_MODELS[0];
  return FALLBACK_MODELS[0];
}

/** Is a key configured? Checks shape only by presence, never by prefix. */
function available() {
  return Boolean(String(config.GEMINI_API_KEY || '').trim());
}

/**
 * Pull the answer out of a generateContent response.
 *
 * Thinking models can return thought parts alongside the answer. Those must be
 * dropped: a command that regexes the output (or drops it into an image prompt)
 * would otherwise ship the model's scratchpad to the chat.
 *
 * @param {object} data response body
 * @returns {string} the answer, or '' when there is none
 */
function extractText(data) {
  const parts = data
    && data.candidates
    && data.candidates[0]
    && data.candidates[0].content
    && data.candidates[0].content.parts;

  if (!Array.isArray(parts)) return '';

  return parts
    .filter((p) => p && !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
    .trim();
}

/** The API's error message, which is far more useful than axios's "status 404". */
function apiErrorMessage(err) {
  const data = err && err.response && err.response.data;
  return String(
    (data && (data.error && data.error.message || data.message)) || (err && err.message) || 'unknown error',
  ).slice(0, 300);
}

/**
 * One generateContent call against one model.
 *
 * @param {string} model
 * @param {string} prompt fully assembled prompt including persona
 * @param {{maxOutputTokens?:number, thinkingLevel?:string, system?:string}} opts
 * @returns {Promise<string>} answer text, '' when empty
 * @throws on transport or API error so the caller can decide to try another model
 */
async function callModel(model, prompt, opts = {}) {
  // The key goes in a header. Both AIza and AQ keys are accepted here, and the
  // header keeps the key out of the URL where it would land in proxy logs.
  const res = await axios.post(
    `${BASE}/${encodeURIComponent(model)}:generateContent`,
    {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      ...(opts.system ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}),
      generationConfig: {
        // No temperature/top_p/top_k: deprecated on Gemini 3.x.
        maxOutputTokens: opts.maxOutputTokens || 2048,
        thinkingConfig: { thinkingLevel: opts.thinkingLevel || 'low' },
      },
    },
    {
      timeout: TIMEOUT_MS,
      headers: { 'x-goog-api-key': String(config.GEMINI_API_KEY), 'Content-Type': 'application/json' },
    },
  );

  const text = extractText(res && res.data);
  if (!text) {
    // A thinking model that exhausted maxOutputTokens returns no text at all.
    const reason = res && res.data && res.data.candidates && res.data.candidates[0]
      && res.data.candidates[0].finishReason;
    throw new Error(`empty response${reason ? ` (finishReason: ${reason})` : ''}`);
  }
  return text;
}

/**
 * Ask Gemini a question. Never throws.
 *
 * @param {string} prompt user-facing question, already worded
 * @param {{system?:string, style?:string, maxOutputTokens?:number, thinkingLevel?:string}} [opts]
 *   `style` is appended to `system`; both are optional.
 * @returns {Promise<string>} the answer, or '' when Gemini could not be reached.
 *   Callers decide what to show; an empty string means "no real answer".
 */
async function ask(prompt, opts = {}) {
  const text = String(prompt || '').trim();
  if (!text || !available()) return '';

  const system = [opts.system, opts.style].filter(Boolean).join('\n');
  const full = system ? `${system}\n\n${text}` : text;

  // Try the resolved model, then the fallbacks, so one unavailable model does
  // not take out all 35 AI commands.
  const tried = [];
  const models = resolvedModel
    ? [resolvedModel, ...FALLBACK_MODELS.filter((m) => m !== resolvedModel)]
    : [preferredModel(), ...FALLBACK_MODELS.filter((m) => m !== preferredModel())];

  for (const model of models) {
    try {
      const answer = await callModel(model, full, opts);
      if (model !== resolvedModel) {
        resolvedModel = model;
        log(`[GEMINI] using ${model}`);
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
        error(`[GEMINI] request failed: ${lastError}`);
        return '';
      }
    }
  }

  error(`[GEMINI] no model answered — ${tried.join(' | ')}`);
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

/** Test seam: forget the cached model and any recorded request. */
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
