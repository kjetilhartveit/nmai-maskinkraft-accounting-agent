import type { TripletexClient } from "./tripletex-client.js";

interface Department {
  id: number;
  name: string;
}

interface Employee {
  id: number;
  firstName: string;
  lastName: string;
}

let cachedDefaultDepartmentId: number | null = null;

export async function getDefaultDepartmentId(
  client: TripletexClient,
): Promise<number> {
  if (cachedDefaultDepartmentId !== null) return cachedDefaultDepartmentId;

  const result = await client.list<Department>("/department", {
    from: "0",
    count: "1",
  });

  if (result.values.length > 0) {
    cachedDefaultDepartmentId = result.values[0].id;
    return cachedDefaultDepartmentId;
  }

  const created = await client.post<Department>("/department", {
    name: "Hovedavdeling",
  });
  cachedDefaultDepartmentId = created.value.id;
  return cachedDefaultDepartmentId;
}

export async function findEmployeeByName(
  client: TripletexClient,
  firstName: string,
  lastName: string,
): Promise<Employee | null> {
  const result = await client.list<Employee>("/employee", {
    firstName,
    lastName,
    from: "0",
    count: "1",
  });
  return result.values[0] ?? null;
}

export function resetCaches(): void {
  cachedDefaultDepartmentId = null;
}
