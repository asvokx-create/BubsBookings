import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { missingBookingRequestDetails, type BookingRequestDetails } from "../lib/booking-request-details.ts";
const valid: BookingRequestDetails = { deliveryMethod: "IN_PERSON", addressLine1: "1 Test St", city: "Test", state: "CA", postalCode: "90001", date: "2026-12-01", time: "10:00", quoteOnly: false, notes: "", bookingQuestions: [], answers: {} };
const source = readFileSync(new URL("../app/services/[slug]/booking-card.tsx", import.meta.url), "utf8");
const availability = source.slice(source.indexOf("  async function checkAvailability("), source.indexOf("  async function confirmRequest("));
const request = source.slice(source.indexOf("  async function confirmRequest("), source.indexOf('  if (step === "confirmed")'));
function harness(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [], errors: string[] = [], steps: string[] = [];
  const context = vm.createContext({ ...valid, addressLine2: "", accessInstructions: "", parentBookingId: "", packageId: "", addOnQuantities: {}, recurrence: "one_time", couponCode: "", bookingDisabled: false, serviceId: "test", hourlyConfig: null, additionalDurationMinutes: 0,
    missingBookingRequestDetails, setError: (s: string) => errors.push(s), setShowFullyBooked: () => {}, setLoading: () => {}, setRequiresLogin: () => {}, setTime: () => {}, setTimeSlots: () => {}, setProviderTimeZone: () => {}, setConfirmedPricing: () => {}, setStep: (s: string) => steps.push(s),
    fetch: async (url: string) => { calls.push(url); return { ok: true }; }, responseJson: async () => ({ times: ["10:00"], timeZone: "America/Los_Angeles" }), ...overrides });
  vm.runInContext(ts.transpile(availability + request, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }), context);
  return { context, calls, errors, steps };
}
test("in-person request lists missing address, question and quote details", () => {
  assert.deepEqual(missingBookingRequestDetails({ ...valid, addressLine1: " ", city: "", state: "XX", postalCode: "bad", quoteOnly: true, notes: "", bookingQuestions: ["What needs fixing?"] }), ["street address", "city", "valid US state", "valid ZIP code", 'answer to "What needs fixing?"', "description of what you need (at least 3 characters)"]);
});
test("remote request needs no postal address; changing to in-person does", () => {
  const input = { ...valid, addressLine1: "", city: "", state: "", postalCode: "" };
  assert.deepEqual(missingBookingRequestDetails({ ...input, deliveryMethod: "REMOTE" }), []);
  assert.equal(missingBookingRequestDetails(input).length, 4);
});
test("valid trimmed address and ZIP+4 pass", () => assert.deepEqual(missingBookingRequestDetails({ ...valid, state: " ca ", postalCode: "90001-1234" }), []));
test("actual availability handler fetches without address, question answers or quote description", async () => {
  const h = harness({ addressLine1: "", postalCode: "", bookingQuestions: ["Required question"], quoteOnly: true });
  await h.context.checkAvailability({ preventDefault() {} });
  assert.equal(h.calls.length, 1); assert.match(h.calls[0], /availability\?date=/); assert.equal(h.steps[0], "times");
  assert.match(source, /<form noValidate onSubmit=\{checkAvailability\}/);
});
test("actual request handler blocks missing fields before network side effect", async () => {
  const h = harness({ addressLine1: "", postalCode: "", bookingQuestions: ["Required question"] });
  await h.context.confirmRequest(); assert.equal(h.calls.length, 0);
  assert.match(h.errors[0], /street address/); assert.match(h.errors[0], /ZIP code/); assert.match(h.errors[0], /Required question/);
});
test("corrected in-person request and remote request can proceed", async () => {
  for (const overrides of [{}, { deliveryMethod: "REMOTE", addressLine1: "", postalCode: "" }]) {
    const h = harness(overrides); await h.context.confirmRequest(); assert.deepEqual(h.calls, ["/api/bookings"]); assert.equal(h.steps[0], "confirmed");
  }
});
test("availability keeps required scheduling inputs; request missing time is blocked", async () => {
  for (const overrides of [{ date: "" }, { deliveryMethod: "" }]) {
    const h = harness(overrides); await h.context.checkAvailability({ preventDefault() {} }); assert.equal(h.calls.length, 0);
  }
  const h = harness({ time: "" }); await h.context.confirmRequest(); assert.equal(h.calls.length, 0);
});
