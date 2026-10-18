import { verifySignature } from './signature.mjs';
import { createPrimitiveClient } from './client.mjs';
import { Rejected, Retry } from '../../shared/errors.mjs';
import { requireThat } from '../../shared/validation.mjs';

// Both Primitive entrypoints share this transport boundary. Business handlers
// receive the provider's email record only after signature and event validation.
export function emailFunction(name, handleEmail) {
  return {
    async fetch(request, env) {
      const rawBody = await request.text();
      if (
        !(await verifySignature(
          rawBody,
          request.headers.get('Primitive-Signature'),
          env.PRIMITIVE_WEBHOOK_SECRET,
        ))
      ) {
        return new Response('Invalid signature', { status: 401 });
      }
      if (request.headers.get('X-Webhook-Event') !== 'email.received') {
        return Response.json({ ok: true, ignored: true });
      }

      try {
        let event;
        try {
          event = JSON.parse(rawBody);
        } catch {
          throw new Rejected('invalid_event_json');
        }
        const emailId = event?.email?.id;
        requireThat(/^[a-f0-9-]{36}$/i.test(emailId || ''), 'invalid_email_id');

        const primitive = createPrimitiveClient(env);
        const email = await primitive.api('/emails/' + emailId);
        const result = await handleEmail(email, env, primitive);
        const { gateway_decisions: decisions = [], ...summary } = result;
        console.log(
          JSON.stringify({
            kind: name + '_handled',
            email_id: emailId,
            ...summary,
          }),
        );
        // One tool decision per row makes the native Primitive log useful
        // without copying tool arguments or protected results into telemetry.
        for (const { tool, decision, reason, assessment } of decisions) {
          console.log(
            JSON.stringify({
              kind: 'tool_decision',
              tool,
              decision,
              reason,
              assessment,
            }),
          );
        }
        return Response.json({ ok: true, ...result });
      } catch (error) {
        if (error instanceof Rejected) {
          console.log(
            JSON.stringify({ kind: name + '_rejected', reason: error.message }),
          );
          return Response.json({ ok: true, rejected: error.message });
        }
        const reason =
          error instanceof Retry ? error.message : 'provider_or_storage_error';
        console.log(JSON.stringify({ kind: name + '_retry', reason }));
        return Response.json({ ok: false, retry: true }, { status: 503 });
      }
    },
  };
}
