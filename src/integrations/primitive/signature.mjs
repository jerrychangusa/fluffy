const encode = (value) => new TextEncoder().encode(value);

export async function verifySignature(
  rawBody,
  header,
  secret,
  now = Date.now(),
) {
  if (!secret || !header) {
    return false;
  }

  const parts = header.split(',').map((part) => part.trim().split('='));
  const timestamps = parts.filter(([name]) => name === 't');
  if (timestamps.length !== 1 || !/^\d+$/.test(timestamps[0][1])) {
    return false;
  }

  const timestamp = Number(timestamps[0][1]);
  if (
    !Number.isSafeInteger(timestamp) ||
    now / 1000 - timestamp > 300 ||
    timestamp - now / 1000 > 60
  ) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  for (const [version, signature] of parts) {
    if (version !== 'v1' || !/^([a-f0-9]{2}){32}$/i.test(signature)) {
      continue;
    }
    const bytes = Uint8Array.from(signature.match(/../g), (byte) =>
      parseInt(byte, 16),
    );
    if (
      await crypto.subtle.verify(
        'HMAC',
        key,
        bytes,
        encode(`${timestamp}.${rawBody}`),
      )
    ) {
      return true;
    }
  }
  return false;
}
