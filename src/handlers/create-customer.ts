import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";

function normalizePostalAddress(raw: unknown): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    const parts = raw.split(",").map((s) => s.trim());
    if (parts.length >= 2) {
      const lastPart = parts[parts.length - 1];
      const postalMatch = lastPart.match(/^(\d{4})\s+(.+)$/);
      if (postalMatch) {
        return {
          addressLine1: parts.slice(0, -1).join(", "),
          postalCode: postalMatch[1],
          city: postalMatch[2],
        };
      }
    }
    return { addressLine1: raw };
  }
  return undefined;
}

function buildCustomerBody(entity: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: entity.name ?? "",
    isCustomer: true,
  };
  if (entity.email) body.email = entity.email;
  if (entity.organizationNumber) body.organizationNumber = entity.organizationNumber;
  if (entity.phoneNumber) body.phoneNumber = entity.phoneNumber;
  if (entity.phoneNumberMobile) body.phoneNumberMobile = entity.phoneNumberMobile;
  const address = normalizePostalAddress(entity.postalAddress);
  if (address) body.postalAddress = address;
  return body;
}

export async function handleCreateCustomer(
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
): Promise<void> {
  const bodies = task.entities.map(buildCustomerBody);

  for (const body of bodies) {
    const name = String(body.name ?? "");
    try {
      const result = await client.post<{ id: number }>("/customer", body);
      ctx.registerCustomer(name, result.value.id);
      console.log(`[Handler] Created customer: id=${result.value.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("postalAddress") && body.postalAddress) {
        console.warn("[Handler] postalAddress rejected, retrying without it");
        const { postalAddress: _, ...bodyWithoutAddress } = body;
        const result = await client.post<{ id: number }>("/customer", bodyWithoutAddress);
        ctx.registerCustomer(name, result.value.id);
        console.log(`[Handler] Created customer (without address): id=${result.value.id}`);
      } else {
        throw err;
      }
    }
  }
}
