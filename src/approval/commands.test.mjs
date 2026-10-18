import test from 'node:test';
import assert from 'node:assert/strict';
import { parseApprovalCommand } from './commands.mjs';

const id = '0123456789ABCDEF';
const quote =
  'On Sun, Oct 18, 2026 at 7:44 AM <approvals@example.com>\nwrote:\n\n> Original approval request';

test('a direct Gmail approval ignores its wrapped quoted attribution', () => {
  assert.deepEqual(parseApprovalCommand(`APPROVE ${id}\n\n${quote}`), {
    decision: 'APPROVE',
    id,
    code: undefined,
    note: '',
  });
});

test('quoted approval commands cannot grant permission', () => {
  assert.equal(parseApprovalCommand(`${quote}\n> APPROVE ${id}`), null);
  assert.equal(parseApprovalCommand(`> APPROVE ${id}`), null);
});

test('extra approval instructions remain invalid before a quoted message', () => {
  assert.equal(
    parseApprovalCommand(`APPROVE ${id}\nDo not send this.\n\n${quote}`),
    null,
  );
});

test('change feedback starting with On is preserved', () => {
  assert.equal(
    parseApprovalCommand(
      `CHANGE ${id}\nOn Tuesday, use the new wording.\n\n${quote}`,
    ).note,
    'On Tuesday, use the new wording.',
  );
});
