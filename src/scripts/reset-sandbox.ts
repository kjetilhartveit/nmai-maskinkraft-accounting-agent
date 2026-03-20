import { config } from "../lib/config.js";
import { TripletexClient } from "../lib/tripletex-client.js";

const today = new Date().toISOString().slice(0, 10);
const yearAgo = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);

const DELETABLE_ENDPOINTS = [
  { endpoint: "/travelExpense", label: "travel expenses", params: {} },
  { endpoint: "/ledger/voucher", label: "vouchers", params: { dateFrom: yearAgo, dateTo: today } },
  { endpoint: "/department", label: "departments", params: {} },
  { endpoint: "/project", label: "projects", params: {} },
] as const;

const LISTABLE_ONLY = [
  { endpoint: "/employee", label: "employees", params: {} },
  { endpoint: "/customer", label: "customers", params: {} },
  { endpoint: "/supplier", label: "suppliers", params: {} },
  { endpoint: "/product", label: "products", params: {} },
  { endpoint: "/order", label: "orders", params: { orderDateFrom: yearAgo, orderDateTo: today } },
  { endpoint: "/invoice", label: "invoices", params: { invoiceDateFrom: yearAgo, invoiceDateTo: today } },
] as const;

async function main() {
  if (!config.sandbox.apiUrl || !config.sandbox.sessionToken) {
    console.error("Missing SANDBOX_API_URL or SANDBOX_SESSION_TOKEN in .env");
    process.exit(1);
  }

  const client = new TripletexClient(config.sandbox.apiUrl, config.sandbox.sessionToken);

  console.log("=== Sandbox Reset ===\n");
  console.log(`Target: ${config.sandbox.apiUrl}\n`);

  for (const { endpoint, label, params } of DELETABLE_ENDPOINTS) {
    try {
      const result = await client.list<{ id: number }>(endpoint, { from: "0", count: "1000", fields: "id", ...params });
      const ids = result.values.map(v => v.id);
      if (ids.length === 0) {
        console.log(`✓ ${label}: already empty`);
        continue;
      }
      console.log(`  ${label}: found ${ids.length} entities, deleting...`);
      let deleted = 0;
      let failed = 0;
      for (const id of ids) {
        try {
          await client.delete(`${endpoint}/${id}`);
          deleted++;
        } catch {
          failed++;
        }
      }
      console.log(`  ${label}: deleted ${deleted}, failed ${failed}`);
    } catch (err) {
      console.log(`  ${label}: error listing — ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log("\n--- Entities that cannot be deleted (API limitation) ---\n");

  for (const { endpoint, label, params } of LISTABLE_ONLY) {
    try {
      const result = await client.list<{ id: number }>(endpoint, { from: "0", count: "1", fields: "id", ...params });
      console.log(`  ${label}: ${result.fullResultSize} entities (cannot delete via API)`);
    } catch {
      console.log(`  ${label}: error listing`);
    }
  }

  console.log("\n=== Done ===");
  console.log("\nNote: The competition provides a fresh sandbox per submission.");
  console.log("This script cleans what it can from your persistent dev sandbox.");
  console.log("Entities like employees, customers, and suppliers cannot be deleted via the API.");
}

main().catch(console.error);
