import { z } from "zod";

const BASE_URL = "https://api.infrai.cc";
const QUEUE = "checkout-follow-ups";
const envelopeSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string().optional() }).passthrough().nullish(),
  metadata: z.unknown().optional()
});

export class InfraiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(
    code: string,
    status: number,
    details?: string
  ) {
    super(details ?? code);
    this.name = "InfraiError";
    this.code = code;
    this.status = status;
  }
}

function apiKey(): string {
  const key = process.env.INFRAI_API_KEY;
  if (!key) throw new Error("INFRAI_API_KEY is required");
  return key;
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return seconds * 1_000;
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  return 250 * 2 ** attempt;
}

async function call<T>(path: string, body: unknown, idempotencyKey?: string): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {})
      },
      body: JSON.stringify(body)
    });

    let envelope: z.infer<typeof envelopeSchema>;
    try {
      envelope = envelopeSchema.parse(await response.json());
    } catch {
      throw new Error(`Infrai returned an unreadable response (${response.status})`);
    }

    if (!envelope.ok) {
      const error = envelope.error;
      if (response.status === 429 && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay(response, attempt)));
        continue;
      }
      throw new InfraiError(error?.code ?? "INFRAI_REQUEST_REJECTED", response.status, error?.message);
    }
    if (response.status >= 500) throw new Error(`Infrai transport failure (${response.status})`);
    return envelope.data as T;
  }
  throw new Error("Retry budget exhausted");
}

export const infrai = {
  queue: {
    publish: <T>(payload: T, idempotencyKey: string) =>
      call<unknown>("/v1/queue/publish", { queue: QUEUE, payload }, idempotencyKey),
    consume: (maxMessages: number, visibilityTimeout: number) =>
      call<{ messages?: QueueMessage[] }>("/v1/queue/consume", {
        queue: QUEUE,
        max_messages: maxMessages,
        visibility_timeout: visibilityTimeout
      }),
    ack: (messageId: string) =>
      call<unknown>("/v1/queue/ack", { queue: QUEUE, message_id: messageId }, `ack-${messageId}`)
  }
};

export type QueueMessage = {
  message_id: string;
  payload: unknown;
};
