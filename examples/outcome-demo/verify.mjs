// The verification oracle. Exit 0 means the task is actually delivered.
import { sum } from "./broken.mjs";
import assert from "node:assert";

assert.strictEqual(sum(2, 3), 5, `sum(2,3) should be 5, got ${sum(2, 3)}`);
assert.strictEqual(sum(10, 5), 15, `sum(10,5) should be 15, got ${sum(10, 5)}`);
console.log("verify: PASSED (sum is correct)");
