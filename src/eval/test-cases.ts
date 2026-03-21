import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { TestCase } from "./types.js";

function loadPromotedCases(): TestCase[] {
  const promotedFile = join(import.meta.dirname, "../../data/verified/promoted-test-cases.json");
  if (!existsSync(promotedFile)) return [];
  try {
    return JSON.parse(readFileSync(promotedFile, "utf-8")) as TestCase[];
  } catch {
    return [];
  }
}

/** Baseline cases derived from docs/sample-tripletex-prompts.json with expected parse targets. */
const manualTestCases: TestCase[] = [
  {
    id: "employee-anna-en",
    prompt: "Create employee Anna Berg, email anna@test.no",
    language: "en",
    tier: 1,
    taskType: "create_employee",
    expectedEntities: [
      { firstName: "Anna", lastName: "Berg", email: "anna@test.no" },
    ],
    expectedApiCalls: { max: 2, maxErrors: 0 },
    notes: "Single employee; handler lists department first.",
  },
  {
    id: "dept-fr-triple",
    prompt:
      'Créez trois départements dans Tripletex : "Logistikk", "Kundeservice" et "Administrasjon".',
    language: "fr",
    tier: 2,
    taskType: "create_department",
    expectedEntities: [
      { name: "Logistikk" },
      { name: "Kundeservice" },
      { name: "Administrasjon" },
    ],
    expectedApiCalls: { max: 1, maxErrors: 0 },
  },
  {
    id: "invoice-pt-porto",
    prompt:
      "Crie e envie uma fatura ao cliente Porto Alegre Lda (org. nº 842889154) por 11200 NOK sem IVA. A fatura refere-se a Consultoria de dados.",
    language: "pt",
    tier: 3,
    taskType: "send_invoice",
    taskTypeAlternatives: ["create_customer", "send_invoice"],
    expectedEntities: [
      { name: "Porto Alegre Lda" },
      { amount: 11200 },
    ],
    expectedTaskSequence: [
      { taskType: "create_customer", entities: [{ name: "Porto Alegre Lda", organizationNumber: "842889154" }] },
      { taskType: "send_invoice", entities: [{ customerName: "Porto Alegre Lda", amount: 11200 }] },
    ],
    expectedApiCalls: { max: 8, maxErrors: 0 },
    notes: "Multi-task: create customer then send invoice.",
  },
  {
    id: "project-de-wind",
    prompt:
      'Erstellen Sie das Projekt "Analyse Windkraft" verknüpft mit dem Kunden Windkraft GmbH (Org.-Nr. 897356171). Projektleiter ist Finn Richter (finn.richter@example.org).',
    language: "de",
    tier: 3,
    taskType: "create_project",
    taskTypeAlternatives: ["create_customer", "create_employee", "create_project"],
    expectedEntities: [
      { name: "Analyse Windkraft" },
    ],
    expectedTaskSequence: [
      { taskType: "create_customer", entities: [{ name: "Windkraft GmbH" }] },
      { taskType: "create_employee", entities: [{ firstName: "Finn", lastName: "Richter" }] },
      { taskType: "create_project", entities: [{ name: "Analyse Windkraft", customerName: "Windkraft GmbH" }] },
    ],
    expectedApiCalls: { max: 10, maxErrors: 2 },
    notes: "Multi-task: create customer + employee, then project. PM entitlement requires EXTENDED access. In dirty sandbox, existing employee may lack EXTENDED (write-once). Fresh sandbox: ~8 calls, 0 errors.",
  },
  {
    id: "invoice-de-waldstein",
    prompt:
      "Erstellen und senden Sie eine Rechnung an den Kunden Waldstein GmbH (Org.-Nr. 925346519) über 25100 NOK ohne MwSt. Die Rechnung betrifft Systementwicklung.",
    language: "de",
    tier: 3,
    taskType: "send_invoice",
    taskTypeAlternatives: ["create_customer", "send_invoice"],
    expectedEntities: [
      { name: "Waldstein GmbH" },
      { amount: 25100 },
    ],
    expectedTaskSequence: [
      { taskType: "create_customer", entities: [{ name: "Waldstein GmbH", organizationNumber: "925346519" }] },
      { taskType: "send_invoice", entities: [{ customerName: "Waldstein GmbH", amount: 25100 }] },
    ],
    expectedApiCalls: { max: 8, maxErrors: 0 },
    notes: "Multi-task: create customer then send invoice.",
  },
  {
    id: "dept-no-triple",
    prompt: 'Opprett tre avdelingar i Tripletex: "Logistikk", "Innkjøp" og "IT".',
    language: "no",
    tier: 2,
    taskType: "create_department",
    expectedEntities: [{ name: "Logistikk" }, { name: "Innkjøp" }, { name: "IT" }],
    expectedApiCalls: { max: 1, maxErrors: 0 },
  },
  {
    id: "supplier-de-waldstein",
    prompt:
      "Registrieren Sie den Lieferanten Waldstein GmbH mit der Organisationsnummer 891505019. E-Mail: faktura@waldsteingmbh.no.",
    language: "de",
    tier: 2,
    taskType: "create_supplier",
    expectedEntities: [
      {
        name: "Waldstein GmbH",
        organizationNumber: "891505019",
        email: "faktura@waldsteingmbh.no",
      },
    ],
    expectedApiCalls: { max: 1, maxErrors: 0 },
  },

  // Multi-task test cases
  {
    id: "multi-customer-invoice-no",
    prompt:
      'Opprett kunden Nordbyen AS med organisasjonsnummer 923456789 og e-post post@nordbyen.no. Deretter, lag og send en faktura til dem for "Konsulenttjenester" på 15000 NOK eks. mva.',
    language: "no",
    tier: 3,
    taskType: "create_customer",
    expectedEntities: [
      {
        name: "Nordbyen AS",
        organizationNumber: "923456789",
        email: "post@nordbyen.no",
      },
    ],
    expectedTaskSequence: [
      {
        taskType: "create_customer",
        entities: [{ name: "Nordbyen AS", organizationNumber: "923456789" }],
      },
      {
        taskType: "send_invoice",
        entities: [{ customerName: "Nordbyen AS" }],
      },
    ],
    expectedApiCalls: { max: 7, maxErrors: 0 },
    notes: "Multi-task: create customer then send invoice. Tests dependency ordering.",
  },
  {
    id: "multi-dept-employee-en",
    prompt:
      'Create a department called "Engineering" and then hire employee Lars Olsen (lars.olsen@example.com) into it.',
    language: "en",
    tier: 2,
    taskType: "create_department",
    expectedEntities: [
      { name: "Engineering" },
    ],
    expectedTaskSequence: [
      {
        taskType: "create_department",
        entities: [{ name: "Engineering" }],
      },
      {
        taskType: "create_employee",
        entities: [{ firstName: "Lars", lastName: "Olsen" }],
      },
    ],
    expectedApiCalls: { max: 2, maxErrors: 0 },
    notes: "Multi-task: create department, then create employee. Fresh sandbox: POST dept + GET employee (dedup) + POST employee = 3. Dirty sandbox: 2 (employee already exists).",
  },
];

const promoted = loadPromotedCases();
const promotedIds = new Set(promoted.map(tc => tc.id));
const deduped = manualTestCases.filter(tc => !promotedIds.has(tc.id));

/** All test cases: manually curated + LLM-verified promoted cases. */
export const testCases: TestCase[] = [...deduped, ...promoted];
