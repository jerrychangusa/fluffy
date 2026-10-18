function isAttribution(lines, index) {
  if (!/^\s*On\s/i.test(lines[index])) return false;
  for (const line of lines.slice(index, index + 4)) {
    if (!line.trim() || /^\s*>/.test(line)) return false;
    if (/\bwrote:\s*$/i.test(line)) return true;
  }
  return false;
}

const freshText = (body) => {
  const sourceLines = String(body || '')
    .replace(/\r/g, '')
    .split('\n');
  const lines = [];
  for (const [index, line] of sourceLines.entries()) {
    // Gmail can wrap its attribution before "wrote:". Only trim a complete
    // attribution, so feedback such as "On Tuesday, use the new wording" stays.
    const attribution = isAttribution(sourceLines, index);
    if (
      attribution ||
      /^\s*>|^From:\s|^-- $|^\s*-{2,}\s*Original Message/i.test(line)
    ) {
      break;
    }
    lines.push(line);
  }
  return lines.join('\n').trim();
};

export function parseApprovalCommand(body) {
  const match =
    /^(APPROVE|DENY|CHANGE|REVOKE) ([A-F0-9]{16})(?: ([A-F0-9]{32}))?(?:\n([\s\S]{1,2000}))?$/.exec(
      freshText(body),
    );
  if (!match) return null;
  const [, decision, id, code, feedback = ''] = match;
  const note = feedback.trim();
  if ((decision === 'APPROVE' && feedback) || (decision === 'CHANGE' && !note))
    return null;
  return { decision, id, code, note };
}
