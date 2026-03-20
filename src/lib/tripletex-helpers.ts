import type { TripletexClient } from "./tripletex-client.js";

interface Department {
  id: number;
  name: string;
}

interface Employee {
  id: number;
  firstName: string;
  lastName: string;
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
 * Find a VAT type ID by percentage rate. Falls back to the default 25% VAT type.
 * Matches "utgående" (outgoing/sales) VAT types by looking at the name and percentage.
 */
export async function findVatTypeIdByRate(
  client: TripletexClient,
  ratePercent: number,
): Promise<number> {
  const vatTypes = await loadVatTypes(client);

  if (ratePercent === 0) {
    const exempt = vatTypes.find(
      (v) =>
        v.percentage === 0 ||
        v.name?.toLowerCase().includes("fritatt") ||
        v.name?.toLowerCase().includes("avgiftsfri") ||
        v.number === "6",
    );
    if (exempt) {
      console.log(`[Helper] VAT 0%: id=${exempt.id} (${exempt.name})`);
      return exempt.id;
    }
  }

  if (ratePercent === 15 || ratePercent === 12) {
    const medium = vatTypes.find(
      (v) =>
        (v.percentage === ratePercent ||
          v.name?.toLowerCase().includes("middels") ||
          v.name?.toLowerCase().includes("lav")) &&
        v.name?.toLowerCase().includes("utgående"),
    );
    if (medium) {
      console.log(`[Helper] VAT ${ratePercent}%: id=${medium.id} (${medium.name})`);
      return medium.id;
    }
  }

  if (ratePercent === 25) {
    return getDefaultProductVatTypeId(client);
  }

  // Try percentage match on any outgoing type
  const match = vatTypes.find(
    (v) => v.percentage === ratePercent && v.name?.toLowerCase().includes("utgående"),
  );
  if (match) {
    console.log(`[Helper] VAT ${ratePercent}%: id=${match.id} (${match.name})`);
    return match.id;
  }

  console.log(`[Helper] No VAT type found for ${ratePercent}%, falling back to default`);
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

export async function findEmployeeByName(
  client: TripletexClient,
  firstName: string,
  lastName: string,
): Promise<Employee | null> {
  const result = await client.list<Employee>("/employee", {
    firstName,
    lastName,
    from: "0",
    count: "1",
  });
  return result.values[0] ?? null;
}

export async function findEmployeeByEmail(
  client: TripletexClient,
  email: string,
): Promise<Employee | null> {
  const result = await client.list<Employee>("/employee", {
    email,
    from: "0",
    count: "1",
  });
  return result.values[0] ?? null;
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
  const result = await client.list<Product>("/product", {
    number: String(productNumber),
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

export async function findOrCreateProduct(
  client: TripletexClient,
  name: string,
  unitPriceExcVat: number,
  vatTypeId?: number,
): Promise<Product> {
  const existing = await findProductByName(client, name);
  if (existing) {
    console.log(`[Helper] Found existing product: ${name} (id=${existing.id})`);
    return existing;
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

  if (vatTypeId) {
    body.vatType = { id: vatTypeId };
  }

  try {
    const created = await client.post<Product>("/product", body);
    console.log(`[Helper] Created product: ${name} (id=${created.value.id})`);
    return created.value;
  } catch {
    // If VAT type was specified, retry without it; otherwise try default VAT
    if (vatTypeId) {
      delete body.vatType;
    } else {
      const defaultVatTypeId = await getDefaultProductVatTypeId(client);
      body.vatType = { id: defaultVatTypeId };
    }
    const created = await client.post<Product>("/product", body);
    console.log(`[Helper] Created product (fallback): ${name} (id=${created.value.id})`);
    return created.value;
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

export function resetCaches(): void {
  cachedDefaultDepartmentId = null;
  cachedNokCurrencyId = null;
  cachedProductVatTypeId = null;
  cachedProductUnitId = null;
  cachedVatTypes = null;
  cachedCompanyId = null;
  bankAccountConfigured = false;
  cachedProjectManagerId = null;
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

// === Project Manager ===
// Projects require an employee with project manager entitlements
// The first employee in the sandbox typically has these rights

let cachedProjectManagerId: number | null = null;

export async function getProjectManagerEmployeeId(
  client: TripletexClient,
): Promise<number | null> {
  if (cachedProjectManagerId !== null) return cachedProjectManagerId;

  // The first employee in the sandbox typically has project manager rights
  const result = await client.list<Employee>("/employee", {
    from: "0",
    count: "1",
  });

  if (result.values.length > 0) {
    cachedProjectManagerId = result.values[0].id;
    console.log(`[Helper] Using project manager employee id=${cachedProjectManagerId}`);
    return cachedProjectManagerId;
  }

  return null;
}
