"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import BookingDatePicker from "@/components/booking-date-picker";
import CustomSelect from "@/components/custom-select";
import type { ServiceDeliveryType } from "@/lib/service-delivery";
import { recurrenceLabel, type RecurrenceOption, type ServiceAddOn, type ServicePackage } from "@/lib/service-commerce";
import { calculateHourlyBasePriceCents, formatDurationMinutes, hourlyDurationOptions, type HourlyPricingConfig, type PricingType } from "@/lib/service-pricing";

type BookingCardProps = {
  serviceId: string;
  price: number;
  duration: string;
  pricingType: PricingType;
  hourlyRateCents: number | null;
  minimumDurationMinutes: number | null;
  maximumDurationMinutes: number | null;
  billingIncrementMinutes: number | null;
  defaultDurationMinutes: number | null;
  serviceTitle: string;
  provider: string;
  serviceCity: string;
  serviceState: string;
  isSignedIn: boolean;
  returnPath: string;
  cancellationPolicy: string;
  cancellationWindowHours: number;
  noShowPolicy: string;
  bookingQuestions: string[];
  bookingDisabled?: boolean;
  parentBookingId?: string;
  requestAnotherTimeHref: string;
  deliveryType: ServiceDeliveryType;
  packages: ServicePackage[];
  addOns: ServiceAddOn[];
  recurrenceOptions: RecurrenceOption[];
  serviceKind: "standard" | "consultation";
  preparationNotes: string;
};

function formatTime(time: string) {
  const [hoursText, minutes] = time.split(":");
  const hours = Number(hoursText);
  return `${hours % 12 || 12}:${minutes} ${hours >= 12 ? "PM" : "AM"}`;
}

type CouponPricing = {
  code?: string;
  originalSubtotalCents: number;
  discountCents: number;
  serviceSubtotalCents: number;
  customerServiceFeeCents: number;
  customerTotalCents: number;
  couponCode?: string | null;
};

async function responseJson<T>(response: Response | null) {
  if (!response) return null;
  return response.json().catch(() => null) as Promise<T | null>;
}

