/**
 * Summarize OpenAPI component schemas: required, properties with types/refs/enums.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const specPath = process.argv[2] || path.join(__dirname, "..", "tripletex-openapi.json");
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const schemas = spec.components?.schemas || {};

function refName(ref) {
  if (!ref || typeof ref !== "string") return null;
  const m = ref.match(/#\/components\/schemas\/(.+)$/);
  return m ? m[1] : null;
}

function summarizeProp(name, s, depth = 0) {
  if (depth > 4) return { name, note: "max depth" };
  if (!s) return { name, type: "unknown" };
  if (s.$ref) {
    const rn = refName(s.$ref);
    return { name, ref: rn, openapiRef: s.$ref };
  }
  if (s.allOf) {
    const parts = s.allOf.map((x, i) => summarizeProp(`${name}[allOf${i}]`, x, depth + 1));
    return { name, allOf: parts };
  }
  const out = { name };
  if (s.type) out.type = s.type;
  if (s.format) out.format = s.format;
  if (s.enum) out.enum = s.enum;
  if (s.description) out.description = String(s.description).replace(/\s+/g, " ").slice(0, 280);
  if (s.readOnly) out.readOnly = true;
  if (s.writeOnly) out.writeOnly = true;
  if (s.nullable) out.nullable = true;
  if (s.type === "array" && s.items) {
    out.items = summarizeProp("items", s.items, depth + 1);
  }
  if (s.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(s.properties)) {
      out.properties[k] = summarizeProp(k, v, depth + 1);
    }
  }
  return out;
}

function summarizeSchema(schemaName) {
  const s = schemas[schemaName];
  if (!s) return { error: `Unknown schema: ${schemaName}` };
  const merged = s.allOf ? { type: "object", properties: {}, required: [] } : s;
  if (s.allOf) {
    for (const part of s.allOf) {
      const r = part.$ref ? schemas[refName(part.$ref)] : part;
      if (r?.properties) Object.assign(merged.properties, r.properties);
      if (r?.required) merged.required = [...new Set([...(merged.required || []), ...r.required])];
    }
  }
  const req = merged.required || s.required || [];
  const props = merged.properties || s.properties || {};
  const summary = {
    schema: schemaName,
    required: req,
    properties: {},
  };
  for (const [k, v] of Object.entries(props)) {
    summary.properties[k] = summarizeProp(k, v);
  }
  return summary;
}

function getRequestSchemaForPath(pathKey, method) {
  const p = spec.paths[pathKey]?.[method];
  if (!p?.requestBody?.content) return null;
  const c = p.requestBody.content;
  const content = c["application/json"] || c["application/json; charset=utf-8"] || Object.values(c)[0];
  const sch = content?.schema;
  if (!sch) return null;
  if (sch.$ref) return refName(sch.$ref);
  return sch;
}

const SCHEMA_NAMES = [
  "Employee",
  "Customer",
  "Supplier",
  "Product",
  "Department",
  "Invoice",
  "Order",
  "TravelExpense",
  "Project",
  "LedgerVoucher",
  "Posting",
  "Account",
  "ListResponseEmployee",
  "ListResponseCustomer",
  "ListResponseSupplier",
  "ListResponseProduct",
  "ListResponseDepartment",
  "ListResponseInvoice",
  "ListResponseOrder",
  "ListResponseTravelExpense",
  "ListResponseProject",
  "ListResponseLedgerVoucher",
  "ListResponsePosting",
  "ListResponseAccount",
  "ListResponseCurrency",
  "ListResponseLedgerVatType",
  "EmployeeListRequest", // guess - need to find actual names
];

// Discover wrapper/list request types from paths
function discoverListRequestTypes() {
  const paths = [
    ["/employee/list", "post"],
    ["/customer/list", "post"],
    ["/supplier/list", "post"],
    ["/product/list", "post"],
    ["/department/list", "post"],
    ["/invoice/list", "post"],
    ["/order/list", "post"],
    ["/project/list", "post"],
    ["/ledger/voucher", "post"],
  ];
  const out = {};
  for (const [pk, m] of paths) {
    const name = getRequestSchemaForPath(pk, m);
    out[`${m.toUpperCase()} ${pk}`] = name;
  }
  return out;
}

const listReq = discoverListRequestTypes();

const extra = [];
for (const v of Object.values(listReq)) {
  if (v && typeof v === "string" && !SCHEMA_NAMES.includes(v)) extra.push(v);
}

const toDump = [...new Set([...SCHEMA_NAMES, ...extra])].filter((n) => schemas[n]);

const output = {
  listPostRequestSchemas: listReq,
  summaries: {},
};
for (const n of toDump.sort()) {
  output.summaries[n] = summarizeSchema(n);
}

console.log(JSON.stringify(output, null, 2));
