const response = await fetch("http://localhost:3000/checkouts/follow-up", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    orderId: "order_1042",
    customerEmail: "shopper@example.com",
    fulfillment: "ship",
    receiptNumber: "R-1042",
    delayHours: 6
  })
});

console.log(response.status, await response.json());

export {};
