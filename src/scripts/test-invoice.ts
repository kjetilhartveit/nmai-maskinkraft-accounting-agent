/**
 * Test script to investigate invoice creation requirements
 */
import "dotenv/config";
import { TripletexClient } from "../lib/tripletex-client.js";

const SANDBOX_API_URL = process.env.SANDBOX_API_URL!;
const SANDBOX_SESSION_TOKEN = process.env.SANDBOX_SESSION_TOKEN!;

async function main() {
  const client = new TripletexClient(SANDBOX_API_URL, SANDBOX_SESSION_TOKEN);

  console.log("\n=== Investigating Invoice Creation ===\n");

  // 1. Check company settings
  console.log("1. Checking company settings...");
  try {
    const companyResult = await client.get<{ bankAccountNumber?: string; bankAccountIBAN?: string }>("/company/1");
    console.log("Company bank info:", JSON.stringify(companyResult.value, null, 2));
  } catch (e) {
    console.log("Failed to get company:", e);
  }

  // 2. Create a test customer
  console.log("\n2. Creating test customer...");
  let customerId: number | null = null;
  try {
    const customerResult = await client.post<{ id: number }>("/customer", {
      name: "Test Invoice Customer",
      organizationNumber: "999888777",
    });
    customerId = customerResult.value.id;
    console.log("Created customer:", customerId);
  } catch (e) {
    console.log("Failed to create customer:", e);
  }

  if (!customerId) return;

  // 3. Create an order
  console.log("\n3. Creating order...");
  let orderId: number | null = null;
  const today = new Date().toISOString().slice(0, 10);
  const dueDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  try {
    const orderResult = await client.post<{ id: number; status?: string; invoiceIssued?: boolean }>("/order", {
      customer: { id: customerId },
      orderDate: today,
      deliveryDate: dueDate,
    });
    orderId = orderResult.value.id;
    console.log("Created order:", orderId);
    console.log("Order details:", JSON.stringify(orderResult.value, null, 2));
  } catch (e) {
    console.log("Failed to create order:", e);
  }

  if (!orderId) return;

  // 4. Get the order to see its status
  console.log("\n4. Getting order details...");
  try {
    const orderDetails = await client.get<{ id: number; status?: string; number?: number; invoiceIssued?: boolean }>(`/order/${orderId}`);
    console.log("Order full details:", JSON.stringify(orderDetails.value, null, 2));
  } catch (e) {
    console.log("Failed to get order:", e);
  }

  // 5. Try to create invoice
  console.log("\n5. Attempting invoice creation...");
  try {
    const invoiceResult = await client.post<{ id: number }>("/invoice", {
      invoiceDate: today,
      invoiceDueDate: dueDate,
      orders: [{ id: orderId }],
    });
    console.log("SUCCESS! Created invoice:", invoiceResult.value.id);
  } catch (e: unknown) {
    if (e instanceof Error) {
      console.log("\nFULL ERROR MESSAGE:");
      console.log(e.message);
      if ("body" in e) {
        console.log("\nFULL ERROR BODY:");
        console.log((e as { body: string }).body);
      }
    }
  }

  console.log("\n=== Summary ===");
  console.log("API calls:", client.stats);
}

main().catch(console.error);
