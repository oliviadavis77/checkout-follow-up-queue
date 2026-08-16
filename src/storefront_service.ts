import { createServer, type ServerResponse } from "node:http";
import { InfraiError, infrai } from "./infrai_queue.js";
import { checkoutSchema, planFollowUp } from "./follow_up_policy.js";

function reply(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readJson(request: AsyncIterable<Uint8Array>): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/checkouts/follow-up") {
    reply(response, 404, { error: "Route not found" });
    return;
  }

  try {
    const checkout = checkoutSchema.parse(await readJson(request));
    const followUp = planFollowUp(checkout, new Date());
    await infrai.queue.publish(followUp, `checkout-follow-up-${checkout.orderId}`);
    reply(response, 202, { orderId: checkout.orderId, followUpAt: followUp.dueAt, status: "queued" });
  } catch (error) {
    if (error instanceof InfraiError) {
      reply(response, error.status >= 400 && error.status < 500 ? error.status : 502, {
        error: error.code,
        message: error.message
      });
      return;
    }
    if (error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError")) {
      reply(response, 400, { error: "Invalid checkout body" });
      return;
    }
    reply(response, 500, { error: "Could not queue follow-up" });
  }
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => console.log(`Storefront service listening on http://localhost:${port}`));
