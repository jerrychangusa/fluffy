import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const SIGNATURE_WINDOW_SECONDS = 300;

function signedTimestamp(rawBody, header, secret) {
  const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(header || '');
  if (!match) return null;

  const expected = createHmac('sha256', secret)
    .update(match[1] + '.' + rawBody)
    .digest();
  return timingSafeEqual(expected, Buffer.from(match[2], 'hex'))
    ? Number(match[1]) * 1000
    : null;
}

function isFresh(timestamp, now) {
  return (
    timestamp !== null &&
    Math.abs(now - timestamp) <= SIGNATURE_WINDOW_SECONDS * 1000
  );
}

export function verifyAgentSignature(
  rawBody,
  header,
  secret,
  now = Date.now(),
) {
  return isFresh(signedTimestamp(rawBody, header, secret), now);
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

export function createAgentServer({
  service,
  secret,
  modelReady,
  policyReady,
  clock,
  traces = null,
}) {
  const server = http.createServer(async (request, response) => {
    if (request.url?.startsWith('/api/traces/')) {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Vary', 'Authorization, Cookie');
      try {
        const match = /^\/api\/traces\/([A-Za-z0-9_-]{32})$/.exec(request.url);
        const trace =
          request.method === 'GET' && match && traces
            ? await traces.read(match[1], request)
            : null;
        return sendJson(
          response,
          trace ? 200 : 404,
          trace || { error: 'not_found' },
        );
      } catch {
        return sendJson(response, 404, { error: 'not_found' });
      }
    }
    if (request.url === '/health' && request.method === 'GET') {
      return sendJson(response, 200, {
        ok: true,
        harness: 'claude-agent-sdk',
        model_ready: modelReady,
        ...(policyReady === undefined ? {} : { policy_ready: policyReady }),
      });
    }

    if (request.url !== '/events' || request.method !== 'POST') {
      return sendJson(response, 404, { error: 'not_found' });
    }

    try {
      const chunks = [];
      let bodyBytes = 0;
      for await (const chunk of request) {
        bodyBytes += chunk.length;
        if (bodyBytes > MAX_BODY_BYTES) {
          return sendJson(response, 413, { error: 'too_large' });
        }
        chunks.push(chunk);
      }
      const rawBody = Buffer.concat(chunks).toString('utf8');

      const timestamp = signedTimestamp(
        rawBody,
        request.headers['x-agent-signature'],
        secret,
      );
      // Reject invalid MACs before making any provider call. A valid MAC still
      // needs a fresh timestamp; VM standby must not widen that window.
      if (timestamp === null) {
        return sendJson(response, 401, { error: 'invalid_signature' });
      }
      await clock?.synchronize();
      const now = clock ? clock.now() : Date.now();
      if (!isFresh(timestamp, now)) {
        console.log(
          JSON.stringify({
            kind: 'agent_signature_rejected',
            timestamp_age_seconds: Math.round((now - timestamp) / 1000),
          }),
        );
        return sendJson(response, 401, { error: 'invalid_signature' });
      }

      let event;
      try {
        event = JSON.parse(rawBody);
      } catch {
        return sendJson(response, 400, { error: 'invalid_event_json' });
      }
      console.log(
        JSON.stringify({
          kind: 'agent_started',
          event_id: event.id,
          conversation_id: event.conversation_id,
          event: event.kind,
        }),
      );

      const result = await service.handle(event);
      console.log(
        JSON.stringify({
          kind: 'agent_finished',
          event_id: event.id,
          status: result.status,
          session_id: result.session_id,
          resumed: result.resumed,
          replayed: !!result.replayed,
          tool_calls: result.tool_calls,
          cost_usd: result.cost_usd,
          gateway_decisions: result.gateway_decisions,
        }),
      );
      sendJson(response, 200, result);
    } catch (error) {
      const reason = /^[a-z_]+$/.test(error.message)
        ? error.message
        : 'harness_error';
      console.log(JSON.stringify({ kind: 'agent_error', reason }));
      sendJson(response, 503, {
        error: 'agent_unavailable',
        reason,
      });
    }
  });

  server.requestTimeout = 200_000;
  return server;
}
