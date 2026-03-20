#!/usr/bin/env node
/**
 * Extract Tripletex OpenAPI details for accounting agent documentation.
 * Usage: node scripts/extract-tripletex-openapi-report.mjs [path-to-openapi.json]
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const specPath =
  process.argv[2] || path.join(__dirname, "..", "tripletex-openapi.json");
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const schemas = spec.components?.schemas || {};

function resolveRef(ref) {
  if (!ref || typeof ref !== "string") return null;
  const m = ref.match(/^#\/components\/schemas\/(.+)$/);
  if (!m) return null;
  return schemas[m[1]] || null;
}

function mergeAllOf(parts) {
  const out = { type: "object", properties: {}, required: [] };
  for (const p of parts) {
    const r = p.$ref ? resolveRef(p.$ref) : p;
    if (!r) continue;
    if (r.allOf) {
      const m = mergeAllOf(r.allOf);
      Object.assign(out.properties, m.properties);
      out.required = [...new Set([...(out.required || []), ...(m.required || [])])];
    } else {
      if (r.properties) Object.assign(out.properties, r.properties);
      if (r.required) out.required = [...new Set([...(out.required || []), ...r.required])];
      if (r.type && !out.type) out.type = r.type;
    }
  }
  return out;
}

function expandSchema(s, depth = 0, seen = new Set()) {
  if (depth > 12) return { note: "max depth" };
  if (!s) return {};
  if (s.$ref) {
    const name = s.$ref.split("/").pop();
    if (seen.has(name)) return { $ref: s.$ref, circular: true };
    seen.add(name);
    const base = resolveRef(s.$ref);
    if (!base) return { $ref: s.$ref, unresolved: true };
    const ex = expandSchema(base, depth + 1, seen);
    return { $ref: s.$ref, ...ex };
  }
  if (s.allOf) {
    const merged = mergeAllOf(s.allOf);
    return expandSchema(merged, depth, seen);
  }
  if (s.oneOf) {
    return {
      oneOf: s.oneOf.map((x) => expandSchema(x, depth + 1, new Set(seen))),
    };
  }
  if (s.anyOf) {
    return {
      anyOf: s.anyOf.map((x) => expandSchema(x, depth + 1, new Set(seen))),
    };
  }
  const out = {};
  if (s.type !== undefined) out.type = s.type;
  if (s.format) out.format = s.format;
  if (s.enum) out.enum = s.enum;
  if (s.description) out.description = String(s.description).slice(0, 500);
  if (s.default !== undefined) out.default = s.default;
  if (s.nullable) out.nullable = true;
  if (s.readOnly) out.readOnly = true;
  if (s.writeOnly) out.writeOnly = true;
  if (Array.isArray(s.required)) out.required = s.required;

  if (s.type === "array" && s.items) {
    out.items = expandSchema(s.items, depth + 1, seen);
  }
  if (s.type === "object" || s.properties) {
    out.type = out.type || "object";
    out.properties = {};
    for (const [k, v] of Object.entries(s.properties || {})) {
      out.properties[k] = expandSchema(v, depth + 1, new Set(seen));
    }
    if (s.additionalProperties && s.additionalProperties !== false) {
      out.additionalProperties =
        typeof s.additionalProperties === "object"
          ? expandSchema(s.additionalProperties, depth + 1, seen)
          : s.additionalProperties;
    }
  }
  return out;
}

function summarizeForMarkdown(expanded, indent = 0) {
  const pad = "  ".repeat(indent);
  const lines = [];
  if (expanded.$ref) lines.push(`${pad}- **ref:** \`${expanded.$ref}\``);
  if (expanded.type) lines.push(`${pad}- type: \`${expanded.type}\``);
  if (expanded.enum) lines.push(`${pad}- enum: ${JSON.stringify(expanded.enum)}`);
  if (expanded.format) lines.push(`${pad}- format: \`${expanded.format}\``);
  if (expanded.description) lines.push(`${pad}- _${expanded.description.replace(/\n/g, " ").slice(0, 200)}_`);
  if (expanded.items) {
    lines.push(`${pad}- items:`);
    lines.push(...summarizeForMarkdown(expanded.items, indent + 1));
  }
  if (expanded.properties) {
    for (const [k, v] of Object.entries(expanded.properties)) {
      lines.push(`${pad}- **\`${k}\`**: `);
      const sub = summarizeForMarkdown(v, 0).map((l) => (l.startsWith("-") ? l : `- ${l}`));
      lines.push(...sub.map((l) => `${pad}  ${l.replace(/^- /, "")}`));
    }
  }
  if (expanded.oneOf) {
    lines.push(`${pad}- oneOf (alternatives):`);
    expanded.oneOf.forEach((alt, i) => {
      lines.push(`${pad}  - variant ${i + 1}:`);
      lines.push(...summarizeForMarkdown(alt, indent + 2));
    });
  }
  if (expanded.anyOf) {
    lines.push(`${pad}- anyOf:`);
    expanded.anyOf.forEach((alt, i) => {
      lines.push(`${pad}  - ${i + 1}:`);
      lines.push(...summarizeForMarkdown(alt, indent + 2));
    });
  }
  if (expanded.circular) lines.push(`${pad}- _(circular ref)_`);
  return lines.filter(Boolean);
}

/** Flatten property paths with resource hints */
function collectRefFields(expanded, prefix = "", acc = []) {
  if (!expanded || typeof expanded !== "object") return acc;
  const name = prefix.split(".").filter(Boolean).pop() || "";
  const refLike =
    /^(id|.*Id|.*\.id)$/.test(name) ||
    /(customer|supplier|employee|department|product|project|account|vatType|currency|order|invoice|voucher|company|bank|payment)/i.test(
      name,
    );
  if (expanded.$ref && refLike) {
    acc.push({ path: prefix || "(root)", ref: expanded.$ref });
  }
  if (expanded.properties) {
    for (const [k, v] of Object.entries(expanded.properties)) {
      const p = prefix ? `${prefix}.${k}` : k;
      collectRefFields(v, p, acc);
    }
  }
  if (expanded.items) collectRefFields(expanded.items, `${prefix}[]`, acc);
  if (expanded.oneOf) expanded.oneOf.forEach((x) => collectRefFields(x, prefix, acc));
  if (expanded.anyOf) expanded.anyOf.forEach((x) => collectRefFields(x, prefix, acc));
  return acc;
}

