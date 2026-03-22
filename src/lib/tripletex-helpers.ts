import type { TripletexClient } from "./tripletex-client.js";

interface Department {
  id: number;
  name: string;
}

interface Employee {
  id: number;
  firstName: string;
  lastName: string;
  email?: string;
}

interface Customer {
  id: number;
  name: string;
}

interface Currency {
  id: number;
  code: string;
}

interface VatType {
  id: number;
  name: string;
  number: string;
  percentage?: number;
}

let cachedVatTypes: VatType[] | null = null;

interface ProductUnit {
  id: number;
  name: string;
}

interface Product {
  id: number;
  name: string;
}

let cachedProductCatalog: Map<string, Product> | null = null;
let cachedProductCatalogById: Map<number, Product> | null = null;
let cachedProductCatalogByNumber: Map<string, Product> | null = null;

/**
 * Loads all products in a single GET call and caches them.
 * Subsequent lookups resolve in-memory without additional API calls.
 * Useful when resolving ≥2 products (saves N-1 calls).
 */
export async function loadProductCatalog(
  client: TripletexClient,
): Promise<Map<string, Product>> {
  if (cachedProductCatalog) return cachedProductCatalog;
  const result = await client.list<Product & { number?: string }>("/product", {
    from: "0",
    count: "1000",
  });
  cachedProductCatalog = new Map();
  cachedProductCatalogById = new Map();
  cachedProductCatalogByNumber = new Map();
  for (const p of result.values) {
    cachedProductCatalog.set(p.name.trim().toLowerCase(), p);
    cachedProductCatalogById.set(p.id, p);
    if ((p as unknown as Record<string, unknown>).number) {
      cachedProductCatalogByNumber.set(
        String((p as unknown as Record<string, unknown>).number).trim(),
        p,
      );
    }
  }
  return cachedProductCatalog;
}

export function findProductInCatalog(name: string): Product | null {
  return cachedProductCatalog?.get(name.trim().toLowerCase()) ?? null;
}

export function findProductInCatalogByNumber(num: string): Product | null {
  return cachedProductCatalogByNumber?.get(num.trim()) ?? null;
}

let cachedDefaultDepartmentId: number | null = null;
let cachedNokCurrencyId: number | null = null;
let cachedProductVatTypeId: number | null = null;
let cachedProductUnitId: number | null = null;
let cachedCompanyId: number | null = null;

export function setCompanyId(id: number): void {
  cachedCompanyId = id;
}

export async function getCompanyId(
  client: TripletexClient,
): Promise<number> {
  if (cachedCompanyId) return cachedCompanyId;
  const result = await client.list<{ companyId: number }>("/employee", {
    from: "0",
    count: "1",
  });
  const emp = result.values?.[0];
  if (emp?.companyId) {
    cachedCompanyId = emp.companyId;
    return emp.companyId;
  }
  throw new Error("Could not determine company ID");
}

export async function getDefaultDepartmentId(
  client: TripletexClient,
): Promise<number> {
  if (cachedDefaultDepartmentId !== null) return cachedDefaultDepartmentId;

  const result = await client.list<Department>("/department", {
    from: "0",
    count: "1",
  });

  if (result.values.length > 0) {
    cachedDefaultDepartmentId = result.values[0].id;
    return cachedDefaultDepartmentId;
  }

  const created = await client.post<Department>("/department", {
    name: "Hovedavdeling",
  });
  cachedDefaultDepartmentId = created.value.id;
  return cachedDefaultDepartmentId;
}

export async function getDefaultCurrencyId(
  client: TripletexClient,
): Promise<number> {
  if (cachedNokCurrencyId !== null) return cachedNokCurrencyId;

  const result = await client.list<Currency>("/currency", {
    code: "NOK",
    from: "0",
    count: "1",
  });

  if (result.values.length > 0) {
    cachedNokCurrencyId = result.values[0].id;
    return cachedNokCurrencyId;
  }

  // Fallback: id 1 is typically NOK
  cachedNokCurrencyId = 1;
  return cachedNokCurrencyId;
}

