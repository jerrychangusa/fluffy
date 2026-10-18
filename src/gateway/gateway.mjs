import { createHash } from 'node:crypto';
import { canonical } from '../shared/json.mjs';

function freezeJson(value) {
  const encoded = JSON.stringify(value);
  if (!encoded || Buffer.byteLength(encoded) > 65536)
    throw new Error('tool_arguments_too_large');
  function freeze(entry) {
    if (entry && typeof entry === 'object') {
      for (const child of Object.values(entry)) freeze(child);
      Object.freeze(entry);
    }
    return entry;
  }
  return freeze(JSON.parse(encoded));
}

export const toolCallHash = (name, args) =>
  createHash('sha256')
    .update(JSON.stringify(canonical({ tool: name, arguments: args })))
    .digest('hex');

const safeAssessment = (assessment) => ({
  source: assessment?.source === 'jev' ? 'jev' : 'unavailable',
  choice: ['allow', 'review', 'deny'].includes(assessment?.choice)
    ? assessment.choice
    : 'review',
  ...(typeof assessment?.model === 'string'
    ? { model: assessment.model.slice(0, 80) }
    : {}),
  ...(Number.isFinite(assessment?.confidence) &&
  assessment.confidence >= 0 &&
  assessment.confidence <= 1
    ? { confidence: assessment.confidence }
    : {}),
});

// Framework independent: no Claude, Primitive, or application imports. Registered
// tools provide validation, policy metadata, execution, and an optional review adapter.
export class ToolGateway {
  constructor({
    tools,
    assess,
    policy,
    context = {},
    onDecision = () => {},
    minConfidence = 0.8,
    maxCalls = 24,
  }) {
    if (
      typeof assess !== 'function' ||
      typeof policy !== 'string' ||
      !policy.trim() ||
      policy.length > 8000 ||
      !Number.isFinite(minConfidence) ||
      minConfidence < 0 ||
      minConfidence > 1 ||
      !Number.isInteger(maxCalls) ||
      maxCalls < 1 ||
      maxCalls > 100
    ) {
      throw new Error('invalid_gateway_configuration');
    }
    this.tools = new Map();
    for (const definition of tools) {
      if (
        !/^[a-z][a-z0-9_]{0,63}$/.test(definition.name) ||
        this.tools.has(definition.name) ||
        !['read', 'write', 'external_write'].includes(definition.effect) ||
        (typeof definition.mode !== 'function' &&
          !['automatic', 'review', 'deny'].includes(definition.mode)) ||
        typeof definition.validate !== 'function' ||
        typeof definition.execute !== 'function' ||
        typeof definition.inspect !== 'function' ||
        ['prepare', 'check', 'review'].some(
          (field) =>
            definition[field] !== undefined &&
            typeof definition[field] !== 'function',
        )
      )
        throw new Error('invalid_guarded_tool');
      this.tools.set(definition.name, definition);
    }
    this.assess = assess;
    this.policy = policy;
    this.context = freezeJson(context);
    this.onDecision = onDecision;
    this.minConfidence = minConfidence;
    this.maxCalls = maxCalls;
    this.calls = 0;
    this.pending = null;
    this.writes = new Map();
    this.queue = Promise.resolve();
  }

  invoke(name, input) {
    const snapshot = freezeJson(input);
    // Serialize even parallel SDK tool calls. Once review starts, no queued tool
    // may read data or perform a side effect behind the pending permission.
    const task = this.queue
      .catch(() => {})
      .then(() => this.process(name, snapshot));
    this.queue = task;
    return task;
  }

  async process(name, input) {
    if (this.pending)
      return { ...this.pending, reason: 'turn_waiting_for_approval' };
    const tool = this.tools.get(name);
    if (!tool) return this.block(name, null, 'unregistered_tool');
    if (++this.calls > this.maxCalls)
      return this.block(name, null, 'tool_call_limit');
    let args;
    try {
      const validated = tool.validate(input);
      args = freezeJson(
        tool.prepare ? await tool.prepare(validated) : validated,
      );
    } catch {
      return this.block(name, null, 'invalid_tool_arguments');
    }
    const hash = toolCallHash(name, args);
    if (this.writes.has(hash)) return this.writes.get(hash);
    const mode =
      typeof tool.mode === 'function' ? await tool.mode(args) : tool.mode;
    if (!['automatic', 'review', 'deny'].includes(mode))
      return this.block(name, hash, 'invalid_tool_policy');
    const forbidden =
      mode === 'deny' ? 'tool_forbidden' : await tool.check?.(args);
    if (forbidden) return this.block(name, hash, forbidden);

    let assessment;
    try {
      assessment = safeAssessment(
        await this.assess({
          tool: {
            name,
            effect: tool.effect,
            sensitivity: tool.sensitivity || 'unspecified',
            approval: mode,
          },
          arguments: freezeJson(tool.inspect(args)),
          context: this.context,
          policy: this.policy,
        }),
      );
    } catch {
      assessment = safeAssessment(null);
    }
    if (assessment.choice === 'deny')
      return this.block(name, hash, 'sentinel_denied', assessment);

    const confidentAllow =
      assessment.source === 'jev' &&
      assessment.choice === 'allow' &&
      assessment.confidence >= this.minConfidence;
    const review = mode === 'review' || !confidentAllow;
    const decision = {
      tool: name,
      call_hash: hash,
      decision: review ? 'review' : 'allow',
      reason:
        mode === 'review'
          ? 'human_approval_required'
          : confidentAllow
            ? 'sentinel_allowed'
            : 'sentinel_requires_review',
      assessment,
    };
    await this.onDecision(decision);
    if (review) {
      if (!tool.review)
        return {
          status: 'blocked',
          ...decision,
          reason: 'human_review_required_no_adapter',
        };
      this.pending = {
        status: 'pending',
        tool: name,
        call_hash: hash,
        reason: 'approval_request_in_progress',
      };
      const receipt = await tool.review(args, decision);
      if (
        receipt?.status !== 'pending' ||
        typeof receipt.request_id !== 'string' ||
        !receipt.request_id ||
        receipt.request_id.length > 200
      )
        throw new Error('invalid_approval_adapter_result');
      this.pending = {
        status: 'pending',
        tool: name,
        call_hash: hash,
        request_id: receipt.request_id,
        instruction:
          'Approval was requested. Stop this turn; an authenticated receipt will resume the agent.',
      };
      return this.pending;
    }
    // Automatic writes need their own durable idempotency. This cache additionally
    // prevents duplicate side effects within the current model turn.
    if (tool.effect !== 'read')
      this.writes.set(hash, {
        status: 'blocked',
        reason: 'execution_outcome_unknown',
        tool: name,
        call_hash: hash,
      });
    const result = {
      status: 'executed',
      tool: name,
      call_hash: hash,
      result: await tool.execute(args),
    };
    if (tool.effect !== 'read') this.writes.set(hash, result);
    return result;
  }

  async block(tool, hash, reason, assessment = undefined) {
    const decision = {
      tool,
      call_hash: hash,
      decision: 'deny',
      reason,
      ...(assessment ? { assessment } : {}),
    };
    await this.onDecision(decision);
    return { status: 'blocked', ...decision };
  }
}
