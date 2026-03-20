/**
 * Test script to investigate company settings and bank account
 */
import "dotenv/config";
import { TripletexClient } from "../lib/tripletex-client.js";

const SANDBOX_API_URL = process.env.SANDBOX_API_URL!;
const SANDBOX_SESSION_TOKEN = process.env.SANDBOX_SESSION_TOKEN!;

async function main() {
  const client = new TripletexClient(SANDBOX_API_URL, SANDBOX_SESSION_TOKEN);

  console.log("\n=== Investigating Bank Account Settings ===\n");

  // 1. Search for bank accounts in ledger
  console.log("1. Searching for bank accounts in ledger...");
  try {
    const bankAccounts = await client.list<{
      id: number;
      number: number;
      name: string;
      isBankAccount: boolean;
      bankAccountNumber?: string;
      bankAccountCountry?: { id: number };
    }>("/ledger/account", {
      isBankAccount: "true",
      from: "0",
      count: "10",
    });
    console.log("Bank accounts found:", bankAccounts.values.length);
    bankAccounts.values.forEach((a, i) => {
      console.log(`  ${i + 1}. ${a.number} - ${a.name} (id=${a.id})`);
      console.log(`      bankAccountNumber: ${a.bankAccountNumber}`);
    });
  } catch (e) {
    console.log("Failed:", e);
  }

  // 2. Check account 1920 (typical bank account)
  console.log("\n2. Checking account 1920 (typical bank)...");
  try {
    const account1920 = await client.list<{
      id: number;
      number: number;
      name: string;
      bankAccountNumber?: string;
      isBankAccount?: boolean;
    }>("/ledger/account", {
      number: "1920",
      from: "0",
      count: "1",
    });
    if (account1920.values.length > 0) {
      console.log("Account 1920:", JSON.stringify(account1920.values[0], null, 2));
    }
  } catch (e) {
    console.log("Failed:", e);
  }

  // 3. Get full account details
  console.log("\n3. Getting full details of bank account...");
  try {
    const bankAccounts = await client.list<{ id: number }>("/ledger/account", {
      isBankAccount: "true",
      from: "0",
      count: "1",
    });
    if (bankAccounts.values.length > 0) {
      const fullAccount = await client.get<unknown>(`/ledger/account/${bankAccounts.values[0].id}`);
      console.log("Full account details:", JSON.stringify(fullAccount, null, 2));
    }
  } catch (e) {
    console.log("Failed:", e);
  }

  // 4. Check if we can PUT the account to add bank number
  console.log("\n4. Trying to update account with bank number...");
  try {
    const bankAccounts = await client.list<{ id: number; version: number; number: number; name: string }>("/ledger/account", {
      isBankAccount: "true",
      from: "0",
      count: "1",
    });
    if (bankAccounts.values.length > 0) {
      const acct = bankAccounts.values[0];
      console.log(`Updating account ${acct.number} (id=${acct.id}, version=${acct.version})...`);

      // Try setting a valid Norwegian bank account number (MOD11 check)
      // Format: 11 digits, MOD11 calculated: 1503268613 with check digit 0
      const updatedAccount = await client.put<unknown>(`/ledger/account/${acct.id}`, {
        id: acct.id,
        version: acct.version,
        number: acct.number,
        name: acct.name,
        bankAccountNumber: "15032686130", // MOD11 validated
      });
      console.log("Update result:", JSON.stringify(updatedAccount, null, 2));
    }
  } catch (e: unknown) {
    if (e instanceof Error) {
      console.log("Update failed:", e.message);
      if ("body" in e) {
        console.log("Error details:", (e as { body: string }).body);
      }
    }
  }

  console.log("\n=== Summary ===");
  console.log("API calls:", client.stats);
}

main().catch(console.error);
