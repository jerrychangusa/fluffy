# Agent handoff: private traces against a real backend

This branch adds a default-off, read-only trace API and durable execution events.
It does not deploy anything or establish that the agent is currently online.
Read README.md and schema.json in this directory before connecting a viewer.

## What changed

- `GET /api/traces/{opaqueTraceId}` authorizes each trace against its stored owner
  subject or verified matching sender. An opaque ID alone grants no access.
- The response is the closed, metadata-only `fluffy.trace/1` contract. No prompts,
  transcripts, raw Memories, arguments/results, reasoning, addresses, approval
  codes, wake tokens or credentials are projected.
- Signed event handling records durable event receipt, actual harness start,
  session observation, action request, gateway decision and tool start/success/
  failure events in the existing agent SQLite store. Gateway allow is not tool
  completion; handler success is not email delivery.
- Optional Primitive GET overlays read inbound email, inbox checkpoint, request
  binding, approval/question record, and sent-email status. GET never reconciles,
  sends, wakes, runs a model or writes local/provider state.
- Historical traces retain unknown timestamps and incomplete coverage. Local
  history caps at 200 events, historical decisions at 24, approval lifecycle at 40.
  A trace covers one inbound event and its associated permission, not an entire
  conversation. Questions route to `questions`, never executable approval.

## Secure setup by the operator

1. Review and deploy only in an explicitly authorized environment. Preserve the
   persistent `AGENT_STATE_DIR`; populate `SOURCE_REVISION` with the deployed Git
   SHA. Existing agent configuration remains required, including
   `AGENT_BRIDGE_SECRET`, and existing model/policy settings for actual runs.
2. Leave `TRACE_ENABLED` unset/false initially. To enable the reader, supply
   `TRACE_ENABLED=true`, `TRACE_OWNER_SUBJECT`, and `TRACE_OWNER_TOKEN`. Use an
   existing appropriate private server credential through the runtime secret
   manager; never paste values in issues, commits, logs, browser bundles or PRs.
   Do not reuse the agent bridge signing secret as a browser-facing credential.
   If no appropriate credential/identity adapter exists, stop for secure setup.
3. Provider overlays are separately disabled unless `TRACE_PROVIDER_ENABLED=true`
   and existing `PRIMITIVE_API_KEY` is available. Existing
   `PRIMITIVE_API_BASE_URL` and optional `PRIMITIVE_FUNCTION_ID` are honored.
   No new credential or grant is provisioned by this branch.
4. The built-in owner adapter validates the server bearer credential and returns
   the configured subject. The native viewer worker must authenticate its own
   user first, verify the exact authorized owner, then proxy server-side. Never
   proxy all logged-in users as that owner. Multi-user deployments must inject a
   trusted authenticator preserving subject or verified sender identity.
5. Strip caller Authorization and identity headers at the proxy boundary. Do not
   trust x-user-id, x-user-email, or an emailVerified claim supplied by the browser.
   Keep upstream URLs and credentials server-side. Every trace is separately
   authorized; do not infer permission from access to another trace or the site.

## Same-origin viewer connection

The existing private viewer is at
`https://fluffy-inbox.lucas-lin.chatgpt.site/trace/live/?trace=<opaque-trace-id>`.
It is owner-private: Jerry may not have access, and this PR changes no sharing.
The backend can be integrated/tested using schema.json and example.json without
opening the site or depending on its private source files.

The separate frontend build currently sets `liveTraceEnabled=false` in
`dist/trace-config.js`. Keep it false until authentication and the same-origin
route have been verified. A worker must provide `GET /api/traces/:id`; the static
site alone cannot provide the private backend identity bridge. Request frontend
assets from Lucas/the parent agent if implementation needs them; do not assume
these files are in this repository.

The browser uses same-origin credentials, no-store reads, redirect:error, no
arbitrary backend URL, and textContent rendering. It currently does not poll.
The API supports repeated reads; adding polling/backoff is a separate frontend
choice. Preserve no-store on proxy responses and do not enable broad CORS. Backend
unknown/unauthorized traces are indistinguishable 404s. A generic frontend
unauthenticated 401/403 state is acceptable if it does not disclose existence.
Never return a synthetic fixture as a fallback for an unavailable live trace.

## Correlate actual events without replaying them

