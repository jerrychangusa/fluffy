import { Retry } from '../shared/errors.mjs';

const AGENT_TIMEOUT_MS = 180_000;
const encode = (value) => new TextEncoder().encode(value);

async function signPayload(payload, timestamp, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encode(timestamp + '.' + payload),
  );

  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function createAgentClient(agentUrl, secret) {
  return async function invokeAgent(event) {
    const payload = JSON.stringify(event);
    const deadline = Date.now() + AGENT_TIMEOUT_MS;
    for (let attempt = 0; attempt < 3; attempt++) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = await signPayload(payload, timestamp, secret);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Retry('agent_timeout');
      // Reuse the exact event on a transient cold-start failure. The runtime
      // deduplicates event IDs and checkpoints proposals before returning.
      const response = await fetch(agentUrl + '/events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Agent-Signature': `t=${timestamp},v1=${signature}`,
        },
        body: payload,
        signal: AbortSignal.timeout(remaining),
      });
      if (response.ok) return response.json();
      if (![502, 503, 504].includes(response.status) || attempt === 2) {
        throw new Retry('agent_http_' + response.status);
      }
      await new Promise((resolve) =>
        setTimeout(resolve, attempt === 0 ? 250 : 1000),
      );
    }
  };
}
