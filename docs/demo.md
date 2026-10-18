# Live demo

**Human help and approval for AI agents.**

[Watch the 2-minute Fluffy recording](https://youtu.be/THKHfZs5Poc) or follow this walkthrough with your own configured inboxes. The Fluffy cut opens with the support problem that motivated the project; the [system overview](system-overview.png) is available for a live presentation.

## Roles

| Role                | Demo inbox                | Responsibility                                                       |
| ------------------- | ------------------------- | -------------------------------------------------------------------- |
| Customer            | Outlook, purple label     | Sends documents, asks for help, receives the result                  |
| Support agent       | Its own Primitive address | Owns the case and asks for missing information or authority          |
| Teammate / approver | Gmail, green label        | Answers a focused question, then separately approves an exact action |

In the recording, Jerry plays both human roles, using his own two accounts. The documents consistently name Jerry Chang and are fictional. The agent and email handoffs run live. For another performance, use the identities in your own deployment configuration.

## Walkthrough

1. Start a **new customer thread** to your configured support address. Subject: `Order 1042: prescription review`. Attach [`tests/fixtures/prescription.png`](../tests/fixtures/prescription.png). Send: “Hi, I've attached my prescription for order 1042. What else do you need to finish the intake?”
2. In Primitive's native inbox Function logs, show the incoming email, agent session and tool decisions. The agent notices missing pupillary distance (PD) and sends a fillable PDF.
3. In the customer's inbox, open that actual attachment. Complete its fields with order `1042`, name `Jerry Chang`, PD `31 / 31`, and the date. A completed fictional form may be prepared in advance to keep the demonstration short.
4. Reply in the **same thread** with the saved PDF: “Hi, the completed form is attached with my PD. Could someone confirm whether the date on my prescription is acceptable?”
5. In the teammate inbox, open the question and review attachments. Reply: “The date is acceptable for administrative intake. The name matches the prescription, and the supplied PD is in an acceptable split format. You can finish collecting the intake details. Clinical review is still required before fulfillment.” This is fictional administrative guidance for the demo.
6. Show the resumed agent and Jev's `review` decision for `complete_intake`. Open the separate approval email: the teammate's answer supplied information, but did not authorize completion.
7. Review the exact proposed customer message. Approve through **Approve email → Send**, or reply `APPROVE <reference>` in that original thread. The inbox is the approval interface.
8. Show native Primitive execution and the resumed agent session. Open the final customer response; the internal review files were not forwarded.

Close with: “Instead of taking over entire tickets, teammates provide the specific answers and approvals the agent needs. Less manual follow-up, less work for the human support team, and more tickets the AI agent can resolve from start to finish.”

## Recording notes

The 1:59.8 Fluffy video is an edited live journey, not an uninterrupted take. It adds the Partiful support motivation, explains the trusted gateway and external Jev decision API, and closes on reducing full-ticket handoffs. It reuses the verified recorded emails from earlier cuts. Actual clicks play at recorded speed. Waiting and navigation are removed; a genuine pre-Send frame is held for two seconds for readability. Unrelated inbox lists and browser controls are cropped out.

During the recorded rehearsal, a wrapped Gmail quote attribution exposed a reply-parser bug. After fixing and deploying the parser, we replayed the same stored human-approved email through Primitive's documented replay endpoint. The exact action then executed and delivered. This run did not succeed on its first delivery; see [verification](verification.md).

Chris narration uses ElevenLabs for this noncommercial hackathon submission. Keep `elevenlabs.io` in the publication title; it is also present in the video's title metadata and footer.

Each live run needs a new conversation. The example backend supports order `1042`. With `customer_access: authenticated`, other testers can use their own email and get separate cases; restricted mode uses the configured customer. It does not clinically validate a prescription or fulfill an order.

## Version history

- [Fluffy: current 2-minute submission](https://youtu.be/THKHfZs5Poc): motivation, live email flow, Jev/sandbox overview, and impact.
- [V2: tighter 1:50 cut](https://youtu.be/3a4yvBBT6DM): previous presentation.
- [V1: original 1:58 cut](https://youtu.be/uBpWsKtDoRw): preserved as a fallback.

The package name and client label now use Fluffy. The recorded journey uses the previously deployed runtime; this branding revision makes no change to application behavior and does not claim a fresh hosted deployment.
