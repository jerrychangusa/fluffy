# Run your own Fluffy instance

The shortest supported path is **Node 24 on a persistent host, your own Primitive
email resources, an Anthropic key, and a Jev key**. First run the local demo without
credentials. Connect real email only after configuring and checking your own resources.

## What you are setting up

This is an eyewear support demo: a customer emails a prescription image, the agent
collects missing details with a PDF, asks an optician a question, and requests human
approval before completing administrative intake. Questions provide information;
approvals authorize one exact action. It does not clinically validate prescriptions,
look up production orders, or fulfill orders.

This is **not a SimpleLogin-style alias product**. Alias creation, forwarding rules,
account onboarding and a general-purpose personal inbox are not implemented. A
future alias/gatekeeper service could reuse the transport and approval boundary
without depending on Claude, but that requires additional implementation.

For the live workflow, both Primitive Functions are required:

| Component                                        | What it does                                                                                                                                                                                                            |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inbox Function (`src/functions/inbox.mjs`)       | Receives customer mail and internal receipts, authenticates incoming mail, checkpoints work in Memories, and forwards signed events to your agent.                                                                      |
| Internal Function (`src/functions/approval.mjs`) | Handles teammate questions and replies, exact-action permissions, and Wake-triggered execution. It executes the approved action and returns a receipt. Despite its filename, it handles questions as well as approvals. |
| Node agent (`agents/support/server.mjs`)         | Runs the Claude session and tool gateway, maintains case state, and resumes after answers or receipts.                                                                                                                  |

The four routing addresses below share these two Functions; they are not four
Functions. There is no separate approval web app. The offline demo uses test
adapters and needs neither hosted Function. Removing a Function from the live
workflow or replacing Primitive requires code changes, not a configuration toggle.

## 1. Clone and try the offline demo

Prerequisites: Git, Node.js **24**, npm, and a shell. `curl` is used for later smoke
checks. The commands below assume a Unix-like shell and run from the repository root.
This setup is currently on draft PR #2, so select its branch explicitly:

```sh
git clone --branch feat/own-instance-setup --single-branch https://github.com/jerrychangusa/fluffy.git
cd fluffy
node --version
npm ci
npm run demo
npm run verify
```

`demo` uses a deterministic model and in-memory mail transport. `verify` runs tests,
format checks and builds both Function bundles. Neither sends email nor makes paid
model calls in its default mode. Leave `REAL_MODELS` unset. Dependency installation
requires registry access. You can stop here to explore the workflow without accounts.

## 2. Gather your own live resources

For live operation you need access to Primitive, Anthropic and Jev/Typesafe, a host
with persistent disk, and an HTTPS origin reachable by Primitive. These services
may charge for use. This repository does not provision them.

In **your own Primitive account**, use its resource-management interface or current
provider provisioning documentation to obtain the following. This guide does not
assume a particular dashboard layout or invent account-creation API commands. If
your account cannot create these resources, resolve that with Primitive before
continuing; copying the examples cannot create them.

1. Provision an email domain and record its actual DKIM signing domain and selector.
2. Create two separate native Functions: an inbox Function and an internal
   question/approval Function. Record each Function's ID from its resource details.
3. Obtain a Primitive API credential authorized to update those Functions and their
   secrets and read your routes. Keep provider-injected Function credentials,
   Function identity and webhook secret intact.
4. Choose four distinct addresses on your domain and configure these **enabled,
   exact-address** routes. Verify their destination Function IDs, not just names.

| Config field in `approval.json` | Example address (replace the domain)    | Destination                                                            |
| ------------------------------- | --------------------------------------- | ---------------------------------------------------------------------- |
| `customer_sender`               | `support@your-domain.primitive.email`   | Inbox Function                                                         |
| `requester_address`             | `requester@your-domain.primitive.email` | Inbox Function; receives internal receipts and sends internal requests |
| `approval_address`              | `approvals@your-domain.primitive.email` | Internal Function; questions and permission requests/replies           |
| `execution_address`             | `executor@your-domain.primitive.email`  | Internal Function; Wake execution                                      |

Also obtain an Anthropic API key with access to your chosen Claude model and a
Jev/Typesafe API key. Choose a private bridge secret for the inbox-to-agent signed
requests using your own secret-management process. Do not reuse someone else's
keys, live deployment files, resource IDs or bridge secret.

