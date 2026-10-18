export function informationRequest(orderId, missing) {
  const lines = [
    'Hi,',
    '',
    `Thanks for getting in touch about order ${orderId}.`,
  ];
  if (!missing.includes('prescription'))
    lines.push('', 'I have your prescription on file.');
  if (missing.includes('prescription'))
    lines.push(
      '',
      'Please attach a clear photo or PDF of your prescription to your reply.',
    );
  if (missing.includes('pd'))
    lines.push(
      '',
      'We also need your pupillary distance (PD). Please add your existing measurement in millimeters to the attached form, save it, and reply with the completed PDF. If you do not know your PD, just let us know and we will help with the next step.',
    );
  lines.push(
    '',
    'I will keep everything together and coordinate with our review team for you.',
    '',
    'Thanks,',
    'Your support team',
  );
  return lines.join('\n');
}

export function completionMessage(orderId) {
  return `Hi,\n\nThank you for sending your information for order ${orderId}. Your prescription and pupillary distance (PD) are now collected, and your intake is complete.\n\nOur team will review the prescription before the order moves forward. I will stay with your case if anything else is needed.\n\nThanks,\nYour support team`;
}
