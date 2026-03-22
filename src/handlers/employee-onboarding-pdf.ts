import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import { getDefaultDepartmentId, findEmployeeByName, findEmployeeByEmail } from "../lib/tripletex-helpers.js";

/**
 * Employee onboarding from attached PDF/offer letter.
 *
 * The parser extracts employee details from the prompt (and PDF context).
 * This handler creates the employee with all extracted details.
 */
export async function handleEmployeeOnboardingPdf(
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};

  const firstName = String(entity.firstName ?? "");
  const lastName = String(entity.lastName ?? "");
  const email = String(entity.email ?? "");
  const phone = String(entity.phoneNumber ?? entity.phone ?? "");
  const phoneMobile = String(entity.phoneNumberMobile ?? entity.mobile ?? "");
  const dateOfBirth = String(entity.dateOfBirth ?? "");
  const startDate = String(entity.startDate ?? "");
  const salaryRaw = entity.salary ?? entity.baseSalary ?? entity.annualSalary ?? 0;
  const salary = Number(String(salaryRaw).replace(/[^\d.]/g, ""));
  const position = String(entity.position ?? entity.jobTitle ?? entity.title ?? "");
  const occupationCode = String(entity.occupationCode ?? entity.styrkCode ?? "");
  const departmentName = String(entity.departmentName ?? entity.department ?? "");
  const userType = String(entity.userType ?? (email ? "EXTENDED" : "NO_ACCESS"));
  const employmentPercentage = Number(entity.employmentPercentage ?? entity.percentage ?? 100);
  const workingHoursPerWeek = Number(entity.workingHoursPerWeek ?? entity.workingHours ?? entity.hoursPerWeek ?? 37.5);
  const address = String(entity.address ?? entity.streetAddress ?? "");
  const postalCode = String(entity.postalCode ?? entity.zipCode ?? "");
  const city = String(entity.city ?? "");
  const nationalIdNumber = String(entity.identityNumber ?? entity.nationalIdNumber ?? entity.ssn ?? entity.personnummer ?? "");

  // Check if employee already exists
  let employeeId: number | null = null;
  if (email) {
    const existing = await findEmployeeByEmail(client, email);
    if (existing) employeeId = existing.id;
  }
  if (!employeeId && firstName && lastName) {
    const existing = await findEmployeeByName(client, firstName, lastName);
    if (existing) employeeId = existing.id;
  }

  if (employeeId) {
    console.log(`[Handler] Employee already exists: id=${employeeId}`);
    ctx.registerEmployee(`${firstName} ${lastName}`, employeeId);
    if (email) ctx.registerEmployee(email, employeeId);
    return;
  }

  // Resolve department
  let departmentId: number | undefined;
  if (departmentName) {
    const depts = await client.list<{ id: number; name: string }>("/department", {
      name: departmentName,
      from: "0",
      count: "5",
    });
    if (depts.values.length > 0) {
      departmentId = depts.values[0].id;
    } else {
      const created = await client.post<{ id: number }>("/department", { name: departmentName });
      departmentId = created.value.id;
    }
  }
  if (!departmentId) {
    departmentId = await getDefaultDepartmentId(client);
  }

  // Create employee
  const body: Record<string, unknown> = {
    firstName: firstName || "Ny",
    lastName: lastName || "Ansatt",
    department: { id: departmentId },
  };

  if (email) body.email = email;
  if (phone) body.phoneNumberHome = phone;
  if (phoneMobile) body.phoneNumberMobile = phoneMobile;
  if (dateOfBirth) body.dateOfBirth = dateOfBirth;
  if (userType) body.userType = userType;
  if (nationalIdNumber) body.nationalIdentityNumber = nationalIdNumber;
  if (address || postalCode || city) {
    const addr: Record<string, string> = {};
    if (address) addr.addressLine1 = address;
    if (postalCode) addr.postalCode = postalCode;
    if (city) addr.city = city;
    body.address = addr;
  }

  const result = await client.post<{ id: number }>("/employee", body);
  employeeId = result.value.id;
  console.log(`[Handler] Created employee from onboarding: id=${employeeId} (${firstName} ${lastName})`);

  if (firstName && lastName) ctx.registerEmployee(`${firstName} ${lastName}`, employeeId);
  if (email) ctx.registerEmployee(email, employeeId);

  // Create employment record if start date provided
  if (startDate) {
    try {
      // Employment requires division (virksomhet) reference
      let divisionId: number | undefined;
      try {
        const divs = await client.list<{ id: number }>("/division", { from: "0", count: "1" });
        divisionId = divs.values[0]?.id;
      } catch { /* division lookup optional */ }

      const employmentBody: Record<string, unknown> = {
        employee: { id: employeeId },
        startDate,
      };
      if (divisionId) employmentBody.division = { id: divisionId };

      const empResult = await client.post<{ id: number }>("/employee/employment", employmentBody);
      console.log(`[Handler] Created employment id=${empResult.value.id} starting ${startDate}`);

      // Set employment details: salary, percentage, working hours, employment type
      try {
        const detailsBody: Record<string, unknown> = {
          employment: { id: empResult.value.id },
          date: startDate,
          employmentType: "ORDINARY",
          employmentForm: "PERMANENT",
          remunerationType: "MONTHLY_WAGE",
          workingHoursScheme: "NOT_SHIFT",
          shiftDurationHours: workingHoursPerWeek / 5,
        };
        if (salary > 0) detailsBody.annualSalary = salary;
        if (employmentPercentage) detailsBody.percentageOfFullTimeEquivalent = employmentPercentage;
        if (occupationCode) {
          detailsBody.occupationCode = { code: occupationCode };
        }
        await client.post("/employee/employment/details", detailsBody);
        console.log(`[Handler] Created employment details: salary=${salary}, pct=${employmentPercentage}, hours=${workingHoursPerWeek}h/wk, position=${position}`);
      } catch (detailsErr) {
        const detailsMsg = detailsErr instanceof Error ? detailsErr.message : String(detailsErr);
        console.warn(`[Handler] Could not set employment details: ${detailsMsg}`);
        // Retry without enum fields if they caused a validation error
        if (detailsMsg.includes("422")) {
          try {
            const retryBody: Record<string, unknown> = {
              employment: { id: empResult.value.id },
              date: startDate,
            };
            if (salary > 0) retryBody.annualSalary = salary;
            if (employmentPercentage) retryBody.percentageOfFullTimeEquivalent = employmentPercentage;
            await client.post("/employee/employment/details", retryBody);
            console.log(`[Handler] Created employment details (retry without enums): salary=${salary}`);
          } catch {
            console.warn(`[Handler] Employment details retry also failed`);
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("403")) {
        console.warn(`[Handler] Employment creation failed: ${msg}`);
      }
    }
  }
}
