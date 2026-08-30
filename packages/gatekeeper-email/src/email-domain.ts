/** Normalizes and validates a DNS hostname used as an inbound email domain. */
export function normalizeEmailDomain(value: string): string {
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  if (domain.length > 253 || !domain.includes(".")) {
    throw new Error(`Invalid email domain: ${value}`);
  }
  for (const label of domain.split(".")) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
      throw new Error(`Invalid email domain: ${value}`);
    }
  }
  return domain;
}
