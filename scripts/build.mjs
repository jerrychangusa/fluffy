import { buildApprovalBundle, buildInboxBundle } from './lib/bundles.mjs';

const target = process.argv[2];
const builders = { approval: buildApprovalBundle, inbox: buildInboxBundle };
if (target && !builders[target]) throw new Error('Choose approval or inbox.');
await Promise.all(
  target
    ? [builders[target]()]
    : Object.values(builders).map((build) => build()),
);
