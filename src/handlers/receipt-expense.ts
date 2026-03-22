import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import { today, getDefaultDepartmentId, postLedgerVoucherWithSupplierFallback } from "../lib/tripletex-helpers.js";

interface LedgerAccount {
  id: number;
  number: number;
}

async function findAccount(
  client: TripletexClient,
  accountNumber: number,
): Promise<LedgerAccount> {
  const result = await client.list<LedgerAccount>("/ledger/account", {
    number: String(accountNumber),
    from: "0",
    count: "1",
  });
  const account = result.values[0];
  if (!account) throw new Error(`Ledger account ${accountNumber} not found`);
  return account;
}

/**
 * Deterministic receipt expense handler.
 *
 * Books an expense from an attached receipt to a department and account.
 * Creates a voucher: debit expense account + debit input VAT (if applicable) + credit bank.
 */
export async function handleReceiptExpense(
  client: TripletexClient,
  task: ParsedTask,
  _ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};

  const expenseAccountNumber = Number(entity.accountNumber ?? entity.account ?? 6300);
  const departmentName = String(entity.departmentName ?? entity.department ?? "");
  const totalAmount = Number(String(entity.amount ?? entity.totalAmount ?? 0).replace(/[^\d.]/g, ""));
  const vatRateRaw = String(entity.vatRate ?? "25");
  const vatRate = Number(vatRateRaw.replace(/[%\s]/g, ""));
  const vatAmount = Number(String(entity.vatAmount ?? 0).replace(/[^\d.]/g, ""));
  const description = String(entity.itemDescription ?? entity.expenseName ?? entity.description ?? entity.name ?? "Kvittering");
  const dateStr = String(entity.date ?? today());

  // Resolve department
  let departmentId: number | undefined;
  if (departmentName) {
    const depts = await client.list<{ id: number; name: string }>("/department", {
      name: departmentName,
      from: "0",
      count: "5",
    });
    if (depts.values.length > 0) {
      departmentId = depts.values[0].id;
    } else {
      const created = await client.post<{ id: number }>("/department", { name: departmentName });
      departmentId = created.value.id;
      console.log(`[Handler] Created department: ${departmentName} (id=${departmentId})`);
    }
  }
  if (!departmentId) {
    departmentId = await getDefaultDepartmentId(client);
  }

  // Calculate amounts
  let net: number;
  let vat: number;
  if (vatAmount > 0) {
    vat = vatAmount;
    net = totalAmount > 0 ? totalAmount - vatAmount : vatAmount * (100 / vatRate);
  } else if (totalAmount > 0 && vatRate > 0) {
    net = Math.round(totalAmount / (1 + vatRate / 100));
    vat = totalAmount - net;
  } else if (totalAmount > 0) {
    net = totalAmount;
    vat = 0;
  } else {
    console.warn("[Handler] No amount found for receipt expense, using placeholder");
    net = 1000;
    vat = 250;
  }

  const gross = net + vat;

  // Create supplier from receipt vendor name
  const supplierName = String(entity.supplierName ?? entity.vendor ?? entity.storeName ?? description);
  let supplierId: number | null = null;
  if (supplierName && supplierName !== "Kvittering") {
    try {
      const existing = await client.list<{ id: number; name: string }>("/supplier", {
        from: "0",
        count: "20",
      });
      const match = existing.values.find(
        (s) => s.name?.toLowerCase().includes(supplierName.toLowerCase()),
      );
      if (match) {
        supplierId = match.id;
      } else {
        const created = await client.post<{ id: number }>("/supplier", {
          name: supplierName,
          isSupplier: true,
        });
        supplierId = created.value.id;
        console.log(`[Handler] Created supplier: ${supplierName} id=${supplierId}`);
      }
    } catch {
      // supplier creation optional
    }
  }

  // Look up accounts: expense + AP (VAT handled via vatType)
  const accountNumbers = [expenseAccountNumber, 2400];
  const accounts = await Promise.all(accountNumbers.map((n) => findAccount(client, n)));

  const expenseAccount = accounts[0];
  const apAccount = accounts[1];

  // Use vatType for automatic VAT handling (1 = 25% input VAT)
  const vatTypeMap: Record<number, number> = { 25: 1, 15: 11, 12: 13, 0: 0 };
  const resolvedVatRate = vatRate > 20 ? 25 : vatRate > 13 ? 15 : vatRate > 5 ? 12 : 0;
  const vatTypeId = vatTypeMap[resolvedVatRate] ?? 1;

  // Build voucher: expense with vatType + credit AP with supplier
  const postings: Record<string, unknown>[] = [
    {
      row: 1,
      account: { id: expenseAccount.id },
      date: dateStr,
      amountGross: gross,
      amountGrossCurrency: gross,
      description,
      department: { id: departmentId },
      ...(vat > 0 ? { vatType: { id: vatTypeId } } : {}),
    },
  ];

  const creditPosting: Record<string, unknown> = {
    row: 2,
    account: { id: apAccount.id },
    date: dateStr,
    amountGross: -gross,
    amountGrossCurrency: -gross,
    description: supplierName || "Leverandørgjeld",
  };
  if (supplierId) creditPosting.supplier = { id: supplierId };
  postings.push(creditPosting);

  const result = await postLedgerVoucherWithSupplierFallback(client, {
    date: dateStr,
    description: `Kvittering: ${description}`,
    postings,
  });
  console.log(
    `[Handler] Created receipt expense voucher: id=${result.value.id} (net=${net}, vat=${vat}, dept=${departmentName || "default"}, supplier=${supplierName})`,
  );
}
