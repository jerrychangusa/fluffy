# Architecture

Two Primitive Functions and one Blaxel agent runtime handle the complete workflow. “Approval Service” names the project; questions and approvals are separate reusable services within it.

| Request                | Reply                                                           | What resumes the agent                                                  |
| ---------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `question.request/1`   | A configured teammate answers in the original email thread      | `question.receipt/1` supplies information; it grants no authority       |
| `permission.request/1` | The authorized reviewer approves, declines, or requests changes | `permission.receipt/1` reports the outcome after any approved execution |

The agent stops its turn while a request is pending. A later email receipt starts another turn with the saved Claude session; no process waits on an open chat for the human.

```mermaid
sequenceDiagram
    participant C as Customer inbox
    participant I as Primitive inbox Function
    participant A as Support agent / Claude on Blaxel
    participant G as Tool gateway / Jev
    participant P as Primitive internal inbox Function
    participant H as Teammate inbox
    C->>I: Email + prescription attachment
    I->>A: Authenticated, signed customer event
    A->>G: Record intake / request missing information
    G->>P: Policy-eligible request for fixed form email
    P->>C: Fillable intake PDF
    C->>I: Reply + completed PDF
    I->>A: Resume same case
    A->>G: Ask a focused teammate question
    G->>P: question.request/1 + internal evidence
    P->>H: Question + review attachments
    H->>P: Authenticated reply in original thread
    P->>I: question.receipt/1
    I->>A: Resume with answer (no authority grant)
    A->>G: Complete intake
    G->>P: permission.request/1; exact message held
    P->>H: Review exact message + evidence
    H->>P: Approve / change / decline by email
    P->>P: Primitive Wake consumes exact permission
    P->>C: Approved customer email
    P->>I: permission.receipt/1
    I->>A: Record administrative completion
```

## Boundaries

- **Inbox bridge:** authenticates customer/receipt senders, preserves conversation ownership and threading, validates file references, checkpoints events and a stable outbox before sending internal requests.
- **Agent runtime:** serializes a conversation, deduplicates events, checkpoints one immutable proposal per event, resumes the Claude session on the matching receipt, and queues customer follow-ups during a pending request.
- **Tool gateway:** intercepts every registered tool. Trusted checks and independent Jev assessment run before the actual handler. Hard approval requirements cannot be weakened by the model or Jev. Missing/uncertain assessments block reads without a review adapter and route supported writes to review.
- **Questions:** a configured role maps to a trusted teammate mailbox. The reply must authenticate as that teammate and refer to the exact sent question. An answer is information only; it contains no executable permission. Uncertain or review-routed questions are blocked before forwarding their evidence. Expiry is enforced when a reply arrives.
- **Approvals:** the exact canonical customer action, case snapshot and evidence hashes are bound to a one-use permission. Sender authentication, reply thread or secret reply code, expiry, immutable hashes, compare-and-swap state, and send idempotency are enforced independently of the agent. Unknown execution outcomes require read-only reconciliation.
- **Support application:** knows orders, Rx, PD, form fields, messages and case completion. Its trusted executor adapter independently rebuilds fixed information/completion messages. Only the fixed missing-information request is eligible for automatic sending; completion and freeform replies require human approval.

## Teammate routing

Questions address a configured role, and `QuestionService` resolves that role to a trusted mailbox. The support application currently uses the `optician` role for information requests; the model does not supply an arbitrary recipient address. Approval requests separately target the configured `approver`. One person can fill both roles, as in the recorded demo. Other applications can supply more roles through the same trusted mapping.

## Files and state

Incoming files are verified against Primitive's size and SHA-256 metadata. Large files remain provider references in Memories and are hydrated only at execution boundaries. References must belong to the authenticated customer. A permission request may carry output attachments and review-only evidence; the latter is hash-bound and visible to the reviewer but never forwarded to the customer.

The PDF reader extracts only the named fields from our fillable intake form. It does not OCR arbitrary/scanned prescriptions. Values are saved verbatim with source email and form-field provenance; clinical interpretation remains a human task.

Primitive Memories hold inbox checkpoints, permission records, question records and delivery audit state. Blaxel SQLite holds agent sessions and support cases. Each customer thread has its own case; the configured order number is a local example backend, not a live order lookup. Administrative completion is saved after the verified execution receipt, so it can lag email delivery until that receipt is handled.

## Reuse

Register another application's tools behind `ToolGateway`, provide its policy and review adapter, and wire its trusted action validator at `src/functions/approval.mjs`. `src/agent`, `src/inbox`, `src/questions`, and `src/approval` have no imports from the support application. The Claude SDK integration is an adapter; the gateway itself has no dependency on Claude or Primitive.
