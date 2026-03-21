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

  const travelDate = String(entity.date ?? today());
  const title = String(entity.description ?? entity.title ?? entity.tripTitle ?? "");

  // Only include fields that the travelExpense API accepts
  const travelExpenseBody: Record<string, unknown> = {
    employee: { id: employeeId },
    date: travelDate,
  };
  if (title) travelExpenseBody.title = title;

  const teResult = await client.post<{ id: number }>(
    "/travelExpense",
    travelExpenseBody,
  );
  const travelExpenseId = teResult.value.id;
  console.log(`[Handler] Created travel expense: id=${travelExpenseId}`);

  // Add cost lines for expenses
  const costItems: { amount: number; description: string }[] = [];

  for (const e of task.entities.slice(1)) {
    let amt = Number(e.amount ?? e.cost ?? 0);
    // Compute per-diem total if days+rate provided but no pre-computed amount
    if (amt <= 0 && e.days && e.dailyRate) {
      amt = Number(e.days) * Number(e.dailyRate);
    }
    if (amt > 0) {
      costItems.push({
        amount: amt,
        description: String(e.description ?? e.name ?? ""),
      });
    }
  }

  // Fallback: single cost from first entity
  if (costItems.length === 0) {
    let amount = Number(entity.amount ?? entity.cost ?? 0);
    if (amount <= 0 && entity.days && entity.dailyRate) {
      amount = Number(entity.days) * Number(entity.dailyRate);
    }
    if (amount > 0) {
      costItems.push({
        amount,
        description: String(entity.description ?? ""),
      });
    }
  }

  if (costItems.length > 0) {
    const paymentTypeId = await getDefaultPaymentTypeId(client);
    const expenseDate = String(entity.date ?? today());

    for (const item of costItems) {
      const costBody: Record<string, unknown> = {
        travelExpense: { id: travelExpenseId },
        paymentType: { id: paymentTypeId },
        date: expenseDate,
        amountCurrencyIncVat: item.amount,
      };
      if (item.description) costBody.comments = item.description;

      try {
        await client.post("/travelExpense/cost", costBody);
        console.log(`[Handler] Added cost to travel expense: ${item.amount} (${item.description || "no description"})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Handler] Failed to add cost line: ${msg}`);
      }
    }
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