async function loadVatTypes(client: TripletexClient): Promise<VatType[]> {
  if (cachedVatTypes !== null) return cachedVatTypes;
  const result = await client.list<VatType>("/ledger/vatType", {
    from: "0",
    count: "100",
  });
  cachedVatTypes = result.values;
  return cachedVatTypes;
}

export async function getDefaultProductVatTypeId(
  client: TripletexClient,
): Promise<number> {
  if (cachedProductVatTypeId !== null) return cachedProductVatTypeId;

  const vatTypes = await loadVatTypes(client);

  if (vatTypes.length > 0) {
    const code3 = vatTypes.find((v) => v.number === "3");
    if (code3) {
      cachedProductVatTypeId = code3.id;
      console.log(`[Helper] Using VAT type id=${code3.id} (code 3)`);
      return cachedProductVatTypeId;
    }

    const outgoingHigh = vatTypes.find(
      (v) =>
        v.name?.toLowerCase().includes("utgående") &&
        v.name?.toLowerCase().includes("høy"),
    );
    if (outgoingHigh) {
      cachedProductVatTypeId = outgoingHigh.id;
      console.log(`[Helper] Using VAT type id=${outgoingHigh.id} (${outgoingHigh.name})`);
      return cachedProductVatTypeId;
    }

    const anyOutgoing = vatTypes.find((v) =>
      v.name?.toLowerCase().includes("utgående"),
    );
    if (anyOutgoing) {
      cachedProductVatTypeId = anyOutgoing.id;
      console.log(`[Helper] Using VAT type id=${anyOutgoing.id} (${anyOutgoing.name})`);
      return cachedProductVatTypeId;
    }

    console.log(
      `[Helper] Available VAT types: ${vatTypes.map((v) => `${v.id}:${v.number}:${v.name}`).join(", ")}`,
    );
    cachedProductVatTypeId = vatTypes[0].id;
    return cachedProductVatTypeId;
  }

  console.warn("[Helper] No VAT types found, defaulting to id=3");
  cachedProductVatTypeId = 3;
  return cachedProductVatTypeId;
}

/**
 * Standard Norwegian outgoing VAT type numbers by rate.
 * These are the well-known "mva-kode" numbers used in Tripletex for sales/products.
 */
const OUTGOING_VAT_NUMBER_BY_RATE: Record<number, string> = {
  25: "3",   // Utgående avgift, høy sats
  15: "31",  // Utgående avgift, middels sats
  12: "33",  // Utgående avgift, lav sats
  0: "6",    // Ingen utgående avgift (utenfor mva-loven)
};

/**
 * Find a VAT type ID by percentage rate. Uses the standard Norwegian
 * outgoing VAT type numbers for deterministic matching.
 */
export async function findVatTypeIdByRate(
  client: TripletexClient,
  ratePercent: number,
): Promise<number> {
  if (ratePercent === 25) {
    return getDefaultProductVatTypeId(client);
  }

  const vatTypes = await loadVatTypes(client);

  // Match by the standard Norwegian VAT number first (most reliable)
  const expectedNumber = OUTGOING_VAT_NUMBER_BY_RATE[ratePercent];
  if (expectedNumber) {
    const byNumber = vatTypes.find((v) => String(v.number) === expectedNumber);
    if (byNumber) {
      console.log(`[Helper] VAT ${ratePercent}%: id=${byNumber.id} (code ${byNumber.number}: ${byNumber.name})`);
      return byNumber.id;
    }
  }

  // For 0%: also try code "5" (Ingen utgående avgift innenfor mva-loven)
  if (ratePercent === 0) {
    const code5 = vatTypes.find((v) => String(v.number) === "5");
    if (code5) {
      console.log(`[Helper] VAT 0%: id=${code5.id} (code 5: ${code5.name})`);
      return code5.id;
    }
  }

  // Fallback: match by percentage on outgoing types
  const outgoing = vatTypes.find(
    (v) => v.percentage === ratePercent && v.name?.toLowerCase().includes("utgående"),
  );
  if (outgoing) {
    console.log(`[Helper] VAT ${ratePercent}%: id=${outgoing.id} (${outgoing.name})`);
    return outgoing.id;
  }

  // Broader fallback: any type with matching percentage (some sandboxes lack outgoing middels/lav)
  const anyMatch = vatTypes.find(
    (v) => v.percentage === ratePercent && !v.name?.toLowerCase().includes("direktepostert"),
  );
  if (anyMatch) {
    console.log(`[Helper] VAT ${ratePercent}% (broad match): id=${anyMatch.id} (${anyMatch.name})`);
    return anyMatch.id;
  }

  console.log(`[Helper] No VAT type found for ${ratePercent}%, falling back to default 25%`);
  return getDefaultProductVatTypeId(client);
}

