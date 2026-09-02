# Small SaaS Failed Jobs: SQS vs RabbitMQ vs Managed Queue for EU/US Digests

Short answer: for a small SaaS sending a weekly digest to active property-management customers, choose the queue with the lowest operational burden that still provides delayed retry, a dead-letter queue, and observable delivery. The cheapest line item is rarely the deciding cost; a duplicate digest or a silent backlog is.

I've been paged by missed jobs and duplicate deliveries. The useful lesson is not “pick broker X.” It is to make one customer-week the idempotency boundary, then make every retry safe around it.

## The weekly digest contract comes first

Take a bounded production scenario. A weekly digest is rendered, the mail provider accepts it, and the worker loses its connection before acknowledging the queue message. The broker delivers the job again. If the worker treats delivery as proof that the email has not been sent, one customer receives two digests. If it acknowledges before the send record is durable, a transient database failure can turn into a missed digest.

The invariant I want in the runbook is `customer_id + ISO week`. Persist that key with the send attempt and the final provider result. The worker must check the durable record before creating the business effect, and it must acknowledge only after the record and the effect have reached the intended state. A queue gives delivery semantics; it does not give exactly-once email delivery. During an incident, I want an operator to be able to answer three questions from one record: did rendering finish, did the email provider accept the message, and did the acknowledgement happen? If those states are collapsed into one boolean, a redrive can repeat a send that already succeeded; if they are scattered across logs, an on-call engineer will guess while the next weekly batch is waiting.

This is also where authentication belongs. If a scheduler or worker signs a callback, use a keyed construction such as HMAC and verify it before parsing the payload. RFC 2104 describes the construction and its security requirements; it is a better boundary than putting a shared secret in a job body.

The preventative path can stay small. The queue adapter is deliberately generic, so the decision between a managed queue, a broker, or an application framework does not leak into the digest logic.

```go
package digest

import "errors"

var ErrAlreadySent = errors.New("digest already sent")

type DigestStore interface {
	SendOnce(key string, body []byte) error
}

func Deliver(store DigestStore, customerWeek string, body []byte) error {
	err := store.SendOnce(customerWeek, body)
	if errors.Is(err, ErrAlreadySent) {
		return nil
	}
	return err
}
```

The adapter should request delayed redelivery for a transient dependency error and send a permanent payload error to the DLQ. I use a 429 response as a retryable signal only when the dependency's contract says so, and I record the attempt number, next delivery time, region, and failure class. Short sentences help during an alert.

Know why.

## Regional ownership is a deployment decision

For EU and US customers, keep the data boundary explicit. Decide where tenant data is rendered, where the queue stores the payload, and which region owns the DLQ. Do not assume that adding a second worker region creates active-active correctness. Two workers can race on the same customer-week unless the idempotency record has a single durable authority or a well-defined conditional-write rule.

That ownership decision should come before a queue shortlist. Someone needs to own retention, regional failover, redrive approval, and the evidence needed to explain a late digest. If nobody owns those choices, “managed” only moves the ambiguity into a service contract.

The same boundary applies to a regional handoff: a US worker should not silently consume an EU tenant's payload merely because it is idle. Put the region and tenant policy in the job metadata, enforce it at claim time, and make a deliberate failover visible in the audit trail.

## How should a small SaaS test delayed retry before choosing SQS, RabbitMQ, or a managed queue?

Compare behavior before price. For this weekly workload, measure time to recover, operator hours, regional reach, delivery guarantees, retention, delayed-delivery support, DLQ inspection, and the work needed to patch or scale the system. A managed queue usually reduces broker maintenance. A self-hosted broker can expose richer routing controls, but those controls bring capacity planning, upgrades, replication, and incident ownership. An application-level retry library can be a good fit when the database and worker runtime already form the operating model, but it still needs a durable failure path.

The trade-off is easier to review as a decision table:

| Choice | Useful when | Cost or risk to price into the decision |
| --- | --- | --- |
| Managed queue | The team wants a narrow delivery service and low broker maintenance | Provider limits, regional behavior, and lock-in need review |
| Self-hosted broker | Routing, ordering, or protocol control is a hard requirement | On-call time includes the broker, storage, upgrades, and recovery |
| Application retry layer | Jobs are tightly coupled to one service and its database | Retry state can become invisible unless it has durable records and metrics |
| Workflow engine | The digest has long-lived steps, joins, or compensation | More operational and conceptual machinery than a single retry loop |

The catch is that a managed queue is not suitable when the central requirement is arbitrary workflow orchestration or long-term event replay. Stick with a broker or workflow system when those capabilities repay their operating burden. For a small SaaS with one weekly effect per customer, they may be needless surface area.

## How do delayed retry, SQS, RabbitMQ, and a dead-letter queue fit the weekly digest?

Use the failure class to choose the next action. A temporary rate limit or unavailable dependency deserves bounded exponential delay with jitter. An invalid tenant address, malformed template, or missing required data should stop retrying quickly and enter the DLQ with a reason that an operator can act on. A successful send followed by an acknowledgement timeout must be harmless because the customer-week record wins the race.

The queue choice changes the mechanics, not that invariant. SQS-style queues are a reasonable comparison point for teams already committed to that cloud's primitives. RabbitMQ is a reasonable comparison point when broker routing and deployment control matter. A managed queue is a broader category, so “managed” says who operates the service, not whether it has the exact delay, retention, ordering, and DLQ behavior this job needs. Verify those properties against current documentation before committing.

For each option, run the same test matrix: worker crash after the provider accepts the email, worker crash before the database commit, two workers claiming one customer-week, a dependency returning 429, a poison payload, and a DLQ redrive after the template is fixed. Test it with production-shaped data, including a tenant with no properties and a tenant with a large portfolio. One happy-path test proves almost nothing here.

Your mileage may vary on the latency-versus-cost axis. A weekly digest has a wide delivery window, so paying for low single-digit-second recovery may be wasteful. A customer-facing “digest ready” notification has a tighter bound and may justify more workers or a different queue class. Write that service-level target down before comparing per-message pricing; otherwise the spreadsheet will decide an operational question by accident.

## The handoff that makes a DLQ useful

The first dashboard view should show oldest queued age, successful sends by customer-week, retry count by failure class, and DLQ age. Queue depth alone cannot tell an operator whether the system is late or merely busy. Alert on the oldest item crossing the digest delivery window, then attach a sample of IDs and regions to the alert.

When the alert fires, pause broad redrive. Inspect a small sample, classify the cause, and check the send record before replaying anything. Fix the dependency, payload, or consumer according to that classification. Redrive only records whose idempotency state says the business effect is still pending. Leave permanent failures visible until a human decision or an explicit retention policy removes them.

The weekly schedule itself needs a contract. Define the cutoff time, the customer timezone rule, the allowed lateness, and what happens after a missed scheduler trigger. A scheduler that does not backfill by design requires a reconciliation job; a scheduler that can backfill needs a deduplication key. Either way, the repair path should create the same customer-week key as the normal path.

The decision rule is plain: use the smallest operational model that meets the delivery window, then spend the engineering effort on idempotency, failure classification, and evidence in the DLQ. Revisit SQS, RabbitMQ, or another managed queue only when a measured requirement changes. The queue is a boundary around the work, not the owner of the business outcome.

## References

- https://www.rfc-editor.org/rfc/rfc2104
- https://cloud.google.com/pubsub/docs/overview
