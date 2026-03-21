import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask, ParsedTaskSequence } from "../types/index.js";
import { SequenceContext } from "../lib/sequence-context.js";
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
import { handleCreatePayment } from "./create-payment.js";
import { handleCreateCreditNote } from "./create-credit-note.js";
import { handleCreatePayroll } from "./create-payroll.js";
import { handleCreateSupplierInvoice } from "./create-supplier-invoice.js";
import { handleCreateDimension } from "./create-dimension.js";
import { handleReversePayment } from "./reverse-payment.js";
import { handleProjectFixedPrice } from "./project-fixed-price.js";
import { handleCreateTimesheet } from "./create-timesheet.js";
import { handleGenericTask } from "./generic-handler.js";

export type TaskHandler = (
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
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
  create_payment: handleCreatePayment,
  create_credit_note: handleCreateCreditNote,
  create_payroll: handleCreatePayroll,
  create_supplier_invoice: handleCreateSupplierInvoice,
  create_dimension: handleCreateDimension,
  reverse_payment: handleReversePayment,
  project_fixed_price: handleProjectFixedPrice,
  create_timesheet: handleCreateTimesheet,
};

export async function executeTask(
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
): Promise<void> {
  const handler = handlers[task.taskType];

  if (handler) {
    console.log(`[Handler] Executing ${task.taskType} handler`);
    await handler(client, task, ctx);
  } else {
    console.log(
      `[Handler] No dedicated handler for "${task.taskType}" — using generic agentic handler`,
    );
    await handleGenericTask(client, task, ctx);
  }
}

export async function executeTaskSequence(
  client: TripletexClient,
  sequence: ParsedTaskSequence,
): Promise<void> {
  const ctx = new SequenceContext();
  const errors: string[] = [];
  console.log(`[Handler] Executing sequence of ${sequence.tasks.length} task(s)`);
  for (let i = 0; i < sequence.tasks.length; i++) {
    const task = sequence.tasks[i];
    console.log(`[Handler] Task ${i + 1}/${sequence.tasks.length}: ${task.taskType}`);
    try {
      await executeTask(client, task, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Handler] Task ${i + 1} (${task.taskType}) failed: ${msg}`);
      errors.push(`${task.taskType}: ${msg}`);
    }
  }
  if (errors.length > 0) {
    console.warn(`[Handler] ${errors.length}/${sequence.tasks.length} task(s) had errors`);
  }
}
