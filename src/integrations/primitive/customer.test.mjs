import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticatedCustomer, verifyCustomerRequest } from './customer.mjs';
import { inboxConfig, approvalConfig } from '../../shared/configuration.mjs';

const config = {
  customer_access: 'authenticated',
  customer_sender: 'support@demo.primitive.email',
  requester_address: 'requester@demo.primitive.email',
  approval_address: 'approvals@demo.primitive.email',
  execution_address: 'executor@demo.primitive.email',
  approver: 'reviewer@gmail.com',
  signing_domain: 'primitive.email',
  signing_selector: 'demo.pri-test',
  agent_url: 'https://agent.example.com',
};
const customer = {
  id: crypto.randomUUID(),
  from_email: 'new-customer@gmail.com',
  recipient: config.customer_sender,
  status: 'completed',
  auth: {
    dmarc: 'pass',
    dmarcDkimAligned: true,
    dkimSignatures: [{ domain: 'gmail.com', result: 'pass', aligned: true }],
  },
};
const internal = {
  ...customer,
  from_email: config.requester_address,
  auth: {
    ...customer.auth,
    dkimSignatures: [
      {
        domain: config.signing_domain,
        selector: config.signing_selector,
        result: 'pass',
        aligned: true,
      },
    ],
  },
};

test('open customer access accepts authenticated new senders but rejects spoofed and automated mail', () => {
  assert.equal(authenticatedCustomer(customer, config), true);
  assert.equal(
    authenticatedCustomer(customer, {
      ...config,
      customer_access: 'allowlist',
      allowed_customers: ['another@gmail.com'],
    }),
    false,
  );
  assert.equal(
    authenticatedCustomer(
      { ...customer, auth: { ...customer.auth, dmarc: 'fail' } },
      config,
    ),
    false,
  );
  assert.equal(
    authenticatedCustomer({ ...customer, automated: true }, config),
    false,
  );
  assert.equal(
    authenticatedCustomer({ ...customer, from_email: 'invalid' }, config),
    false,
  );
});

test('open reply requests independently bind the recipient to the authenticated source email', async () => {
  const request = {
    context: { customer_email_id: customer.id },
    action: { to: customer.from_email },
  };
  const api = async (route) => {
    assert.equal(route, '/emails/' + customer.id);
    return customer;
  };
  await verifyCustomerRequest(request, internal, config, api);
  await assert.rejects(
    verifyCustomerRequest(
      { ...request, action: { to: 'victim@gmail.com' } },
      internal,
      config,
      api,
    ),
    /recipient_not_customer/,
  );
  await assert.rejects(
    verifyCustomerRequest({ ...request, context: {} }, internal, config, api),
    /customer_email_reference_required/,
  );
  await assert.rejects(
    verifyCustomerRequest(request, customer, config, api),
    /untrusted_requester/,
  );
  await assert.rejects(
    verifyCustomerRequest(request, internal, config, async () => ({
      ...customer,
      recipient: config.approval_address,
    })),
    /recipient_not_customer/,
  );
  await assert.rejects(
    verifyCustomerRequest(request, internal, config, async () => ({
      ...customer,
      auth: {},
    })),
    /recipient_not_customer/,
  );
});

test('customer access mode is explicit and the restricted configuration stays the default', () => {
  assert.equal(inboxConfig(config).customer_access, 'authenticated');
  assert.equal(approvalConfig(config).customer_access, 'authenticated');
  assert.throws(
    () => inboxConfig({ ...config, customer_access: undefined }),
    /allowed_customers/,
  );
  assert.throws(
    () => approvalConfig({ ...config, customer_access: undefined }),
    /allowed_recipients/,
  );
  assert.throws(
    () => inboxConfig({ ...config, customer_access: 'everyone' }),
    /customer_access/,
  );
});
