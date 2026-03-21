import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import { findEmployeeByName, today } from "../lib/tripletex-helpers.js";

interface PaymentType {
  id: number;
  name: string;
}

let cachedPaymentTypeId: number | null = null;

export function resetTravelExpenseCache(): void {
  cachedPaymentTypeId = null;
}

async function getDefaultPaymentTypeId(client: TripletexClient): Promise<number> {
  if (cachedPaymentTypeId !== null) return cachedPaymentTypeId;

  const result = await client.list<PaymentType>("/travelExpense/paymentType", {
    from: "0",
    count: "10",
  });

  if (result.values.length > 0) {
    // Prefer "company card" or similar; otherwise take first
    const companyCard = result.values.find(
      (p) =>
        p.name?.toLowerCase().includes("company") ||
        p.name?.toLowerCase().includes("kort") ||
        p.name?.toLowerCase().includes("firma"),
    );
    cachedPaymentTypeId = companyCard?.id ?? result.values[0].id;
    return cachedPaymentTypeId;
  }

  cachedPaymentTypeId = 1;
  return cachedPaymentTypeId;
}

export async function handleCreateTravelExpense(
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};

  const firstName = String(entity.employeeFirstName ?? entity.firstName ?? "");
  const lastName = String(entity.employeeLastName ?? entity.lastName ?? "");

  let employeeId: number | null = null;
  if (firstName && lastName) {
    employeeId = ctx.getEmployeeId(`${firstName} ${lastName}`) ?? null;
    if (!employeeId) {
      const employee = await findEmployeeByName(client, firstName, lastName);
      if (employee) employeeId = employee.id;
    }
  }
  if (!employeeId && entity.employeeId) employeeId = Number(entity.employeeId);

  if (!employeeId) {
    console.warn("[Handler] No employee found for travel expense by name, using fallback");
    const fallbackEmployees = await client.list<{ id: number }>("/employee", { from: "0", count: "1" });
    if (fallbackEmployees.values.length > 0) {
      employeeId = fallbackEmployees.values[0].id;
    } else {
      console.warn("[Handler] No fallback employee available");
      return;
    }
  }

  const travelExpenseBody: Record<string, unknown> = {
    employee: { id: employeeId },
    date: String(entity.date ?? today()),
  };

  if (entity.description) travelExpenseBody.comment = entity.description;
  if (entity.projectName ?? entity.project) {
    // Project ID would need lookup; skip for now
  }

  const teResult = await client.post<{ id: number }>(
    "/travelExpense",
    travelExpenseBody,
  );
  const travelExpenseId = teResult.value.id;
  console.log(`[Handler] Created travel expense: id=${travelExpenseId}`);

  // Add cost line if amount is specified
  const amount = entity.amount ?? entity.cost;
  if (amount !== undefined) {
    const paymentTypeId = await getDefaultPaymentTypeId(client);

    const costBody: Record<string, unknown> = {
      travelExpense: { id: travelExpenseId },
      paymentType: { id: paymentTypeId },
      amountCurrencyIncVat: Number(amount),
    };

    if (entity.description) costBody.comment = entity.description;

    await client.post("/travelExpense/cost", costBody);
    console.log(`[Handler] Added cost to travel expense: ${amount}`);
  }
}

export async function handleDeleteTravelExpense(
  client: TripletexClient,
  task: ParsedTask,
  _ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};

  if (entity.travelExpenseId ?? entity.id) {
    const id = Number(entity.travelExpenseId ?? entity.id);
    await client.delete(`/travelExpense/${id}`);
    console.log(`[Handler] Deleted travel expense: id=${id}`);
    return;
  }

  // Try to find by employee name
  const firstName = String(entity.employeeFirstName ?? entity.firstName ?? "");
  const lastName = String(entity.employeeLastName ?? entity.lastName ?? "");
  if (firstName && lastName) {
    const employee = await findEmployeeByName(client, firstName, lastName);
    if (employee) {
      const result = await client.list<{ id: number }>(
        "/travelExpense",
        {
          employeeId: String(employee.id),
          from: "0",
          count: "1",
        },
      );
      if (result.values.length > 0) {
        const id = result.values[0].id;
        await client.delete(`/travelExpense/${id}`);
        console.log(`[Handler] Deleted travel expense: id=${id}`);
      }
    }
  }
}
