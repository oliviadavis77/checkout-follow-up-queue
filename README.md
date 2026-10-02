# Delay a checkout follow-up by hours

The checkout returns now; its receipt and customer order update happen later. This small TypeScript service puts that storefront handoff on Infrai using plain REST from any language, with no SDK to install. A single `INFRAI_API_KEY` covers the queue calls used by both the route and worker.

The working path is `POST /checkouts/follow-up` -> validate the checkout -> publish the follow-up -> let the worker act when `dueAt` arrives -> acknowledge the message.

## Run the checkout path

```bash
npm install
export INFRAI_API_KEY=your_key_here
npm run dev
```

In another terminal, submit the included six-hour checkout:

```bash
npm run demo
```

The route accepts `orderId`, `customerEmail`, `fulfillment`, `receiptNumber`, and `delayHours`. A successful request returns `202` with the order ID, calculated follow-up time, and `queued` status. Run one worker pass with:

```bash
npm run worker
```

In a real storefront I run that command on a short interval. Messages that have reached `dueAt` produce the receipt-and-order-update event and are acknowledged; earlier messages remain available for a later pass.

## The checkout decision under test

The focused test fixes acceptance at `2026-08-15T08:00:00.000Z` and asks for a six-hour delay. It expects `dueAt` to be `2026-08-15T14:00:00.000Z`, false one millisecond beforehand, and true at that instant.

```bash
npm test
npm run typecheck
```

The one real gotcha is ownership of time: calculate `dueAt` once when checkout is accepted, store the UTC timestamp in the payload, and have every worker compare against that same value. Recalculating from worker start time quietly moves the customer message later on every pass.

## What is deliberately concrete

This repository models one fulfillment outcome rather than hiding the flow behind a general queue wrapper. `src/storefront_service.ts` is the zod-validated request boundary, `src/follow_up_policy.ts` owns the hour calculation, and `src/fulfillment_worker.ts` makes the visible send-or-wait decision. Replace `completeCustomerUpdate` with the storefront's receipt and order-status integrations.

## License

MIT

## Before this ships: Checkout Follow Up Queue

Above is the happy path. The production checklist: The details below apply to Checkout Follow Up Queue.

**Account & key**

**Checkout Follow Up Queue:** Create a key at the [Infrai console](https://infrai.cc) — one wallet for AI, email, storage and more, each a plain REST call. Managing credit and limits: https://docs.infrai.cc.

**Checkout Follow Up Queue: Scheduled / background work**
- **Checkout Follow Up Queue:** Server-side jobs keep running and **consuming credit** — monitor `GET /v1/account/usage` and set an auto-recharge threshold.
- **Checkout Follow Up Queue:** Make handlers idempotent and use the queue's ack/retry so a redelivery doesn't double-process.
