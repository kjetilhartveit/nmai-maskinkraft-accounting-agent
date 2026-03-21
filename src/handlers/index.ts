import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask, ParsedTaskSequence, TaskType } from "../types/index.js";
import { SequenceContext } from "../lib/sequence-context.js";
import { handleCreateEmployee } from "./create-employee.js";
import { handleCreateCustomer } from "./create-customer.js";
import { handleCreateDepartment } from "./create-department.js";
import { handleCreateSupplier } from "./create-supplier.js";
import { handleCreateProduct } from "./create-product.js";
import { handleCreateOrder } from "./create-order.js";
import { handleCreateInvoice, handleSendInvoice } from "./create-invoice.js";
import { handleCreateTravelExpense } from "./create-travel-expense.js";
import { handleCreateProject } from "./create-project.js";
import { handleCreatePayment } from "./create-payment.js";
import { handleCreateCreditNote } from "./create-credit-note.js";
import { handleCreatePayroll } from "./create-payroll.js";
import { handleCreateSupplierInvoice } from "./create-supplier-invoice.js";
import { handleCreateDimension } from "./create-dimension.js";
import { handleReversePayment } from "./reverse-payment.js";
import { handleProjectFixedPrice } from "./project-fixed-price.js";
import { handleCreateTimesheet } from "./create-timesheet.js";
import { handleReceiptExpense } from "./receipt-expense.js";
import { handleEmployeeOnboardingPdf } from "./employee-onboarding-pdf.js";
import { handleBankReconciliation } from "./bank-reconciliation.js";
import { handleLedgerAudit } from "./ledger-audit.js";
import { handleLedgerAnalysis } from "./ledger-analysis.js";
import { handleYearEndClosing } from "./year-end-closing.js";
import { handleMonthlyClosing } from "./monthly-closing.js";
import { handleFxPayment } from "./fx-payment.js";
import { handleProjectLifecycle } from "./project-lifecycle.js";
import { handleReminderFee } from "./reminder-fee.js";
import { handleGenericTask } from "./generic-handler.js";

export type TaskHandler = (
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
) => Promise<void>;

/**
 * All 30 task types mapped to their dedicated handlers.
 * No "unknown" fallback — every prompt type has a handler.
 */
const handlers: Record<TaskType, TaskHandler> = {
  // Tier 1 — Simple CRUD (1-3 API calls)
  create_customer: handleCreateCustomer,           // 1-2 calls: POST /customer
  create_employee: handleCreateEmployee,           // 2-3 calls: dept lookup + POST /employee
  create_department: handleCreateDepartment,       // 1 call: batch POST /department/list
  create_supplier: handleCreateSupplier,           // 1 call: POST /supplier
  create_product: handleCreateProduct,             // 3-5 calls: dept + VAT + unit + POST

  // Tier 2 — Multi-step (3-10 API calls)
  create_project: handleCreateProject,             // 3-8 calls: PM entitlements + POST /project
  create_invoice: handleCreateInvoice,             // 5-7 calls: bank config + order + invoice
  send_invoice: handleSendInvoice,                 // 5-7 calls: bank config + order + invoice + send
  create_order: handleCreateOrder,                 // 3-8 calls: customer + products + order + lines
  create_payment: handleCreatePayment,             // 3-5 calls: find invoice + payment type + PUT
  create_credit_note: handleCreateCreditNote,      // 6-8 calls: find/create invoice + credit
  create_travel_expense: handleCreateTravelExpense, // 4-7 calls: employee + POST + costs
  create_payroll: handleCreatePayroll,             // 5-7 calls: employee + accounts + voucher
  create_supplier_invoice: handleCreateSupplierInvoice, // 4-5 calls: accounts + voucher
  create_dimension: handleCreateDimension,         // 5-8 calls: dimension + values + voucher
  reverse_payment: handleReversePayment,           // 4-6 calls: find invoice + reverse payment
  project_fixed_price: handleProjectFixedPrice,    // 5-8 calls: project + fixed price + invoice %
  create_timesheet: handleCreateTimesheet,         // 4-6 calls: employee + project + activity + timesheet

  // Tier 3 — Complex / file-based (3-15 API calls)
  receipt_expense: handleReceiptExpense,            // 3-5 calls: read receipt + voucher
  employee_onboarding_pdf: handleEmployeeOnboardingPdf, // 3-5 calls: parse PDF + create employee
  employee_contract_pdf: handleEmployeeOnboardingPdf,   // same handler, different entity extraction
  supplier_invoice_pdf: handleCreateSupplierInvoice,    // same handler, entities from PDF
  bank_reconciliation: handleBankReconciliation,   // 5-10 calls: bank txns + ledger matching
  ledger_audit: handleLedgerAudit,                 // 5-10 calls: find errors + correcting vouchers
  ledger_analysis: handleLedgerAnalysis,           // 5-10 calls: analyze ledger + create projects
  year_end_closing: handleYearEndClosing,          // 5-10 calls: depreciation + accruals + closing
  monthly_closing: handleMonthlyClosing,           // 3-6 calls: monthly accruals + depreciation
  fx_payment: handleFxPayment,                     // 4-6 calls: FX conversion + voucher
  project_lifecycle: handleProjectLifecycle,       // 8-15 calls: project + hours + invoice
  reminder_fee: handleReminderFee,                 // 4-6 calls: find overdue + reminder fee
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
    console.log(`[Handler] No handler for "${task.taskType}" — using generic fallback`);
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
