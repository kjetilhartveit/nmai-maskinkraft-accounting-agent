import type { ParsedTaskSequence, TaskType } from "../types/index.js";
import type { TestCase } from "./types.js";

function norm(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return String(v);
  return String(v).trim().toLowerCase();
}

function valueMatches(expected: unknown, actual: unknown): boolean {
  if (typeof expected === "number" && typeof actual === "string") {
    return Number(actual) === expected;
  }
  if (typeof expected === "string" && typeof actual === "number") {
    return Number(expected) === actual;
  }
  if (typeof expected === "number" && typeof actual === "number") {
    return expected === actual;
  }
  return norm(expected) === norm(actual);
}

const FIELD_ALIASES: Record<string, string[]> = {
  name: ["name", "departmentName", "projectName", "companyName", "supplierName"],
  customerName: ["customerName", "name", "companyName"],
  email: ["email", "emailAddress"],
  organizationNumber: ["organizationNumber", "orgNumber", "orgNo", "orgNr"],
  amount: ["amount", "totalAmount", "invoiceAmount", "amountExcludingVat"],
};

function getActualValue(actual: Record<string, unknown>, key: string): unknown {
  if (key in actual) return actual[key];
  const aliases = FIELD_ALIASES[key];
  if (aliases) {
    for (const alias of aliases) {
      if (alias in actual) return actual[alias];
    }
  }
  return undefined;
}

function entityContainsExpected(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  for (const [key, ev] of Object.entries(expected)) {
    const av = getActualValue(actual, key);
    if (av === undefined || !valueMatches(ev, av)) {
      return false;
    }
  }
  return true;
}

/** Each expected entity must match at least one actual entity (unique assignment). */
export function entitiesMatch(
  actual: Record<string, unknown>[],
  expected: Record<string, unknown>[],
): boolean {
  if (expected.length === 0) return true;
  const used = new Set<number>();
  for (const exp of expected) {
    const idx = actual.findIndex(
      (a, i) => !used.has(i) && entityContainsExpected(a, exp),
    );
    if (idx === -1) return false;
    used.add(idx);
  }
  return true;
}

export function allowedTaskTypes(tc: TestCase): TaskType[] {
  const base = [tc.taskType, ...(tc.taskTypeAlternatives ?? [])];
  return [...new Set(base)];
}

export function taskTypeMatches(tc: TestCase, sequence: ParsedTaskSequence | undefined): boolean {
  if (!sequence || sequence.tasks.length === 0) return false;

  if (tc.expectedTaskSequence) {
    return sequenceTaskTypesMatch(tc, sequence);
  }

  const allowed = allowedTaskTypes(tc);
  return sequence.tasks.some((t) => allowed.includes(t.taskType));
}

function sequenceTaskTypesMatch(tc: TestCase, sequence: ParsedTaskSequence): boolean {
  const expected = tc.expectedTaskSequence!;
  if (sequence.tasks.length < expected.length) return false;

  for (let i = 0; i < expected.length; i++) {
    const matchIdx = sequence.tasks.findIndex(
      (t, j) => j >= i && t.taskType === expected[i].taskType,
    );
    if (matchIdx === -1) return false;
  }
  return true;
}

const LANGUAGE_ALIASES: Record<string, string[]> = {
  en: ["en", "english"],
  fr: ["fr", "french", "français"],
  de: ["de", "german", "deutsch"],
  no: ["no", "nb", "nn", "norwegian", "norsk", "bokmål", "nynorsk"],
  pt: ["pt", "portuguese", "português"],
  es: ["es", "spanish", "español"],
};

function normalizeLanguage(lang: string): string {
  const l = norm(lang);
  for (const [key, aliases] of Object.entries(LANGUAGE_ALIASES)) {
    if (aliases.includes(l)) return key;
  }
  return l;
}

export function languageMatches(tc: TestCase, sequence: ParsedTaskSequence | undefined): boolean {
  if (!sequence) return false;
  return normalizeLanguage(sequence.language) === normalizeLanguage(tc.language);
}

export function sequenceEntitiesMatch(tc: TestCase, sequence: ParsedTaskSequence | undefined): boolean {
  if (!sequence) return false;

  if (tc.expectedTaskSequence) {
    for (const expectedTask of tc.expectedTaskSequence) {
      const matchingTask = sequence.tasks.find((t) => t.taskType === expectedTask.taskType);
      if (!matchingTask) return false;
      if (!entitiesMatch(matchingTask.entities as Record<string, unknown>[], expectedTask.entities)) {
        return false;
      }
    }
    return true;
  }

  const allEntities = sequence.tasks.flatMap((t) => t.entities as Record<string, unknown>[]);
  return entitiesMatch(allEntities, tc.expectedEntities);
}

export function apiBoundsSatisfied(
  tc: TestCase,
  total: number,
  errors: number,
): boolean {
  const b = tc.expectedApiCalls;
  if (!b) return true;
  if (b.min !== undefined && total < b.min) return false;
  if (b.max !== undefined && total > b.max) return false;
  if (b.maxErrors !== undefined && errors > b.maxErrors) return false;
  return true;
}
