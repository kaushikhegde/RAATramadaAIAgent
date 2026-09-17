/**
 * payment-events.js — the ONE thing the agent subscribes to for Mint status.
 * ============================================================================
 * Real Mint has no webhooks — the spec documents none (see mock-mint-server.js's
 * header). So the only way to learn that a human has authorised (or declined) a
 * staged payment is to ask: either an SSE stream in mock mode, standing in for
 * the human's screen, or a genuine poll of getTransaction() against real Mint.
 * This module is the seam that hides which one is happening — the caller gets
 * the same onStatusChange(status, transaction) callback either way, and never
 * talks to mock-mint-server.js's /mock/events directly (that would be a
 * dependency on a capability Mint does not actually offer).
 *
 * Fires ONCE per transaction: as soon as status moves away from
 * "pending_for_authorisation" (to authorised, declined or cancelled), the watch
 * stops itself. What happens after that — the Tramada write-back, or telling the
 * consultant it was declined — is the caller's job, not this module's.
 */

const mintClient = require("./mint-client");

// Real Mint will be slower and less reliable than the mock, and a human may not
// get to MintEFT for hours — this is a long poll on purpose, not a quick retry.
const POLL_INTERVAL_MS = Number(process.env.MINT_POLL_INTERVAL_MS || 20000);
const MAX_WAIT_MS = Number(process.env.MINT_POLL_MAX_WAIT_MS || 7 * 24 * 60 * 60 * 1000); // 7 days
const SSE_RECONNECT_MS = 2000;

function log(...args) {
  if (process.env.DEBUG === "true") console.log("[payment-events]", ...args);
}

/**
 * Watch one Mint transaction until it leaves pending_for_authorisation.
 *
 * @param {string} transactionId
 * @param {object} callbacks
 *   onStatusChange(status, transaction)  called exactly once, then the watch stops
 *   onError(err, { transient })          transient: a single failed poll/reconnect,
 *                                        the watch is still running. Non-transient:
 *                                        the watch has given up (MAX_WAIT_MS).
 * @returns {function} stop() — cancel the watch early (e.g. on server shutdown)
 */
function watchTransaction(transactionId, { onStatusChange, onError } = {}) {
  return mintClient.environment() === "mock"
    ? watchViaSSE(transactionId, { onStatusChange, onError })
    : watchViaPolling(transactionId, { onStatusChange, onError });
}

/** Real (or UAT) Mint: no push available, so ask on an interval. */
function watchViaPolling(transactionId, { onStatusChange, onError }) {
  let stopped = false;
  const startedAt = Date.now();
  let timer = null;

  async function tick() {
    if (stopped) return;
    if (Date.now() - startedAt > MAX_WAIT_MS) {
      stopped = true;
      onError && onError(
        new Error(`Gave up waiting for Mint transaction ${transactionId} to be authorised after ${MAX_WAIT_MS}ms.`),
        { transient: false }
      );
      return;
    }
    try {
      const txn = await mintClient.getTransaction(transactionId);
      if (txn && txn.status && txn.status !== "pending_for_authorisation") {
        stopped = true;
        onStatusChange && onStatusChange(txn.status, txn);
        return;
      }
    } catch (err) {
      // A single failed poll must not give up on the whole wait — see
      // mint-client.js's own comment on timeouts vs. reconciliation.
      log("poll failed (transient):", err.message);
      onError && onError(err, { transient: true });
    }
    if (!stopped) timer = setTimeout(tick, POLL_INTERVAL_MS);
  }

  timer = setTimeout(tick, 0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/** Mock mode: mock-mint-server.js pushes over SSE the instant a human answers. */
function watchViaSSE(transactionId, { onStatusChange, onError }) {
  let stopped = false;
  let aborter = null;

  // A transaction can change status between being staged and this call
  // subscribing (a server restart, most obviously) — check current state first
  // so a change that happened while nobody was listening is never missed.
  mintClient
    .getTransaction(transactionId)
    .then((txn) => {
      if (stopped) return;
      if (txn && txn.status && txn.status !== "pending_for_authorisation") {
        stopped = true;
        onStatusChange && onStatusChange(txn.status, txn);
      } else {
        connect();
      }
    })
    .catch((err) => {
      log("initial getTransaction check failed, streaming anyway:", err.message);
      if (!stopped) connect();
    });

  async function connect() {
    if (stopped) return;
    aborter = new AbortController();
    const root = mintClient.BASE_URL.replace(/\/eft\/v1\/?$/, "");

    try {
      const res = await fetch(`${root}/mock/events`, { signal: aborter.signal });
      if (!res.ok || !res.body) throw new Error(`SSE connect failed: HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;

          let payload;
          try {
            payload = JSON.parse(dataLine.slice(5).trim());
          } catch {
            continue;
          }
          // authorisation_required events carry no `status` field — only
          // status_changed does, which is the one we're actually waiting for.
          if (payload.transaction_id !== transactionId) continue;
          if (payload.status && payload.status !== "pending_for_authorisation") {
            stopped = true;
            onStatusChange && onStatusChange(payload.status, payload);
            aborter.abort();
            return;
          }
        }
      }
      if (!stopped) setTimeout(connect, SSE_RECONNECT_MS);
    } catch (err) {
      if (!stopped) {
        log("SSE stream dropped (transient), reconnecting:", err.message);
        onError && onError(err, { transient: true });
        setTimeout(connect, SSE_RECONNECT_MS);
      }
    }
  }

  return () => {
    stopped = true;
    if (aborter) aborter.abort();
  };
}

module.exports = { watchTransaction };
