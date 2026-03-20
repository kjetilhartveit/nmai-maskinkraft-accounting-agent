import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import { handleCreateEmployee } from "./create-employee.js";
import { handleCreateCustomer } from "./create-customer.js";
import { handleCreateDepartment } from "./create-department.js";
import { handleCreateSupplier } from "./create-supplier.js";
import { handleCreateProduct } from "./create-product.js";
import { handleCreateOrder } from "./create-order.js";
import { handleCreateInvoice, handleSendInvoice } from "./create-invoice.js";
import {
  handleCreateTravelExpense,
  handleDeleteTravelExpense,
} from "./create-travel-expense.js";
import { handleCreateProject } from "./create-project.js";
import { handleCreateVoucher } from "./create-voucher.js";
import { handleUpdateEmployee } from "./update-employee.js";
import { handleUpdateCustomer } from "./update-customer.js";

export type TaskHandler = (
  client: TripletexClient,
  task: ParsedTask,
) => Promise<void>;

const handlers: Record<string, TaskHandler> = {
  create_employee: handleCreateEmployee,
  update_employee: handleUpdateEmployee,
  create_customer: handleCreateCustomer,
  update_customer: handleUpdateCustomer,
  create_department: handleCreateDepartment,
  create_supplier: handleCreateSupplier,
  create_product: handleCreateProduct,
  create_order: handleCreateOrder,
  create_invoice: handleCreateInvoice,
  send_invoice: handleSendInvoice,
  create_travel_expense: handleCreateTravelExpense,
  delete_travel_expense: handleDeleteTravelExpense,
  create_project: handleCreateProject,
  create_voucher: handleCreateVoucher,
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
