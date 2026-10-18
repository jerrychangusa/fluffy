// Only explicitly enabled trace credentials enter the trusted runtime. Claude's
// subprocess keeps its separate, minimal environment in src/agent/claude.mjs.
export function traceEnvironment(env, sourceRevision) {
  const enabled = flag(env, 'TRACE_ENABLED');
  const providerEnabled = flag(env, 'TRACE_PROVIDER_ENABLED');
  if (providerEnabled && !enabled)
    throw new Error('TRACE_PROVIDER_ENABLED requires TRACE_ENABLED=true');
  if (!enabled)
    return { TRACE_ENABLED: 'false', TRACE_PROVIDER_ENABLED: 'false' };

  const token = value(env, 'TRACE_OWNER_TOKEN');
  if (token === env.AGENT_BRIDGE_SECRET)
    throw new Error('TRACE_OWNER_TOKEN must not reuse AGENT_BRIDGE_SECRET');
  const revision = env.SOURCE_REVISION || sourceRevision;
  if (!/^[a-f0-9]{40}$/.test(revision || ''))
    throw new Error('SOURCE_REVISION must be a 40-character Git SHA');
  const config = {
    TRACE_ENABLED: 'true',
    TRACE_OWNER_SUBJECT: value(env, 'TRACE_OWNER_SUBJECT'),
    TRACE_OWNER_TOKEN: token,
    TRACE_PROVIDER_ENABLED: String(providerEnabled),
    SOURCE_REVISION: revision,
  };
  if (providerEnabled) {
    config.PRIMITIVE_API_KEY = value(env, 'PRIMITIVE_API_KEY');
    if (env.PRIMITIVE_API_BASE_URL) {
      const base = value(env, 'PRIMITIVE_API_BASE_URL');
      if (!URL.canParse(base))
        throw new Error('invalid_PRIMITIVE_API_BASE_URL');
      const url = new URL(base);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error('invalid_PRIMITIVE_API_BASE_URL');
      config.PRIMITIVE_API_BASE_URL = base;
    }
    if (env.PRIMITIVE_FUNCTION_ID) {
      if (!/^[a-f0-9-]{36}$/i.test(env.PRIMITIVE_FUNCTION_ID))
        throw new Error('invalid_PRIMITIVE_FUNCTION_ID');
      config.PRIMITIVE_FUNCTION_ID = env.PRIMITIVE_FUNCTION_ID;
    }
  }
  return config;
}

function flag(env, key) {
  const input = env[key];
  if (input === undefined || input === '' || input === 'false') return false;
  if (input === 'true') return true;
  throw new Error('invalid_' + key);
}

function value(env, key) {
  const input = env[key];
  // These values are written to an unquoted env file. Exclude comment, quote,
  // whitespace and escape characters so a credential cannot inject a new field.
  if (
    typeof input !== 'string' ||
    !input ||
    input.length > 4096 ||
    /[\s\u0000-\u001f\u007f\\#'"]/.test(input)
  )
    throw new Error('invalid_' + key);
  return input;
}
