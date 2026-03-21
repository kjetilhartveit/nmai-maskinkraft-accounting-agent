import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import { today } from "../lib/tripletex-helpers.js";

interface LedgerAccount {
  id: number;
  number: number;
}

interface DimensionName {
  id: number;
  dimensionIndex: number;
  dimensionName: string;
}

const accountCache = new Map<number, LedgerAccount>();

async function findAccount(
  client: TripletexClient,
  accountNumber: number,
): Promise<LedgerAccount> {
  const cached = accountCache.get(accountNumber);
  if (cached) return cached;
  const result = await client.list<LedgerAccount>("/ledger/account", {
    number: String(accountNumber),
    from: "0",
    count: "1",
  });
  const account = result.values[0];
  if (!account) throw new Error(`Ledger account ${accountNumber} not found`);
  accountCache.set(accountNumber, account);
  return account;
}

export function resetDimensionCache(): void {
  accountCache.clear();
}

/**
 * Deterministic custom accounting dimension handler.
 *
 * Recipe (fresh sandbox):
 *   1. GET /ledger/accountingDimensionName (check existing)
 *   2. POST /ledger/accountingDimensionName (create if new)
 *   3. GET /ledger/accountingDimensionValue (check existing values)
 *   4. POST /ledger/accountingDimensionValue × N (create missing)
 *   5. GET /ledger/account × 2 (expense + bank, parallel)
 *   6. POST /ledger/voucher (balanced postings with dimension link)
 * Total: 5-8 API calls with 0 errors.
 */
export async function handleCreateDimension(
  client: TripletexClient,
  task: ParsedTask,
  _ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};

  const dimensionName = String(entity.dimensionName ?? "");
  const dimensionValues: string[] = Array.isArray(entity.dimensionValues)
    ? (entity.dimensionValues as string[])
    : [];
  const accountNumber = Number(entity.accountNumber ?? entity.account ?? 0);
  const amount = Number(entity.amount ?? 0);

  if (!dimensionName) {
    console.warn("[Handler] No dimension name provided");
    return;
  }

  // 1. Check if dimension already exists, create if not
  let dimensionIndex: number;
  const existing = await client.list<DimensionName>(
    "/ledger/accountingDimensionName",
    { from: "0", count: "100" },
  );
  const found = existing.values.find(
    (d) => d.dimensionName.toLowerCase() === dimensionName.toLowerCase(),
  );
  if (found) {
    dimensionIndex = found.dimensionIndex;
    console.log(`[Handler] Dimension "${dimensionName}" already exists → index=${dimensionIndex}`);
  } else {
    const result = await client.post<DimensionName>(
      "/ledger/accountingDimensionName",
      { dimensionName, active: true },
    );
    dimensionIndex = result.value.dimensionIndex;
    console.log(`[Handler] Created dimension "${dimensionName}" → index=${dimensionIndex}`);
  }

  // 2. Check existing values, then create missing ones
  interface DimensionValue {
    id: number;
    displayName: string;
  }
  const existingValues = await client.list<DimensionValue>(
    "/ledger/accountingDimensionValue",
    { dimensionIndex: String(dimensionIndex), from: "0", count: "100" },
  );
  const valueMap = new Map<string, number>(
    existingValues.values.map((v) => [v.displayName.toLowerCase(), v.id]),
  );

  for (const valueName of dimensionValues) {
    if (valueMap.has(valueName.toLowerCase())) {
      console.log(`[Handler] Dimension value "${valueName}" already exists, skipping`);
      continue;
    }
    try {
      const created = await client.post<DimensionValue>("/ledger/accountingDimensionValue", {
        dimensionIndex,
        displayName: valueName,
        active: true,
        showInVoucherRegistration: true,
      });
      valueMap.set(valueName.toLowerCase(), created.value.id);
      console.log(`[Handler] Created dimension value "${valueName}" (id=${created.value.id})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Navnet er i bruk") || msg.includes("already")) {
        console.log(`[Handler] Dimension value "${valueName}" already exists, skipping`);
      } else {
        console.warn(`[Handler] Failed to create dimension value "${valueName}": ${msg}`);
      }
    }
  }

  // 3. Create balanced voucher if an account and amount are specified
  if (!accountNumber || !amount) {
    console.log("[Handler] No voucher requested (no account/amount)");
    return;
  }

  // Resolve linked dimension value ID for freeAccountingDimension field
  const linkedValueName = String(entity.linkedDimensionValue ?? "");
  const linkedValueId = linkedValueName
    ? valueMap.get(linkedValueName.toLowerCase())
    : undefined;
  if (linkedValueId) {
    console.log(`[Handler] Linking voucher to dimension value "${linkedValueName}" (id=${linkedValueId})`);
  }

  const [expenseAccount, bankAccount] = await Promise.all([
    findAccount(client, accountNumber),
    findAccount(client, 1920),
  ]);

  const voucherDate = today();

  const dimensionField = `freeAccountingDimension${dimensionIndex}`;
  const expensePosting: Record<string, unknown> = {
    row: 1,
    account: { id: expenseAccount.id },
    date: voucherDate,
    amountGross: amount,
    amountGrossCurrency: amount,
    description: `Kostnad ${dimensionName}`,
  };
  const creditPosting: Record<string, unknown> = {
    row: 2,
    account: { id: bankAccount.id },
    date: voucherDate,
    amountGross: -amount,
    amountGrossCurrency: -amount,
    description: "Utbetaling",
  };
  if (linkedValueId) {
    expensePosting[dimensionField] = { id: linkedValueId };
    creditPosting[dimensionField] = { id: linkedValueId };
  }

  const body = {
    date: voucherDate,
    description: `Bilag ${dimensionName}`,
    postings: [expensePosting, creditPosting],
  };

  const result = await client.post<{ id: number }>("/ledger/voucher", body);
  console.log(
    `[Handler] Created dimension voucher: id=${result.value.id} (account=${accountNumber}, amount=${amount})`,
  );
}
