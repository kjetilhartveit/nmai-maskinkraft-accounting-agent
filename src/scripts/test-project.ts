/**
 * Test script to investigate project creation requirements
 */
import "dotenv/config";
import { TripletexClient } from "../lib/tripletex-client.js";

const SANDBOX_API_URL = process.env.SANDBOX_API_URL!;
const SANDBOX_SESSION_TOKEN = process.env.SANDBOX_SESSION_TOKEN!;

async function main() {
  const client = new TripletexClient(SANDBOX_API_URL, SANDBOX_SESSION_TOKEN);

  console.log("\n=== Investigating Project Creation ===\n");

  // 1. Get current company info
  console.log("1. Getting company info via /company...");
  try {
    const companyResult = await client.list<{ id: number; name: string }>("/company", {
      from: "0",
      count: "5",
    });
    console.log("Companies:", JSON.stringify(companyResult.values, null, 2));
  } catch (e) {
    console.log("Failed to list companies:", e);
  }

  // 2. List employees
  console.log("\n2. Listing employees...");
  let employees: { id: number; firstName: string; lastName: string; email?: string; hasProjectManagerRight?: boolean }[] = [];
  try {
    const empResult = await client.list<{ id: number; firstName: string; lastName: string; email?: string; hasProjectManagerRight?: boolean }>("/employee", {
      from: "0",
      count: "10",
      fields: "id,firstName,lastName,email",
    });
    employees = empResult.values;
    console.log("Employees found:", employees.length);
    employees.forEach((e, i) => {
      console.log(`  ${i + 1}. ${e.firstName} ${e.lastName} (id=${e.id}, email=${e.email})`);
    });
  } catch (e) {
    console.log("Failed to list employees:", e);
  }

  // 3. Get full employee details to check rights
  if (employees.length > 0) {
    console.log("\n3. Getting detailed employee info...");
    const emp = employees[0];
    try {
      const empDetail = await client.get<{
        id: number;
        firstName: string;
        lastName: string;
        email?: string;
        allowInformationRegistration?: boolean;
        isContact?: boolean;
        comments?: string;
        userType?: string;
      }>(`/employee/${emp.id}`);
      console.log("Employee details:", JSON.stringify(empDetail.value, null, 2));
    } catch (e) {
      console.log("Failed to get employee detail:", e);
    }
  }

  // 4. Try to create a project with the first employee
  console.log("\n4. Attempting project creation...");
  const today = new Date().toISOString().slice(0, 10);

  if (employees.length > 0) {
    const projectManager = employees[0];
    console.log(`  Using project manager: ${projectManager.firstName} ${projectManager.lastName} (id=${projectManager.id})`);

    try {
      const projectResult = await client.post<{ id: number }>("/project", {
        name: "Test Project",
        projectManager: { id: projectManager.id },
        startDate: today,
      });
      console.log("SUCCESS! Created project:", projectResult.value.id);
    } catch (e: unknown) {
      if (e instanceof Error) {
        console.log("\nFULL ERROR MESSAGE:");
        console.log(e.message);
        if ("body" in e) {
          console.log("\nFULL ERROR BODY:");
          console.log((e as { body: string }).body);

          // Try to parse and format
          try {
            const errorObj = JSON.parse((e as { body: string }).body);
            console.log("\nValidation messages:", JSON.stringify(errorObj.validationMessages, null, 2));
          } catch {}
        }
      }
    }
  }

  // 5. Check what's needed for project manager
  console.log("\n5. Checking /project endpoint documentation...");
  try {
    // Try to find the project manager rights field
    const empListFull = await client.list<{
      id: number;
      firstName: string;
      lastName: string;
      userType?: string;
    }>("/employee", {
      from: "0",
      count: "3",
      fields: "*",
    });
    console.log("Full employee data sample:", JSON.stringify(empListFull.values[0], null, 2));
  } catch (e) {
    console.log("Failed:", e);
  }

  console.log("\n=== Summary ===");
  console.log("API calls:", client.stats);
}

main().catch(console.error);
