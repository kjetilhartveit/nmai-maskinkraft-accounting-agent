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
 * Recipe: 3 account lookups → 1 POST voucher = 4 calls (supplier created by prior task).
 * Postings:
 *   Debit  <expense account>  = net amount
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
  const totalAmount = Number(entity.amount ?? entity.totalAmount ?? 0);
  const expenseAccountNumber = Number(entity.accountNumber ?? entity.account ?? 7300);
  const vatRate = Number(entity.vatRate ?? 25);
  const includesVat = entity.amountIncludesVat === true || entity.includesVat === true
    || String(entity.amountIncludesVat ?? "").toLowerCase() === "true";
  const invoiceNumber = String(entity.invoiceNumber ?? "");
  const description = String(entity.description ?? "");

  // Resolve supplier ID from context
  let supplierId: number | undefined;
  if (supplierName) {
    supplierId = ctx.getSupplierId(supplierName);
  }

  if (!supplierId) {
    // Try to find or create supplier
    const supplierOrgNumber = String(entity.organizationNumber ?? entity.orgNumber ?? "");
    const result = await client.list<{ id: number; name: string }>("/supplier", {
      name: supplierName,
      from: "0",
      count: "1",
    });
    if (result.values.length > 0) {
      supplierId = result.values[0].id;
    } else {
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

  // Calculate VAT amounts
  let net: number;
  let vat: number;
  if (includesVat && vatRate > 0) {
    net = Math.round(totalAmount / (1 + vatRate / 100));
    vat = totalAmount - net;
  } else if (vatRate > 0) {
    net = totalAmount;
    vat = Math.round(totalAmount * (vatRate / 100));
  } else {
    net = totalAmount;
    vat = 0;
  }

  // Look up accounts in parallel
  const accountNumbers = [expenseAccountNumber, 2710, 2400];
  const [expenseAccount, vatAccount, payableAccount] = await Promise.all(
    accountNumbers.map((n) => findAccount(client, n)),
  );

  const voucherDate = today();
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

  if (vat > 0) {
    postings.push({
      row: 2,
      account: { id: vatAccount.id },
      date: voucherDate,
      amountGross: vat,
      amountGrossCurrency: vat,
      description: "Inngående mva",
    });
  }

  const creditAmount = -(net + vat);
  postings.push({
    row: postings.length + 1,
    account: { id: payableAccount.id },
    date: voucherDate,
    amountGross: creditAmount,
    amountGrossCurrency: creditAmount,
    description: "Leverandørgjeld",
    supplier: { id: supplierId },
  });

  const body = {
    date: voucherDate,
    description: desc,
    postings,
  };

  const result = await client.post<{ id: number }>("/ledger/voucher", body);
  console.log(
    `[Handler] Created supplier invoice voucher: id=${result.value.id} (net=${net}, vat=${vat}, total=${net + vat})`,
  );
}
