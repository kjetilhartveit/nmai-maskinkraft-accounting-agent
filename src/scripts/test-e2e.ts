import "dotenv/config";

const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";

const samplePrompts = [
  {
    name: "Create employee (EN)",
    prompt: "Create employee Anna Berg, email anna@test.no",
  },
  {
    name: "Create departments (FR)",
    prompt:
      'Créez trois départements dans Tripletex : "Logistikk", "Kundeservice" et "Administrasjon".',
  },
  {
    name: "Create supplier (DE)",
    prompt:
      "Registrieren Sie den Lieferanten Waldstein GmbH mit der Organisationsnummer 891505019. E-Mail: faktura@waldsteingmbh.no.",
  },
];

async function testSolve(
  name: string,
  prompt: string,
): Promise<{ ok: boolean; elapsed: number; status: number; body: unknown }> {
  const baseUrl = process.env.SANDBOX_API_URL;
  const sessionToken = process.env.SANDBOX_SESSION_TOKEN;

  if (!baseUrl || !sessionToken) {
    throw new Error("Missing SANDBOX_API_URL or SANDBOX_SESSION_TOKEN in .env");
  }

  const payload = {
    prompt,
    files: [],
    tripletex_credentials: {
      base_url: baseUrl,
      session_token: sessionToken,
    },
  };

  console.log(`\n${"=".repeat(60)}`);
  console.log(`TEST: ${name}`);
  console.log(`Prompt: ${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}`);
  console.log("=".repeat(60));

  const start = performance.now();
  const res = await fetch(`${SERVER_URL}/solve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const elapsed = Math.round(performance.now() - start);
  const body = await res.json();

  console.log(`Status: ${res.status} | Time: ${elapsed}ms`);
  console.log(`Response:`, JSON.stringify(body, null, 2));

  return { ok: res.ok, elapsed, status: res.status, body };
}

async function main() {
  console.log(`Testing against: ${SERVER_URL}`);
  console.log(`Time: ${new Date().toISOString()}`);

  const args = process.argv.slice(2).filter((a) => a !== "--");
  const arg = args[0];
  const selected =
    arg === "all"
      ? samplePrompts
      : arg
        ? samplePrompts.filter((p) =>
            p.name.toLowerCase().includes(arg.toLowerCase()),
          )
        : [samplePrompts[0]];

  if (selected.length === 0) {
    console.log("No matching prompts found. Available:");
    for (const p of samplePrompts) console.log(`  - ${p.name}`);
    process.exit(1);
  }

  const results: { name: string; ok: boolean; elapsed: number }[] = [];

  for (const { name, prompt } of selected) {
    try {
      const result = await testSolve(name, prompt);
      results.push({ name, ok: result.ok, elapsed: result.elapsed });
    } catch (error) {
      console.error(`FAILED: ${name}`, (error as Error).message);
      results.push({ name, ok: false, elapsed: 0 });
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("SUMMARY");
  console.log("=".repeat(60));
  for (const r of results) {
    const icon = r.ok ? "PASS" : "FAIL";
    console.log(`  [${icon}] ${r.name} (${r.elapsed}ms)`);
  }
}

main().catch(console.error);
