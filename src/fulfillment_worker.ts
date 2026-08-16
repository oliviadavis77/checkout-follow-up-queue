import { followUpSchema, isDue, type FollowUp } from "./follow_up_policy.js";
import { infrai, type QueueMessage } from "./infrai_queue.js";

export function completeCustomerUpdate(followUp: FollowUp): void {
  console.log(JSON.stringify({
    orderId: followUp.orderId,
    receiptNumber: followUp.receiptNumber,
    fulfillment: followUp.fulfillment,
    customerEmail: followUp.customerEmail,
    status: "receipt-and-order-update-sent"
  }));
}

async function handle(message: QueueMessage, now: Date): Promise<void> {
  const parsed = followUpSchema.safeParse(message.payload);
  if (!parsed.success || !isDue(parsed.data, now)) return;
  completeCustomerUpdate(parsed.data);
  await infrai.queue.ack(message.message_id);
}

async function workOnce(): Promise<number> {
  const batch = await infrai.queue.consume(10, 60);
  const messages = batch.messages ?? [];
  await Promise.all(messages.map((message) => handle(message, new Date())));
  return messages.length;
}

const count = await workOnce();
console.log(`Checked ${count} checkout follow-up message(s)`);
