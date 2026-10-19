# Run your own Fluffy instance

This path uses your resources and keys. Setup writes local templates only; it does
not provision accounts, domains, Functions, routes, sandboxes, or public endpoints.
Existing deployments are never discovered or adopted automatically. The sample
prescription workflow is still a demo, not a general inbox/alias product.

## Provider boundaries

| Component                                             | Supported implementation                                         | Configuration / ownership                                                       |
| ----------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Email ingress, sending, approvals, Memories and Wakes | Primitive native Functions and API                               | Your Primitive account, domain, two Function IDs, four routes and DKIM identity |
| Agent model and session runtime                       | Anthropic Claude Agent SDK                                       | Your `ANTHROPIC_API_KEY`, `AGENT_MODEL` available to your account               |
| Policy classification                                 | Jev (`api.typesafe.ai`, `jev-latest`)                            | Your `TYPESAFE_API_KEY`, in agent runtime and approval Function                 |
| Agent hosting                                         | Node 24 process; container recipe below; existing Blaxel updater | Your persistent disk and HTTPS reverse proxy, or your existing Blaxel sandbox   |
| State                                                 | SQLite plus local Claude session/workspace files                 | One process per state directory; back up the entire volume                      |

Changing a key or model name does not make OpenAI, another mail provider, or another
policy provider compatible. Those require adapters and tests. The gateway and
question/approval protocol are separate from the Claude adapter; future alias
routing can sit at the transport boundary without depending on Claude. No alias
implementation is included here. The separate Postgres experiment is not included
and would still require persistent Claude session storage.

## Local setup (no provider calls)

Use Node 24+ and `npm ci`. Choose a private directory outside the checkout whose
parent already exists:

```sh
npm run setup -- init /absolute/private/fluffy-instance
export FLUFFY_CONFIG_DIR=/absolute/private/fluffy-instance
```

Edit `approval.json` and `support-inbox.json` there. Replace all example addresses,
Function IDs, DKIM selector and agent URL with resources you own. Use distinct
Functions and four distinct routing addresses. Set the same customer access mode
in both files. The default support demo binds one customer and one order; that
customer must also be an allowed recipient. Keep allowlist mode initially.
`authenticated` deliberately admits any sender passing the existing authentication
checks; it is not an owner-only inbox.

```sh
npm run setup -- check "$FLUFFY_CONFIG_DIR"
```

This rejects placeholders and inconsistent settings and prints the runtime customer
and order settings. It does **not** verify account ownership, DKIM, routes, uptime,
keys or model access. Copy `runtime.env.example` to `runtime.env` in that private
directory (`chmod 600`). Copy the printed runtime settings into it. Set your own
Anthropic and Jev keys and a private bridge secret shared with the inbox Function.
Never commit or paste these values into a browser. Trace access stays disabled by
default; enabling it requires the separate owner authentication described in
[operations](operations.md). Keep the Primitive deployer key out of the runtime
unless explicitly enabling the trace provider.

## Host the agent yourself

For a plain Node host, set `AGENT_STATE_DIR` to a private persistent directory and
run `node --env-file=/absolute/private/fluffy-instance/runtime.env agents/support/server.mjs`.
Run as an unprivileged user. Model and policy calls occur when valid signed events
are processed and can incur charges.

For Docker Compose (the host must already have Docker and Compose):

```sh
export FLUFFY_RUNTIME_ENV=/absolute/private/fluffy-instance/runtime.env
docker compose build
docker compose up -d
curl --fail http://127.0.0.1:8000/health
```

The container runs as `node`, binds only host loopback, and stores SQLite, Claude
sessions and workspace files in the `agent-state` named volume. Compose overrides
the template's state path with `/state`. Do not scale replicas sharing this volume
or run `docker compose down -v` unless intentionally deleting all state. Back up
the volume with the agent stopped. The build context allowlists source files;
private deployment files and env files are excluded.

Provide your own HTTPS reverse proxy to port 8000, forwarding signed `/events`
requests unchanged. Allow at least 200 seconds for requests and graceful shutdown.
Set `agent_url` to that HTTPS origin. A healthy process or `model_ready: true`
means neither provider connectivity nor successful email delivery has been tested.
No TLS, public DNS, hosting account or paid resource is created by this repository.

For Blaxel instead, authenticate to your own workspace and create your own existing
sandbox with the prerequisites in [operations](operations.md). Set `sandbox` in
your private inbox config and use `deploy:agent`. The updater does not create a
sandbox. The `sandbox` field is unused by Docker/Node hosting.

## Wire your Primitive resources

Follow the provisioning and routing steps in [operations](operations.md). In your
own account configure the two Functions and their provider-injected credentials.
Configure `TYPESAFE_API_KEY` on the approval Function separately: deployment
preserves existing provider secrets and does not copy this key automatically.
The bridge secret on the inbox Function must match the runtime.

With `FLUFFY_CONFIG_DIR` exported, the deploy scripts select these private JSON
files; omitting it preserves the legacy `deployment/` location. Load deployer
credentials through your private environment mechanism, never command arguments.
Dry runs build locally and perform no provider requests:

```sh
npm run deploy:approval -- --dry-run
npm run deploy:inbox -- --dry-run
# Only if using Blaxel:
npm run deploy:agent -- --dry-run
```

After you have reviewed your resource IDs and intentionally authorized changes to
your own account, run the corresponding commands without `--dry-run` (approval,
agent hosting, then inbox). These update the configured resources. They do not
verify that an ID belongs to the intended account: you must verify ownership before
running them. Do not reuse anyone else's deployment JSON or secrets.

Run `npm run verify` for local fake-provider tests, format checking and bundles.
An end-to-end live check is a separate, intentional email/model action with your
own keys and addresses; no setup command sends a test email. The trace viewer is
also separate: deploying this agent does not connect an existing sample-data site.
