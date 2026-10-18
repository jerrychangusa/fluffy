import { Retry, Rejected } from '../../shared/errors.mjs';

function encodeBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

export function createPrimitiveClient(env) {
  const base = (
    env.PRIMITIVE_API_BASE_URL || 'https://api.primitive.dev/v1'
  ).replace(/\/$/, '');
  const root = base.endsWith('/v1') ? base : base + '/v1';
  const headers = {
    Authorization: `Bearer ${env.PRIMITIVE_API_KEY}`,
    ...(env.PRIMITIVE_FUNCTION_ID
      ? { 'x-primitive-function-id': env.PRIMITIVE_FUNCTION_ID }
      : {}),
  };

  async function api(endpoint, method = 'GET', body, idempotencyKey) {
    const response = await fetch(root + endpoint, {
      method,
      headers: {
        ...headers,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(40_000),
    });
    if (response.status === 204) return null;
    const result = await response.json().catch(() => null);

    if (!response.ok || !result?.success) {
      const error = new Error(
        `Primitive ${response.status} ${result?.error?.code || 'request_failed'}`,
      );
      error.status = response.status;
      throw error;
    }
    return result.data;
  }

  async function loadAttachment(emailId, partIndex) {
    if (!/^[a-f0-9-]{36}$/i.test(emailId) || !Number.isInteger(partIndex)) {
      throw new Rejected('bad_attachment_reference');
    }

    const response = await fetch(
      `${root}/emails/${emailId}/attachments/${partIndex}`,
      {
        headers,
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      throw new Retry('attachment_unavailable');
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  return {
    api,
    mail: {
      base64: encodeBase64,
      attachment: loadAttachment,
      send: (body, key) =>
        api(
          '/send-mail',
          'POST',
          { ...body, wait: true, wait_timeout_ms: 10_000 },
          key,
        ),
      lookup: (key) =>
        api('/sent-emails?idempotency_key=' + encodeURIComponent(key)),
      detail: (id) => api('/sent-emails/' + id),
    },
  };
}