## 3. Create your private configuration

Replace the path below once with an absolute private directory **outside the
checkout**. Its parent must already exist; the instance directory must not exist.
Keep this exported variable in every terminal used for configuration or deployment.

```sh
export FLUFFY_CONFIG_DIR=/absolute/private/fluffy-instance
npm run setup -- init "$FLUFFY_CONFIG_DIR"
```

This creates `approval.json`, `support-inbox.json` and `runtime.env.example` with
private permissions. It refuses to overwrite an existing directory and makes no
provider calls. Edit the JSON files in your editor:

| File                 | Required changes                                                                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `approval.json`      | Set the internal Function's `function_id`, the four addresses above, `signing_domain`, `signing_selector`, `approver`, `teammates.optician`, `approver_timezone`, and `allowed_recipients`.  |
| `support-inbox.json` | Set the inbox Function's different `function_id`, `agent_url` to your HTTPS origin (no extra path), `allowed_customers`, and `order_id`. Leave `agent_entry` at `agents/support/server.mjs`. |
| Both                 | Start with `customer_access: "allowlist"`. Use the same mode in both files. Any duplicated shared settings must agree.                                                                       |

For the initial demo, put **one customer address** in `allowed_customers` and include
that same address in `allowed_recipients`. The optician and approver can be the same
human mailbox. Use lowercase addresses. `order_id` is a demo reference, not an order
system integration. The `sandbox` and `state_namespace` fields are for the optional
Blaxel path and are unused by plain Node/Docker hosting.

```sh
npm run setup -- check "$FLUFFY_CONFIG_DIR"
cp "$FLUFFY_CONFIG_DIR/runtime.env.example" "$FLUFFY_CONFIG_DIR/runtime.env"
chmod 600 "$FLUFFY_CONFIG_DIR/runtime.env"
```

The check rejects placeholders, conflicting shared settings and inconsistent
customer configuration. It prints the runtime customer/order settings to copy into
your env file. It does **not** prove ownership, route destinations, DKIM, connectivity
or valid credentials. Do not repeat the `cp` command over an edited runtime file.

Edit `runtime.env` as follows; enter real secrets only in this private file:

| Variable                                                                | Value to supply                                                                                                                                         |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`                                                     | Your model credential.                                                                                                                                  |
| `TYPESAFE_API_KEY`                                                      | Your Jev credential. Also configure this separately in the internal Primitive Function's secrets; the Function deployer does not copy it automatically. |
| `AGENT_BRIDGE_SECRET`                                                   | Your shared secret; the inbox deployer needs this exact same value.                                                                                     |
| `AGENT_STATE_DIR`                                                       | Absolute private persistent directory for SQLite, Claude sessions/config and workspace.                                                                 |
| `SUPPORT_CUSTOMER_ACCESS`, `SUPPORT_CUSTOMER_EMAIL`, `SUPPORT_ORDER_ID` | The settings printed by `setup -- check`.                                                                                                               |
| `AGENT_MODEL`                                                           | A Claude model available to your account; the template uses `sonnet`.                                                                                   |
| `AGENT_PORT`                                                            | `8000` unless you also adjust your proxy and smoke-test URLs.                                                                                           |

Keep `TRACE_ENABLED=false` and `TRACE_PROVIDER_ENABLED=false` initially. Remove the
`PRIMITIVE_API_KEY` and `FLUFFY_CONFIG_DIR` entries from the **runtime** file; those
are deployer settings. Only enable a runtime Primitive key intentionally for the
optional trace provider. The Claude subprocess receives the model credential, not
the Primitive/Jev/bridge credentials.

Create a separate private `deploy.env` in the same directory using your editor.
Its fields for the Node path are `PRIMITIVE_API_KEY` and `AGENT_BRIDGE_SECRET`, with
your own values. Run `chmod 600 "$FLUFFY_CONFIG_DIR/deploy.env"`. Do not put secret
values into shell command arguments, source control, screenshots or a browser viewer.

## 4. Start the Node agent and smoke-test locally

On your chosen host, run as an unprivileged user. Create the state directory you
selected with mode 700, then start from the repository root:

```sh
node --env-file="$FLUFFY_CONFIG_DIR/runtime.env" agents/support/server.mjs
```

Leave that terminal running. In another terminal, these requests test only the
local process and rejected inputs; they do not submit a signed agent event:

```sh
curl --fail http://127.0.0.1:8000/health
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Content-Type: application/json' --data '{}' http://127.0.0.1:8000/events
curl -sS -o /dev/null -w '%{http_code}\n' \
  http://127.0.0.1:8000/api/traces/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

