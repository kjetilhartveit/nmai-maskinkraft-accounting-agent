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

export function resetFxPaymentCache(): void {
  accountCache.clear();
}

/**
 * Foreign currency payment handler.
 *
 * Registers a supplier invoice/payment with exchange rate conversion.
 * Creates a voucher similar to create_supplier_invoice but with FX conversion.
 *
 * Postings:
 *   Debit  <expense account>     = NOK amount (net of VAT)
 *   Debit  2710 (input VAT)      = VAT in NOK
 *   Credit 2400 (accounts payable) = -(net + VAT) in NOK, with supplier ref
 */
export async function handleFxPayment(
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};

  const supplierName = String(entity.supplierName ?? entity.supplier ?? "");
  const supplierOrgNumber = String(entity.organizationNumber ?? entity.orgNumber ?? "");
  const foreignAmount = Number(entity.foreignAmount ?? entity.amount ?? 0);
  const foreignCurrency = String(entity.foreignCurrency ?? entity.currency ?? "EUR");
  const exchangeRate = Number(entity.exchangeRate ?? 0);
  let nokAmount = Number(entity.nokAmount ?? entity.totalNok ?? 0);
  const expenseAccountNumber = Number(entity.accountNumber ?? entity.account ?? 7300);
  const vatRate = Number(entity.vatRate ?? 25);
  const invoiceNumber = String(entity.invoiceNumber ?? "");
  const description = String(entity.description ?? `${foreignCurrency} betaling`);

  // Calculate NOK amount if not directly provided
  if (nokAmount <= 0 && foreignAmount > 0 && exchangeRate > 0) {
    nokAmount = Math.round(foreignAmount * exchangeRate);
  }
  if (nokAmount <= 0) {
    nokAmount = foreignAmount; // Fallback: assume 1:1 if no rate
  }

  // Find or create supplier
  let supplierId: number | undefined;
  if (supplierName) {
    supplierId = ctx.getSupplierId(supplierName);
  }

  if (!supplierId) {
    const result = await client.list<{ id: number; name: string }>("/supplier", {
      name: supplierName,
      from: "0",
      count: "5",
    });

    if (result.values.length > 0) {
      supplierId = result.values[0].id;
    } else if (supplierOrgNumber) {
      const byOrg = await client.list<{ id: number }>("/supplier", {
        organizationNumber: supplierOrgNumber,
        from: "0",
        count: "1",
      });
      if (byOrg.values.length > 0) supplierId = byOrg.values[0].id;
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

  // Calculate VAT
  let net: number;
  let vat: number;
  if (vatRate > 0) {
    net = Math.round(nokAmount / (1 + vatRate / 100));
    vat = nokAmount - net;
  } else {
    net = nokAmount;
    vat = 0;
  }

  // Look up accounts
  const accountNumbers = [expenseAccountNumber, ...(vat > 0 ? [2710] : []), 2400];
  const accounts = await Promise.all(accountNumbers.map((n) => findAccount(client, n)));

  const expenseAccount = accounts[0];
  const vatAccount = vat > 0 ? accounts[1] : null;
  const payableAccount = accounts[accounts.length - 1];

  // Build voucher
  const voucherDate = today();
  const desc = invoiceNumber
    ? `Valutafaktura ${invoiceNumber} ${supplierName} (${foreignAmount} ${foreignCurrency} @ ${exchangeRate})`
    : `Valutafaktura ${supplierName} (${foreignAmount} ${foreignCurrency})`;

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

  try {
    const result = await client.post<{ id: number }>("/ledger/voucher", {
      date: voucherDate,
      description: desc,
      postings,
    });
    console.log(
      `[Handler] Created FX payment voucher: id=${result.value.id} (${foreignAmount} ${foreignCurrency} → ${nokAmount} NOK)`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("422")) {
      console.warn("[Handler] Voucher with supplier ref failed, retrying without");
      const lastPosting = postings[postings.length - 1];
      delete lastPosting.supplier;
      const result = await client.post<{ id: number }>("/ledger/voucher", {
        date: voucherDate,
        description: desc,
        postings,
      });
      console.log(`[Handler] Created FX payment voucher (no supplier ref): id=${result.value.id}`);
    } else {
      throw err;
    }
  }
}
