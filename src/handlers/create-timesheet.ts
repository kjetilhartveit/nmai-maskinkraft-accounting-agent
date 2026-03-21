import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import {
  findEmployeeByName,
  findEmployeeByEmail,
  today,
} from "../lib/tripletex-helpers.js";

interface Activity {
  id: number;
  name: string;
}

interface Project {
  id: number;
  name: string;
}

/**
 * Handler for logging/registering hours on a project activity.
 *
 * Strategy: find employee → find/create project → find activity → POST timesheet entry
 */
export async function handleCreateTimesheet(
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};

  const firstName = String(entity.employeeFirstName ?? entity.firstName ?? "");
  const lastName = String(entity.employeeLastName ?? entity.lastName ?? "");
  const email = String(entity.employeeEmail ?? entity.email ?? "");
  const hours = Number(entity.hours ?? 0);
  const activityName = String(entity.activityName ?? entity.activity ?? "");
  const projectName = String(entity.projectName ?? entity.project ?? "");
  const date = String(entity.date ?? today());

  // 1. Find employee
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
      const emp = await findEmployeeByName(client, firstName, lastName);
      if (emp) employeeId = emp.id;
    }
  }

  if (!employeeId) {
    const fallback = await client.list<{ id: number }>("/employee", { from: "0", count: "1" });
    if (fallback.values.length > 0) employeeId = fallback.values[0].id;
    else throw new Error("No employee found for timesheet entry");
  }

  // 2. Find project
  let projectId: number | null = null;
  if (projectName) {
    try {
      const projects = await client.list<Project>("/project", {
        name: projectName,
        from: "0",
        count: "5",
      });
      if (projects.values.length > 0) {
        projectId = projects.values[0].id;
      }
    } catch {
      console.log("[Handler] Project search failed, will try without project");
    }
  }

  // 3. Find activity
  let activityId: number | null = null;
  try {
    const activities = await client.list<Activity>("/activity", {
      from: "0",
      count: "50",
    });
    if (activityName) {
      const match = activities.values.find(
        (a) => a.name.toLowerCase().includes(activityName.toLowerCase()),
      );
      activityId = match?.id ?? activities.values[0]?.id ?? null;
    } else {
      activityId = activities.values[0]?.id ?? null;
    }
  } catch {
    console.log("[Handler] Activity list failed");
  }

  // 4. Create timesheet entry
  const timesheetBody: Record<string, unknown> = {
    employee: { id: employeeId },
    date,
    hours,
  };
  if (projectId) timesheetBody.project = { id: projectId };
  if (activityId) timesheetBody.activity = { id: activityId };

  try {
    const result = await client.post<{ id: number }>("/timesheet/entry", timesheetBody);
    console.log(`[Handler] Created timesheet entry: id=${result.value.id}, hours=${hours}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("403")) {
      console.log("[Handler] Timesheet entry endpoint is BETA, falling back to generic handler");
      throw err;
    }
    console.warn(`[Handler] Timesheet entry failed: ${msg}`);
    throw err;
  }
}