export default function BookingCard({ serviceId, price, duration, pricingType, hourlyRateCents, minimumDurationMinutes, maximumDurationMinutes, billingIncrementMinutes, defaultDurationMinutes, serviceTitle, provider, serviceCity, serviceState, isSignedIn, returnPath, cancellationPolicy, cancellationWindowHours, noShowPolicy, bookingQuestions, bookingDisabled = false, parentBookingId = "", requestAnotherTimeHref, deliveryType, packages, addOns, recurrenceOptions, serviceKind, preparationNotes }: BookingCardProps) {
  const quoteOnly = pricingType === "QUOTE_ONLY";
  const [deliveryMethod, setDeliveryMethod] = useState<"IN_PERSON" | "REMOTE" | "">(deliveryType === "BOTH" ? "" : deliveryType);
  const [addressLine1, setAddressLine1] = useState("");
  const [addressLine2, setAddressLine2] = useState("");
  const [city, setCity] = useState(serviceCity);
  const [state, setState] = useState(serviceState);
  const [postalCode, setPostalCode] = useState("");
  const [accessInstructions, setAccessInstructions] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [timeSlots, setTimeSlots] = useState<string[]>([]);
  const [providerTimeZone, setProviderTimeZone] = useState("");
  const [step, setStep] = useState<"details" | "times" | "confirmed">("details");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [requiresLogin, setRequiresLogin] = useState(false);
  const [showFullyBooked, setShowFullyBooked] = useState(false);
  const [notes, setNotes] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [packageId, setPackageId] = useState(quoteOnly ? "" : packages[0]?.id ?? "");
  const [addOnQuantities, setAddOnQuantities] = useState<Record<string, number>>({});
  const [recurrence, setRecurrence] = useState<RecurrenceOption>("one_time");
  const [couponCode, setCouponCode] = useState("");
  const [couponPricing, setCouponPricing] = useState<CouponPricing | null>(null);
  const [couponLoading, setCouponLoading] = useState(false);
  const [couponMessage, setCouponMessage] = useState("");
  const [confirmedPricing, setConfirmedPricing] = useState<CouponPricing | null>(null);
  const hourlyConfig: HourlyPricingConfig | null = pricingType === "HOURLY" && hourlyRateCents !== null && minimumDurationMinutes !== null && (billingIncrementMinutes === 15 || billingIncrementMinutes === 30 || billingIncrementMinutes === 60) && defaultDurationMinutes !== null ? { pricingType: "HOURLY", hourlyRateCents, minimumDurationMinutes, maximumDurationMinutes, billingIncrementMinutes, defaultDurationMinutes } : null;
  const [selectedDurationMinutes, setSelectedDurationMinutes] = useState(defaultDurationMinutes ?? Math.max(15, Math.round(Number(duration.split(" ")[0]) * 60) || 60));
  const selectedPackage = packages.find((item) => item.id === packageId);
  const visibleBasePriceCents = quoteOnly ? 0 : hourlyConfig ? calculateHourlyBasePriceCents(hourlyConfig.hourlyRateCents, selectedDurationMinutes) : (selectedPackage?.priceCents ?? Math.round(price * 100));
  const visiblePriceCents = visibleBasePriceCents + addOns.reduce((total, item) => total + item.priceCents * (addOnQuantities[item.id] ?? 0), 0);
  const additionalDurationMinutes = addOns.reduce((total, item) => total + item.additionalMinutes * (addOnQuantities[item.id] ?? 0), 0);
  const displayedServiceSubtotalCents = couponPricing?.serviceSubtotalCents ?? visiblePriceCents;

  function clearCouponPricing() {
    setCouponPricing(null);
    setCouponMessage("");
  }

  async function applyCoupon() {
    if (!couponCode) { setCouponMessage("Enter a coupon code first."); return; }
    setCouponLoading(true);
    setCouponMessage("");
    setCouponPricing(null);
    try {
      const response = await fetch("/api/coupons/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceId, durationMinutes: hourlyConfig ? selectedDurationMinutes : null, packageId: packageId || null, addOns: Object.entries(addOnQuantities).filter(([, quantity]) => quantity > 0).map(([addOnId, quantity]) => ({ addOnId, quantity })), couponCode }),
      });
      const data = await responseJson<CouponPricing & { error?: string }>(response);
      if (!response.ok || !data) { setCouponMessage(data?.error ?? "That coupon could not be applied. Please try again."); return; }
      setCouponPricing(data);
      setCouponMessage(`${data.code ?? couponCode} applied.`);
    } catch {
      setCouponMessage("That coupon could not be checked. Check your connection and try again.");
    } finally {
      setCouponLoading(false);
    }
  }

  async function checkAvailability(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (bookingDisabled) {
      setError("");
      setShowFullyBooked(true);
      return;
    }
    if (!deliveryMethod) {
      setError("Choose whether you want this service in person or remotely.");
      return;
    }
    if (deliveryMethod === "IN_PERSON" && (!addressLine1.trim() || !city.trim() || !/^[A-Za-z]{2}$/.test(state.trim()) || !/^\d{5}(?:-\d{4})?$/.test(postalCode.trim()))) {
      setError("Add a complete US service address and date to see available times.");
      return;
    }
    if (!date) { setError("Choose a date to see available times."); return; }
    setError("");
    setLoading(true);
    const response = await fetch(`/api/services/${serviceId}/availability?date=${encodeURIComponent(date)}${hourlyConfig ? `&durationMinutes=${selectedDurationMinutes}` : ""}${additionalDurationMinutes ? `&additionalMinutes=${additionalDurationMinutes}` : ""}`).catch(() => null);
    if (!response) {
      setLoading(false);
      setError("We could not check availability. Please try again.");
      return;
    }
    const data = await responseJson<{ times?: string[]; timeZone?: string; error?: string }>(response);
    setLoading(false);
    if (!response.ok || !data) {
      setError(data?.error ?? "We could not check availability. Please try again.");
      return;
    }
    setTimeSlots(data.times ?? []);
    setProviderTimeZone(data.timeZone ?? "");
    setStep("times");
  }

  async function confirmRequest() {
    if (!time) {
      setError("Choose an available time to continue.");
      return;
    }
    if (quoteOnly && notes.trim().length < 3) {
      setError("Describe what you need so the provider can prepare an accurate quote.");
      return;
    }
    setError("");
    setRequiresLogin(false);
    setLoading(true);
    const response = await fetch("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serviceId, date, time, durationMinutes: hourlyConfig ? selectedDurationMinutes : null, deliveryMethod, addressLine1, addressLine2, city, state, postalCode, accessInstructions, notes, answers, parentBookingId, packageId: quoteOnly ? null : packageId || null, addOns: quoteOnly ? [] : Object.entries(addOnQuantities).filter(([, quantity]) => quantity > 0).map(([addOnId, quantity]) => ({ addOnId, quantity })), recurrence: quoteOnly ? "one_time" : recurrence, couponCode: quoteOnly ? "" : couponCode }),
    }).catch(() => null);
    if (!response) {
      setLoading(false);
      setError("We could not send your request. Please try again.");
      return;
    }
    const data = await responseJson<{ error?: string; pricing?: CouponPricing }>(response);
    setLoading(false);
    if (!response.ok || !data) {
      setRequiresLogin(response.status === 401);
      setError(data?.error ?? "We could not send your request. Please try again.");
      if (response.status === 409) {
        setTime("");
        setStep("details");
      }
      return;
    }
    setConfirmedPricing(data.pricing ?? null);
    setStep("confirmed");
  }

  if (step === "confirmed") {
    return (
      <div className="rounded-[2rem] border border-[#183126]/10 bg-white p-7 text-center shadow-[0_20px_50px_rgba(24,49,38,.12)]">
        <span className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-[#e5f1e7] text-3xl text-[#33704a]">✓</span>
        <p className="mt-6 text-xs font-bold uppercase tracking-[.16em] text-[#6a7c72]">Request sent</p>
        <h2 className="mt-2 text-2xl font-bold tracking-tight">Your request is on its way to {provider}.</h2>
        <p className="mt-3 text-sm leading-6 text-[#6c7b74]">We&apos;ve requested {date} at {formatTime(time)}. You&apos;ll receive a confirmation before anything is charged.</p>
        <div className="mt-6 rounded-2xl bg-[#f7f6f1] p-4 text-left">
          <p className="text-xs font-bold uppercase tracking-wider text-[#78867f]">Booking summary</p>
          <p className="mt-2 font-bold">{serviceTitle}</p>
          <p className="mt-1 text-sm text-[#6c7b74]">{deliveryMethod === "REMOTE" ? "Remote service" : <>{addressLine1}{addressLine2 ? `, ${addressLine2}` : ""}, {city}, {state.toUpperCase()} {postalCode}</>} · {quoteOnly ? "Custom quote requested. No price has been approved yet." : <>{hourlyConfig ? `${formatDurationMinutes(selectedDurationMinutes)} at $${(hourlyConfig.hourlyRateCents / 100).toFixed(2)}/hr · ` : ""}${((confirmedPricing?.serviceSubtotalCents ?? visiblePriceCents) / 100).toFixed(2)} service subtotal{recurrence !== "one_time" ? ` · ${recurrenceLabel(recurrence)}` : ""}</>}</p>
          {!quoteOnly && confirmedPricing && <p className="mt-2 text-xs text-[#718078]">${(confirmedPricing.customerServiceFeeCents / 100).toFixed(2)} service fee · ${(confirmedPricing.customerTotalCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} total after provider confirmation{confirmedPricing.discountCents > 0 ? ` · ${(confirmedPricing.discountCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} coupon savings` : ""}</p>}
        </div>
        <Link href="/account" className="mt-5 block w-full rounded-full bg-[#183126] px-6 py-3.5 text-sm font-bold text-white transition hover:bg-[#294a3a]">View my bookings</Link>
        <button onClick={() => { setStep("details"); setTime(""); setTimeSlots([]); }} className="mt-6 rounded-full px-4 py-2 text-sm font-bold underline decoration-[#c2b842] decoration-2 underline-offset-4 transition hover:bg-[#eee25a]">Make another request</button>
      </div>
    );
  }

  if (!isSignedIn) {
    const redirect = encodeURIComponent(returnPath);
    return <div className="rounded-[2rem] border border-[#183126]/10 bg-white p-7 text-center shadow-[0_20px_50px_rgba(24,49,38,.12)]"><span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-[#e7eee2] text-2xl">🔒</span><p className="mt-5 text-xs font-bold uppercase tracking-[.16em] text-[#6a7c72]">Account required</p><h2 className="mt-2 text-2xl font-bold">Log in to {quoteOnly ? "request a quote" : "book this service"}</h2><p className="mt-3 text-sm leading-6 text-[#6c7b74]">Every customer needs their own BubsBookings account so bookings, messages, and safety records stay with the right person.</p><div className="mt-6 grid gap-3"><Link href={`/login?redirect=${redirect}`} className="rounded-full bg-[#183126] px-6 py-3.5 text-sm font-bold text-white transition hover:bg-[#315846]">Log in</Link><Link href={`/signup?redirect=${redirect}`} className="rounded-full bg-[#eee25a] px-6 py-3.5 text-sm font-bold transition hover:bg-[#e1d43d]">Create an account</Link></div></div>;
  }

  return (
    <div className="rounded-[2rem] border border-[#183126]/10 bg-white p-6 shadow-[0_20px_50px_rgba(24,49,38,.12)] sm:p-7">
      <div className="flex items-end justify-between gap-3">
        <div><p className="text-sm text-[#6f7f77]">{quoteOnly ? "Custom Quote" : hourlyConfig ? `$${(hourlyConfig.hourlyRateCents / 100).toFixed(2)}/hr × ${formatDurationMinutes(selectedDurationMinutes)}` : packages.length || couponPricing ? "Selected service subtotal" : "Starting at"}</p><p className="mt-1 text-3xl font-bold tracking-tight">{quoteOnly ? "Request a Quote" : `$${(displayedServiceSubtotalCents / 100).toFixed(2)}`}</p>{!quoteOnly && couponPricing && <p className="mt-1 text-xs font-semibold text-[#34704a]">You save ${(couponPricing.discountCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}</p>}</div>
        <p className="rounded-full bg-[#f1f0eb] px-3 py-1.5 text-xs font-semibold text-[#5f7067]">{hourlyConfig ? "Estimated service subtotal" : `Estimated time: ${duration}`}</p>
      </div>

      <form onSubmit={checkAvailability} className="mt-7 space-y-3">
        {hourlyConfig && <fieldset className="rounded-2xl border border-[#183126]/10 bg-[#f5f7f2] p-4"><legend className="px-1 text-sm font-bold">Choose your booking duration</legend><label className="mt-3 block"><span className="mb-2 block text-xs font-bold uppercase tracking-wider text-[#708078]">Duration</span><CustomSelect ariaLabel="Booking duration" value={selectedDurationMinutes} onChange={(value) => { setSelectedDurationMinutes(Number(value)); setTime(""); setTimeSlots([]); setStep("details"); clearCouponPricing(); }} buttonClassName="min-h-12 w-full rounded-xl border border-[#183126]/15 bg-white px-4 text-sm font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4d725d]" ariaDescribedBy="hourly-duration-help">{hourlyDurationOptions(hourlyConfig).map((minutes) => <option key={minutes} value={minutes}>{formatDurationMinutes(minutes)} · ${(calculateHourlyBasePriceCents(hourlyConfig.hourlyRateCents, minutes) / 100).toFixed(2)}</option>)}</CustomSelect></label><p id="hourly-duration-help" className="mt-2 text-xs leading-5 text-[#718078]">{formatDurationMinutes(hourlyConfig.minimumDurationMinutes)} minimum · {hourlyConfig.billingIncrementMinutes}-minute increments{hourlyConfig.maximumDurationMinutes ? ` · ${formatDurationMinutes(hourlyConfig.maximumDurationMinutes)} maximum` : ""}. Changing duration recalculates availability.</p></fieldset>}
        {!quoteOnly && packages.length > 0 && <fieldset><legend className="mb-3 text-xs font-bold uppercase tracking-wider text-[#708078]">Choose a package</legend><div className="grid gap-2">{packages.map((item) => <label key={item.id} className={`cursor-pointer rounded-2xl border p-4 ${packageId === item.id ? "border-[#183126] bg-[#edf3e7]" : "border-[#183126]/12 bg-white"}`}><input type="radio" className="sr-only" name="package" checked={packageId === item.id} onChange={() => { setPackageId(item.id); clearCouponPricing(); }} /><span className="flex items-start justify-between gap-3"><span><strong className="block">{item.name}</strong><span className="mt-1 block text-xs leading-5 text-[#6d7c75]">{item.description}</span></span><strong className="shrink-0">${(item.priceCents / 100).toFixed(2)}</strong></span>{item.features.length > 0 && <span className="mt-2 block text-xs text-[#52665b]">{item.features.join(" · ")}</span>}</label>)}</div></fieldset>}
        {!quoteOnly && addOns.length > 0 && <fieldset className="rounded-2xl bg-[#f5f7f2] p-4"><legend className="px-1 text-sm font-bold">Optional add-ons</legend><div className="mt-3 grid gap-2">{addOns.map((item) => { const quantity = addOnQuantities[item.id] ?? 0; return <div key={item.id} className="flex min-w-0 items-center gap-3 rounded-xl bg-white p-3"><label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3"><input type="checkbox" className="mt-1" checked={quantity > 0} onChange={(event) => { setAddOnQuantities((current) => ({ ...current, [item.id]: event.target.checked ? 1 : 0 })); clearCouponPricing(); }} /><span className="min-w-0"><strong className="block text-sm">{item.name} · +${(item.priceCents / 100).toFixed(2)}</strong>{item.description && <span className="block text-xs leading-5 text-[#718078]">{item.description}</span>}</span></label>{item.allowsQuantity && quantity > 0 && <CustomSelect ariaLabel={`${item.name} quantity`} value={quantity} onChange={(value) => { setAddOnQuantities((current) => ({ ...current, [item.id]: Number(value) })); clearCouponPricing(); }} buttonClassName="shrink-0 rounded-lg border border-[#183126]/15 px-2 py-2 text-sm">{Array.from({ length: item.maxQuantity }, (_, index) => index + 1).map((value) => <option key={value}>{value}</option>)}</CustomSelect>}</div>; })}</div></fieldset>}
        {!quoteOnly && recurrenceOptions.length > 1 && <fieldset className="rounded-2xl border border-[#183126]/10 p-4"><legend className="px-1 text-sm font-bold">One time or recurring?</legend><div className="mt-3 grid grid-cols-2 gap-2">{recurrenceOptions.map((option) => <label key={option} className={`flex min-h-12 cursor-pointer items-center justify-center rounded-xl border px-3 text-center text-sm font-bold ${recurrence === option ? "border-[#183126] bg-[#183126] text-white" : "border-[#183126]/15 bg-white"}`}><input type="radio" className="sr-only" name="recurrence" checked={recurrence === option} onChange={() => setRecurrence(option)} />{recurrenceLabel(option)}</label>)}</div><p className="mt-3 text-xs leading-5 text-[#718078]">Recurring visits create separate booking and payment records. You can cancel future visits without removing completed history.</p></fieldset>}
        {serviceKind === "consultation" && preparationNotes && <div className="rounded-2xl bg-[#fff8cf] p-4 text-sm"><strong>Before your consultation</strong><p className="mt-1 text-xs leading-5 text-[#6d642c]">{preparationNotes}</p></div>}
        {bookingQuestions.map((question) => <label key={question} className="block"><span className="mb-2 block text-xs font-bold uppercase tracking-wider text-[#708078]">{question}</span><textarea required={!bookingDisabled} value={answers[question] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [question]: event.target.value }))} maxLength={500} rows={2} className="w-full resize-none rounded-2xl border border-[#183126]/15 bg-[#faf9f5] px-4 py-3.5 text-sm outline-none transition focus:border-[#4d725d] focus:ring-2 focus:ring-[#4d725d]/10" /></label>)}
        {deliveryType === "BOTH" && <fieldset className="rounded-2xl bg-[#f5f7f2] p-4"><legend className="px-1 text-sm font-bold">How would you like this service?</legend><div className="mt-3 grid grid-cols-2 gap-2">{(["IN_PERSON", "REMOTE"] as const).map((method) => <label key={method} className={`flex min-h-12 cursor-pointer items-center justify-center rounded-xl border px-3 text-center text-sm font-bold ${deliveryMethod === method ? "border-[#183126] bg-[#183126] text-white" : "border-[#183126]/15 bg-white"}`}><input type="radio" className="sr-only" name="deliveryMethod" value={method} checked={deliveryMethod === method} onChange={() => { setDeliveryMethod(method); setError(""); }} />{method === "REMOTE" ? "Remote / online" : "In person"}</label>)}</div></fieldset>}
        {deliveryMethod !== "REMOTE" && <section className="rounded-2xl bg-[#f5f7f2] p-4">
          <div className="mb-4 flex items-start gap-3"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white text-sm">⌖</span><div><h3 className="text-sm font-bold">Where do you need the service?</h3><p className="mt-0.5 text-xs leading-5 text-[#6d7c75]">Your street address stays private until the provider accepts.</p></div></div>
          <div className="space-y-3">
            <label className="block"><span className="sr-only">Street address</span><input required={!bookingDisabled} autoComplete="address-line1" maxLength={120} value={addressLine1} onChange={(event) => setAddressLine1(event.target.value)} placeholder="Street address" className="w-full rounded-xl border border-[#183126]/15 bg-white px-4 py-3 text-sm outline-none transition focus:border-[#4d725d] focus:ring-2 focus:ring-[#4d725d]/10" /></label>
            <label className="block"><span className="sr-only">City</span><input required={!bookingDisabled} autoComplete="address-level2" maxLength={80} value={city} onChange={(event) => setCity(event.target.value)} placeholder="City" className="w-full rounded-xl border border-[#183126]/15 bg-white px-4 py-3 text-sm outline-none focus:border-[#4d725d]" /></label>
            <div className="grid grid-cols-[84px_1fr] gap-2"><label className="block"><span className="sr-only">State</span><input required={!bookingDisabled} autoComplete="address-level1" inputMode="text" maxLength={2} value={state} onChange={(event) => setState(event.target.value.toUpperCase().replace(/[^A-Z]/g, ""))} placeholder="State" className="w-full rounded-xl border border-[#183126]/15 bg-white px-3 py-3 text-sm uppercase outline-none focus:border-[#4d725d]" /></label><label className="block"><span className="sr-only">ZIP code</span><input required={!bookingDisabled} autoComplete="postal-code" inputMode="numeric" maxLength={10} pattern="[0-9]{5}(-[0-9]{4})?" value={postalCode} onChange={(event) => setPostalCode(event.target.value.replace(/[^0-9-]/g, ""))} placeholder="ZIP code" className="w-full rounded-xl border border-[#183126]/15 bg-white px-4 py-3 text-sm outline-none focus:border-[#4d725d]" /></label></div>
            <details className="group rounded-xl border border-[#183126]/10 bg-white"><summary className="booking-detail-toggle cursor-pointer list-none font-bold text-[#52665b] marker:hidden">+ Add unit or arrival instructions</summary><div className="space-y-3 border-t border-[#183126]/8 p-3"><label className="block"><span className="mb-1.5 block text-xs font-bold">Apartment, unit, or suite</span><input autoComplete="address-line2" maxLength={80} value={addressLine2} onChange={(event) => setAddressLine2(event.target.value)} placeholder="Apt 4B" className="w-full rounded-xl border border-[#183126]/15 bg-[#fafaf6] px-4 py-3 text-sm outline-none focus:border-[#4d725d]" /></label><label className="block"><span className="mb-1.5 block text-xs font-bold">Arrival or parking instructions</span><textarea value={accessInstructions} onChange={(event) => setAccessInstructions(event.target.value)} maxLength={500} rows={2} placeholder="Parking, entrance, or other helpful directions. No alarm or access codes." className="w-full resize-none rounded-xl border border-[#183126]/15 bg-[#fafaf6] px-4 py-3 text-sm outline-none focus:border-[#4d725d]" /></label></div></details>
          </div>
        </section>}
        {deliveryMethod === "REMOTE" && <section className="rounded-2xl bg-[#f5f7f2] p-4"><div className="flex items-start gap-3"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white text-sm">⌁</span><div><h3 className="text-sm font-bold">Remote service</h3><p className="mt-0.5 text-xs leading-5 text-[#6d7c75]">No street address is needed. After confirmation, use BubsBookings messages to coordinate the provider&apos;s approved meeting or delivery method.</p></div></div></section>}
        {quoteOnly ? <label className="block rounded-2xl border border-[#183126]/10 bg-[#f5f7f2] p-4"><span className="mb-2 block text-sm font-bold">Tell the provider what you need</span><textarea required value={notes} onChange={(event) => setNotes(event.target.value)} minLength={3} maxLength={1000} rows={5} placeholder="Describe the project, goals, size, timing, and anything else the provider needs to prepare an accurate quote. Do not include passwords or payment information." className="w-full resize-none rounded-xl border border-[#183126]/15 bg-white px-4 py-3 text-sm outline-none transition focus:border-[#4d725d] focus:ring-2 focus:ring-[#4d725d]/10" /><span className="mt-2 block text-xs leading-5 text-[#718078]">The provider can discuss the details with you and send a quote. Nothing is charged until you accept the quote and complete checkout.</span></label> : <details className="rounded-2xl border border-[#183126]/10 bg-white"><summary className="booking-detail-toggle cursor-pointer list-none font-bold text-[#52665b] marker:hidden">+ Add booking notes</summary><div className="border-t border-[#183126]/8 p-3"><label className="block"><span className="sr-only">Booking notes</span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={1000} rows={3} placeholder="Describe what you need or anything the provider should know. Keep addresses, passwords, and payment information out of this box." className="w-full resize-none rounded-xl border border-[#183126]/15 bg-[#fafaf6] px-4 py-3 text-sm outline-none transition focus:border-[#4d725d] focus:ring-2 focus:ring-[#4d725d]/10" /></label></div></details>}
        {!quoteOnly && <div className="block"><label htmlFor="booking-coupon" className="mb-2 block text-xs font-bold uppercase tracking-wider text-[#708078]">Coupon <span className="normal-case font-normal">(optional)</span></label><div className="flex gap-2"><input id="booking-coupon" value={couponCode} onChange={(event) => { setCouponCode(event.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 32)); clearCouponPricing(); }} autoComplete="off" placeholder="Enter provider coupon" className="min-w-0 flex-1 rounded-xl border border-[#183126]/15 bg-white px-4 py-3 text-sm uppercase outline-none focus:border-[#4d725d]" /><button type="button" onClick={()=>void applyCoupon()} disabled={couponLoading || !couponCode} className="min-h-12 shrink-0 rounded-xl border border-[#183126]/15 bg-[#edf3e7] px-4 text-sm font-bold disabled:opacity-50">{couponLoading?"Checking…":"Apply"}</button></div>{couponMessage&&<p role={couponPricing?"status":"alert"} className={`mt-2 text-xs font-semibold ${couponPricing?"text-[#34704a]":"text-[#9a4e25]"}`}>{couponMessage}</p>}{couponPricing&&<div className="mt-3 rounded-xl bg-[#f5f7f2] p-3 text-xs"><div className="flex justify-between gap-3"><span>Service before coupon</span><span>${(couponPricing.originalSubtotalCents/100).toFixed(2)}</span></div><div className="mt-1 flex justify-between gap-3 font-bold text-[#34704a]"><span>Coupon savings</span><span>−${(couponPricing.discountCents/100).toFixed(2)}</span></div><div className="mt-2 flex justify-between gap-3 border-t border-[#183126]/10 pt-2 font-bold"><span>Service subtotal</span><span>${(couponPricing.serviceSubtotalCents/100).toFixed(2)}</span></div><div className="mt-1 flex justify-between gap-3 text-[#718078]"><span>BubsBookings service fee</span><span>${(couponPricing.customerServiceFeeCents/100).toFixed(2)}</span></div><div className="mt-2 flex justify-between gap-3 text-sm font-bold"><span>Total after confirmation</span><span>${(couponPricing.customerTotalCents/100).toFixed(2)}</span></div></div>}<span className="mt-1.5 block text-xs text-[#718078]">The provider funds valid discounts. The $2.99 BubsBookings service fee is shown separately at checkout.{recurrence!=="one_time"?" A coupon applies to this first occurrence unless a future offer states otherwise.":""}</span></div>}
        <div className="block">
          <span className="mb-2 block text-xs font-bold uppercase tracking-wider text-[#708078]">Preferred date</span>
          <BookingDatePicker serviceId={serviceId} value={date} disabled={bookingDisabled} durationMinutes={hourlyConfig ? selectedDurationMinutes : undefined} additionalMinutes={additionalDurationMinutes} onChange={(nextDate) => { setDate(nextDate); setTime(""); setTimeSlots([]); setStep("details"); setError(""); }} />
        </div>

        {step === "times" && (
          <fieldset className="pt-2">
            <legend className="mb-3 text-xs font-bold uppercase tracking-wider text-[#708078]">Available times{providerTimeZone ? ` · ${providerTimeZone}` : ""}</legend>
            <div className="grid grid-cols-2 gap-2">
              {timeSlots.map((slot) => (
                <button key={slot} type="button" onClick={() => { setTime(slot); setError(""); }} className={`rounded-xl border px-3 py-3 text-sm font-semibold transition ${time === slot ? "border-[#183126] bg-[#183126] text-white" : "border-[#183126]/15 bg-white hover:border-[#8f8421] hover:bg-[#fff7ad]"}`}>{formatTime(slot)}</button>
              ))}
            </div>
            {timeSlots.length === 0 && <div className="rounded-xl bg-[#f5f5ef] p-4 text-center text-sm text-[#708078]"><p>No times are available on this date.</p><Link href={requestAnotherTimeHref} className="mt-3 inline-flex rounded-full bg-[#183126] px-4 py-2 text-xs font-bold text-white">Request another time</Link></div>}
          </fieldset>
        )}

        {error && <div role="alert" className="rounded-xl bg-[#fff1e8] px-3 py-2.5 text-xs font-semibold text-[#9a4e25]">{error}{requiresLogin && <Link href={`/login?redirect=${encodeURIComponent(returnPath)}`} className="ml-1 underline">Log in here.</Link>}</div>}

        {step === "details" ? (
        <button type="submit" disabled={loading} className="mt-3 w-full rounded-full bg-[#eee25a] px-6 py-4 font-bold text-[#183126] transition hover:bg-[#f5ea6b] disabled:cursor-wait disabled:opacity-60">{loading ? "Checking…" : quoteOnly ? "Check times for quote request" : "Check availability"}</button>
        ) : (
          <button type="button" onClick={confirmRequest} disabled={loading || !time} className="mt-3 w-full rounded-full bg-[#eee25a] px-6 py-4 font-bold text-[#183126] transition hover:bg-[#f5ea6b] disabled:cursor-not-allowed disabled:opacity-55">{loading ? "Sending request…" : quoteOnly ? "Request a Quote" : "Request this time"}</button>
        )}

        {showFullyBooked && <div role="alert" className="rounded-2xl border border-[#e5d45a] bg-[#fff5cf] p-4 text-sm text-[#6d5d16]"><p className="font-bold text-[#183126]">This service is fully booked</p><p className="mt-1 leading-6">There are no appointments available right now. Please come back later to check for new availability.</p></div>}
      </form>

      <p className="mt-4 text-center text-xs leading-5 text-[#7c8a83] lg:hidden">No charge yet. The provider will confirm your request before the time is reserved. Text is checked by the BubsBookings Safety Bot.</p>
      <div className="mt-4 rounded-2xl bg-[#f5f5ef] p-4 lg:hidden"><p className="text-xs font-bold">Cancellation policy · {cancellationWindowHours}h notice</p><p className="mt-1 text-xs leading-5 text-[#718078]">{cancellationPolicy}</p><p className="mt-3 text-xs font-bold">No-show policy</p><p className="mt-1 text-xs leading-5 text-[#718078]">{noShowPolicy}</p></div>
      <div className="mt-6 border-t border-[#183126]/10 pt-6 lg:hidden">
        <div className="flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-2xl bg-[#e8f2e9] text-xl">✓</span><div><p className="text-sm font-bold">BubsBookings Promise</p><p className="text-xs text-[#76847d]">Clear provider details and payments through Stripe</p></div></div>
      </div>
    </div>
  );
}
