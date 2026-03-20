import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const OPENAPI_PATH = join(import.meta.dirname, "../../docs/tripletex-openapi.json");
const INDEX_PATH = join(import.meta.dirname, "../../data/api-index.json");

interface EndpointInfo {
  path: string;
  method: string;
  summary: string;
  tags: string[];
  parameters: { name: string; in: string; required: boolean; type: string }[];
  requestBodyFields: { name: string; type: string; required: boolean }[];
}

if (!existsSync(OPENAPI_PATH)) {
  console.error(`OpenAPI spec not found at ${OPENAPI_PATH}`);
  console.error("Fetch it with: curl -s -k 'https://kkpqfuj-amager.tripletex.dev/v2/openapi.json' > docs/tripletex-openapi.json");
  process.exit(1);
}

const start = Date.now();
const spec = JSON.parse(readFileSync(OPENAPI_PATH, "utf-8"));
console.log(`Parsed OpenAPI spec in ${Date.now() - start}ms`);
console.log(`Paths: ${Object.keys(spec.paths).length}, Schemas: ${Object.keys(spec.components?.schemas ?? {}).length}`);

function resolveSchemaFields(ref: string | undefined): EndpointInfo["requestBodyFields"] {
  if (!ref || !spec.components?.schemas) return [];
  const schemaName = ref.replace("#/components/schemas/", "");
  const schema = spec.components.schemas[schemaName];
  if (!schema?.properties) return [];

  const requiredSet = new Set(schema.required ?? []);
  return Object.entries(schema.properties as Record<string, { type?: string; $ref?: string }>).map(([name, prop]) => ({
    name,
    type: prop.type ?? (prop.$ref ? prop.$ref.replace("#/components/schemas/", "") : "object"),
    required: requiredSet.has(name),
  }));
}

const endpoints: EndpointInfo[] = [];

for (const [path, methods] of Object.entries(spec.paths as Record<string, Record<string, unknown>>)) {
  for (const [method, op] of Object.entries(methods)) {
    if (method === "parameters") continue;
    const operation = op as {
      tags?: string[];
      summary?: string;
      parameters?: { name: string; in: string; required?: boolean; schema?: { type?: string } }[];
      requestBody?: { content?: { "application/json"?: { schema?: { $ref?: string; properties?: Record<string, unknown>; required?: string[] } } } };
    };

    const params = (operation.parameters ?? []).map((p) => ({
      name: p.name,
      in: p.in,
      required: p.required ?? false,
      type: p.schema?.type ?? "string",
    }));

    const bodyContent = operation.requestBody?.content?.["application/json"];
    let requestBodyFields: EndpointInfo["requestBodyFields"] = [];
    if (bodyContent?.schema) {
      if (bodyContent.schema.$ref) {
        requestBodyFields = resolveSchemaFields(bodyContent.schema.$ref);
      } else if (bodyContent.schema.properties) {
        const req = new Set(bodyContent.schema.required ?? []);
        requestBodyFields = Object.entries(bodyContent.schema.properties as Record<string, { type?: string }>).map(
          ([name, prop]) => ({ name, type: prop.type ?? "unknown", required: req.has(name) }),
        );
      }
    }

    endpoints.push({
      path,
      method: method.toUpperCase(),
      summary: operation.summary ?? "",
      tags: operation.tags ?? [],
      parameters: params,
      requestBodyFields,
    });
  }
}

writeFileSync(INDEX_PATH, JSON.stringify(endpoints));
console.log(`\nBuilt index: ${endpoints.length} endpoints → ${INDEX_PATH}`);
console.log(`Index size: ${(Buffer.byteLength(JSON.stringify(endpoints)) / 1024).toFixed(0)}KB`);
