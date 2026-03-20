import type { TestCase } from "./types.js";

/** Baseline cases derived from docs/sample-tripletex-prompts.json with expected parse targets. */
export const testCases: TestCase[] = [
  {
    id: "employee-anna-en",
    prompt: "Create employee Anna Berg, email anna@test.no",
    language: "en",
    tier: 1,
    taskType: "create_employee",
    expectedEntities: [
      { firstName: "Anna", lastName: "Berg", email: "anna@test.no" },
    ],
    expectedApiCalls: { max: 8, maxErrors: 0 },
    notes: "Single employee; handler may list departments first.",
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
    expectedApiCalls: { max: 6, maxErrors: 0 },
  },
  {
    id: "invoice-pt-porto",
    prompt:
      "Crie e envie uma fatura ao cliente Porto Alegre Lda (org. nº 842889154) por 11200 NOK sem IVA. A fatura refere-se a Consultoria de dados.",
    language: "pt",
    tier: 3,
    taskType: "send_invoice",
    taskTypeAlternatives: ["create_invoice", "send_invoice"],
    expectedEntities: [
      {
        customerName: "Porto Alegre Lda",
        organizationNumber: "842889154",
        amount: 11200,
      },
    ],
    expectedApiCalls: { max: 40, maxErrors: 0 },
    notes: "May parse as create_invoice depending on wording; adjust expected if pipeline only supports send_invoice.",
  },
  {
    id: "project-de-wind",
    prompt:
      'Erstellen Sie das Projekt "Analyse Windkraft" verknüpft mit dem Kunden Windkraft GmbH (Org.-Nr. 897356171). Projektleiter ist Finn Richter (finn.richter@example.org).',
    language: "de",
    tier: 3,
    taskType: "create_project",
    expectedEntities: [
      {
        name: "Analyse Windkraft",
        customerName: "Windkraft GmbH",
        organizationNumber: "897356171",
      },
    ],
    expectedApiCalls: { max: 40, maxErrors: 0 },
  },
  {
    id: "invoice-de-waldstein",
    prompt:
      "Erstellen und senden Sie eine Rechnung an den Kunden Waldstein GmbH (Org.-Nr. 925346519) über 25100 NOK ohne MwSt. Die Rechnung betrifft Systementwicklung.",
    language: "de",
    tier: 3,
    taskType: "send_invoice",
    taskTypeAlternatives: ["create_invoice", "send_invoice"],
    expectedEntities: [
      {
        customerName: "Waldstein GmbH",
        organizationNumber: "925346519",
        amount: 25100,
      },
    ],
    expectedApiCalls: { max: 40, maxErrors: 0 },
  },
  {
    id: "dept-no-triple",
    prompt: 'Opprett tre avdelingar i Tripletex: "Logistikk", "Innkjøp" og "IT".',
    language: "no",
    tier: 2,
    taskType: "create_department",
    expectedEntities: [{ name: "Logistikk" }, { name: "Innkjøp" }, { name: "IT" }],
    expectedApiCalls: { max: 6, maxErrors: 0 },
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
    expectedApiCalls: { max: 12, maxErrors: 0 },
  },
];
