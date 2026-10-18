import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const TOOLS = [
  'read_case',
  'read_attachment',
  'record_intake',
  'request_information',
  'ask_teammate',
  'complete_intake',
  'send_email',
];
const STATUSES = [
  'running',
  'completed',
  'waiting_for_approval',
  'waiting_for_execution',
  'waiting_for_teammate',
  'needs_attention',
  'pending',
  'approved',
  'denied',
  'revoked',
  'blocked',
  'expired',
  'executed',
  'executing',
  'execution_unknown',
  'execution_failed',
  'answered',
  'changes_requested',
];
const TYPES = {
  event_received: ['Agent event received', 'observed'],
  run_started: ['Agent started', 'running'],
  session_started: ['Agent session observed', 'observed'],
  action_requested: ['Action requested', 'pending'],
  gateway_decision: ['Policy decision', 'observed'],
  tool_started: ['Tool started', 'running'],
  tool_succeeded: ['Tool finished', 'succeeded'],
  tool_failed: ['Tool failed', 'failed'],
};
const iso = (value) => {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const status = (value) => (STATUSES.includes(value) ? value : 'unknown');
const digest = (value) => createHash('sha256').update(value).digest();

// Server-to-server credential, never embedded in a viewer. Alternatively inject
// an authenticator backed by the deployment's existing verified identity session.
export function ownerAuthenticator({ token, subject }) {
  if (!token || !subject) return async () => null;
  return async (request) => {
    const header = request.headers.authorization;
    return typeof header === 'string' &&
      timingSafeEqual(digest(header), digest('Bearer ' + token))
      ? { subject }
      : null;
  };
}

export class TraceService {
  constructor({
    state,
    ownerSubject,
    authenticate = async () => null,
    provider = null,
    now = Date.now,
    sourceRevision = null,
  }) {
    Object.assign(this, {
      state,
      ownerSubject,
      authenticate,
      provider,
      now,
      sourceRevision,
    });
  }

  begin(event, { historical: importedHistory = false } = {}) {
    let id = this.state.get('trace-event/' + event.id);
    if (id) return id;
    const historical = importedHistory || !!this.state.get('event/' + event.id);
    id = randomBytes(24).toString('base64url');
    this.state.transaction(() => {
      this.state.put('trace-event/' + event.id, id);
      this.state.put('trace/' + id, {
        id,
        event_id: event.id,
        email_id: event.email?.id,
        owner_subject: this.ownerSubject || null,
        sender: event.email?.from_email || null,
        received_at: event.email?.received_at || null,
        events: [],
        sequence: 0,
        truncated: false,
        historical,
      });
    });
    if (!historical) this.append(event.id, { type: 'event_received' });
    return id;
  }

  append(eventId, entry) {
    if (!TYPES[entry.type]) return;
    this.state.transaction(() => {
      const id = this.state.get('trace-event/' + eventId);
      if (!id) return;
      const record = this.state.get('trace/' + id);
      const sequence = ++record.sequence;
      record.events.push({
        id: String(sequence),
        sequence,
        at: iso(this.now()),
        type: entry.type,
        title: TYPES[entry.type][0],
        status: TYPES[entry.type][1],
        tool: TOOLS.includes(entry.tool) ? entry.tool : null,
        decision: ['allow', 'review', 'deny'].includes(entry.decision)
          ? entry.decision
          : null,
        reason_code: null,
        provenance: 'agent',
      });
      if (record.events.length > 200) {
        record.events.shift();
        record.truncated = true;
      }
      this.state.put('trace/' + id, record);
    });
  }

  async read(id, request) {
    const identity = await this.authenticate(request);
    if (!identity || !/^[A-Za-z0-9_-]{32}$/.test(id)) return null;
    const record = this.state.get('trace/' + id);
    if (
      !record ||
      !(
        (record.owner_subject && identity.subject === record.owner_subject) ||
        (identity.emailVerified === true &&
          typeof identity.email === 'string' &&
          record.sender &&
          identity.email.toLowerCase() === record.sender.toLowerCase())
      )
    )
      return null;
    const checkpoint = this.state.get('event/' + record.event_id);
    let overlay = null;
    if (this.provider && record.email_id) {
      try {
        overlay = await this.provider.read(record);
      } catch {
        /* incomplete, never invent provider state */
      }
    }
    let observedAt = null;
    try {
      observedAt = iso(this.now());
    } catch {
      /* clock unavailable after restart */
    }
    const events = record.events.map((entry) => ({
      id: entry.id,
      sequence: entry.sequence,
      at: iso(entry.at),
      type: entry.type,
      title: TYPES[entry.type][0],
      status: TYPES[entry.type][1],
      tool: TOOLS.includes(entry.tool) ? entry.tool : null,
      decision: ['allow', 'review', 'deny'].includes(entry.decision)
        ? entry.decision
        : null,
      reason_code: null,
      provenance: 'agent',
    }));
    const historicalDecisions =
      checkpoint?.result?.gateway_decisions ||
      checkpoint?.gateway_decisions ||
      overlay?.checkpoint?.gateway_decisions ||
      [];
    if (record.historical) {
      for (const decision of historicalDecisions.slice(0, 24)) {
        events.push({
          id: 'historical-' + events.length,
          sequence: (events.at(-1)?.sequence || 0) + 1,
          at: null,
          type: 'gateway_decision',
          title: 'Policy decision',
          status: 'observed',
          tool: TOOLS.includes(decision.tool) ? decision.tool : null,
          decision: ['allow', 'review', 'deny'].includes(decision.decision)
            ? decision.decision
            : null,
          reason_code: null,
          provenance: 'agent_checkpoint',
        });
      }
    }
    const lifecycle = [
      'requested',
      'assessed',
      'approved',
      'denied',
      'revoked',
      'changes_requested',
      'blocked',
      'executing',
      'execution_unknown',
      'approval_requested',
      'notification_unknown',
      'notification_delivery',
      'execution_delivery',
      'receipt_delivery',
      'wake_requested',
      'wake_dispatched',
      'wake_unknown',
    ];
    const lifecycleOccurrences = new Map();
    for (const entry of (overlay?.approval?.events || []).slice(-40)) {
      if (!lifecycle.includes(entry.kind)) continue;
      const fingerprint = JSON.stringify([entry.kind, iso(entry.at)]);
      const occurrence = lifecycleOccurrences.get(fingerprint) || 0;
      lifecycleOccurrences.set(fingerprint, occurrence + 1);
      events.push({
        id:
          'approval-' +
          digest(JSON.stringify([entry.kind, iso(entry.at), occurrence]))
            .toString('hex')
            .slice(0, 24),
        sequence: (events.at(-1)?.sequence || 0) + 1,
        at: iso(entry.at),
        type: 'approval_' + entry.kind,
        title: 'Approval: ' + entry.kind.replaceAll('_', ' '),
        status: status(entry.kind),
        tool: null,
        decision: null,
        reason_code: null,
        provenance: 'primitive_memory',
      });
    }
    const sentStatus = [
      'queued',
      'pending',
      'sending',
      'sent',
      'delivered',
      'bounced',
      'gate_denied',
      'agent_failed',
      'canceled',
    ].includes(overlay?.sent?.status)
      ? overlay.sent.status
      : null;
    return {
      protocol: 'fluffy.trace/1',
      trace_id: id,
      status: status(
        checkpoint?.result?.status ||
          checkpoint?.status ||
          overlay?.checkpoint?.status,
      ),
      observed_at: observedAt,
      source_revision: /^[a-f0-9]{40}$/.test(this.sourceRevision || '')
        ? this.sourceRevision
        : null,
      email: {
        received_at: iso(overlay?.email?.received_at || record.received_at),
      },
      events,
      approval: overlay?.approval
        ? {
            status: status(overlay.approval.status),
            created_at: iso(overlay.approval.created_at),
            expires_at: iso(overlay.approval.expires_at),
            decided_at: null,
          }
        : null,
      delivery: {
        state:
          sentStatus === 'delivered'
            ? 'delivered'
            : ['bounced', 'gate_denied', 'agent_failed', 'canceled'].includes(
                  sentStatus,
                )
              ? 'failed'
              : sentStatus
                ? 'pending_delivery'
                : 'unknown',
        provider_status: sentStatus,
        observed_at: overlay?.sent ? observedAt : null,
      },
      completeness: {
        live_connected: !!overlay,
        tool_completion_events_available: !record.historical,
        history_truncated:
          record.truncated ||
          (record.historical && historicalDecisions.length >= 24) ||
          (overlay?.approval?.events?.length || 0) >= 40,
        timestamps_partial:
          !observedAt ||
          record.historical ||
          events.some((entry) => entry.at === null) ||
          !iso(overlay?.email?.received_at || record.received_at) ||
          !!overlay?.approval,
      },
    };
  }
}

// GET-only adapter. Do not use ApprovalService.reconcile (it writes and wakes).
export function createTraceProvider(api) {
  const memory = async (namespace, key) => {
    try {
      return (
        await api('/memories?key=' + encodeURIComponent(namespace + '/' + key))
      )?.value;
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  };
  return {
    async read(record) {
      const email = await api('/emails/' + encodeURIComponent(record.email_id));
      // Receipt events retain the customer's email for ownership checks, but
      // their own inbox checkpoint holds the action requested after resumption.
      const checkpoint = await memory('inbox', 'event/' + record.event_id);
      let approval = null;
      let sent = null;
      if (/^[A-F0-9]{16}$/.test(checkpoint?.permission_id || '')) {
        const context = await memory(
          'inbox',
          'request/' + checkpoint.permission_id,
        );
        if (
          context?.customer_email?.id !== record.email_id ||
          context?.customer_email?.from_email !== record.sender
        )
          return { email };
        const namespace =
          context.receipt_protocol === 'question.receipt/1'
            ? 'questions'
            : context.receipt_protocol === 'permission.receipt/1'
              ? 'approval'
              : null;
        if (namespace)
          approval = await memory(namespace, checkpoint.permission_id);
        if (
          namespace === 'approval' &&
          typeof approval?.execution?.provider_id === 'string'
        )
          sent = await api(
            '/sent-emails/' +
              encodeURIComponent(approval.execution.provider_id),
          );
      }
      return { email, approval, sent, checkpoint };
    },
  };
}