The actual inbox is `support@pink-marsh.primitive.email`. For a newly processed
customer event, the signed agent response contains trace_id; alternatively resolve
`trace-event/{eventId}` in private SQLite. Use the actual Primitive email ID and
existing inbox checkpoint, not a guessed thread or approval ID. Do not log message
content or copy production state into the PR. The read adapter follows
`inbox/event/{emailId}` → permission_id → `inbox/request/{permissionId}` and checks
the customer binding before reading the protocol-selected record. Delivery uses
`approval.execution.provider_id` with GET `/v1/sent-emails/{id}`.

For an old event, a trusted offline operator can call
`traces.begin(validatedOriginalEvent, {historical:true})` against private state.
Validate that event/sender/owner binding against the actual stored inbox event
first. This registration writes only the trace index; it must not call
AgentService.handle or replay a live event. There is no browser import endpoint.
Do not fabricate missing events or timestamps. Cold-start observed_at may be null;
that is reported as partial timing, not a 404 or invented clock value.

## Test matrix for Jerry or his coding agent

These are instructions for an authorized operator, not claims of live execution.
Use existing test identities and a controlled case. The original implementation
passed 123 synthetic tests; reviewed fixes passed 129 tests before rebasing. The
PR validation passed 135 tests on current main (85e609d), plus formatting and build. No live email, paid model
call, production send or live provider query was performed for this work.

| Step | Operator action                                                                                     | Required evidence / expected result                                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Run `npm ci` then `npm run verify` on the exact PR head                                             | Tests, formatting, build pass; record SHA and counts                                                                                    |
| 2    | Start the authorized backend with traces disabled                                                   | Trace GET returns generic 404; ordinary health/event behavior unchanged                                                                 |
| 3    | Enable reader with existing private credential; keep provider overlay off                           | Authorized existing trace returns schema-valid JSON, live_connected=false, delivery unknown                                             |
| 4    | Test missing/wrong bearer, forged identity headers, unknown ID and another owner's trace            | Identical backend 404 body; no provider calls, no trace data or existence leak                                                          |
| 5    | Test trusted verified sender and a different sender through the identity adapter                    | Only the matching stored sender or owner obtains that run; unverified email denied                                                      |
| 6    | Compare SQLite rows and provider audit before/after repeated GETs                                   | No writes, model starts, sends, wake or reconcile; only allowlisted provider GETs                                                       |
| 7    | Enable overlay using existing Primitive access; read a known historical event                       | Real received_at if available; correct protocol namespace; sanitized lifecycle; null unknown dates; truncation warnings                 |
| 8    | Read a known question request                                                                       | Questions namespace used, no approval execution/delivery claimed                                                                        |
| 9    | Restart agent and GET before any signed event                                                       | Existing authorized trace still readable; null observed_at and partial timing if clock unavailable                                      |
| 10   | Only with separate live-send/model-cost authorization, send a controlled email to the actual inbox  | Correlate actual email ID to signed response/private trace index; received/start/session/decision events from that run                  |
| 11   | Exercise an allowed read, a blocked/reviewed action, and a safe failure in a controlled environment | Allow is only a decision; actual execution yields start and success/failure; review does not claim execution                            |
| 12   | Only if separately authorized, complete normal human approval and observe real outbound delivery    | Approval and tool success do not imply delivery; only provider delivered sets delivery.state=delivered; failure/unknown remain explicit |
| 13   | Connect same-origin worker; test owner/nonowner sessions, redirect rejection and no-store           | Browser receives only DTO, never backend credential or raw provider content; no existence leak                                          |
| 14   | Enable frontend flag after steps above; open `/trace/live/?trace=<id>`                              | Real metadata rendered with escaped text and partial-history indicators; sample remains clearly separate                                |
| 15   | Disable TRACE_ENABLED and frontend flag to roll back reader                                         | Generic unavailable state; no new reads/exposure, persisted evidence retained                                                           |

Record only SHA, test IDs, HTTP statuses, allowlisted event types, completeness
flags and sanitized provider state as evidence. Keep credentials, full addresses,
message bodies and raw logs out of issue/PR comments. Live blockers are the backend
URL, appropriate existing credentials, verified worker identity, historical binding,
and any separate authorization needed for email sends or paid agent execution.

## Suggested coding-agent task

> On this reviewed branch, integrate the private trace reader with our existing
> backend and owner identity using the secure setup and matrix above. Preserve
> default-off flags until authorization tests pass. Implement the same-origin
> worker only after obtaining its actual frontend source and identity APIs; do not
> trust browser headers or expose credentials. Resolve a real trace from private
> event state without replaying it. Run synthetic and authorized read-only live
> checks, report exact SHA and sanitized evidence, and stop before any live send,
> paid model execution, deployment or sharing change that lacks separate approval.
