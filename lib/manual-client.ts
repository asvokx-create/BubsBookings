import { normalizeEmail, normalizePhone } from "./customer-import.ts";

export function parseManualClient(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("Enter a client name and contact details.");
  const body = value as Record<string, unknown>;
  const read = (key: string, max: number) => {
    const value = body[key];
    if (value === undefined || value === null) return "";
    if (typeof value !== "string" || value.length > max) throw new Error(`${key} is too long or invalid.`);
    return value.replace(/[\u0000-\u001f<>]/g, " ").trim();
  };
  const name = read("name", 200), rawEmail = read("email", 254), rawPhone = read("phone", 40), notes = read("notes", 4000);
  const email = normalizeEmail(rawEmail), phone = normalizePhone(rawPhone);
  if (!name) throw new Error("Enter the client's name.");
  if (rawEmail && !email) throw new Error("Enter a valid email address.");
  if (rawPhone && !phone) throw new Error("Enter a phone number with 10 to 15 digits.");
  if (body.lawfulBasis !== true) throw new Error("Confirm that you have permission to store this client's details.");
  return { name, email, phone, notes };
}
