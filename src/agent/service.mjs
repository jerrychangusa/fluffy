import { validateEvent, draftAction } from './contracts.mjs';

export class AgentService {
  constructor({
    state,
    traces = null,
    run,
    onReceipt = async () => {},
    now = () => Date.now(),
  }) {
    this.state = state;
    this.traces = traces;
    this.run = run;
    this.onReceipt = onReceipt;
    this.now = now;
    this.conversationQueues = new Map();
    this.runningEvents = new Map();
  }

  async handle(event) {
    // Duplicate events share a task; different events in one conversation wait
    // for the previous task before reading or changing its session state.
    validateEvent(event);
    this.traces?.begin(event);
    const eventKey = 'event/' + event.id;
    const checkpoint = this.state.get(eventKey);
    if (checkpoint?.result) {
      return { ...checkpoint.result, replayed: true };
    }
    if (this.runningEvents.has(eventKey)) {
      return this.runningEvents.get(eventKey);
    }
    const previousRun =
      this.conversationQueues.get(event.conversation_id) || Promise.resolve();
    const currentRun = previousRun
      .catch(() => {})
      .then(() => this.process(event));
    this.conversationQueues.set(event.conversation_id, currentRun);
    this.runningEvents.set(eventKey, currentRun);
    try {
      return await currentRun;
    } finally {
      this.runningEvents.delete(eventKey);
      if (this.conversationQueues.get(event.conversation_id) === currentRun) {
        this.conversationQueues.delete(event.conversation_id);
      }
    }
  }

  async process(event) {
    const eventKey = 'event/' + event.id;
    const checkpoint = this.state.get(eventKey);
    if (checkpoint?.result) {
      return { ...checkpoint.result, replayed: true };
    }
    const conversationKey = 'conversation/' + event.conversation_id;
    const conversation = this.state.get(conversationKey) || {
      id: event.conversation_id,
      session_id: null,
      runs: 0,
      revision: 0,
      status: 'new',
      pending: null,
    };
    const earlyResult = this.prepareConversation(
      event,
      conversation,
      conversationKey,
    );
    if (earlyResult) {
      return earlyResult;
    }
    if (event.kind === 'receipt') await this.onReceipt(event, conversation);
    let proposal = checkpoint?.proposal || null;
    if (!proposal) this.consumeRunBudget(conversation, conversationKey);
    let sessionId = conversation.session_id;
    const gatewayDecisions = checkpoint?.gateway_decisions || [];
    // Persist a tool proposal before returning pending, so a crashed SDK turn
    // can recover it without generating a different draft on retry.
    const saveCheckpoint = () =>
      this.state.put(eventKey, {
        status: 'running',
        proposal,
        session_id: sessionId,
        gateway_decisions: gatewayDecisions,
      });
    saveCheckpoint();
    const requestAction = async (input) => {
      const nextProposal = draftAction(input, event);
      if (
        proposal &&
        JSON.stringify(proposal) !== JSON.stringify(nextProposal)
      ) {
        throw new Error('one_immutable_proposal_per_event');
      }
      proposal = nextProposal;
      this.traces?.append(event.id, { type: 'action_requested' });
      saveCheckpoint();
      return {
        status: 'pending',
        request_id: nextProposal.request_id,
        instruction:
          'Request recorded for email delivery. Stop this turn. A later email reply will resume this conversation.',
      };
    };
    let runResult;
    if (proposal) {
      runResult = { status: 'recovered_proposal' };
    } else {
      runResult = await this.run({
        event,
        conversation,
        requestAction,
        onExecution: (entry) => this.traces?.append(event.id, entry),
        onDecision: (decision) => {
          this.traces?.append(event.id, {
            ...decision,
            type: 'gateway_decision',
          });
          if (gatewayDecisions.length < 24)
            gatewayDecisions.push(structuredClone(decision));
          saveCheckpoint();
        },
        onSession: (id) => {
          this.traces?.append(event.id, { type: 'session_started' });
          sessionId = id;
          conversation.session_id = id;
          this.state.put(conversationKey, conversation);
          saveCheckpoint();
        },
      });
    }
    conversation.session_id = sessionId;
    conversation.status = proposal
      ? proposal.type === 'teammate.question'
        ? 'waiting_for_teammate'
        : proposal.sentinel?.decision === 'allow'
          ? 'waiting_for_execution'
          : 'waiting_for_approval'
      : event.kind === 'receipt'
        ? event.receipt.status
        : gatewayDecisions.some((decision) => decision.decision !== 'allow')
          ? 'needs_attention'
          : 'completed';
    if (proposal) {
      conversation.pending = proposal;
    } else if (event.kind === 'receipt') {
      conversation.pending = null;
    }
    this.state.put(conversationKey, conversation);
    const response = {
      status: conversation.status,
      conversation_id: conversation.id,
      session_id: sessionId,
      resumed: !!(checkpoint?.session_id || runResult.resumed),
      proposal,
      agent_result: runResult.text || '',
      cost_usd: runResult.cost_usd || 0,
      tool_calls: runResult.tool_calls || [],
      gateway_decisions: gatewayDecisions,
    };
    if (
      conversation.deferred_emails?.length &&
      event.kind === 'receipt' &&
      !proposal
    ) {
      response.deferred_emails = conversation.deferred_emails;
      delete conversation.deferred_emails;
      this.state.put(conversationKey, conversation);
    }
    return this.remember(event, response);
  }

