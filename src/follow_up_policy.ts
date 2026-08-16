import { z } from "zod";

export const checkoutSchema = z.object({
  orderId: z.string().min(1),
  customerEmail: z.string().email(),
  fulfillment: z.enum(["ship", "pickup"]),
  receiptNumber: z.string().min(1),
  delayHours: z.number().int().min(1).max(72)
});

export type Checkout = z.infer<typeof checkoutSchema>;

export const followUpSchema = checkoutSchema.omit({ delayHours: true }).extend({
  action: z.literal("send_order_follow_up"),
  dueAt: z.string().datetime()
});

export type FollowUp = z.infer<typeof followUpSchema>;

export function planFollowUp(checkout: Checkout, acceptedAt: Date): FollowUp {
  return {
    orderId: checkout.orderId,
    customerEmail: checkout.customerEmail,
    fulfillment: checkout.fulfillment,
    receiptNumber: checkout.receiptNumber,
    action: "send_order_follow_up",
    dueAt: new Date(acceptedAt.getTime() + checkout.delayHours * 3_600_000).toISOString()
  };
}

export function isDue(followUp: FollowUp, now: Date): boolean {
  return Date.parse(followUp.dueAt) <= now.getTime();
}
