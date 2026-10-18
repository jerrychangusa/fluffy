import { Rejected } from '../../shared/errors.mjs';

export function createMemoryStore(api, namespace) {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(namespace))
    throw new Error('Invalid Memory namespace.');
  return {
    async get(key) {
      try {
        return await api(
          '/memories?key=' + encodeURIComponent(namespace + '/' + key),
        );
      } catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
    },
    put(key, value, condition = {}) {
      const json = JSON.stringify(value);
      if (
        typeof json !== 'string' ||
        new TextEncoder().encode(json).length > 65_536
      ) {
        throw new Rejected('memory_value_too_large');
      }
      return api('/memories', 'PUT', {
        key: namespace + '/' + key,
        value,
        ...condition,
      });
    },
  };
}
