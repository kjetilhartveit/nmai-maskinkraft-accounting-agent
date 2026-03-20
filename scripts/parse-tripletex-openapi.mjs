#!/usr/bin/env node
/**
 * Extract task-handler-relevant info from Tripletex openapi.json (concise output).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const specPath = path.join(__dirname, "../docs/reports/tripletex-openapi.json");
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const schemas = spec.components?.schemas || {};
const paths = spec.paths || {};

const ENTITY_NAMES = [
  "Employee",
  "Customer",
  "Supplier",
  "Department",
  "Product",
  "Invoice",
  "Order",
  "TravelExpense",
  "Project",
  "Voucher",
  "OrderLine",
  "Posting",
];

function refName(ref) {
  if (!ref || typeof ref !== "string") return null;
  const m = ref.match(/#\/components\/schemas\/(.+)$/);
  return m ? m[1] : null;
}

function collectEnums(schema, depth = 0) {
  if (depth > 12) return [];
  if (!schema) return [];
  if (schema.enum) return [{ path: "", values: schema.enum.slice(0, 30) }];
  const out = [];
  if (schema.$ref) {
    const n = refName(schema.$ref);
    if (n && schemas[n]) return collectEnums(schemas[n], depth + 1);
  }
  if (schema.allOf) {
    for (const s of schema.allOf) out.push(...collectEnums(s, depth + 1));
  }
  if (schema.properties) {
    for (const [k, v] of Object.entries(schema.properties)) {
      const sub = collectEnums(v, depth + 1);
      for (const e of sub) {
        if (e.values?.length) out.push({ path: k + (e.path ? "." + e.path : ""), values: e.values });
      }
    }
  }
  if (schema.items) {
    out.push(...collectEnums(schema.items, depth + 1));
  }
  return out;
}

function schemaSummary(name) {
  const s = schemas[name];
  if (!s) return null;
  const req = s.required || [];
  const props = s.properties ? Object.keys(s.properties).slice(0, 80) : [];
  const enums = collectEnums(s).slice(0, 25);
  return { required: req, propertyCount: props.length, propertiesSample: props, enums };
}

function postBodiesForPath(p) {
  const ops = paths[p] || {};
  const rows = [];
  for (const method of ["post", "put", "patch"]) {
    const op = ops[method];
    if (!op) continue;
    const body = op.requestBody?.content?.["application/json; charset=utf-8"]?.schema
      || op.requestBody?.content?.["application/json"]?.schema;
    let schemaName = null;
    if (body?.$ref) schemaName = refName(body.$ref);
    else if (body?.items?.$ref) schemaName = refName(body.items.$ref) + "[]";
    rows.push({
      method: method.toUpperCase(),
      operationId: op.operationId,
      requestSchema: schemaName || (body?.type === "array" ? "array" : JSON.stringify(body?.type || "?")),
    });
  }
  return rows;
}

// --- POST / batch endpoints filter ---
const postEndpoints = [];
const batchList = [];
for (const [p, ops] of Object.entries(paths)) {
  for (const method of ["post", "put"]) {
    const op = ops[method];
    if (!op) continue;
    if (method !== "post" && method !== "put") continue;
    const isBatch = p.includes("/list") || p.includes("/:batch") || /\/list$/.test(p);
    const summary = (op.summary || "").slice(0, 120);
    const body =
      op.requestBody?.content?.["application/json; charset=utf-8"]?.schema ||
      op.requestBody?.content?.["application/json"]?.schema;
    let schemaHint = "";
    if (body?.$ref) schemaHint = refName(body.$ref);
    else if (body?.type === "array" && body.items?.$ref) schemaHint = refName(body.items.$ref) + "[]";

    postEndpoints.push({
      path: p,
      method: method.toUpperCase(),
      operationId: op.operationId,
      summary,
      bodySchema: schemaHint,
    });
    if (method === "post" && (p.endsWith("/list") || p.includes("/list"))) {
      batchList.push({ path: p, operationId: op.operationId, bodySchema: schemaHint, summary });
    }
  }
}

// Key resource paths (first segment)
const KEY_PREFIXES = [
  "/employee",
  "/customer",
  "/supplier",
  "/department",
  "/product",
  "/invoice",
  "/order",
  "/travelExpense",
  "/project",
  "/voucher",
  "/ledger/voucher", // if any
];

const filteredPosts = postEndpoints.filter(
  (e) => KEY_PREFIXES.some((k) => e.path === k || e.path.startsWith(k + "/"))
);

console.log("=== SPEC INFO ===");
console.log("version:", spec.info?.version);
console.log("paths:", Object.keys(paths).length);
console.log("POST+PUT total:", postEndpoints.length);
console.log("POST /list batch-style:", batchList.length);

console.log("\n=== BATCH /list POST (key prefixes) ===");
for (const b of batchList.filter((x) => KEY_PREFIXES.some((k) => x.path.startsWith(k)))) {
  console.log(b.path, "->", b.bodySchema || "?", b.operationId);
}

console.log("\n=== KEY ENTITY SCHEMA SUMMARIES ===");
for (const name of ENTITY_NAMES) {
  const sum = schemaSummary(name);
  if (!sum) {
    console.log(name, ": (no schema)");
    continue;
  }
  console.log("\n--", name, "--");
  console.log("  required[]:", sum.required.length ? sum.required.join(", ") : "(none in schema)");
  console.log("  properties:", sum.propertyCount, sum.propertiesSample.slice(0, 40).join(", ") + (sum.propertyCount > 40 ? "..." : ""));
  if (sum.enums.length) {
    for (const e of sum.enums.slice(0, 15)) {
      console.log("  enum", e.path + ":", e.values.join("|"));
    }
  }
}

console.log("\n=== POST/PUT FOR KEY RESOURCES (concise) ===");
for (const e of filteredPosts.sort((a, b) => a.path.localeCompare(b.path))) {
  if (e.method === "PUT" && !e.path.match(/\{id\}/)) continue;
  console.log(e.method, e.path, e.bodySchema || "-", "|", e.operationId);
}

// List GET pagination params from one typical list endpoint
const sampleList = paths["/employee"]?.get;
if (sampleList?.parameters) {
  const names = sampleList.parameters.map((p) => p.name).filter(Boolean);
  console.log("\n=== Sample GET /employee query params ===");
  console.log(names.join(", "));
}