  prepareConversation(event, conversation, conversationKey) {
    if (event.kind === 'receipt') {
      if (
        !conversation.pending ||
        conversation.pending.request_id !== event.receipt.client_request_id
      ) {
        return this.remember(event, {
          status: 'ignored',
          reason: 'receipt_not_for_current_request',
          conversation_id: conversation.id,
        });
      }
      if (event.receipt.status === 'pending') {
        return this.remember(event, {
          status: 'waiting_for_approval',
          session_id: conversation.session_id,
          conversation_id: conversation.id,
        });
      }
      if (
        (event.receipt.protocol === 'question.receipt/1') !==
        (conversation.pending.type === 'teammate.question')
      )
        throw new Error('receipt_kind_mismatch');
      if (
        ![
          'answered',
          'changes_requested',
          'executed',
          'denied',
          'revoked',
          'blocked',
          'expired',
          'execution_unknown',
          'execution_failed',
        ].includes(event.receipt.status)
      ) {
        return this.remember(event, {
          status: 'ignored',
          reason: 'nonterminal_receipt',
          conversation_id: conversation.id,
        });
      }
      if (
        event.receipt.status === 'changes_requested' &&
        conversation.last_revision_event_id !== event.id
      ) {
        // Count the human's revision once, even if the SDK turn fails and this
        // receipt is retried after a process restart.
        conversation.revision++;
        conversation.last_revision_event_id = event.id;
        this.state.put(conversationKey, conversation);
      }
    } else if (conversation.pending) {
      // Keep new customer context, but never create an overlapping permission.
      conversation.deferred_emails = conversation.deferred_emails || [];
      if (conversation.deferred_emails.length >= 5) {
        throw new Error('pending_queue_full');
      }
      conversation.deferred_emails.push(event.email);
      this.state.put(conversationKey, conversation);
      return this.remember(event, {
        status: conversation.status,
        reason: 'new_email_saved',
        session_id: conversation.session_id,
        conversation_id: conversation.id,
      });
    } else {
      conversation.revision = 0;
      delete conversation.last_revision_event_id;
      conversation.latest_email = event.email;
    }
    return null;
  }

  consumeRunBudget(conversation, conversationKey) {
    if (conversation.runs >= 20 || conversation.revision > 3) {
      throw new Error('conversation_run_limit');
    }
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const budgetKey = 'budget/' + day;
    const budget = this.state.get(budgetKey) || { runs: 0 };
    if (budget.runs >= 40) {
      throw new Error('daily_run_limit');
    }
    budget.runs++;
    this.state.put(budgetKey, budget);
    conversation.runs++;
    this.state.put(conversationKey, conversation);
  }

  remember(event, result) {
    if (this.traces)
      result = {
        ...result,
        trace_id: this.state.get('trace-event/' + event.id),
      };
    this.state.put('event/' + event.id, { status: 'complete', result });
    return result;
  }
}