export async function getDefaultProductUnitId(
  client: TripletexClient,
): Promise<number> {
  if (cachedProductUnitId !== null) return cachedProductUnitId;

  const result = await client.list<ProductUnit>("/product/unit", {
    from: "0",
    count: "1",
  });

  if (result.values.length > 0) {
    cachedProductUnitId = result.values[0].id;
    return cachedProductUnitId;
  }

  cachedProductUnitId = 1;
  return cachedProductUnitId;
}

let cachedEmployees: Employee[] | null = null;

/**
 * Loads all employees in a single API call and caches them.
 * Subsequent calls to findEmployeeByName/findEmployeeByEmail use the cache
 * instead of making additional API calls.
 */
export async function loadEmployees(client: TripletexClient): Promise<Employee[]> {
  if (cachedEmployees) return cachedEmployees;
  const result = await client.list<Employee>("/employee", {
    from: "0",
    count: "50",
  });
  cachedEmployees = result.values;
  return cachedEmployees;
}

export async function findEmployeeByName(
  client: TripletexClient,
  firstName: string,
  lastName: string,
): Promise<Employee | null> {
  const employees = await loadEmployees(client);
  const fLower = firstName.toLowerCase();
  const lLower = lastName.toLowerCase();
  return employees.find(e =>
    e.firstName.toLowerCase() === fLower && e.lastName.toLowerCase() === lLower,
  ) ?? null;
}

export async function findEmployeeByEmail(
  client: TripletexClient,
  email: string,
): Promise<Employee | null> {
  const employees = await loadEmployees(client);
  const eLower = email.toLowerCase();
  return employees.find(e =>
    e.email?.toLowerCase() === eLower,
  ) ?? null;
}

export async function findCustomerByName(
  client: TripletexClient,
  name: string,
): Promise<Customer | null> {
  const result = await client.list<Customer>("/customer", {
    name,
    from: "0",
    count: "1",
  });
  return result.values[0] ?? null;
}

export async function findProductByNumber(
  client: TripletexClient,
  productNumber: string | number,
): Promise<Product | null> {
  const numStr = String(productNumber).trim();
  if (!/^\d+$/.test(numStr)) {
    return null;
  }
  const result = await client.list<Product>("/product", {
    number: numStr,
    from: "0",
    count: "1",
  });
  return result.values[0] ?? null;
}

export async function findProductByName(
  client: TripletexClient,
  name: string,
): Promise<Product | null> {
  const result = await client.list<Product>("/product", {
    name,
    from: "0",
    count: "1",
  });
  return result.values[0] ?? null;
}

/**
 * Warm the product-creation caches (department, unit, vatType) in a single
 * parallel batch so that subsequent findOrCreateProduct calls hit cache.
 */
export async function warmProductCaches(client: TripletexClient): Promise<void> {
  await Promise.all([
    getDefaultDepartmentId(client),
    getDefaultProductUnitId(client),
    getDefaultProductVatTypeId(client),
  ]);
}

