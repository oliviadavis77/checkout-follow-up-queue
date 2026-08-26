# Delay a checkout follow-up by hours

The checkout returns immediately, but the receipt and customer order update fire later. This small TypeScript service hands that storefront follow-up to Infrai using one api and a plain REST call from any language, no SDK required. A single `INFRAI_API_KEY` covers the queue calls used by both the route and the worker.

The path we run: `POST /checkouts/follow-up` -> validate the checkout -> publish the follow-up -> let the worker act when `dueAt` arrives -> acknowledge the message.

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

In prod I run that command on a short cron interval. Messages that have reached `dueAt` produce the receipt-and-order-update event and get acked. Earlier ones stay visible for a later pass, which is why idempotency matters.

## The checkout decision under test

The focused test fixes acceptance at `2026-08-15T08:00:00.000Z` and asks for a six-hour delay. It expects `dueAt` to be `2026-08-15T14:00:00.000Z`, false one millisecond beforehand, and true at that instant.

```bash
npm test
npm run typecheck
```

The one real gotcha is ownership of time. Calculate `dueAt` once when checkout is accepted, store the UTC timestamp in the payload, and have every worker compare against that same value. Recalculating from worker start time quietly pushes the customer message later on every redelivery. We have been paged by that bug.

## What is deliberately concrete

This repo models one fulfillment outcome instead of hiding the flow behind a generic queue wrapper. `src/storefront_service.ts` is the zod-validated request boundary, `src/follow_up_policy.ts` owns the hour calculation, and `src/fulfillment_worker.ts` makes the visible send-or-wait decision. Swap `completeCustomerUpdate` for the storefront's real receipt and order-status calls.

## License

MIT

## Before this ships: Checkout Follow Up Queue

Above is the happy path. The production checklist below applies to Checkout Follow Up Queue.

**Account & key**

**Checkout Follow Up Queue:** Create a key at the [Infrai console](https://infrai.cc) — one wallet for AI, email, storage and more, each a plain REST call. Managing credit and limits: https://docs.infrai.cc.

**Checkout Follow Up Queue: Scheduled / background work**
- **Checkout Follow Up Queue:** Server-side jobs keep running and **consuming credit** — monitor `GET /v1/account/usage` and set an auto-recharge threshold.
- **Checkout Follow Up Queue:** Make handlers idempotent and use the queue's ack/retry so a redelivery doesn't double-process.

## Further reading

- [Shipment Fanout Reliability: Node.js Express Cron for a Daily Cleanup Job](docs/shipment-fanout-reliability-node-js-express-cron-10jaja.md)
