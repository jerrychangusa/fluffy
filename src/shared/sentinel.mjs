import { Rejected } from './errors.mjs';

// Provenance for audit/preview only. This metadata never grants permission.
export function sentinelDecision(value) {
  if (value === undefined) return undefined;
  if (
    !value ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(value.tool || '') ||
    !/^[a-f0-9]{64}$/.test(value.call_hash || '') ||
    !['allow', 'review'].includes(value.decision) ||
    !/^[a-z_]{1,120}$/.test(value.reason || '') ||
    !['jev', 'unavailable'].includes(value.assessment?.source) ||
    !['allow', 'review'].includes(value.assessment?.choice)
  ) {
    throw new Rejected('invalid_sentinel_context');
  }
  const { source, choice, confidence, model } = value.assessment;
  if (
    confidence !== undefined &&
    (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
  ) {
    throw new Rejected('invalid_sentinel_confidence');
  }
  return {
    tool: value.tool,
    call_hash: value.call_hash,
    decision: value.decision,
    reason: value.reason,
    assessment: {
      source,
      choice,
      ...(confidence === undefined ? {} : { confidence }),
      ...(typeof model === 'string' ? { model: model.slice(0, 80) } : {}),
    },
  };
}
