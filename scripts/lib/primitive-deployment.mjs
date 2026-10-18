import fs from 'node:fs/promises';
import { createPrimitiveClient } from '../../src/integrations/primitive/client.mjs';

export const readConfig = async (url) =>
  JSON.parse(await fs.readFile(url, 'utf8'));
export function adminApi() {
  if (!process.env.PRIMITIVE_API_KEY)
    throw new Error('PRIMITIVE_API_KEY required');
  return createPrimitiveClient({
    PRIMITIVE_API_KEY: process.env.PRIMITIVE_API_KEY,
  }).api;
}
export async function configureSecrets(api, functionId, secrets) {
  const endpoint = '/functions/' + functionId + '/secrets';
  const response = await api(endpoint);
  const existing = response.items || response;
  for (const [key, value] of Object.entries(secrets)) {
    if (typeof value !== 'string' || !value) throw new Error(key + ' required');
    const exists = existing.some((entry) => (entry.key || entry.name) === key);
    await api(
      exists ? endpoint + '/' + key : endpoint,
      exists ? 'PUT' : 'POST',
      exists ? { value } : { key, value },
    );
  }
}
