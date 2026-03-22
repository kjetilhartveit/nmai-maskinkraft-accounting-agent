import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ApiCallLog } from "../types/index.js";
import type { EntityType, ExpectedEntity } from "./types.js";

export interface VerifyResult {
  verified: boolean;
  failures: string[];
  checks: number;
}

const API_LOG_PATTERNS: Partial<
  Record<EntityType, { method: string; pathMatch: string; successStatus: number[] }>
> = {
  invoice: { method: "POST", pathMatch: "/invoice", successStatus: [201] },
  order: { method: "POST", pathMatch: "/order", successStatus: [201] },
  activity: { method: "POST", pathMatch: "/activity", successStatus: [201] },
  travelExpense: { method: "POST", pathMatch: "/travelExpense", successStatus: [201] },
  timesheetEntry: { method: "POST", pathMatch: "/timesheet/entry", successStatus: [201] },
  payment: { method: "PUT", pathMatch: "/:payment", successStatus: [200] },
  creditNote: { method: "PUT", pathMatch: "/:createCreditNote", successStatus: [200] },
  project: { method: "POST", pathMatch: "/project", successStatus: [201] },
  dimension: { method: "POST", pathMatch: "/ledger/accountingDimensionName", successStatus: [201] },
  voucher: { method: "POST", pathMatch: "/ledger/voucher", successStatus: [201] },
  employee: { method: "POST", pathMatch: "/employee", successStatus: [201] },
  customer: { method: "POST", pathMatch: "/customer", successStatus: [201] },
  supplier: { method: "POST", pathMatch: "/supplier", successStatus: [201] },
  product: { method: "POST", pathMatch: "/product", successStatus: [201] },
  department: { method: "POST", pathMatch: "/department", successStatus: [201] },
};

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function tomorrowStr(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

export async function verifySandboxEntities(
  client: TripletexClient,
  entities: ExpectedEntity[],
  apiCallDetails: ApiCallLog[],
): Promise<VerifyResult> {
  if (entities.length === 0) return { verified: true, failures: [], checks: 0 };

  const failures: string[] = [];
  let checks = 0;

  for (const entity of entities) {
    checks++;
    const { _type, _minCount, ...fields } = entity;
    const minCount = (typeof _minCount === "number" ? _minCount : undefined) ?? 1;
    let found = false;

    try {
      if (hasSearchableFields(fields)) {
        found = await verifyViaGet(client, _type as EntityType, fields, minCount);
      }
      if (!found) {
        found = verifyViaApiLog(apiCallDetails, _type as EntityType, minCount);
      }
    } catch {
      found = verifyViaApiLog(apiCallDetails, _type as EntityType, minCount);
    }

    if (!found) {
      const label = Object.keys(fields).length > 0 ? `${_type}: ${JSON.stringify(fields)}` : String(_type);
      failures.push(label);
    }
  }

  return { verified: failures.length === 0, failures, checks };
}

function hasSearchableFields(fields: Record<string, unknown>): boolean {
  return ["name", "firstName", "lastName", "organizationNumber", "description"].some(
    (f) => f in fields && fields[f] !== undefined,
  );
}

async function verifyViaGet(
  client: TripletexClient,
  type: EntityType,
  fields: Record<string, unknown>,
  minCount: number,
): Promise<boolean> {
  switch (type) {
    case "customer":
    case "supplier":
      return verifyByNameSearch(client, `/${type}`, fields, minCount);
    case "employee":
      return verifyEmployee(client, fields, minCount);
    case "department":
      return verifyByNameSearch(client, "/department", fields, minCount);
    case "product":
      return verifyByNameSearch(client, "/product", fields, minCount);
    case "project":
      return verifyByNameSearch(client, "/project", fields, minCount);
    case "voucher":
      return verifyVoucher(client, fields);
    default:
      return false;
  }
}

async function verifyByNameSearch(
  client: TripletexClient,
  endpoint: string,
  fields: Record<string, unknown>,
  minCount: number,
): Promise<boolean> {
  const name = String(fields.name ?? "");
  if (!name) return false;

  const params: Record<string, string> = { from: "0", count: "1000", name };
  if (fields.organizationNumber) params.organizationNumber = String(fields.organizationNumber);

  const result = await client.list<{ id: number; name?: string }>(endpoint, params);
  const matches = result.values.filter(
    (v) => v.name && v.name.toLowerCase().includes(name.toLowerCase()),
  );
  return matches.length >= minCount;
}

async function verifyEmployee(
  client: TripletexClient,
  fields: Record<string, unknown>,
  minCount: number,
): Promise<boolean> {
  const params: Record<string, string> = { from: "0", count: "100" };
  if (fields.firstName) params.firstName = String(fields.firstName);
  if (fields.lastName) params.lastName = String(fields.lastName);

  const result = await client.list<{ id: number }>("/employee", params);
  return result.values.length >= minCount;
}

async function verifyVoucher(
  client: TripletexClient,
  fields: Record<string, unknown>,
): Promise<boolean> {
  const description = String(fields.description ?? "");
  if (!description) return false;

  const result = await client.list<{ id: number; description?: string }>(
    "/ledger/voucher",
    { dateFrom: todayStr(), dateTo: tomorrowStr(), from: "0", count: "100" },
  );
  return result.values.some(
    (v) => v.description?.toLowerCase().includes(description.toLowerCase()),
  );
}

function verifyViaApiLog(
  apiCallDetails: ApiCallLog[],
  type: EntityType,
  minCount: number,
): boolean {
  const pattern = API_LOG_PATTERNS[type];
  if (!pattern) return false;

  const matches = apiCallDetails.filter((d) => {
    if (d.method !== pattern.method) return false;
    if (!pattern.successStatus.includes(d.status)) return false;
    const ep = d.endpoint.split("?")[0];
    if (pattern.method === "PUT") return ep.includes(pattern.pathMatch);
    // Match exact path or batch /list variant (e.g. /department or /department/list)
    return ep === pattern.pathMatch || ep === `${pattern.pathMatch}/list`;
  });
  return matches.length >= minCount;
}
