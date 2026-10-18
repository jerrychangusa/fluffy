// Trust provider authentication results, not headers supplied by the sender.
export function authenticated(email, address, config, human = false) {
  const authentication = email.auth || {};
  const domain = address.split('@')[1];
  return (
    email.from_email?.toLowerCase() === address.toLowerCase() &&
    ['accepted', 'completed'].includes(email.status) &&
    authentication.dmarc === 'pass' &&
    authentication.dmarcDkimAligned === true &&
    (!human || email.automated !== true) &&
    authentication.dkimSignatures?.some(
      (signature) =>
        signature.result === 'pass' &&
        signature.aligned === true &&
        (human
          ? signature.domain === domain
          : signature.domain === config.signing_domain &&
            signature.selector === config.signing_selector),
    )
  );
}
