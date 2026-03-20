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
}

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

export async function getDefaultProductVatTypeId(
  client: TripletexClient,
): Promise<number> {
  if (cachedProductVatTypeId !== null) return cachedProductVatTypeId;

  // Fetch VAT types and prefer one suitable for product sales (outgoing, high rate)
  const result = await client.list<VatType>("/ledger/vatType", {
    from: "0",
    count: "50",
  });

  if (result.values.length > 0) {
    // Try to find "utgående" (outgoing) standard VAT
    const outgoing = result.values.find(
      (v) =>
        v.name?.toLowerCase().includes("utgående") &&
        v.name?.toLowerCase().includes("høy"),
    );
    cachedProductVatTypeId = outgoing?.id ?? result.values[0].id;
    return cachedProductVatTypeId;
  }

  cachedProductVatTypeId = 6; // Sandbox default from testing
  return cachedProductVatTypeId;
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

export async function findOrCreateProduct(
  client: TripletexClient,
  name: string,
  unitPriceExcVat: number,
): Promise<Product> {
  // Check if product already exists
  const result = await client.list<Product>("/product", {
    name,
    from: "0",
    count: "1",
  });
  if (result.values.length > 0) return result.values[0];

  // Create it
  const [departmentId, vatTypeId, unitId] = await Promise.all([
    getDefaultDepartmentId(client),
    getDefaultProductVatTypeId(client),
    getDefaultProductUnitId(client),
  ]);

  const created = await client.post<Product>("/product", {
    name,
    priceExcludingVatCurrency: unitPriceExcVat,
    vatType: { id: vatTypeId },
    department: { id: departmentId },
    productUnit: { id: unitId },
  });
  return created.value;
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
}
