import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import { findEmployeeByName, findEmployeeByEmail, today } from "../lib/tripletex-helpers.js";

interface PaymentType {
  id: number;
  name: string;
}

interface CostCategory {
  id: number;
  description: string;
}

async function getDefaultPaymentTypeId(client: TripletexClient): Promise<number> {
  const result = await client.list<PaymentType>("/travelExpense/paymentType", {
    from: "0",
    count: "10",
  });

  if (result.values.length > 0) {
    const companyCard = result.values.find(
      (p) =>
        p.name?.toLowerCase().includes("company") ||
        p.name?.toLowerCase().includes("kort") ||
        p.name?.toLowerCase().includes("firma"),
    );
    return companyCard?.id ?? result.values[0].id;
  }

  return 1;
}

async function getCostCategories(client: TripletexClient): Promise<CostCategory[]> {
  try {
    const result = await client.list<CostCategory>("/travelExpense/costCategory", {
      from: "0",
      count: "100",
    });
    return result.values;
  } catch {
    return [];
  }
}

function matchCostCategory(categories: CostCategory[], description: string): CostCategory | undefined {
  const desc = description.toLowerCase();
  const keywords: [string[], string][] = [
    [["diett", "per diem", "diem", "dietas", "indemnité", "tagegeld", "tagesgeld", "diaria"], "diett"],
    [["fly", "flight", "avion", "vuelo", "flug"], "fly"],
    [["taxi"], "taxi"],
    [["hotel", "hotell", "alojamiento", "hébergement", "unterkunft"], "hotel"],
    [["parkering", "parking", "estacionamiento"], "parkering"],
    [["tog", "train", "tren", "zug"], "tog"],
    [["buss", "bus", "autobus", "autobús"], "buss"],
  ];

  for (const [terms, _label] of keywords) {
    if (terms.some((t) => desc.includes(t))) {
      const match = categories.find((c) =>
        terms.some((t) => c.description?.toLowerCase().includes(t)),
      );
      if (match) return match;
    }
  }

  return undefined;
}

export async function handleCreateTravelExpense(
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};

  const firstName = String(entity.employeeFirstName ?? entity.firstName ?? "");
  const lastName = String(entity.employeeLastName ?? entity.lastName ?? "");
  const email = String(entity.email ?? entity.employeeEmail ?? "");

  let employeeId: number | null = null;

  if (email) {
    employeeId = ctx.getEmployeeId(email) ?? null;
    if (!employeeId) {
      const emp = await findEmployeeByEmail(client, email);
      if (emp) {
        employeeId = emp.id;
        ctx.registerEmployee(email, emp.id);
      }
    }
  }
  if (!employeeId && firstName && lastName) {
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

  // Check entity.costs array first (from entity extraction)
  const costsArray = Array.isArray(entity.costs) ? entity.costs : [];
  for (const c of costsArray as Record<string, unknown>[]) {
    const amt = Number(c.amount ?? c.cost ?? 0);
    if (amt > 0) {
      costItems.push({
        amount: amt,
        description: String(c.description ?? c.name ?? ""),
      });
    }
  }

  // Then check additional entities
  for (const e of task.entities.slice(1)) {
    let amt = Number(e.amount ?? e.cost ?? 0);
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

  // Fallback: per-diem calculation or single cost from first entity
  if (costItems.length === 0) {
    let amount = Number(entity.amount ?? entity.cost ?? entity.totalAmount ?? 0);
    if (amount <= 0 && entity.days && (entity.perDiemRate ?? entity.dailyRate)) {
      amount = Number(entity.days) * Number(entity.perDiemRate ?? entity.dailyRate);
    }
    if (amount > 0) {
      costItems.push({
        amount,
        description: String(entity.description ?? entity.title ?? entity.tripTitle ?? "Reise"),
      });
    }
  }

  if (costItems.length > 0) {
    const [paymentTypeId, costCategories] = await Promise.all([
      getDefaultPaymentTypeId(client),
      getCostCategories(client),
    ]);
    const expenseDate = String(entity.date ?? today());

    for (const item of costItems) {
      const costBody: Record<string, unknown> = {
        travelExpense: { id: travelExpenseId },
        paymentType: { id: paymentTypeId },
        date: expenseDate,
        amountCurrencyIncVat: item.amount,
      };
      if (item.description) costBody.comments = item.description;

      const category = matchCostCategory(costCategories, item.description);
      if (category) {
        costBody.costCategory = { id: category.id };
        console.log(`[Handler] Matched cost category: "${category.description}" for "${item.description}"`);
      }

      try {
        await client.post("/travelExpense/cost", costBody);
        console.log(`[Handler] Added cost to travel expense: ${item.amount} (${item.description || "no description"})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Retry without cost category if it causes issues
        if (msg.includes("422") && costBody.costCategory) {
          delete costBody.costCategory;
          try {
            await client.post("/travelExpense/cost", costBody);
            console.log(`[Handler] Added cost (without category): ${item.amount}`);
          } catch (retryErr) {
            console.warn(`[Handler] Failed to add cost line on retry: ${retryErr}`);
          }
        } else {
          console.warn(`[Handler] Failed to add cost line: ${msg}`);
        }
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
