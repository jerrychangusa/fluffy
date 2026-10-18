# Verification and limits

The default tests run without credentials. Hosted behavior was separately checked against Primitive, Blaxel, Outlook and Gmail on **October 18, 2026**. This page summarizes those checks without publishing personal mailbox addresses, live resource settings, approval capabilities or raw rehearsal logs.

## Reproducible checks

```sh
npm ci
npm run demo
npm run verify
```

| Check                   | What it establishes                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Complete workflow test  | Customer image → fillable form → returned PDF → teammate answer → exact approval → final reply → saved completion                  |
| Gateway tests           | Trusted policy and Jev assessment precede handlers; pending approval stops further tool calls                                      |
| Approval tests          | Exact-action binding, authorized sender/thread, expiry, change/deny behavior, duplicate handling and uncertain-send reconciliation |
| Question tests          | A configured teammate can answer; the answer grants no executable permission                                                       |
| Session and inbox tests | Deduplication, serialized conversation state, matching receipts and session resumption                                             |
| Attachment tests        | File provenance, byte/hash checks and internal evidence excluded from customer messages                                            |
| Architecture test       | Shared infrastructure cannot import the support application outside composition roots                                              |
| Formatting and build    | Readable source and both generated Primitive Function bundles                                                                      |

The suite contains **115 passing tests**. Its default model and transport adapters are deterministic fixtures, not live Claude, Jev or SMTP. Tests exercise the actual application and infrastructure services. GitHub Actions runs the same `npm run verify` command on Node 24 without credentials. [Operations](operations.md) documents the optional real-model test, which still uses isolated mail transport.

## Hosted checks

During the recorded email walkthrough, we verified:

- The customer's image and returned fillable PDF were received through real email; the supplied PD and attachment bytes matched saved backend state.
- The agent emailed a teammate a focused question and both review files. The reply resumed the same Claude session without granting authority to complete intake.
- Jev assessed tool calls. The completion action required a separate human approval of the exact customer message.
- The delivered sender, recipient, subject and body matched the frozen approved action. Zero review attachments were forwarded to the customer.
- Four event checkpoints shared one Claude session. Backend completion was saved, the teammate answer was recorded, and no action remained pending.
- Replaying a completed event returned its saved checkpoint without new model work.
- Both deployed Function source hashes and all 24 packaged agent runtime files matched local runtime source. Four email routes were enabled, the agent process was healthy, and unsigned events were rejected.

A separate six-minute sandbox-idle check returned a signed duplicate's saved checkpoint in 544 ms. Altered, expired and future-dated signed requests returned 401. That check used the same runtime process and did not invoke the model or send email.

These are observations from the rehearsal, not a promise that the hosted demo will remain online indefinitely. Raw provider records and live deployment settings stay local and are excluded from Git.

## Fluffy video and rename

The [current 2-minute Fluffy cut](https://youtu.be/THKHfZs5Poc) reuses the verified recorded journey. It adds the user-provided motivation from building AI customer support, explains Jev's place beside the sandboxed Claude runtime, and closes on the intended benefit: fewer full-ticket handoffs and more work completed by the agent. The recording demonstrates the workflow; it does not measure production resolution rates or time savings.

The footage shows real emails and execution records with waiting/navigation removed and a brief held pre-Send frame. It does not represent a fresh hosted run. Earlier cuts remain available in [version history](demo.md#version-history).

Fluffy was previously named Agent Approval Service. The repository/package and client label were renamed; the recorded hosted run predates those labels. Application behavior is unchanged, and no new hosted deployment is claimed for this rename.

## Rehearsal issue and recovery

The video run exposed a Gmail quote-parser bug: Gmail wrapped `On … wrote:` over two lines, so an otherwise valid approval was initially ignored. We fixed the parser, added four regression tests, deployed the updated internal Function, and verified its source. The **same stored human-approved reply** was replayed using Primitive's email replay endpoint; the exact frozen action then executed and delivered. No replacement approval was fabricated. The recording is an edited walkthrough of this recovered run, not an uncut first-attempt success.

The parser accepts a complete attribution over up to four consecutive nonempty, unquoted lines. It still rejects commands that appear only inside quoted text and retains sender, original-thread, expiry and exact-action checks. See [`commands.mjs`](../src/approval/commands.mjs) and its [regression tests](../src/approval/commands.test.mjs).

## Deliberate scope

- The support backend serves one configured customer and order, with separate cases per email thread. It has no production customer/order API.
- The PDF reader extracts named fields from our own fillable form. It does not OCR arbitrary scanned PDFs. The model can view supported image attachments; that is not clinical validation.
- Administrative intake completion does not mean prescription approval, healthcare compliance, order acceptance or fulfillment.
- The runtime uses one process and local SQLite state. A distributed worker pool, automatic reminders and reassignment are not implemented.
- A failed model turn or unknown delivery outcome may need operator reconciliation. The code does not promise exactly-once effects across every external provider failure.
