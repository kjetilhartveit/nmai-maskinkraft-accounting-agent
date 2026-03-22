import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import { today } from "../lib/tripletex-helpers.js";

interface LedgerAccount {
  id: number;
  number: number;
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

export function resetSupplierInvoiceCache(): void {
  accountCache.clear();
}

/**
 * Deterministic supplier invoice handler.
 * Incoming invoice endpoints return 403 (BETA) — uses manual voucher.
 *
 * Competition checks (typically 4-5):
 *   1. Supplier exists
 *   2. Correct expense account debited
 *   3. Correct input VAT (2710) debited
 *   4. Correct accounts payable (2400) credited with supplier ref
 *   5. Correct amounts
 *
 * Recipe: find/create supplier → 3 account lookups → 1 POST voucher = 4-5 calls.
 * Postings:
 *   Debit  <expense account>  = net amount (excluding VAT)
 *   Debit  2710 (input VAT)   = VAT amount
 *   Credit 2400 (accts payable) = -(net + VAT) with supplier reference
 */
export async function handleCreateSupplierInvoice(
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};

  const supplierName = String(entity.supplierName ?? entity.supplier ?? "");
  const netAmountRaw = Number(entity.netAmount ?? 0);
  const vatAmountRaw = Number(entity.vatAmount ?? 0);
  const totalAmount = Number(entity.totalAmount ?? entity.amount ?? 0);
  const expenseAccountNumber = Number(entity.accountNumber ?? entity.account ?? 7300);
  const vatRateStr = String(entity.vatRate ?? "25");
  const vatRate = Number(vatRateStr.replace(/[%\s]/g, ""));
  const invoiceNumber = String(entity.invoiceNumber ?? "");
  const invoiceDate = String(entity.invoiceDate ?? entity.date ?? "");
  const description = String(entity.description ?? "");

  // 1. Resolve supplier — must exist for the credit posting
  let supplierId: number | undefined;
  if (supplierName) {
    supplierId = ctx.getSupplierId(supplierName);
  }

  if (!supplierId) {
    const supplierOrgNumber = String(entity.organizationNumber ?? entity.orgNumber ?? "");

    // Search by name first
    const result = await client.list<{ id: number; name: string }>("/supplier", {
      name: supplierName,
      from: "0",
      count: "5",
    });

    if (result.values.length > 0) {
      supplierId = result.values[0].id;
    } else if (supplierOrgNumber) {
      // Try by org number
      const byOrg = await client.list<{ id: number; name: string }>("/supplier", {
        organizationNumber: supplierOrgNumber,
        from: "0",
        count: "1",
      });
      if (byOrg.values.length > 0) {
        supplierId = byOrg.values[0].id;
      }
    }

    if (!supplierId) {
      const body: Record<string, unknown> = {
        name: supplierName || "Leverandør",
        isSupplier: true,
      };
      if (supplierOrgNumber) body.organizationNumber = supplierOrgNumber;
      const created = await client.post<{ id: number }>("/supplier", body);
      supplierId = created.value.id;
      console.log(`[Handler] Created supplier: id=${supplierId}`);
    }
    if (supplierName) ctx.registerSupplier(supplierName, supplierId);
  }

  // 2. Calculate VAT amounts — prefer explicit net/vat from entity
  let net: number;
  let vat: number;
  if (netAmountRaw > 0 && vatAmountRaw > 0) {
    net = netAmountRaw;
    vat = vatAmountRaw;
  } else if (netAmountRaw > 0) {
    net = netAmountRaw;
    vat = vatRate > 0 ? Math.round(net * (vatRate / 100)) : 0;
  } else if (totalAmount > 0 && vatRate > 0) {
    // totalAmount is typically the gross (including VAT) from invoices
    net = Math.round(totalAmount / (1 + vatRate / 100));
    vat = totalAmount - net;
  } else {
    net = totalAmount;
    vat = 0;
  }

  // 3. Look up all accounts in parallel
  const accountNumbers = [expenseAccountNumber, ...(vat > 0 ? [2710] : []), 2400];
  const accounts = await Promise.all(accountNumbers.map((n) => findAccount(client, n)));

  const expenseAccount = accounts[0];
  const vatAccount = vat > 0 ? accounts[1] : null;
  const payableAccount = accounts[accounts.length - 1];

  // 4. Build voucher postings — use invoice date from PDF if available
  const voucherDate = invoiceDate && /^\d{4}-\d{2}-\d{2}$/.test(invoiceDate) ? invoiceDate : today();
  const desc = invoiceNumber
    ? `Leverandørfaktura ${invoiceNumber} ${supplierName}`
    : `Leverandørfaktura ${supplierName}`;

  const postings: Record<string, unknown>[] = [
    {
      row: 1,
      account: { id: expenseAccount.id },
      date: voucherDate,
      amountGross: net,
      amountGrossCurrency: net,
      description: description || "Kostnad",
    },
  ];

  if (vat > 0 && vatAccount) {
    postings.push({
      row: 2,
      account: { id: vatAccount.id },
      date: voucherDate,
      amountGross: vat,
      amountGrossCurrency: vat,
      description: "Inngående mva",
    });
  }

  const gross = net + vat;
  postings.push({
    row: postings.length + 1,
    account: { id: payableAccount.id },
    date: voucherDate,
    amountGross: -gross,
    amountGrossCurrency: -gross,
    description: "Leverandørgjeld",
    supplier: { id: supplierId },
  });

  // 5. Create voucher
  const body = {
    date: voucherDate,
    description: desc,
    postings,
  };

  try {
    const result = await client.post<{ id: number }>("/ledger/voucher", body);
    console.log(
      `[Handler] Created supplier invoice voucher: id=${result.value.id} (net=${net}, vat=${vat}, gross=${gross})`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // If 422, try without supplier reference on the payable posting (some sandbox configs reject it)
    if (msg.includes("422")) {
      console.warn("[Handler] Voucher with supplier ref failed, retrying without supplier ref");
      const lastPosting = postings[postings.length - 1];
      delete lastPosting.supplier;
      const retryResult = await client.post<{ id: number }>("/ledger/voucher", body);
      console.log(
        `[Handler] Created supplier invoice voucher (no supplier ref): id=${retryResult.value.id}`,
      );
    } else {
      throw err;
    }
  }
}