export async function findOrCreateProduct(
  client: TripletexClient,
  name: string,
  unitPriceExcVat: number,
  vatTypeId?: number,
  skipSearch?: boolean,
): Promise<Product> {
  if (!skipSearch) {
    const existing = await findProductByName(client, name);
    if (existing) {
      console.log(`[Helper] Found existing product: ${name} (id=${existing.id})`);
      return existing;
    }
  }

  const [departmentId, unitId] = await Promise.all([
    getDefaultDepartmentId(client),
    getDefaultProductUnitId(client),
  ]);

  const body: Record<string, unknown> = {
    name,
    priceExcludingVatCurrency: unitPriceExcVat,
    department: { id: departmentId },
    productUnit: { id: unitId },
  };

  try {
    const created = await client.post<Product>("/product", body);
    console.log(`[Helper] Created product: ${name} (id=${created.value.id})`);
    return created.value;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    if (msg.includes("allerede registrert") || msg.includes("already registered")) {
      console.warn(`[Helper] Product "${name}" already exists, looking it up`);
      const existing = await findProductByName(client, name);
      if (existing) return existing;
    }

    throw err;
  }
}

/** Returns today's date as YYYY-MM-DD */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Returns a date N days from now as YYYY-MM-DD */
export function daysFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

let cachedPaymentTypeId: number | null = null;

export async function getPaymentTypeId(client: TripletexClient): Promise<number> {
  if (cachedPaymentTypeId) return cachedPaymentTypeId;
  const result = await client.list<{ id: number; description: string }>("/invoice/paymentType", {
    from: "0",
    count: "5",
  });
  if (result.values.length > 0) {
    cachedPaymentTypeId = result.values[0].id;
    return cachedPaymentTypeId;
  }
  throw new Error("No payment types available");
}

export function resetCaches(): void {
  cachedDefaultDepartmentId = null;
  cachedNokCurrencyId = null;
  cachedProductVatTypeId = null;
  cachedProductUnitId = null;
  cachedVatTypes = null;
  cachedCompanyId = null;
  bankAccountConfigured = false;
  cachedProjectManagerId = null;
  bulkAccountMap = null;
  cachedEmployees = null;
  cachedProductCatalog = null;
  cachedProductCatalogById = null;
  cachedProductCatalogByNumber = null;
  cachedPaymentTypeId = null;
}

// === Bulk Account Loader ===
// Fetches all ledger accounts in a single API call and caches them by number.
// Dramatically reduces API calls for handlers that need multiple accounts.

interface BulkLedgerAccount {
  id: number;
  number: number;
  name: string;
  bankAccountNumber?: string;
}

let bulkAccountMap: Map<number, BulkLedgerAccount> | null = null;

export async function loadAllAccounts(client: TripletexClient): Promise<Map<number, BulkLedgerAccount>> {
  if (bulkAccountMap) return bulkAccountMap;
  const result = await client.list<BulkLedgerAccount>("/ledger/account", {
    from: "0",
    count: "1000",
  });
  bulkAccountMap = new Map();
  for (const acc of result.values) {
    bulkAccountMap.set(acc.number, acc);
  }
  return bulkAccountMap;
}

export async function getAccountByNumber(
  client: TripletexClient,
  accountNumber: number,
): Promise<BulkLedgerAccount> {
  const accounts = await loadAllAccounts(client);
  const account = accounts.get(accountNumber);
  if (!account) throw new Error(`Ledger account ${accountNumber} not found`);
  return account;
}

export async function getMultipleAccountsByNumber(
  client: TripletexClient,
  accountNumbers: number[],
): Promise<Map<number, BulkLedgerAccount>> {
  const accounts = await loadAllAccounts(client);
  const result = new Map<number, BulkLedgerAccount>();
  for (const num of accountNumbers) {
    const account = accounts.get(num);
    if (account) result.set(num, account);
  }
  return result;
}

