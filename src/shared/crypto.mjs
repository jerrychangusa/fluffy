export const encodeUtf8 = (text) => new TextEncoder().encode(text);

export const sha = async (value) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        value instanceof Uint8Array
          ? value
          : encodeUtf8(
              typeof value === 'string' ? value : JSON.stringify(value),
            ),
      ),
    ),
  )
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
