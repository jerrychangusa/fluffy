# Live demo

**Escalate the question, not the whole task.**

[Watch the 1:58 recording](https://youtu.be/uBpWsKtDoRw) or follow this walkthrough with your own configured inboxes. The [system overview](system-overview.png) takes about six seconds to explain.

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

Close with: “A teammate provides the missing answer or permission by email. The agent continues helping the customer, without handing over the case.”

## Recording notes

The 1:58 video is an edited live journey, not an uninterrupted take. It removes waiting and navigation, uses a prepared fictional form, and holds one genuine pre-Send frame briefly for readability. Actual clicks play at recorded speed. Native logs and the final reply were inspected again after execution. Unrelated inbox lists and browser controls are cropped out.

During the recorded rehearsal, a wrapped Gmail quote attribution exposed a reply-parser bug. After fixing and deploying the parser, we replayed the same stored human-approved email through Primitive's documented replay endpoint. The exact action then executed and delivered. This run did not succeed on its first delivery; see [verification](verification.md).

Chris narration uses ElevenLabs for this noncommercial hackathon submission. Keep `elevenlabs.io` in the publication title; it is also present in the video's title metadata and footer.

Each live run needs a new conversation. The example backend supports the configured customer and order `1042`; it does not clinically validate a prescription or fulfill an order.
