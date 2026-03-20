import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import { handleCreateEmployee } from "./create-employee.js";
import { handleCreateCustomer } from "./create-customer.js";
import { handleCreateDepartment } from "./create-department.js";
import { handleCreateSupplier } from "./create-supplier.js";

export type TaskHandler = (
  client: TripletexClient,
  task: ParsedTask,
) => Promise<void>;

const handlers: Record<string, TaskHandler> = {
  create_employee: handleCreateEmployee,
  create_customer: handleCreateCustomer,
  create_department: handleCreateDepartment,
  create_supplier: handleCreateSupplier,
};

export async function executeTask(
  client: TripletexClient,
  task: ParsedTask,
): Promise<void> {
  const handler = handlers[task.taskType];

  if (handler) {
    console.log(`[Handler] Executing ${task.taskType} handler`);
    await handler(client, task);
  } else {
    console.warn(
      `[Handler] No dedicated handler for task type: ${task.taskType}. Skipping execution.`,
    );
  }
}
