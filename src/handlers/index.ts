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
  // Tier 1 — Simple CRUD (1-4 API calls)
  create_customer: handleCreateCustomer,           // 1 call: POST /customer
  create_employee: handleCreateEmployee,           // 2 calls: dept lookup + POST /employee
  create_department: handleCreateDepartment,       // 1 call: batch POST /department/list
  create_supplier: handleCreateSupplier,           // 1 call: POST /supplier
  create_product: handleCreateProduct,             // 4 calls: dept + VAT + unit + product lookup

  // Tier 2 — Multi-step (2-9 API calls)
  create_project: handleCreateProject,             // 4 calls: employee cache + dept + customer + POST
  create_invoice: handleCreateInvoice,             // 8 calls: bank config + order + products + invoice
  send_invoice: handleSendInvoice,                 // 7 calls: bank config + order + product + invoice + send
  create_order: handleCreateOrder,                 // 5 calls: customer + order + products + lines
  create_payment: handleCreatePayment,             // 3 calls: invoice + paymentType (parallel) + PUT
  create_credit_note: handleCreateCreditNote,      // 8 calls: customer + accounts + invoice + credit
  create_travel_expense: handleCreateTravelExpense, // 2 calls: employee cache + POST
  create_payroll: handleCreatePayroll,             // 3 calls: employee cache + accounts + voucher
  create_supplier_invoice: handleCreateSupplierInvoice, // 3 calls: supplier + accounts + voucher
  create_dimension: handleCreateDimension,         // 4 calls: dimensions + accounts + voucher
  reverse_payment: handleReversePayment,           // 4 calls: customer + invoice + paymentType + PUT
  project_fixed_price: handleProjectFixedPrice,    // 9 calls: customer + project + accounts + invoice
  create_timesheet: handleCreateTimesheet,         // 4 calls: employee cache + project + activity + entry

  // Tier 3 — Complex / file-based (2-13 API calls)
  receipt_expense: handleReceiptExpense,            // 3-5 calls: read receipt + voucher
  employee_onboarding_pdf: handleEmployeeOnboardingPdf, // 3-5 calls: parse PDF + create employee
  employee_contract_pdf: handleEmployeeOnboardingPdf,   // same handler, different entity extraction
  supplier_invoice_pdf: handleCreateSupplierInvoice,    // same handler, entities from PDF
  bank_reconciliation: handleBankReconciliation,   // 5-10 calls: bank txns + ledger matching
  ledger_audit: handleLedgerAudit,                 // 4 calls: voucher search + accounts + voucher
  ledger_analysis: handleLedgerAnalysis,           // 5 calls: emp + dept + vouchers + batch projects + batch activities
  year_end_closing: handleYearEndClosing,          // 2 calls: accounts + voucher
  monthly_closing: handleMonthlyClosing,           // 2 calls: accounts + voucher
  fx_payment: handleFxPayment,                     // 3 calls: invoice + accounts + FX voucher
  project_lifecycle: handleProjectLifecycle,       // 12 calls: project + batch hours + supplier + invoice
  reminder_fee: handleReminderFee,                 // 9 calls: invoices + accounts + voucher + invoice + send
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