Expect health JSON with `ok: true`, then **401** for the unsigned event and **404**
for disabled traces. Readiness booleans only indicate configured keys, not valid
keys or provider availability. This smoke test also works with model/policy keys
left empty; that does not make real processing available. Stop with Ctrl-C.

The Node server listens on `0.0.0.0`, so restrict direct access to port 8000 with
your host's firewall/network configuration. For live service, run it under your
host's process manager with restart and graceful-stop support. Use one process per
state directory. Preserve the entire directory across restarts and back it up while
the agent is stopped; copying only SQLite loses Claude session/workspace data.

Put your own TLS reverse proxy in front of the agent. Forward `/events` unchanged,
including its body and signature header, and allow at least 200 seconds for requests
and shutdown. Set `agent_url` to this HTTPS origin. Keep trace access disabled unless
you have implemented its owner-authenticated proxy. DNS, certificates, a process
manager and firewall rules depend on your host and are not provisioned by Fluffy.

## 5. Check bundles, then intentionally connect live email

With `FLUFFY_CONFIG_DIR` still exported, run these local-only checks:

```sh
npm run setup -- check "$FLUFFY_CONFIG_DIR"
npm run deploy:approval -- --dry-run
npm run deploy:inbox -- --dry-run
```

Dry runs build bundles without loading deployer credentials or making provider
requests. Without `FLUFFY_CONFIG_DIR`, deployers use the legacy `deployment/`
directory; confirm your exported path before every real deployment.

**The next commands change your configured Primitive resources.** Run them only
when you intend to connect live email, have checked ownership of both Function IDs,
have configured the internal Function's Jev secret and all four routes, and have
the Node agent running behind the configured HTTPS origin. If updating an existing
instance, first save its Function sources/configuration and back up its state.

```sh
node --env-file="$FLUFFY_CONFIG_DIR/deploy.env" scripts/deploy-approval.mjs
node --env-file="$FLUFFY_CONFIG_DIR/deploy.env" scripts/deploy-inbox.mjs
```

These update existing Functions and selected secrets. They do not create accounts,
domains, Functions, routes or HTTPS endpoints. The inbox deployer checks for enabled
route patterns but does not establish ownership or verify every route destination;
verify those yourself. Do not run `deploy:agent` for plain Node hosting: that command
is specifically the Blaxel updater.

For an intentional live check, send a **new email thread** from your allowed customer
address to your configured support address, using fictional data and your configured
order ID. Follow the [email walkthrough](demo.md), substituting your own people and
order reference. This sends real mail and invokes model/policy providers. Answer the
question in its original thread; approve only the separate exact-action request.
A successful health check alone is not evidence of email delivery or completion.

## Customize the workflow

Mailbox identities, teammate/approver roles, timezone, allowlists and demo order ID
are configuration. After changing customer/order settings, rerun `setup -- check`,
update the matching runtime env settings, restart the agent and intentionally redeploy
the affected Functions. Editing JSON alone does not update a running instance.

`customer_access: "authenticated"` in both files and
`SUPPORT_CUSTOMER_ACCESS=authenticated` in the runtime accepts any sender passing
the existing email authentication checks, with separate cases per sender/thread.
It is broader than an owner-only inbox; use allowlist mode for your first setup.

A different business workflow requires changes to the support prompt, tools, policy
and trusted action validators, with tests; see [architecture and reuse](architecture.md).
Changing the prompt alone does not replace the approved-action implementation.
The bundled intake PDF is a demo asset; [operations](operations.md) describes editing it.

## Optional hosting paths

### Docker Compose

The recipe and its complete local import graph are checked. **A full container image
build/start remains unverified in this change** because registry access failed in the
validation environment. Use the Node path above if you need the locally verified path.
With Docker and Compose installed on your own host:

```sh
export FLUFFY_RUNTIME_ENV="$FLUFFY_CONFIG_DIR/runtime.env"
docker compose config --quiet
docker compose build
docker compose up -d
curl --fail http://127.0.0.1:8000/health
```

