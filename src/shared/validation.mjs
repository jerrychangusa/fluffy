import { Rejected } from './errors.mjs';

export const requireThat = (test, reason) => {
  if (!test) {
    throw new Rejected(reason);
  }
};

export const isPlainObject = (x) =>
  x !== null && typeof x === 'object' && !Array.isArray(x);

// The transport carries bounded action metadata; an application's trusted
// executor validates the action-specific schema and policy independently.
export function actionMetadata(input) {
  if (input.type === undefined && input.parameters === undefined) return {};
  requireThat(
    typeof input.type === 'string' &&
      /^[a-z][a-z0-9_.]{1,63}$/.test(input.type) &&
      isPlainObject(input.parameters) &&
      JSON.stringify(input.parameters).length <= 2048,
    'invalid_action_metadata',
  );
  return {
    type: input.type,
    parameters: JSON.parse(JSON.stringify(input.parameters)),
  };
}
