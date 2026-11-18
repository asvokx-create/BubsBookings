const usStateCodes = new Set("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" "));

export type BookingRequestDetails = {
  deliveryMethod: "IN_PERSON" | "REMOTE" | "";
  addressLine1: string; city: string; state: string; postalCode: string;
  date: string; time: string; quoteOnly: boolean; notes: string;
  bookingQuestions: string[]; answers: Record<string, string>;
};

/** Preview needs only scheduling inputs. Personal details are required at request time. */
export function missingBookingRequestDetails(input: BookingRequestDetails): string[] {
  const missing: string[] = [];
  if (!input.deliveryMethod) missing.push("service delivery method");
  if (!input.date) missing.push("date");
  if (!input.time) missing.push("available time");
  if (input.deliveryMethod === "IN_PERSON") {
    if (!input.addressLine1.trim()) missing.push("street address");
    if (!input.city.trim()) missing.push("city");
    if (!usStateCodes.has(input.state.trim().toUpperCase())) missing.push("valid US state");
    if (!/^\d{5}(?:-\d{4})?$/.test(input.postalCode.trim())) missing.push("valid ZIP code");
  }
  for (const question of input.bookingQuestions) {
    if (!(input.answers[question] ?? "").trim()) missing.push(`answer to "${question}"`);
  }
  if (input.quoteOnly && input.notes.trim().length < 3) missing.push("description of what you need (at least 3 characters)");
  return missing;
}
