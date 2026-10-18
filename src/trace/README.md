# Private trace reader (fluffy.trace/1)

`GET /api/traces/{opaqueTraceId}` is pollable and read-only. It returns 404
`{"error":"not_found"}` for disabled, missing, unauthorized or malformed traces.
All trace responses use `Cache-Control: no-store`. There is no public listing,
CORS grant, reconciliation, send, wake, or model call on this path.

The feature defaults off. Deployment may opt into `TRACE_ENABLED=true` with
`TRACE_OWNER_SUBJECT` and `TRACE_OWNER_TOKEN` sourced from an existing private
server credential. Never put that token in browser JavaScript. The viewer's
native worker must verify its own owner session before proxying this request.
An alternative deployment can inject `authenticate(request)` returning a trusted
`{subject}` or `{email, emailVerified:true}`. Never trust client-provided identity
headers. Each trace checks its stored owner or exact verified sender independently;
knowledge of a trace ID is not authorization. Owner changes do not reassign old
records. This work provisions no credentials and enables no deployment.

Optional `TRACE_PROVIDER_ENABLED=true` uses the existing `PRIMITIVE_API_KEY` and
Primitive client URL configuration. Provider reads occur only after authorization.
Set `SOURCE_REVISION` to the deployed 40-character Git SHA. Missing configuration
returns null revision and disconnected provider completeness, not uptime claims.

## Viewer contract

Success contains `protocol: "fluffy.trace/1"`, `trace_id`, `status`, `observed_at`,
`source_revision`, `email: {received_at}`, `events`, nullable `approval`, `delivery`,
and `completeness`. Events have `id`, `sequence`, nullable `at`, `type`, `title`,
`status`, nullable `tool`, `decision`, `reason_code`, and `provenance`. Display in
sequence order; do not sort unknown dates into invented timing. This is an
inbound-event trace, not a merged conversation timeline. Approval history is appended
as a separately sourced observation; sequence is display order, not a global clock.
`gateway_decision/allow` means permission, never tool completion. `tool_succeeded`
means the local handler finished successfully; it does not mean email delivered.
Only provider `delivered` establishes delivery. Missing delivery is `unknown`.
Overall `status` is the agent checkpoint status, separate from provider delivery.
`live_connected` means this authorized read obtained a provider snapshot, not uptime.

`approval` contains only status/created_at/expires_at/decided_at (the last is null
until unambiguous decision timestamps are supported). Delivery contains
state/provider_status/observed_at. Completeness includes live_connected,
tool_completion_events_available, history_truncated, timestamps_partial.
No raw Memories, prompts, arguments, results, codes, session IDs, approval IDs,
email addresses, attachment metadata, reasoning, or wake tokens enter the DTO.

New signed event responses include `trace_id`; the private state mapping
`trace-event/{eventId}` also resolves it. A trusted offline operator can register
an existing event with `traces.begin(validatedOriginalEvent, {historical:true})` without running the
agent. Historical checkpoints have null decision timestamps and mark completion
instrumentation unavailable. Never replay a live event just to obtain a trace.
No endpoint accepts arbitrary email IDs or imports historical records.

The adapter follows current source contracts: `inbox/event/{emailId}` includes
permission_id; `inbox/request/{permissionId}` includes customer_email and
receipt_protocol; `permission.receipt/1` routes to `approval`, and
`question.receipt/1` to `questions`. Memories GET returns `{value,...}`.
Approval delivery uses nested `execution.provider_id` (not a top-level field).
The read adapter calls `/emails/{id}`, `/memories?key=...`, and
`/sent-emails/{id}` only; it never calls mutating `reconcile`. Missing or failing
provider records conservatively leave local evidence available and delivery unknown.
Historical approval lifecycle is capped at 40 by the existing writer; 40 records
is conservatively marked potentially truncated. Local trace history caps at 200.

## Review and integration limitations

No live Blaxel URL, existing viewer identity bridge, Primitive credential, or
historical inbox data was available. The actual inbox is
support@pink-marsh.primitive.email. No live sends, paid model calls, deployment,
sharing changes or new grants were performed. A credentialed operator must bind
the private viewer worker to this endpoint and resolve/register the intended
historical trace before the viewer can show it. The API currently presents one
permission associated with an inbound email, not all subsequent conversation runs.

## Connecting the published viewer

The sample viewer at `https://fluffy-inbox.lucas-lin.chatgpt.site/trace/` and
adapter-ready `/trace/live/` remain disconnected until a native worker/reverse
proxy supplies the same-origin API. Keep the existing private site access policy.

1. Deploy this reviewed branch to the existing agent runtime only after deployment
   authorization; retain persistent `AGENT_STATE_DIR`. Configure the opt-ins above
   using existing credentials. Do not expose the agent's event signing secret.
2. Add a same-origin GET route `/api/traces/:id` in the native worker. Verify the
   site's authenticated owner identity server-side on every request. If that
   verification is unavailable, return the same 404 and do not proxy. The static
   site's private sharing setting alone does not implement API object authorization.
3. For this single-owner deployment, proxy only after verifying the exact owner,
   attach the existing private owner bearer token on the server, strip caller
   Authorization/identity headers, and forward to the configured private agent URL.
   For multiple users, replace the fixed-owner adapter with a verified session
   adapter that preserves subject or verified sender identity; never proxy every
   signed-in user as the owner. Keep credentials and agent URL out of browser bundles.
4. Resolve the intended opaque ID in trusted server state. Supply it to the
   authorized viewer through its existing input/navigation flow. No browser
   request should carry a Primitive email ID, approval code, or provider credential.
5. Forward only the allowlisted DTO and status, preserve `no-store`, keep CORS
   disabled, and poll with modest backoff. Stop or show unavailable on 404; preserve
   null timestamps and completeness warnings. Source revision identifies code, not
   the freshness of a historical email. No deployment health inference is valid.

No worker implementation is included here because the native site's identity and
routing APIs live in the separate frontend task. Do not deploy a placeholder that
trusts a request header for identity. `src/trace/example.json` is a synthetic exact
response shape for frontend contract checks; it contains no real inbox data.
