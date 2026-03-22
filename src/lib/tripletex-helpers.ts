import { TripletexApiError, type TripletexClient } from "./tripletex-client.js";

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

interface ProductUnit {
  id: number;
  name: string;
}

interface Product {
  id: number;
  name: string;
}

export async function getCompanyId(
  client: TripletexClient,
): Promise<number> {
  const result = await client.list<{ companyId: number }>("/employee", {
    from: "0",
    count: "1",
  });
  const emp = result.values?.[0];
  if (emp?.companyId) return emp.companyId;
  throw new Error("Could not determine company ID");
}

export async function getDefaultDepartmentId(
  client: TripletexClient,
): Promise<number> {
  const result = await client.list<Department>("/department", {
    from: "0",
    count: "1",
  });

  if (result.values.length > 0) return result.values[0].id;

  const created = await client.post<Department>("/department", {
    name: "Hovedavdeling",
  });
  return created.value.id;
}

export async function getDefaultCurrencyId(
  client: TripletexClient,
): Promise<number> {
  const result = await client.list<Currency>("/currency", {
    code: "NOK",
    from: "0",
    count: "1",
  });

  if (result.values.length > 0) return result.values[0].id;
  return 1;
}

async function loadVatTypes(client: TripletexClient): Promise<VatType[]> {
  const result = await client.list<VatType>("/ledger/vatType", {
    from: "0",
    count: "100",
  });
  return result.values;
}

export async function getDefaultProductVatTypeId(
  client: TripletexClient,
): Promise<number> {
  const vatTypes = await loadVatTypes(client);

  if (vatTypes.length > 0) {
    const code3 = vatTypes.find((v) => v.number === "3");
    if (code3) return code3.id;

    const outgoingHigh = vatTypes.find(
      (v) =>
        v.name?.toLowerCase().includes("utgående") &&
        v.name?.toLowerCase().includes("høy"),
    );
    if (outgoingHigh) return outgoingHigh.id;

    const anyOutgoing = vatTypes.find((v) =>
      v.name?.toLowerCase().includes("utgående"),
    );
    if (anyOutgoing) return anyOutgoing.id;

    return vatTypes[0].id;
  }

  console.warn("[Helper] No VAT types found, defaulting to id=3");
  return 3;
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
  const result = await client.list<ProductUnit>("/product/unit", {
    from: "0",
    count: "1",
  });

  if (result.values.length > 0) return result.values[0].id;
  return 1;
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


// === Bank Account Configuration ===
// Invoice creation requires a configured bank account on ledger account 1920

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
    return;
  }

  if (bankAccount.bankAccountNumber && bankAccount.bankAccountNumber.length > 0) {
    console.log(`[Helper] Bank account already configured: ${bankAccount.bankAccountNumber}`);
    return;
  }

  console.log(`[Helper] Configuring bank account ${bankAccount.number}...`);
  try {
    await client.put(`/ledger/account/${bankAccount.id}`, {
      id: bankAccount.id,
      version: bankAccount.version,
      number: bankAccount.number,
      name: bankAccount.name,
      bankAccountNumber: "15032686130",
    });
    console.log("[Helper] Bank account configured successfully");
  } catch (err) {
    console.log("[Helper] Failed to configure bank account:", err);
  }
}

// === Project Manager ===
// Projects require an employee with project manager entitlements
// The first employee in the sandbox typically has these rights

export async function getProjectManagerEmployeeId(
  client: TripletexClient,
): Promise<number | null> {
  const result = await client.list<Employee>("/employee", {
    from: "0",
    count: "1",
  });

  if (result.values.length > 0) {
    console.log(`[Helper] Using project manager employee id=${result.values[0].id}`);
    return result.values[0].id;
  }

  return null;
}

// === Activity ===

interface Activity {
  id: number;
  name: string;
}

async function loadActivities(client: TripletexClient): Promise<Activity[]> {
  const result = await client.list<Activity>("/activity", { from: "0", count: "2000" });
  return result.values;
}

function normActivityName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

async function findActivityIdByName(client: TripletexClient, name: string): Promise<number | null> {
  const n = normActivityName(name);
  try {
    const filtered = await client.list<Activity>("/activity", {
      name: name.slice(0, 255),
      from: "0",
      count: "50",
    });
    const hit = filtered.values.find((a) => normActivityName(a.name ?? "") === n);
    if (hit) return hit.id;
  } catch {
    /* name filter may be unsupported */
  }
  const activities = await loadActivities(client);
  const exact = activities.find((a) => normActivityName(a.name ?? "") === n);
  if (exact) return exact.id;
  const partial = activities.find((a) => {
    const an = normActivityName(a.name ?? "");
    return an.includes(n) || n.includes(an);
  });
  return partial?.id ?? null;
}

/**
 * POST /ledger/voucher — some sandboxes use AP accounts where `supplier` on a posting
 * is rejected as an unknown property; others require it. Retry without supplier on 422.
 */
export async function postLedgerVoucherWithSupplierFallback(
  client: TripletexClient,
  body: Record<string, unknown>,
): Promise<{ value: { id: number } }> {
  try {
    return await client.post<{ id: number }>("/ledger/voucher", body);
  } catch (err) {
    if (!(err instanceof TripletexApiError) || err.status !== 422) throw err;
    const text = `${err.body} ${err.message}`;
    const supplierUnknown =
      text.includes("supplier") &&
      (text.includes("eksisterer ikke") ||
        text.includes("does not exist") ||
        text.includes("Unknown") ||
        text.includes("Unrecognized"));
    if (!supplierUnknown) throw err;
    const postings = body.postings as Record<string, unknown>[] | undefined;
    if (!Array.isArray(postings)) throw err;
    const stripped = {
      ...body,
      postings: postings.map((p) => {
        const { supplier: _s, ...rest } = p;
        return rest;
      }),
    };
    console.warn("[Helper] Retrying voucher POST without supplier on posting (API rejected supplier field)");
    return await client.post<{ id: number }>("/ledger/voucher", stripped);
  }
}

/**
 * Find an existing activity by name or create one. Handles the common sandbox
 * scenario where activity names persist across test runs.
 */
export async function findOrCreateActivity(
  client: TripletexClient,
  name: string,
): Promise<number> {
  const existingId = await findActivityIdByName(client, name);
  if (existingId != null) {
    console.log(`[Helper] Found existing activity: "${name}" id=${existingId}`);
    return existingId;
  }

  try {
    const result = await client.post<Activity>("/activity", {
      name: name.slice(0, 255),
      activityType: "PROJECT_GENERAL_ACTIVITY",
    });
    console.log(`[Helper] Created activity: "${name}" id=${result.value.id}`);
    return result.value.id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("422") || msg.includes("i bruk") || msg.includes("in use")) {
      const retryId = await findActivityIdByName(client, name);
      if (retryId != null) {
        console.log(`[Helper] Found activity on retry: "${name}" id=${retryId}`);
        return retryId;
      }
      const refreshed = await loadActivities(client);
      if (refreshed.length > 0) {
        const fallback = refreshed[0];
        console.log(`[Helper] Using fallback activity: "${fallback.name}" id=${fallback.id}`);
        return fallback.id;
      }
    }
    throw new Error(`Cannot find or create activity "${name}": ${msg}`);
  }
}
