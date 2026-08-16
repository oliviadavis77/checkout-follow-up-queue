import assert from "node:assert/strict";
import test from "node:test";
import { isDue, planFollowUp } from "../src/follow_up_policy.js";

test("a checkout follow-up becomes due after its requested hours", () => {
  const acceptedAt = new Date("2026-08-15T08:00:00.000Z");
  const followUp = planFollowUp({
    orderId: "order_1042",
    customerEmail: "shopper@example.com",
    fulfillment: "ship",
    receiptNumber: "R-1042",
    delayHours: 6
  }, acceptedAt);

  assert.equal(followUp.dueAt, "2026-08-15T14:00:00.000Z");
  assert.equal(isDue(followUp, new Date("2026-08-15T13:59:59.999Z")), false);
  assert.equal(isDue(followUp, new Date("2026-08-15T14:00:00.000Z")), true);
});
