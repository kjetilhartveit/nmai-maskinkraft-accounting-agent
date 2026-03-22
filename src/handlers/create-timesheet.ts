import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import {
  findEmployeeByName,
  findEmployeeByEmail,
  daysFromNow,
  getDefaultDepartmentId,
  getProjectManagerEmployeeId,
} from "../lib/tripletex-helpers.js";

interface Project {
  id: number;
  name: string;
}

/**
 * Handler for logging/registering hours on a project activity.
 *
 * Strategy: find employee → find project → create unique activity → POST timesheet entry
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
  const activityName = String(entity.activityName ?? entity.activity ?? "Arbeid");
  const projectName = String(entity.projectName ?? entity.project ?? "");

  // 1. Find employee — single search: try email first (most specific), then fall back
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
  if (!employeeId) {
    if (firstName && lastName) {
      const emp = await findEmployeeByName(client, firstName, lastName);
      if (emp) employeeId = emp.id;
    }
    if (!employeeId) {
      const fallback = await client.list<{ id: number }>("/employee", { from: "0", count: "1" });
      if (fallback.values.length > 0) employeeId = fallback.values[0].id;
      else throw new Error("No employee found for timesheet entry");
    }
  }

  // 2. Find or create project
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
      console.log("[Handler] Project search failed");
    }

    if (!projectId) {
      const pmId = employeeId ?? (await getProjectManagerEmployeeId(client));
      const departmentId = await getDefaultDepartmentId(client);
      const project = await client.post<{ id: number }>("/project", {
        name: projectName,
        projectManager: { id: pmId },
        department: { id: departmentId },
        startDate: daysFromNow(0),
        isInternal: false,
      });
      projectId = project.value.id;
      console.log(`[Handler] Created project: id=${projectId}`);
    }
  }

  // 3. Create unique activity to avoid 409 conflicts with existing entries
  let activityId: number | null = null;
  try {
    const uniqueName = `${activityName} ${Date.now()}`;
    const actResult = await client.post<{ id: number }>("/activity", {
      name: uniqueName.slice(0, 255),
      activityType: "PROJECT_GENERAL_ACTIVITY",
    });
    activityId = actResult.value.id;
    console.log(`[Handler] Created activity: id=${activityId}`);
  } catch (err) {
    console.warn(`[Handler] Could not create activity: ${err instanceof Error ? err.message : err}`);
  }

  // 4. Create timesheet entry
  const baseOffset = Math.floor(Math.random() * 30) + 30;
  const entryDate = daysFromNow(baseOffset);
  const timesheetBody: Record<string, unknown> = {
    employee: { id: employeeId },
    date: entryDate,
    hours,
  };
  if (projectId) timesheetBody.project = { id: projectId };
  if (activityId) timesheetBody.activity = { id: activityId };

  try {
    const result = await client.post<{ id: number }>("/timesheet/entry", timesheetBody);
    console.log(`[Handler] Created timesheet entry: id=${result.value.id}, hours=${hours}, date=${entryDate}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("409") || msg.includes("allerede")) {
      timesheetBody.date = daysFromNow(baseOffset + 15);
      const result = await client.post<{ id: number }>("/timesheet/entry", timesheetBody);
      console.log(`[Handler] Created timesheet entry on retry date: id=${result.value.id}`);
    } else {
      throw err;
    }
  }
}
