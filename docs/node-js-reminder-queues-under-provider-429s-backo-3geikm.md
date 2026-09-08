# Node.js Reminder Queues Under Provider 429s: Backoff, DLQ, and Redrive

Short answer: treat a provider `429 Too Many Requests` as an admission-control event, not a generic retry error. For a fintech reminder queue, preserve one operation ID, pace push, email, and SMS separately, and make the decision to retry, expire, or redrive visible before increasing worker concurrency.

The distinction matters because the queue can be healthy while the customer-facing handoff is not. I've been paged for missed jobs and duplicate deliveries, and the useful question in both incidents was the same: what does the system know about this reminder at the moment the provider says no, or the network says nothing? That question produces a better runbook than “increase the workers.”

## How do we govern 429 evidence before touching a reminder queue?

Start with the response semantics. HTTP 429 means the client sent too many requests in a given period; a server may include `Retry-After` to indicate how long the client should wait. That header is a pacing signal. It does not establish that the reminder was delivered, and it does not make a retry safe by itself.

Classify the event at the channel boundary. A push subscriber, email provider, and SMS provider can each impose a different admission limit, so one shared worker budget turns an email burst into an SMS problem or vice versa. Keep the channel in the durable reminder record, alongside its scheduled time, expiry time, destination reference, and stable operation ID.

The first useful state is not “retrying.” It is evidence:

| Evidence | Meaning | Next decision |
| --- | --- | --- |
| A parseable `Retry-After` on 429 | The provider supplied a wait signal | Delay admission for that channel. |
| A 429 without a usable wait signal | The request was refused, but the window is unspecified | Use capped backoff with jitter and a bounded attempt policy. |
| A successful handoff recorded | The operation may already have produced the customer effect | Acknowledge later deliveries without sending again. |
| No handoff record after a failed attempt | The send decision remains unresolved | Retry only within the reminder's useful window. |

This is the boundary between transport handling and delivery guarantees. A queue can promise at-least-once delivery of work; it cannot honestly promise exactly-once customer effect unless the application has a durable deduplication decision around the same operation ID.

Three words: record the uncertainty.

## What evidence distinguishes a throttle from a duplicate handoff?

Consider a scheduled batch of financial reminders becoming eligible together. The queue accepts the work and the workers drain messages. The provider accepts part of the burst and returns 429 for the rest. If every worker sleeps for the same short interval, they become a second burst when they wake. Queue depth may fall while the channel remains rate limited.

The incident lesson is to separate four clocks: eligibility, admission, handoff, and expiry. Eligibility says the reminder may be attempted. Admission says a provider call is allowed now. Handoff says the downstream request was recorded as accepted. Expiry says the reminder is no longer useful. A retry loop that owns all four clocks hides which guarantee failed.

The operation ID must be created before enqueue and must survive ordinary retries and DLQ redrive. A newly generated message ID on every attempt cannot tell a late timeout from a new business operation. If a downstream API accepts an idempotency key, pass that stable value; if it does not, the application-side handoff ledger still needs to prevent a second send when the prior result is already recorded.

That is the part worth testing before production. Inject a 429, an absent `Retry-After`, a timeout after the provider may have accepted the request, and an expired reminder. Verify the state transition and acknowledgement decision for each case. Do not validate only that the worker eventually returns nil.

## How should a Node.js reminder queue pace push subscribers after a 429?

The following example keeps queue mechanics outside the delivery function. It parses the standard wait header, caps exponential backoff, adds jitter, and retries only 429 responses. A real worker still has to persist the handoff outcome before acknowledging the queue message.

```go
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"strconv"
	"time"
)

type Reminder struct {
	OperationID string `json:"operation_id"`
	Channel     string `json:"channel"`
	Destination string `json:"destination"`
	Body        string `json:"body"`
}

func retryDelay(response *http.Response, attempt int, random *rand.Rand) time.Duration {
	if value := response.Header.Get("Retry-After"); value != "" {
		if seconds, err := strconv.Atoi(value); err == nil && seconds >= 0 {
			return time.Duration(seconds) * time.Second
		}
	}

	base := time.Second << attempt
	if base > 5*time.Minute {
		base = 5 * time.Minute
	}
	return base + time.Duration(random.Int63n(int64(500*time.Millisecond)))
}

func deliver(ctx context.Context, client *http.Client, endpoint string, reminder Reminder) error {
	body, err := json.Marshal(reminder)
	if err != nil {
		return err
	}

	random := rand.New(rand.NewSource(time.Now().UnixNano()))
	for attempt := 0; attempt < 5; attempt++ {
		request, err := http.NewRequestWithContext(
			ctx,
			http.MethodPost,
			endpoint,
			bytes.NewReader(body),
		)
		if err != nil {
			return err
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Idempotency-Key", reminder.OperationID)

		response, err := client.Do(request)
		if err != nil {
			return err
		}
		response.Body.Close()

		if response.StatusCode >= 200 && response.StatusCode < 300 {
			return nil
		}
		if response.StatusCode != http.StatusTooManyRequests {
			return fmt.Errorf("non-retryable provider status: %d", response.StatusCode)
		}

		timer := time.NewTimer(retryDelay(response, attempt, random))
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}

	return fmt.Errorf("rate limit persisted after five attempts")
}
```

The fixed attempt count is an example boundary, not a universal policy. The right limit depends on the reminder's useful window and the provider's documented limit. Your mileage may vary. The policy must still be explicit: a worker that cannot finish within that window should mark the reminder expired or dead-lettered according to the business contract, rather than retrying forever.

## The state record for delivery guarantees, DLQ, and redrive

For user reminders, at-least-once work delivery is usually the clearest infrastructure contract. The system tries not to lose eligible work, and the application makes repeated attempts harmless. Best effort is a valid choice only when dropping an expired or low-value notification is acceptable and the expiry rule is deliberate. “Exactly once” is a business-effect claim that needs a ledger and a deduplication design; it is not something to infer from a queue acknowledgement.

A DLQ is part of that contract, not a storage bin for failed messages. Store the operation ID, channel, attempt count, last status, next eligible time, and reason classification. “Retry later” is not a reason. A 429 that has exhausted the useful window, a permanent destination policy, and an unresolved handoff are different operator decisions.

Redrive in a classified slice. First lower admission for the affected channel. Confirm that new 429 responses have stopped. Release a small set whose state and reason match the release condition, then compare oldest eligible age, recorded handoffs, expiry count, and duplicate-suppression decisions. Pause when those signals worsen.

Short runbooks win.

The monitoring should follow what a customer feels: time from eligibility to recorded handoff, oldest eligible age, 429 rate by channel, expiry count, and duplicate-suppression hits. Queue depth alone can look green while SMS is stalled and reminders are aging out. Alert thresholds should come from the reminder's useful window and the provider's documented limit, then be exercised with a controlled burst.

## The limits of this design

This design fits a direct, time-bounded handoff where the team can operate channel budgets, own idempotency, and review a DLQ. It is not suitable when the product needs durable multi-step orchestration, fan-out and join semantics, retained event replay, or a complete workflow history. Choose a workflow engine or streaming platform when those are the actual requirements.

It is also a poor fit when nobody owns the handoff ledger or can define “too late to send.” A smaller worker pool will not resolve that missing decision. Stick with a simpler queue consumer for a single handoff whose controls are clear; use a broader orchestration model when the business process has several durable steps.

The durable rule is short: protect the provider, preserve the operation ID, and make the delivery guarantee observable. The queue is one part of that promise.

## References

- https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/429
- https://www.inngest.com/docs
