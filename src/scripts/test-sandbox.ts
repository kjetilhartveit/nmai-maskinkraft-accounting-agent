import { config } from "../lib/config.js";
import { TripletexClient } from "../lib/tripletex-client.js";

async function main() {
  const { apiUrl, sessionToken } = config.sandbox;

  if (!apiUrl || !sessionToken) {
    console.error(
      "Missing SANDBOX_API_URL or SANDBOX_SESSION_TOKEN in .env file",
    );
    process.exit(1);
  }

  console.log(`Testing sandbox connection to: ${apiUrl}`);
  const client = new TripletexClient(apiUrl, sessionToken);

  const endpoints = [
    { path: "/employee", label: "Employees" },
    { path: "/customer", label: "Customers" },
    { path: "/product", label: "Products" },
    { path: "/department", label: "Departments" },
    { path: "/project", label: "Projects" },
  ];

  for (const { path, label } of endpoints) {
    try {
      const result = await client.list<unknown>(path, {
        from: "0",
        count: "5",
      });
      console.log(`  ${label}: ${result.fullResultSize} total`);
    } catch (error) {
      console.error(`  ${label}: FAILED -`, (error as Error).message);
    }
  }

  console.log(`\nAPI call stats:`, client.stats);
}

main().catch(console.error);