Compose runs as the unprivileged `node` user, binds host loopback, and overrides
`AGENT_STATE_DIR` with `/state` in the persistent `agent-state` volume. The build
context excludes private config/env files. Provide your own HTTPS proxy. Do not
scale replicas sharing the volume or run `docker compose down -v` unless intentionally
deleting state. Back up the whole volume with the agent stopped.

### Blaxel

Use your own authenticated workspace and an already-provisioned sandbox with Node
24, Python 3, npm, persistent filesystem, port 8000 and HTTPS preview URL. Set
`sandbox` and `agent_url` in your private inbox JSON. The updater expects the
`/blaxel` filesystem layout; it does not create the sandbox.

For this path, also put `ANTHROPIC_API_KEY`, `TYPESAFE_API_KEY` and `AGENT_MODEL` in
your private `deploy.env` so the updater can configure the remote runtime. Authenticate
the Blaxel SDK to the intended workspace through Blaxel's supported mechanism. Then:

```sh
node --env-file="$FLUFFY_CONFIG_DIR/deploy.env" scripts/deploy-agent.mjs --dry-run
```

The dry run packages locally and does not verify workspace access. For intentional
live deployment, run approval deployment first, this command **without `--dry-run`**
second, and inbox deployment last. The updater changes the configured sandbox and
records its process/release in your private inbox JSON. See [operations](operations.md)
for recovery and optional trace settings.

## Supported providers and remaining limits

| Boundary              | Implemented here                                                                 | Extension only                                            |
| --------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Email, Memories, Wake | Primitive native Functions/API                                                   | Other mail transports; SimpleLogin-style aliases          |
| Model/session runtime | Anthropic Claude Agent SDK; configurable Claude model                            | OpenAI or other runtime adapters                          |
| Policy classification | Jev at `api.typesafe.ai`, model `jev-latest`                                     | Other policy providers                                    |
| Hosting               | Plain Node; existing Blaxel updater; Docker recipe with verification limit above | Automatic provisioning of another host                    |
| State                 | SQLite plus persistent Claude session/workspace files                            | Separate Postgres experiment, not included in this branch |

Swapping keys does not implement an adapter or provision resources. The runtime is
not a stateless or distributed worker pool. The separate trace viewer still needs
an authenticated integration; starting this backend does not connect a sample-data
site. Optional traces require separate owner authentication; see the
[trace integration guide](../src/trace/INTEGRATION.md).

## Troubleshooting

| Symptom                                 | Check / next step                                                                                                                                          |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup init reports `EEXIST`             | Reuse and edit that instance, or choose a new directory. Init deliberately refuses overwrite.                                                              |
| Setup check rejects IDs/addresses       | Replace all examples, including the optician address; use distinct Function IDs and routing addresses. Keep shared settings consistent.                    |
| Wrong config directory / missing JSON   | Export the absolute `FLUFFY_CONFIG_DIR` in this terminal. Node env files and shell exports are separate; existing environment variables take precedence.   |
| Runtime fails on startup                | Confirm Node 24, bridge secret, writable private state directory, customer/order settings and free port. Re-run `npm ci` if dependencies are missing.      |
| Local health works, mail does not       | Check all four enabled routes and destination IDs, Function deployment/secrets, HTTPS reachability and matching bridge secret. Health does not test these. |
| Signed work fails / timestamps rejected | Preserve the request body/header through the proxy. The runtime needs trusted uncached time from Primitive and fails closed if unavailable.                |
| No model/policy progress                | Check account access, key placement, model availability and provider connectivity. Unavailable/uncertain Jev results cannot grant automatic execution.     |
| Question or approval reply does nothing | Use the configured teammate/reviewer and original thread. Questions expire after 24 hours; approvals after 30 minutes. Answers do not confer approval.     |
| Registry/container build fails          | Resolve registry access on your own host or use Node; no container-start claim is made here.                                                               |
| Customer send outcome is uncertain      | Inspect existing provider state before retrying. Do not send a replacement message blindly; see recovery in [operations](operations.md).                   |

Local tests and dry runs establish code/configuration behavior, not account ownership,
provider uptime, real delivery or production suitability. See [verification and limits](verification.md).
