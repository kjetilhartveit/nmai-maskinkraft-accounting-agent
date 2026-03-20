import { readFileSync, existsSync } from "fs";
import { join } from "path";

const INDEX_PATH = join(import.meta.dirname, "../../data/api-index.json");

interface EndpointInfo {
  path: string;
  method: string;
  summary: string;
  tags: string[];
  parameters: { name: string; in: string; required: boolean; type: string }[];
  requestBodyFields: { name: string; type: string; required: boolean }[];
}

let _endpoints: EndpointInfo[] | null = null;

function loadIndex(): EndpointInfo[] {
  if (_endpoints) return _endpoints;
  if (!existsSync(INDEX_PATH)) {
    console.warn(`[OpenAPI] Index not found at ${INDEX_PATH}. Run: pnpm build-api-index`);
    _endpoints = [];
    return _endpoints;
  }
  _endpoints = JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
  console.log(`[OpenAPI] Loaded ${_endpoints!.length} endpoints from index`);
  return _endpoints!;
}

export function searchEndpoints(query: string, maxResults = 10): string {
  const endpoints = loadIndex();
  if (endpoints.length === 0) return "API index not available. Run: pnpm build-api-index";

  const terms = query.toLowerCase().split(/\s+/);

  const scored = endpoints.map((ep) => {
    const pathLower = ep.path.toLowerCase();
    const summaryLower = ep.summary.toLowerCase();
    const tagsLower = ep.tags.join(" ").toLowerCase();

    let score = 0;
    for (const term of terms) {
      if (pathLower.includes(term)) score += 3;
      if (summaryLower.includes(term)) score += 2;
      if (tagsLower.includes(term)) score += 2;
    }
    return { ep, score };
  }).filter((s) => s.score > 0);

  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, maxResults);

  if (results.length === 0) return `No endpoints found matching "${query}".`;

  return results.map(({ ep }) => {
    let doc = `### ${ep.method} ${ep.path}\n`;
    doc += `Summary: ${ep.summary}\n`;
    if (ep.tags.length) doc += `Tags: ${ep.tags.join(", ")}\n`;

    const queryParams = ep.parameters.filter((p) => p.in === "query");
    if (queryParams.length) {
      doc += `Query params: ${queryParams.map((p) => `${p.name}${p.required ? "*" : ""} (${p.type})`).join(", ")}\n`;
    }

    const pathParams = ep.parameters.filter((p) => p.in === "path");
    if (pathParams.length) {
      doc += `Path params: ${pathParams.map((p) => p.name).join(", ")}\n`;
    }

    if (ep.requestBodyFields.length) {
      const reqFields = ep.requestBodyFields.filter((f) => f.required);
      const optFields = ep.requestBodyFields.filter((f) => !f.required);
      if (reqFields.length) {
        doc += `Required fields: ${reqFields.map((f) => `${f.name} (${f.type})`).join(", ")}\n`;
      }
      if (optFields.length <= 12) {
        doc += `Optional fields: ${optFields.map((f) => `${f.name} (${f.type})`).join(", ")}\n`;
      } else {
        doc += `Optional fields: ${optFields.slice(0, 12).map((f) => `${f.name} (${f.type})`).join(", ")} ... +${optFields.length - 12} more\n`;
      }
    }

    return doc;
  }).join("\n");
}

export function getEndpointDetail(path: string, method: string): string {
  const endpoints = loadIndex();
  const ep = endpoints.find(
    (e) => e.path === path && e.method === method.toUpperCase(),
  );
  if (!ep) return `Endpoint ${method.toUpperCase()} ${path} not found in API index.`;

  let doc = `### ${ep.method} ${ep.path}\nSummary: ${ep.summary}\n`;
  if (ep.tags.length) doc += `Tags: ${ep.tags.join(", ")}\n`;

  if (ep.parameters.length) {
    doc += `\nParameters:\n`;
    for (const p of ep.parameters) {
      doc += `  - ${p.name} (${p.in}, ${p.type})${p.required ? " [REQUIRED]" : ""}\n`;
    }
  }

  if (ep.requestBodyFields.length) {
    doc += `\nRequest body fields:\n`;
    for (const f of ep.requestBodyFields) {
      doc += `  - ${f.name} (${f.type})${f.required ? " [REQUIRED]" : ""}\n`;
    }
  }

  return doc;
}
