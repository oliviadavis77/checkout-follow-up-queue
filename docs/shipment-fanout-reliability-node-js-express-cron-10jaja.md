# Shipment Fanout Reliability: Node.js Express Cron for a Daily Cleanup Job

Short answer: make the daily trigger boring, and make every shipment notification and cleanup unit safe to repeat. A Node.js Express endpoint is enough for a bounded run; move work behind a durable queue when one shipment update can fan out to many subscribers or when each delivery needs its own retry and audit record.

The operational constraint is duplicate delivery. A scheduler can fire twice, a worker can lose its connection after the remote subscriber accepted the message, and a process can restart after deleting one batch but before recording the result. The cron expression is the easy part. The contract around retry is the design.

I've been paged by missed jobs and duplicate deliveries. That is not a reason to ban retries; it is a reason to carry one stable key through scheduling, queuing, sending, and cleanup. I stopped trusting a green run without that trail.

## What failure signal should start a daily cleanup job?

Start with the data contract, not the scheduler. For a gaming shipment update, create an immutable event identity such as `shipment_id + event_version`. Store a delivery record keyed by that identity and subscriber. The consumer can then claim or insert that record before sending, and a retry can distinguish “already accepted” from “not attempted.” A database uniqueness constraint is more dependable than a boolean in process memory.

For the daily cleanup job, calculate one UTC cutoff at the beginning of the run. Use that same value for old uploads, logs, and stale delivery records. A later retry must not move the boundary forward and delete data that was fresh when the run began. Delete in bounded batches, record the last processed key, and let the next scheduled run continue from a well-defined query rather than holding an unbounded transaction.

Keep the handler explicit about what happened. Its run record should include the cutoff, candidate count, deleted count, notification count, duplicate count, duration, and the final state. A zero count is not automatically success or failure: it may be a healthy day, a broken filter, or a prior run that already completed the work. The alert needs the surrounding signal.

Three words matter: repeat the run.

No magic.

Consider one shipment update for a game launch: the event is `shipment-1842`, version 7, and it has 300 subscribers. The producer writes 300 delivery identities, but the process exits after publishing 120 messages. The next scheduled sweep must discover the remaining 180 without publishing the first 120 again. Later, a worker sends subscriber 42's message and loses its connection before it receives the acknowledgement. A retry is now correct only if the receiver treats the same delivery identity as the same effect. If the worker instead creates a fresh random key on every attempt, the queue can be perfectly healthy and still create a duplicate notification. The cleanup process has a related boundary: deleting a delivery row while its outbox record is still pending loses the evidence needed to publish it, while retaining every completed row forever turns the audit table into an unbounded data store. The retention policy therefore needs states, not just an age predicate: pending and uncertain deliveries need a longer recovery window; completed attempts can be compacted after the support and replay window; failed attempts need their reason and final disposition. I would write those states down before selecting a service, then test a restart at each transition. A one-minute test is more useful than a claim that the scheduler is reliable.

The cleanup path should be a no-op for records outside the cutoff and for delivery keys already marked complete. That makes a scheduler retry survivable. It also makes a manual verification run less dangerous, provided dry-run mode does not write delivery or deletion state.

## How should a Node.js Express cron expression handle shipment retries and old records?

Use a standard five-field expression for a daily trigger, for example `17 3 * * *`, and document the timezone beside it. The expression says when to request work; it does not define retention, delivery ordering, or recovery after a missed invocation. Those rules belong in the application and its runbook.

The fanout needs a separate unit of work for each subscriber. One message containing a shipment update and a giant subscriber array makes retry behavior ambiguous: did the consumer send to subscribers one through 400, or none of them? One delivery task per subscriber gives the system a natural idempotency key and a narrow retry scope. It also lets operators inspect the failed unit without replaying successful deliveries.

Here is the shape of the boundary I would review. It is an application-owned queue interface, so the transport can be replaced without changing the delivery policy.

```go
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

type Delivery struct {
	ShipmentID   string `json:"shipment_id"`
	EventVersion int64  `json:"event_version"`
	SubscriberID string `json:"subscriber_id"`
	Payload      []byte `json:"payload"`
}

type Queue interface {
	Publish(context.Context, string, []byte) error
}

func enqueueDelivery(ctx context.Context, db *sql.DB, q Queue, d Delivery) error {
	key := fmt.Sprintf("%s:%d:%s", d.ShipmentID, d.EventVersion, d.SubscriberID)
	payload, err := json.Marshal(d)
	if err != nil {
		return err
	}

	// The unique key makes an event replay produce one delivery task.
	result, err := db.ExecContext(ctx,
		`INSERT INTO deliveries (idempotency_key, state, payload)
		 VALUES (?, 'pending', ?)
		 ON CONFLICT (idempotency_key) DO NOTHING`, key, payload)
	if err != nil {
		return err
	}
	inserted, err := result.RowsAffected()
	if err != nil || inserted == 0 {
		return err
	}
	return q.Publish(ctx, key, payload)
}

func retryDelay(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	if attempt > 8 {
		attempt = 8
	}
	return time.Duration(1<<uint(attempt-1)) * time.Second
}
```

