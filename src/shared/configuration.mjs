const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

function address(config, key) {
  if (typeof config[key] !== 'string' || !EMAIL.test(config[key])) {
    throw new Error('invalid_config_' + key);
  }
}

function addresses(config, key) {
  if (!Array.isArray(config[key]) || !config[key].length) {
    throw new Error('invalid_config_' + key);
  }
  for (const value of config[key]) address({ value }, 'value');
}

function mailConfig(config) {
  for (const key of [
    'requester_address',
    'approval_address',
    'customer_sender',
  ]) {
    address(config, key);
  }
  for (const key of ['signing_domain', 'signing_selector']) {
    if (typeof config[key] !== 'string' || !config[key].trim()) {
      throw new Error('invalid_config_' + key);
    }
  }
  return config;
}

export function approvalConfig(config) {
  mailConfig(config);
  address(config, 'execution_address');
  address(config, 'approver');
  addresses(config, 'allowed_recipients');
  if (config.approver_timezone !== undefined) {
    try {
      if (
        typeof config.approver_timezone !== 'string' ||
        !config.approver_timezone.trim()
      )
        throw new Error();
      new Intl.DateTimeFormat('en-US', { timeZone: config.approver_timezone });
    } catch {
      throw new Error('invalid_config_approver_timezone');
    }
  }
  if (
    config.policy !== undefined &&
    (typeof config.policy !== 'string' ||
      !config.policy.trim() ||
      config.policy.length > 8000)
  ) {
    throw new Error('invalid_config_policy');
  }
  return config;
}

export function inboxConfig(config) {
  mailConfig(config);
  addresses(config, 'allowed_customers');
  const url = new URL(config.agent_url);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error('invalid_config_agent_url');
  }
  return config;
}
