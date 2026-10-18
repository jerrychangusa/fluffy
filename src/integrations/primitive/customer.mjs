import { authenticated } from './authentication.mjs';
import { validEmailAddress } from '../../shared/configuration.mjs';
import { requireThat } from '../../shared/validation.mjs';

export function authenticatedCustomer(email, config) {
  const sender = email.from_email?.toLowerCase();
  if (!validEmailAddress(sender)) return false;
  const permitted =
    config.customer_access === 'authenticated' ||
    config.allowed_customers?.includes(sender);
  return !!permitted && authenticated(email, sender, config, true);
}

// Open customer access permits replies to verified inbound senders, not arbitrary
// recipients. Independently reload the source email in the trusted mailbox.
export async function verifyCustomerRequest(request, email, config, api) {
  if (config.customer_access !== 'authenticated') return;
  requireThat(
    authenticated(email, config.requester_address, config),
    'untrusted_requester',
  );
  const sourceId = request.context?.customer_email_id;
  requireThat(
    /^[a-f0-9-]{36}$/i.test(sourceId || ''),
    'customer_email_reference_required',
  );
  const source = await api('/emails/' + sourceId);
  requireThat(
    source?.recipient === config.customer_sender &&
      authenticatedCustomer(source, config) &&
      request.action?.to === source.from_email.toLowerCase(),
    'recipient_not_customer',
  );
}