The database insert and queue publish are separate operations in this small example. That is a deliberate boundary to resolve in production, not a promise that the two systems commit together. Use an outbox table when losing a publish after a successful insert is unacceptable: commit the delivery row and outbox row in one database transaction, then publish from the outbox and mark it sent. The consumer still needs idempotency because the publisher can retry after an uncertain acknowledgement.

Do not treat a successful HTTP response as proof that the subscriber processed the event. Keep the delivery state transition separate from the attempt. A timeout after the request leaves the state unknown; retry with the same idempotency key, and require the receiving contract to make that key repeatable. Exponential delay limits pressure during a downstream incident, but it cannot create exactly-once effects by itself.

## Which service boundary keeps the audit trail useful?

Use one scheduled HTTP call when the cleanup is bounded, a single run result is sufficient, and a duplicate invocation is harmless. This is the smallest operational graph, which matters for a daily data cleanup job that a small team must own at 03:17 UTC.

Add a queue when the work has fanout, independent retry needs, or a runtime that can exceed the scheduler's execution window. Keep the cron trigger responsible for creating a run and publishing work. Keep workers responsible for one delivery or one deletion batch. Do not make the trigger wait for every subscriber.

The trade-off is straightforward:

| Boundary | Use it when | Cost you accept |
| --- | --- | --- |
| Cron to Express | The run is short and run-level status is enough | A failed run can hide which individual item needs attention |
| Cron to an outbox | A database event must not vanish before publication | Another table, publisher loop, and reconciliation job |
| Cron to a queue | Fanout units need separate retry and visibility | At-least-once delivery and duplicate-safe consumers |
| Workflow engine | Cleanup has dependencies, joins, or calendar backfills | More state and a larger operational surface |

The catch is that a queue does not fix an unclear retention policy. It can make an unclear policy execute at higher volume. A workflow engine is not suitable when the only requirement is one bounded daily sweep and the team cannot operate its extra state. Stick with a cron endpoint in that case, but keep the endpoint idempotent and the run observable.

I'm not sure a single retention period can be correct for uploads, logs, and delivery records. They serve different recovery needs. Keep those periods as named policy values, and test that an upload needed for an open support case is not treated like an expired debug log. Your mileage may vary on timezone rules; UTC avoids daylight-saving surprises, while a local business rule requires explicit calendar tests.

## What should rollback preserve after a duplicate shipment?

Verification starts before deletion. Run the selector in dry-run mode against a representative copy or a read-only query. Compare the candidate count with a sampled list, inspect the oldest and newest candidate, and confirm that the cutoff is the value recorded in the run. For shipment fanout, replay one event in a staging environment and check that the subscriber receives one effect even when the consumer is restarted after acknowledgement.

In production, alert on missing run records, a sudden change in candidate volume, repeated attempts for one idempotency key, and a growing age of pending deliveries. Retain enough context to answer three questions during an incident: what was selected, what was attempted, and what was acknowledged? Scheduler output is useful for trigger evidence, but it should not be the only copy of application counters.

If duplicate effects are detected, pause the trigger first. Stop new fanout at the producer, preserve the delivery rows and attempt logs, and identify whether the duplicate key was absent, generated differently, or ignored by the receiver. Do not bulk-delete the evidence. Once the cause is fixed, run one controlled event through the same idempotency path, compare the result, and then resume the schedule.

Rollback for deletion is different. A hard delete cannot be undone by pausing tomorrow's trigger. Use a soft-delete or a recoverable storage lifecycle where the data's recovery value justifies it, and test restoration before calling the process reversible. This is why deletion policy, queue semantics, and observability belong in the same runbook.

This design is not suitable for a requirement that promises exactly-once side effects without a receiver-side idempotency contract. It is also a poor fit for private-network work if the scheduler cannot reach the service, or for a multi-stage dependency graph that needs joins and replayable history. Choose a boundary that exposes those requirements instead of hiding them behind a longer cron expression.

## Sources

- https://www.rabbitmq.com/docs/confirms
- https://cloud.google.com/pubsub/docs/overview
