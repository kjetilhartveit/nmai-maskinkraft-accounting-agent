/**
 * Shared context for task sequence execution.
 * Tracks entities created in earlier tasks so later handlers
 * can reference them without redundant API lookups.
 */
export class SequenceContext {
  private departments = new Map<string, number>(); // name → id
  private customers = new Map<string, number>();    // name → id
  private employees = new Map<string, number>();    // "firstName lastName" or email → id
  private suppliers = new Map<string, number>();    // name → id
  private products = new Map<string, number>();     // name or number → id

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
}
