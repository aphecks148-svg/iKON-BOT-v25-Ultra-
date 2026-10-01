'use strict';

/**
 * Diagnostic tap on ws3-fca's HTTP layer.
 *
 * WHY THIS EXISTS
 *
 * Facebook rejects a bad send with a JSON object, and ws3-fca throws it away:
 *
 *   sendMessage.js:92   throw new Error(resData)
 *
 * `new Error({...})` stringifies the object, so `err.message` is the literal
 * string "[object Object]" and the real reason — the `error` code and message
 * Facebook actually returned — is gone before anyone sees it. That is how a
 * total send failure reached production looking identical to "the bot is just
 * quiet": the log said "help: [object Object]".
 *
 * This module wraps ws3-fca's own `post` (the same axios instance it uses
 * internally, reached through its utils module) so the raw response body for
 * message sends is captured and exposed on /health. Read-only: it does not
 * modify the request or alter behaviour, it only records what Facebook said.
 */

const fcaAxios = require('ws3-fca/src/utils/axios');
const { log, error } = require('./helpers');

/** Endpoints worth capturing: these are where a send fails. */
const WATCHED = ['/messaging/send/', '/chat/user_info/'];

/** Cap the body so a huge HTML error page cannot bloat the health payload. */
const MAX_BODY = 600;

let lastRaw = '';
let lastRawAt = 0;
let installed = false;

/**
 * Reduce a Facebook response body to one readable line.
 *
 * Facebook's shape is `{ error: 1545012, errorSummary: ..., ... }` or, for
 * newer endpoints, nested under `payload`. Pull out the code and any summary
 * text so the health endpoint shows something actionable.
 *
 * @param {*} body parsed JSON body
 * @returns {string}
 */
function summarise(body) {
  if (!body || typeof body !== 'object') {
    return String(body === undefined || body === null ? '(empty)' : body).slice(0, MAX_BODY);
  }

  // Walk the plausible spots for an error code/message.
  const candidates = [
    body,
    body.error,
    body.payload && body.payload.error,
    body.error_data,
    body.errorSummary,
  ];

  const parts = [];
  for (const c of candidates) {
    if (c === undefined || c === null) continue;
    if (typeof c === 'string' || typeof c === 'number') {
      parts.push(String(c));
    } else if (typeof c === 'object') {
      for (const k of ['error', 'code', 'message', 'errorSummary', 'failure_reason', 'status']) {
        if (typeof c[k] === 'string' || typeof c[k] === 'number') parts.push(`${k}=${c[k]}`);
      }
    }
    if (parts.length >= 4) break;
  }

  if (!parts.length) parts.push(Object.keys(body).slice(0, 12).join(',') || '{}');
  return [...new Set(parts)].join(' | ').slice(0, MAX_BODY);
}

/**
 * Install the tap. Idempotent — safe to call on every login and reload.
 *
 * @returns {boolean} true if the tap is active
 */
function install() {
  if (installed) return true;

  const original = fcaAxios.post;
  if (typeof original !== 'function') {
    error('[DIAG] ws3-fca post() not found — cannot capture raw Facebook errors.');
    return false;
  }

  fcaAxios.post = async function patchedPost(url, ...rest) {
    const watched = WATCHED.some((w) => String(url).includes(w));
    const res = await original.call(this, url, ...rest);
    if (watched && res && res.body !== undefined && res.body !== null) {
      const summary = summarise(res.body);
      lastRaw = summary;
      lastRawAt = Date.now();
      // Only log when Facebook reports a problem, so a healthy deploy stays quiet.
      const hasError = res.body && typeof res.body === 'object' && (res.body.error || res.body.error_data);
      if (hasError) error(`[FCA] ${url.split('/').slice(-2)[0]} -> ${summary}`);
      else log(`[FCA] ${url.split('/').slice(-2)[0]} -> ok (${summary.slice(0, 80)})`);
    }
    return res;
  };

  installed = true;
  log('[DIAG] Facebook response tap installed');
  return true;
}

/** The last captured response summary, or ''. */
function lastRawSummary() {
  return lastRaw;
}

/** Millisecond timestamp of the last capture, or 0. */
function lastRawAtMs() {
  return lastRawAt;
}

module.exports = { install, lastRawSummary, lastRawAtMs, summarise };
