// Intentionally wrong: sum() subtracts. The task is to make verify.mjs pass.
// The agent under test rewrites this file (or fails to).
export function sum(a, b) {
  return a - b;
}
