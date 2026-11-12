import { test } from "node:test";
import assert from "node:assert/strict";
import { StartPlanSecretRedactor } from "../src/runtime/start-plan-secret-redactor.js";

test("redacts a complete secret inside nested response fields without suppressing surrounding text", () => {
  const secret = "synthetic-marker-only-63d92f";
  const redactor = new StartPlanSecretRedactor(); redactor.register(secret);
  assert.deepEqual(redactor.value({ message: `before ${secret} after`, items: [secret, "other"] }),
    { message: "before [REDACTED] after", items: ["[REDACTED]", "other"] });
  redactor.close();
});

test("many false prefix matches fail closed instead of unbounded hashing", () => {
  const redactor = new StartPlanSecretRedactor(); redactor.register("aaaaaaaaSecret");
  assert.equal(redactor.text("aaaaaaaaX".repeat(140)), "[REDACTED]");
  redactor.close();
});
