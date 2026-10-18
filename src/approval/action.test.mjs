import test from 'node:test';
import assert from 'node:assert/strict';
import { actionHash } from './action.mjs';

const action = {
  from: 'agent@example.com',
  to: 'customer@example.com',
  subject: 'Review',
  body_text: 'Exact message',
  resource: {
    version: 'v1',
    id: 'case',
    kind: 'intake',
    label: 'Review intake',
    requires_approval: true,
  },
  attachments: [],
  evidence: [
    {
      sha256: 'a'.repeat(64),
      filename: 'evidence.pdf',
      content_type: 'application/pdf',
      size_bytes: 20,
      part_index: 0,
    },
  ],
};
const reordered = (value) =>
  Array.isArray(value)
    ? value.map(reordered)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => b.localeCompare(a))
            .map(([key, entry]) => [key, reordered(entry)]),
        )
      : value;

test('storage key reordering preserves the identity of the exact action and its evidence', async () => {
  assert.equal(await actionHash(action), await actionHash(reordered(action)));
  assert.notEqual(
    await actionHash(action),
    await actionHash({ ...action, body_text: 'Changed message' }),
  );
  assert.notEqual(
    await actionHash(action),
    await actionHash({
      ...action,
      evidence: [{ ...action.evidence[0], sha256: 'b'.repeat(64) }],
    }),
  );
});