const TARGET_PATHS = [
  "/employee",
  "/employee/{id}",
  "/employee/list",
  "/customer",
  "/customer/{id}",
  "/customer/list",
  "/supplier",
  "/supplier/{id}",
  "/supplier/list",
  "/product",
  "/product/{id}",
  "/product/list",
  "/department",
  "/department/{id}",
  "/department/list",
  "/invoice",
  "/invoice/list",
  "/invoice/{id}",
  "/invoice/{id}/:createCreditNote",
  "/invoice/{id}/:send",
  "/order",
  "/order/list",
  "/order/{id}",
  "/order/{id}/:invoice",
  "/order/:invoiceMultipleOrders",
  "/travelExpense",
  "/travelExpense/{id}",
  "/travelExpense/list",
  "/travelExpense/{travelExpenseId}/attachment",
  "/travelExpense/{travelExpenseId}/attachment/list",
  "/project",
  "/project/list",
  "/project/{id}",
  "/ledger/voucher",
  "/ledger/voucher/list",
  "/ledger/voucher/{id}",
  "/ledger/account",
  "/ledger/account/list",
  "/ledger/posting",
  "/currency",
  "/ledger/vatType",
  "/invoice/{id}/:payment",
];

function opSummary(pathKey, method, op) {
  const row = {
    path: pathKey,
    method: method.toUpperCase(),
    operationId: op.operationId,
    summary: op.summary,
    tags: op.tags,
    parameters: op.parameters || [],
    requestBody: op.requestBody,
    responses: op.responses,
  };
  return row;
}

const report = { paths: {}, missing: [] };

for (const p of TARGET_PATHS) {
  const pathItem = spec.paths[p];
  if (!pathItem) {
    report.missing.push(p);
    continue;
  }
  report.paths[p] = {};
  for (const method of ["get", "post", "put", "patch", "delete"]) {
    const op = pathItem[method];
    if (!op) continue;
    const rbContent = op.requestBody?.content || {};
    const content =
      rbContent["application/json"] ||
      rbContent["application/json; charset=utf-8"] ||
      Object.values(rbContent)[0];
    let bodySchema = content?.schema;
    let expanded = bodySchema ? expandSchema(bodySchema) : null;
    report.paths[p][method] = {
      operationId: op.operationId,
      summary: op.summary,
      description: op.description ? String(op.description).slice(0, 800) : undefined,
      parameters: (op.parameters || []).map((param) => ({
        name: param.name,
        in: param.in,
        required: param.required,
        schema: param.schema ? expandSchema(param.schema) : undefined,
        description: param.description ? String(param.description).slice(0, 300) : undefined,
      })),
      requestBodyRequired: op.requestBody?.required,
      requestBodySchema: expanded,
      refFields: expanded ? collectRefFields(expanded) : [],
      response200: op.responses?.["200"] || op.responses?.["201"],
    };
  }
}

// Extra: find all *list POST* patterns for key resources
function findListPost(prefix) {
  return Object.keys(spec.paths).filter(
    (k) => k === `${prefix}/list` || k.startsWith(`${prefix}/`) && k.endsWith("/list"),
  );
}

const batchPatterns = {};
for (const base of ["employee", "customer", "supplier", "product", "department", "invoice", "order", "travelExpense", "project", "ledger/voucher"]) {
  const full = `/${base}`;
  const paths = Object.keys(spec.paths).filter((p) => p === `${full}/list` || p.startsWith(`${full}/`) && p.includes("/list"));
  batchPatterns[base] = paths
    .map((p) => {
      const post = spec.paths[p]?.post;
      return post ? { path: p, operationId: post.operationId, summary: post.summary } : null;
    })
    .filter(Boolean);
}

console.log(JSON.stringify({ report, batchPatterns, missingTargets: report.missing }, null, 2));
