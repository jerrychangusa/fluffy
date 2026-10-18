// A suspended VM can resume with a stale wall clock. Read the Date header from
// our existing provider before each authenticated event, then measure elapsed
// time locally. No customer data or credentials are sent by this request.
export function createPrimitiveClock({
  request = fetch,
  elapsed = () => performance.now(),
} = {}) {
  let providerTime;
  let synchronizedAt;

  return {
    async synchronize() {
      const response = await request('https://api.primitive.dev/v1', {
        method: 'HEAD',
        cache: 'no-store',
        redirect: 'error',
        headers: { 'Cache-Control': 'no-cache' },
        signal: AbortSignal.timeout(5000),
      });
      const timestamp = Date.parse(response.headers.get('date'));
      const age = response.headers.get('age');
      if (!Number.isFinite(timestamp) || (age !== null && age !== '0')) {
        throw new Error('clock_unavailable');
      }
      providerTime = timestamp;
      synchronizedAt = elapsed();
    },
    now() {
      if (providerTime === undefined) throw new Error('clock_not_ready');
      return providerTime + elapsed() - synchronizedAt;
    },
  };
}
