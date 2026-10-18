# Deployment and operations

For evaluation, start with `npm ci`, `npm run demo`, and `npm run verify`. Those commands need no accounts or credentials. This guide is for connecting real inboxes.

## Provision and configure

The deployment scripts **update existing resources**. They do not create accounts, a domain, Functions, routes, or a sandbox.

1. In Primitive, provision your email domain and two Functions: the customer inbox Function and the internal approval/question Function. Record their IDs and your domain's DKIM selector.
2. Provision a Blaxel sandbox with Node 24, Python 3, npm, a persistent filesystem, port 8000, and its HTTPS preview URL. Authenticate the Blaxel SDK for the workspace containing that sandbox.
3. Copy `deployment/approval.example.json` to `deployment/approval.json` and `deployment/support-inbox.example.json` to `deployment/support-inbox.json`. Replace the placeholder IDs, domain, customer, reviewer, sandbox and agent URL. The actual configuration files are ignored by Git. Keep the customer allowlist to one address for this example backend; `order_id` selects its single configured order.
4. Configure these four exact-address routes in Primitive:

| Address                                 | Destination                                          |
| --------------------------------------- | ---------------------------------------------------- |
| `support@your-domain.primitive.email`   | Inbox Function                                       |
| `requester@your-domain.primitive.email` | Inbox Function (internal receipts)                   |
| `approvals@your-domain.primitive.email` | Internal approval/question Function                  |
| `executor@your-domain.primitive.email`  | Internal approval/question Function (Wake execution) |

The `requester` identity sends internal requests as well as receiving receipts. The configured optician mailbox receives questions; the configured approver receives permission requests. Both may be the same teammate.

Keep credentials in private environment files outside the repo, using `.env.example` as a field reference. The Primitive deployment credential is only for the deployers. Primitive supplies its Functions with provider credentials, Function identity and webhook secret; preserve these. Configure `TYPESAFE_API_KEY` in the internal Function's secrets for Jev. The agent runtime needs `ANTHROPIC_API_KEY`, `TYPESAFE_API_KEY` and the shared `AGENT_BRIDGE_SECRET`. The inbox deployer needs that same bridge secret. Only the model key reaches the Claude subprocess.

## Build and deploy

Run from the repository root. Substitute your own private environment-file path:

```sh
npm run verify
node --env-file=/absolute/private/agent.env scripts/deploy-approval.mjs --dry-run
node --env-file=/absolute/private/agent.env scripts/deploy-inbox.mjs --dry-run
node --env-file=/absolute/private/agent.env scripts/deploy-agent.mjs --dry-run
```

Dry runs build the artifacts without changing remote resources. On a live installation, first save the existing Function sources, configuration, runtime process and SQLite state. Then deploy in this order:

```sh
node --env-file=/absolute/private/agent.env scripts/deploy-approval.mjs
node --env-file=/absolute/private/agent.env scripts/deploy-agent.mjs
node --env-file=/absolute/private/agent.env scripts/deploy-inbox.mjs
```

Agent deployment preserves the source tree in a new release directory, installs pinned dependencies in shared sandbox storage, writes a protected runtime environment file, starts the server, and records the process/release in the ignored local config. Previous source and state remain available for rollback. It expects the sandbox's `/blaxel` filesystem layout.

After deployment, refetch Function sources, compare the deployed runtime files, inspect `/health`, verify that unsigned `/events` requests are rejected, and check all four enabled routes. Then run a fresh customer email → teammate reply → approval walkthrough. Health checks and local tests alone do not establish email delivery.

To run the agent server locally instead, set `AGENT_STATE_DIR`, `AGENT_BRIDGE_SECRET`, `ANTHROPIC_API_KEY`, `TYPESAFE_API_KEY`, `SUPPORT_CUSTOMER_EMAIL` and `SUPPORT_ORDER_ID` in your private environment file, then:

```sh
node --env-file=/absolute/private/agent.env agents/support/server.mjs
```

This starts the agent endpoint; it does not configure inbound email or expose a public URL.

## Human decisions

Reply to a question in its original thread with a natural-language answer. That answer supplies information and cannot approve a different action.

An approval email displays the exact proposed customer message, output attachments, internal evidence, and expiry. Its buttons open a prefilled reply; press Send to confirm. Direct replies accept `APPROVE <reference>`, `DENY <reference>`, or `CHANGE <reference>` followed by instructions on the next line. Changed content needs a new request. A direct command must come from the authorized reviewer in the original approval thread.

## Recovery and state

- Duplicate events reuse stored results and stable send keys. New customer emails wait while a question or approval is pending, then are processed in order.
- Questions expire after 24 hours; approvals after 30 minutes. Late replies cannot grant authority. Reminders and reassignment are not implemented.
- An unavailable or uncertain Jev result cannot grant automatic execution. Inspect native Primitive records and tool decisions.
- Unknown customer-send outcomes require read-only reconciliation with the existing idempotency key before any retry. Do not send a replacement customer message to recover an uncertain send.
- A restart reuses SQLite case state and saved Claude sessions. The current runtime serializes each conversation within one process; it is not a distributed worker pool.

Before each authenticated event, the runtime refreshes trusted time from Primitive's uncached HTTPS `Date` header. Invalid signatures are rejected before that request, and the five-minute signature window still applies. Missing or cached time fails closed. This handles sandbox standby without keeping the sandbox awake.

## Optional model check and form editing

The full workflow test can use real Claude and Jev with isolated mail transport:

```sh
REAL_MODELS=1 node --env-file=/absolute/private/agent.env --test tests/intake-flow.test.mjs
```

This uses API credits and sends the fictional test input to those model providers, but sends no real email. Its local report goes to the ignored `evidence/` folder.

`assets/prescription-intake.pdf` is the customer form. `assets/intake-form.mjs` embeds the same bytes for the Primitive runtime. To redesign the form, install Python's `reportlab`, run `python3 scripts/create-intake-form.py`, then format, verify and rebuild. The generated asset is not handwritten application logic.

See [verification and limits](verification.md) before adapting this administrative example for other use cases.