// === Bank Account Configuration ===
// Invoice creation requires a configured bank account on ledger account 1920

let bankAccountConfigured = false;

interface LedgerAccount {
  id: number;
  version: number;
  number: number;
  name: string;
  bankAccountNumber?: string;
}

export async function ensureBankAccountConfigured(
  client: TripletexClient,
): Promise<void> {
  if (bankAccountConfigured) return;

  // Find the bank account (1920 - Bankinnskudd)
  const accounts = await client.list<LedgerAccount>("/ledger/account", {
    isBankAccount: "true",
    from: "0",
    count: "5",
  });

  const bankAccount = accounts.values.find(
    (a) => a.number === 1920 || a.name.toLowerCase().includes("bankinnskudd"),
  );

  if (!bankAccount) {
    console.log("[Helper] No bank account found to configure");
    bankAccountConfigured = true; // Don't retry
    return;
  }

  // Check if already configured
  if (bankAccount.bankAccountNumber && bankAccount.bankAccountNumber.length > 0) {
    console.log(`[Helper] Bank account already configured: ${bankAccount.bankAccountNumber}`);
    bankAccountConfigured = true;
    return;
  }

  // Configure with a valid Norwegian bank account number (MOD11 validated)
  console.log(`[Helper] Configuring bank account ${bankAccount.number}...`);
  try {
    await client.put(`/ledger/account/${bankAccount.id}`, {
      id: bankAccount.id,
      version: bankAccount.version,
      number: bankAccount.number,
      name: bankAccount.name,
      bankAccountNumber: "15032686130", // Valid Norwegian MOD11 number
    });
    console.log("[Helper] Bank account configured successfully");
    bankAccountConfigured = true;
  } catch (err) {
    console.log("[Helper] Failed to configure bank account:", err);
    bankAccountConfigured = true; // Don't retry
  }
}

/**
 * Uses already-loaded bulk accounts to check/configure bank account 1920.
 * Saves 1 API call vs ensureBankAccountConfigured() when loadAllAccounts
 * has already been called.
 */
export async function ensureBankAccountFromBulkAccounts(
  client: TripletexClient,
  accountsMap: Map<number, BulkLedgerAccount>,
): Promise<void> {
  if (bankAccountConfigured) return;

  const bankAccount = accountsMap.get(1920);
  if (!bankAccount) {
    console.log("[Helper] No bank account 1920 in bulk accounts");
    bankAccountConfigured = true;
    return;
  }

  if (bankAccount.bankAccountNumber && bankAccount.bankAccountNumber.length > 0) {
    console.log(`[Helper] Bank account already configured: ${bankAccount.bankAccountNumber}`);
    bankAccountConfigured = true;
    return;
  }

  console.log(`[Helper] Configuring bank account ${bankAccount.number} from bulk...`);
  try {
    await client.put(`/ledger/account/${bankAccount.id}`, {
      id: bankAccount.id,
      number: bankAccount.number,
      name: bankAccount.name,
      bankAccountNumber: "15032686130",
    });
    console.log("[Helper] Bank account configured successfully");
    bankAccountConfigured = true;
  } catch (err) {
    console.log("[Helper] Failed to configure bank account:", err);
    bankAccountConfigured = true;
  }
}

// === Project Manager ===
// Projects require an employee with project manager entitlements
// The first employee in the sandbox typically has these rights

let cachedProjectManagerId: number | null = null;

export async function getProjectManagerEmployeeId(
  client: TripletexClient,
): Promise<number | null> {
  if (cachedProjectManagerId !== null) return cachedProjectManagerId;

  const employees = await loadEmployees(client);
  if (employees.length > 0) {
    cachedProjectManagerId = employees[0].id;
    console.log(`[Helper] Using project manager employee id=${cachedProjectManagerId}`);
    return cachedProjectManagerId;
  }

  return null;
}
