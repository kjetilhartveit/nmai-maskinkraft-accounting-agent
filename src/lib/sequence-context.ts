/**
 * Shared context for task sequence execution.
 * Tracks entities created in earlier tasks so later handlers
 * can reference them without redundant API lookups.
 */
export class SequenceContext {
  private departments = new Map<string, number>();
  private customers = new Map<string, number>();
  private employees = new Map<string, number>();
  private suppliers = new Map<string, number>();
  private products = new Map<string, number>();
  private extendedEmployees = new Set<number>();
  private projects = new Map<string, number>();
  private orders = new Map<string, number>();     // customerName → orderId
  private invoices = new Map<string, number>();   // customerName → invoiceId
  private lastOrderId: number | null = null;
  private lastInvoiceId: number | null = null;

  registerDepartment(name: string, id: number): void {
    this.departments.set(name.toLowerCase(), id);
  }

  getDepartmentId(name: string): number | undefined {
    return this.departments.get(name.toLowerCase());
  }

  registerCustomer(name: string, id: number): void {
    this.customers.set(name.toLowerCase(), id);
  }

  getCustomerId(name: string): number | undefined {
    return this.customers.get(name.toLowerCase());
  }

  registerEmployee(key: string, id: number): void {
    this.employees.set(key.toLowerCase(), id);
  }

  getEmployeeId(key: string): number | undefined {
    return this.employees.get(key.toLowerCase());
  }

  registerSupplier(name: string, id: number): void {
    this.suppliers.set(name.toLowerCase(), id);
  }

  getSupplierId(name: string): number | undefined {
    return this.suppliers.get(name.toLowerCase());
  }

  registerProduct(key: string, id: number): void {
    this.products.set(key.toLowerCase(), id);
  }

  getProductId(key: string): number | undefined {
    return this.products.get(key.toLowerCase());
  }

  registerEmployeeExtended(id: number): void {
    this.extendedEmployees.add(id);
  }

  isEmployeeExtended(id: number): boolean {
    return this.extendedEmployees.has(id);
  }

  registerProject(name: string, id: number): void {
    this.projects.set(name.toLowerCase(), id);
  }

  getProjectId(name: string): number | undefined {
    return this.projects.get(name.toLowerCase());
  }

  registerOrder(customerName: string, orderId: number): void {
    this.orders.set(customerName.toLowerCase(), orderId);
    this.lastOrderId = orderId;
  }

  getOrderId(customerName: string): number | undefined {
    return this.orders.get(customerName.toLowerCase());
  }

  getLastOrderId(): number | null {
    return this.lastOrderId;
  }

  registerInvoice(customerName: string, invoiceId: number): void {
    this.invoices.set(customerName.toLowerCase(), invoiceId);
    this.lastInvoiceId = invoiceId;
  }

  getInvoiceId(customerName: string): number | undefined {
    return this.invoices.get(customerName.toLowerCase());
  }

  getLastInvoiceId(): number | null {
    return this.lastInvoiceId;
  }
}
