# Support agent

The application owns prescription-intake rules. Shared infrastructure owns transport, sessions, tool interception, questions and permissions.

- `server.mjs` wires Claude, Jev, state and the application together.
- `tools.mjs` defines the agent's capabilities and trusted gateway rules.
- `cases.mjs` stores customer-supplied information and provenance in isolated cases.
- `form.mjs` reads named fields from our returned fillable PDF.
- `messages.mjs` contains the fixed customer messages.
- `actions.mjs` independently validates/rebuilds those messages inside Primitive.
- `policy.mjs` and `prompt.mjs` express authorization rules and support behavior separately.

Only `request_information` is eligible for automatic customer email, after both gateway and executor checks. `complete_intake` and freeform `send_email` always require approval. `ask_teammate` requests information from the configured optician; the answer resumes the agent and cannot authorize execution.

The local backend uses one configured customer/order number and separate cases per thread. It records receipt of data and administrative completion, not clinical validation. Customer documents remain unverified until a human reviews them.
