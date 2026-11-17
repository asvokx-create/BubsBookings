"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { SERVICE_CATEGORIES } from "@/lib/service-categories";
import BackButton from "@/components/back-button";
import CustomSelect from "@/components/custom-select";
import { deliveryLabel, type ServiceDeliveryType } from "@/lib/service-delivery";
import { RECURRENCE_OPTIONS, recurrenceLabel, type RecurrenceOption } from "@/lib/service-commerce";
import { previewHourlyBasePriceCents, TRACKED_HOURLY_LEGACY_DEFAULTS, type PricingType } from "@/lib/service-pricing";

type EditablePackage = { id?: string; name: string; description: string; price: number; durationMinutes: number; deliveryDays: number | null; revisionCount: number | null; features: string[] };
type EditableAddOn = { id?: string; name: string; description: string; price: number; additionalMinutes: number; allowsQuantity: boolean; maxQuantity: number };

type Listing = {
  id: string;
  businessName: string;
  slug: string;
  title: string;
  category: string;
  deliveryType: ServiceDeliveryType;
  remoteDeliveryDetails: string;
  description: string;
  price: number;
  durationMinutes: number;
  pricingType: PricingType;
  hourlyRate: number | null;
  minimumDurationMinutes: number | null;
  maximumDurationMinutes: number | null;
  billingIncrementMinutes: 15 | 30 | 60 | null;
  defaultDurationMinutes: number | null;
  location: string;
  locationId: string | null;
  locationName: string | null;
  locations: Array<{ id: string; name: string; location: string }>;
  bookingQuestions: string[];
  customQuestionsAllowed: boolean;
  multipleLocationsAllowed: boolean;
  serviceKind: "standard" | "consultation";
  preparationNotes: string;
  recurrenceOptions: RecurrenceOption[];
  packages: EditablePackage[];
  addOns: EditableAddOn[];
};

export default function ListingEditor({ serviceId }: { serviceId: string }) {
  const router = useRouter();
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [durationAmount, setDurationAmount] = useState("2");
  const [durationUnit, setDurationUnit] = useState<"hours" | "days">("hours");

  useEffect(() => {
    let active = true;
    fetch(`/api/providers/services/${serviceId}`)
      .then(async (response) => {
        const result = (await response.json()) as Listing & { error?: string };
        if (!response.ok) throw new Error(result.error ?? "Listing not found.");
        if (active) {
          const unit = result.durationMinutes >= 1440 && result.durationMinutes % 1440 === 0 ? "days" : "hours";
          setListing(result);
          setDurationUnit(unit);
          setDurationAmount(String(result.durationMinutes / (unit === "days" ? 1440 : 60)));
        }
      })
      .catch(() => { if (active) setError("We couldn't load this listing. Refresh the page and try again."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [serviceId]);

  function change<Key extends keyof Listing>(key: Key, value: Listing[Key]) {
    setListing((current) => current ? { ...current, [key]: value } : current);
    setSaved(false);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!listing) return;
    if (listing.pricingType === "HOURLY" && hourlyPreview === null) {
      setError("Enter a valid hourly rate ($0.50–$1,000,000).");
      return;
    }
    setSaving(true);
    setError("");
    const response = await fetch(`/api/providers/services/${serviceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(listing),
    });
    const result = (await response.json()) as { error?: string };
    setSaving(false);
    if (!response.ok) {
      setError(result.error ?? "We could not save your changes.");
      return;
    }
    setSaved(true);
    router.refresh();
  }

  async function deleteListing() {
    setDeleting(true);
    setError("");
    const response = await fetch(`/api/providers/services/${serviceId}`, { method: "DELETE" });
    const result = (await response.json()) as { error?: string };
    if (!response.ok) {
      setDeleting(false);
      setConfirmDelete(false);
      setError(result.error ?? "We could not delete this listing.");
      return;
    }
    router.push("/provider/dashboard?listing=deleted");
    router.refresh();
  }

  const hourlyPreview = previewHourlyBasePriceCents(Math.round((listing?.hourlyRate ?? 0) * 100), 60);
  const inputClass = "w-full rounded-2xl border border-[#183126]/15 bg-[#faf9f5] px-4 py-3.5 text-sm outline-none transition focus:border-[#4d725d] focus:ring-2 focus:ring-[#4d725d]/10";

  return (
    <main className="min-h-screen bg-[#f4f4ef] px-5 py-8 text-[#183126] sm:px-8 sm:py-12">
      <div className="mx-auto max-w-3xl">
        <BackButton label="Back to services" fallbackHref="/provider/dashboard/services" />
        <div className="mt-6 rounded-[2rem] border border-[#183126]/10 bg-white p-6 shadow-[0_18px_50px_rgba(24,49,38,.08)] sm:p-9">
          <p className="text-xs font-bold uppercase tracking-[.14em] text-[#718078]">Manage listing</p>
          <h1 className="mt-2 text-3xl font-bold tracking-[-.04em]">Edit your service</h1>
          <p className="mt-2 text-sm leading-6 text-[#6b7b73]">Updates appear on the public marketplace as soon as you save.</p>

          {loading && <div className="mt-8 h-72 animate-pulse rounded-2xl bg-[#eef0ea]" />}
          {!loading && !listing && <div className="mt-8 rounded-2xl bg-[#fff1e8] p-5 text-sm font-semibold text-[#9a4e25]">{error || "Listing not found."}</div>}
          {listing && <form onSubmit={save} className="mt-8 space-y-5">
            <label className="block"><span className="mb-2 block text-sm font-bold">Company page</span><input value={listing.businessName} readOnly className={`${inputClass} cursor-not-allowed bg-[#eef1eb] font-bold`} /><span className="mt-2 block text-xs text-[#849189]">This listing belongs to {listing.businessName}. Create a new listing to use a different company page.</span></label>
            <label className="block"><span className="mb-2 block text-sm font-bold">Service title</span><input value={listing.title} onChange={(event) => change("title", event.target.value)} className={inputClass} /></label>
            <label className="block"><span className="mb-2 block text-sm font-bold">Category</span><CustomSelect ariaLabel="Service category" searchable value={SERVICE_CATEGORIES.includes(listing.category as (typeof SERVICE_CATEGORIES)[number]) ? listing.category : "__custom__"} onChange={(value) => change("category", value === "__custom__" ? "" : value)} buttonClassName={inputClass}>{SERVICE_CATEGORIES.map((category) => <option key={category}>{category}</option>)}<option value="__custom__">Other / custom category…</option></CustomSelect>{!SERVICE_CATEGORIES.includes(listing.category as (typeof SERVICE_CATEGORIES)[number]) && <input value={listing.category} onChange={(event) => change("category", event.target.value)} maxLength={80} placeholder="Type your service category" className={`${inputClass} mt-3`} />}</label>
            <fieldset><legend className="mb-2 text-sm font-bold">How is this service provided?</legend><div className="grid gap-2 sm:grid-cols-3">{(["IN_PERSON", "REMOTE", "BOTH"] as const).map((value) => <label key={value} className={`cursor-pointer rounded-2xl border p-4 ${listing.deliveryType === value ? "border-[#4d725d] bg-[#edf3e7]" : "border-[#183126]/12"}`}><input type="radio" name="deliveryType" checked={listing.deliveryType === value} onChange={() => change("deliveryType", value)} className="sr-only" /><span className="font-bold">{deliveryLabel(value)}</span><span className="mt-1 block text-xs leading-5 text-[#718078]">{value === "IN_PERSON" ? "Customer and provider meet in person." : value === "REMOTE" ? "Completed online; no service radius." : "Customer chooses online or in person."}</span></label>)}</div></fieldset>
            <label className="flex cursor-pointer items-start justify-between gap-4 rounded-[1.5rem] border border-[#183126]/10 bg-[#fafaf6] p-5"><span><strong className="block text-sm">Custom Quote Only</strong><span className="mt-1 block text-xs leading-5 text-[#718078]">Customers will contact you for a personalized quote instead of booking at a fixed price.</span></span><input type="checkbox" className="mt-1 h-5 w-5" checked={listing.pricingType === "QUOTE_ONLY"} onChange={(event) => change("pricingType", event.target.checked ? "QUOTE_ONLY" : "FIXED")} /></label>
            {listing.pricingType !== "QUOTE_ONLY" && <fieldset className="rounded-[1.5rem] border border-[#183126]/10 p-5"><legend className="px-2 text-sm font-bold">Pricing type</legend><div className="grid gap-2 sm:grid-cols-2">{(["FIXED", "HOURLY"] as const).map((value) => <label key={value} className={`cursor-pointer rounded-xl border p-4 ${listing.pricingType === value ? "border-[#4d725d] bg-[#edf3e7]" : "border-[#183126]/10"}`}><input type="radio" className="sr-only" name="pricingType" checked={listing.pricingType === value} onChange={() => { change("pricingType", value); if (value === "HOURLY") setListing((current) => current ? { ...current, pricingType: value, hourlyRate: current.hourlyRate ?? current.price, ...TRACKED_HOURLY_LEGACY_DEFAULTS, packages: [] } : current); }} /><span className="font-bold">{value === "FIXED" ? "Fixed price" : "Hourly rate"}</span><span className="mt-1 block text-xs leading-5 text-[#718078]">{value === "FIXED" ? "One approved service price." : "Customers set a work limit, review tracked time, then pay."}</span></label>)}</div></fieldset>}
            {listing.pricingType === "QUOTE_ONLY" ? <div className="grid gap-4 rounded-[1.5rem] bg-[#edf3e7] p-5 sm:grid-cols-2"><div><p className="text-sm font-bold">Personalized pricing</p><p className="mt-1 text-xs leading-5 text-[#65776d]">No price will appear publicly or be used at checkout until the customer accepts your quote.</p></div><label className="block"><span className="mb-2 block text-sm font-bold">Estimated job duration</span><div className="grid grid-cols-[minmax(0,1fr)_7.5rem] gap-2"><input aria-label="Estimated job duration" type="number" min={durationUnit === "hours" ? "0.25" : "0.01"} step={durationUnit === "hours" ? "0.25" : "0.01"} value={durationAmount} onChange={(event) => { const amount = event.target.value; setDurationAmount(amount); change("durationMinutes", Math.round(Number(amount) * (durationUnit === "days" ? 1440 : 60))); }} className={`${inputClass} bg-white`} /><CustomSelect ariaLabel="Duration unit" value={durationUnit} onChange={(value) => { const unit = value as "hours" | "days"; setDurationUnit(unit); change("durationMinutes", Math.round(Number(durationAmount) * (unit === "days" ? 1440 : 60))); }} buttonClassName={`${inputClass} bg-white`}><option value="hours">Hours</option><option value="days">Days</option></CustomSelect></div></label></div> : listing.pricingType === "FIXED" ? <div className="grid gap-4 sm:grid-cols-2">
              <label className="block"><span className="mb-2 block text-sm font-bold">Starting price</span><div className="relative"><span className="absolute left-4 top-3.5 text-sm text-[#65766d]">$</span><input type="number" min="1" step="0.01" value={listing.price} onChange={(event) => change("price", Number(event.target.value))} className={`${inputClass} pl-8`} /></div></label>
              <label className="block"><span className="mb-2 block text-sm font-bold">Estimated job duration</span><div className="grid grid-cols-[minmax(0,1fr)_7.5rem] gap-2"><input aria-label="Estimated job duration" type="number" min={durationUnit === "hours" ? "0.25" : "0.01"} step={durationUnit === "hours" ? "0.25" : "0.01"} value={durationAmount} onChange={(event) => { const amount = event.target.value; setDurationAmount(amount); change("durationMinutes", Math.round(Number(amount) * (durationUnit === "days" ? 1440 : 60))); }} className={inputClass} /><CustomSelect ariaLabel="Duration unit" value={durationUnit} onChange={(value) => { const unit = value as "hours" | "days"; setDurationUnit(unit); change("durationMinutes", Math.round(Number(durationAmount) * (unit === "days" ? 1440 : 60))); }} buttonClassName={inputClass}><option value="hours">Hours</option><option value="days">Days</option></CustomSelect></div><span className="mt-2 block text-xs font-normal leading-5 text-[#75837c]">This reserves calendar availability. Actual time and the approved billable amount remain separate.</span></label>
            </div> : <section className="rounded-[1.5rem] bg-[#f5f7f2] p-5"><h2 className="text-sm font-bold">Tracked hourly projects</h2><label className="mt-4 block"><span className="mb-2 block text-sm font-bold">Hourly rate ($)</span><input required type="number" min="0.50" max="1000000" step="0.01" value={listing.hourlyRate ?? ""} onChange={event => change("hourlyRate", Number(event.target.value))} className={`${inputClass} bg-white`} /></label>{hourlyPreview === null && <p role="alert" className="mt-3 text-sm font-bold text-[#9b4934]">Enter a valid hourly rate ($0.50–$1,000,000).</p>}{hourlyPreview !== null && <p aria-live="polite" className="mt-3 text-sm font-bold">Rate preview: ${(hourlyPreview / 100).toFixed(2)}/hr. Final payment is based on the approved timesheet.</p>}<p className="mt-4 text-sm leading-6">The rate is locked when a customer requests a project. Customers approve a maximum work limit, not prepaid hours. Track actual work, submit one final timesheet, and receive payment after customer review. Work is billed by the aggregate minute with no minimum duration or old booking increments.</p><p className="mt-3 text-xs leading-5 text-[#718078]">Rate changes apply only to new projects. Existing bookings and projects keep their agreed pricing. Recurring visits, packages and add-ons are not part of hourly projects.</p></section>}
            {listing.deliveryType !== "REMOTE" && <label className="block"><span className="mb-2 block text-sm font-bold">Service location</span><CustomSelect ariaLabel="Service location" searchable required value={listing.locationId ?? ""} disabled={!listing.multipleLocationsAllowed && Boolean(listing.locationId)} onChange={(value) => { const selected = listing.locations.find((item) => item.id === value); change("locationId", value); if (selected) { change("location", selected.location); change("locationName", selected.name); } }} buttonClassName={`${inputClass} disabled:cursor-not-allowed disabled:bg-[#eef1eb]`}><option value="">Choose a service location</option>{listing.locations.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.location}</option>)}</CustomSelect><span className="mt-2 block text-xs text-[#849189]">{listing.multipleLocationsAllowed ? <>Manage branches and worker coverage from <Link href="/provider/dashboard/locations" className="font-bold underline">Service locations</Link>.</> : "This listing uses your primary location. Pro unlocks multiple locations."}</span></label>}
            <label className="block"><span className="mb-2 block text-sm font-bold">Description</span><textarea rows={6} value={listing.description} onChange={(event) => change("description", event.target.value)} className={`${inputClass} resize-none`} /></label>
            {listing.deliveryType !== "IN_PERSON" && <label className="block"><span className="mb-2 block text-sm font-bold">How remote delivery works <span className="font-normal text-[#849189]">(optional)</span></span><textarea rows={3} maxLength={1000} value={listing.remoteDeliveryDetails} onChange={(event) => change("remoteDeliveryDetails", event.target.value)} className={`${inputClass} resize-none`} placeholder="Explain meetings, communication, and delivery of completed work." /></label>}
            {listing.customQuestionsAllowed ? <label className="block"><span className="mb-2 block text-sm font-bold">Questions for customers</span><textarea rows={4} value={listing.bookingQuestions.join("\n")} onChange={(event) => change("bookingQuestions", event.target.value.split("\n").map((value) => value.trimStart()).slice(0, 3))} placeholder={"Vehicle make and model?\nAnything we should know before arrival?"} className={`${inputClass} resize-none`} /><span className="mt-2 block text-xs text-[#849189]">Up to 3 required questions, one per line. Available on Pro.</span></label> : <div className="rounded-2xl bg-[#f3f0d9] p-4 text-sm"><strong>Custom booking questions</strong> are available on Pro. <Link href="/provider/dashboard/billing" className="underline">View plans</Link></div>}

            <fieldset className="rounded-[1.5rem] border border-[#183126]/10 p-5"><legend className="px-2 text-sm font-bold">Booking frequency</legend><p className="text-xs leading-5 text-[#718078]">Each recurring visit becomes its own booking, payment, refund, and payout record. Customers pay occurrences separately; BubsBookings does not silently charge a saved card.</p><div className="mt-4 grid gap-2 sm:grid-cols-2">{RECURRENCE_OPTIONS.map((option) => <label key={option} className="flex min-h-12 items-center gap-3 rounded-xl bg-[#f7f7f2] px-4 py-3 text-sm font-semibold"><input type="checkbox" checked={listing.recurrenceOptions.includes(option)} disabled={option === "one_time"} onChange={(event) => change("recurrenceOptions", event.target.checked ? [...listing.recurrenceOptions, option] : listing.recurrenceOptions.filter((value) => value !== option))} />{recurrenceLabel(option)}</label>)}</div></fieldset>

            <fieldset className="rounded-[1.5rem] border border-[#183126]/10 p-5"><legend className="px-2 text-sm font-bold">Service format</legend><div className="grid gap-2 sm:grid-cols-2">{(["standard", "consultation"] as const).map((kind) => <label key={kind} className={`cursor-pointer rounded-xl border p-4 ${listing.serviceKind === kind ? "border-[#4d725d] bg-[#edf3e7]" : "border-[#183126]/10"}`}><input type="radio" className="sr-only" checked={listing.serviceKind === kind} onChange={() => change("serviceKind", kind)} /><span className="font-bold">{kind === "consultation" ? "Paid consultation" : "Standard service"}</span><span className="mt-1 block text-xs text-[#718078]">{kind === "consultation" ? "A scheduled paid session using your existing availability." : "A regular local or remote service."}</span></label>)}</div>{listing.serviceKind === "consultation" && <label className="mt-4 block"><span className="mb-2 block text-sm font-bold">Preparation notes <span className="font-normal text-[#849189]">(optional)</span></span><textarea rows={3} maxLength={1000} value={listing.preparationNotes} onChange={(event) => change("preparationNotes", event.target.value)} className={`${inputClass} resize-none`} placeholder="What should the customer prepare before the consultation?" /></label>}</fieldset>

            {listing.pricingType === "FIXED" ? <section className="rounded-[1.5rem] border border-[#183126]/10 p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-bold">Packages</h2><p className="mt-1 text-xs text-[#718078]">Add up to three fixed-price options.</p></div><button type="button" disabled={listing.packages.length >= 3} onClick={() => change("packages", [...listing.packages, { name: "", description: "", price: listing.price, durationMinutes: listing.durationMinutes, deliveryDays: null, revisionCount: null, features: [] }])} className="rounded-full border border-[#183126]/15 px-4 py-2 text-xs font-bold disabled:opacity-40">+ Add package</button></div><div className="mt-4 grid gap-4">{listing.packages.map((item, index) => <div key={item.id ?? index} className="rounded-2xl bg-[#f7f7f2] p-4"><div className="grid gap-3 sm:grid-cols-2"><label className="text-xs font-bold">Package name<input required value={item.name} maxLength={60} onChange={(event) => change("packages", listing.packages.map((entry, itemIndex) => itemIndex === index ? { ...entry, name: event.target.value } : entry))} className={`${inputClass} mt-1.5 bg-white`} /></label><label className="text-xs font-bold">Price ($)<input required type="number" min="0.5" step="0.01" value={item.price} onChange={(event) => change("packages", listing.packages.map((entry, itemIndex) => itemIndex === index ? { ...entry, price: Number(event.target.value) } : entry))} className={`${inputClass} mt-1.5 bg-white`} /></label></div><label className="mt-3 block text-xs font-bold">Description<input value={item.description} maxLength={500} onChange={(event) => change("packages", listing.packages.map((entry, itemIndex) => itemIndex === index ? { ...entry, description: event.target.value } : entry))} className={`${inputClass} mt-1.5 bg-white`} /></label><label className="mt-3 block text-xs font-bold">Included features, one per line<textarea rows={3} value={item.features.join("\n")} onChange={(event) => change("packages", listing.packages.map((entry, itemIndex) => itemIndex === index ? { ...entry, features: event.target.value.split("\n").map((value) => value.trimStart()).slice(0, 10) } : entry))} className={`${inputClass} mt-1.5 resize-none bg-white`} /></label><div className="mt-3 grid gap-3 sm:grid-cols-3"><label className="text-xs font-bold">Duration (minutes)<input required type="number" min="1" value={item.durationMinutes} onChange={(event) => change("packages", listing.packages.map((entry, itemIndex) => itemIndex === index ? { ...entry, durationMinutes: Number(event.target.value) } : entry))} className={`${inputClass} mt-1.5 bg-white`} /></label><label className="text-xs font-bold">Delivery days<input type="number" min="0" max="365" value={item.deliveryDays ?? ""} onChange={(event) => change("packages", listing.packages.map((entry, itemIndex) => itemIndex === index ? { ...entry, deliveryDays: event.target.value ? Number(event.target.value) : null } : entry))} className={`${inputClass} mt-1.5 bg-white`} /></label><label className="text-xs font-bold">Revisions<input type="number" min="0" max="100" value={item.revisionCount ?? ""} onChange={(event) => change("packages", listing.packages.map((entry, itemIndex) => itemIndex === index ? { ...entry, revisionCount: event.target.value ? Number(event.target.value) : null } : entry))} className={`${inputClass} mt-1.5 bg-white`} /></label></div><button type="button" onClick={() => change("packages", listing.packages.filter((_, itemIndex) => itemIndex !== index))} className="mt-3 text-xs font-bold text-[#9a4e3a] underline">Remove package</button></div>)}</div></section> : <div className="rounded-2xl border border-[#183126]/10 bg-[#f5f7f2] p-4 text-sm"><strong>{listing.pricingType === "QUOTE_ONLY" ? "Packages are hidden while this listing uses custom quotes." : "Packages are unavailable for hourly listings."}</strong><p className="mt-1 text-xs leading-5 text-[#718078]">{listing.pricingType === "QUOTE_ONLY" ? "Your saved packages are preserved and will return if you switch back to fixed pricing." : "Use one hourly rate plus fixed-price add-ons so every checkout has an unambiguous calculation."}</p></div>}

            {listing.pricingType === "QUOTE_ONLY" ? <div className="rounded-2xl border border-[#183126]/10 bg-[#f5f7f2] p-4 text-sm"><strong>Add-ons are hidden while this listing uses custom quotes.</strong><p className="mt-1 text-xs leading-5 text-[#718078]">Your saved add-ons are preserved and will return if you switch pricing modes.</p></div> : <section className="rounded-[1.5rem] border border-[#183126]/10 p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-bold">Optional add-ons</h2><p className="mt-1 text-xs text-[#718078]">Offer useful upgrades without changing the base listing.</p></div><button type="button" disabled={listing.addOns.length >= 10} onClick={() => change("addOns", [...listing.addOns, { name: "", description: "", price: 0, additionalMinutes: 0, allowsQuantity: false, maxQuantity: 1 }])} className="rounded-full border border-[#183126]/15 px-4 py-2 text-xs font-bold disabled:opacity-40">+ Add option</button></div><div className="mt-4 grid gap-3">{listing.addOns.map((item, index) => <div key={item.id ?? index} className="rounded-2xl bg-[#f7f7f2] p-4"><div className="grid gap-3 sm:grid-cols-2"><label className="text-xs font-bold">Name<input required value={item.name} maxLength={80} onChange={(event) => change("addOns", listing.addOns.map((entry, itemIndex) => itemIndex === index ? { ...entry, name: event.target.value } : entry))} className={`${inputClass} mt-1.5 bg-white`} /></label><label className="text-xs font-bold">Additional price ($)<input required type="number" min="0" step="0.01" value={item.price} onChange={(event) => change("addOns", listing.addOns.map((entry, itemIndex) => itemIndex === index ? { ...entry, price: Number(event.target.value) } : entry))} className={`${inputClass} mt-1.5 bg-white`} /></label></div><div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="text-xs font-bold">Extra time (minutes)<input type="number" min="0" max="43200" value={item.additionalMinutes} onChange={(event) => change("addOns", listing.addOns.map((entry, itemIndex) => itemIndex === index ? { ...entry, additionalMinutes: Number(event.target.value) } : entry))} className={`${inputClass} mt-1.5 bg-white`} /></label><label className="flex items-center gap-2 pt-6 text-xs font-bold"><input type="checkbox" checked={item.allowsQuantity} onChange={(event) => change("addOns", listing.addOns.map((entry, itemIndex) => itemIndex === index ? { ...entry, allowsQuantity: event.target.checked, maxQuantity: event.target.checked ? Math.max(2, entry.maxQuantity) : 1 } : entry))} />Allow a quantity</label></div>{item.allowsQuantity && <label className="mt-3 block text-xs font-bold">Maximum quantity<input type="number" min="2" max="20" value={item.maxQuantity} onChange={(event) => change("addOns", listing.addOns.map((entry, itemIndex) => itemIndex === index ? { ...entry, maxQuantity: Number(event.target.value) } : entry))} className={`${inputClass} mt-1.5 bg-white`} /></label>}<button type="button" onClick={() => change("addOns", listing.addOns.filter((_, itemIndex) => itemIndex !== index))} className="mt-3 text-xs font-bold text-[#9a4e3a] underline">Remove add-on</button></div>)}</div></section>}

            {error && <p role="alert" className="rounded-xl bg-[#fff1e8] px-3 py-2.5 text-xs font-semibold text-[#9a4e25]">{error}</p>}
            {saved && <p role="status" className="rounded-xl bg-[#e6f1e5] px-3 py-2.5 text-xs font-semibold text-[#3f7652]">Your listing changes are live.</p>}
            <div className="flex flex-col-reverse justify-between gap-3 border-t border-[#183126]/10 pt-6 sm:flex-row sm:items-center">
              <button type="button" onClick={() => setConfirmDelete(true)} className="rounded-full px-5 py-3 text-sm font-bold text-[#9a4e3a] hover:bg-[#fff0ea]">Delete listing</button>
              <div className="flex gap-3"><Link href={`/services/${listing.slug}`} className="rounded-full border border-[#183126]/15 px-5 py-3 text-sm font-bold transition hover:bg-[#dfead9]">View public page</Link><button type="submit" disabled={saving} className="rounded-full bg-[#eee25a] px-6 py-3 text-sm font-bold transition hover:bg-[#f8ed70] disabled:cursor-wait disabled:opacity-60">{saving ? "Saving…" : "Save changes"}</button></div>
            </div>
          </form>}
        </div>
      </div>

      {confirmDelete && listing && <div role="dialog" aria-modal="true" aria-labelledby="delete-title" className="fixed inset-0 z-50 grid place-items-center bg-[#10241b]/60 p-5 backdrop-blur-sm"><div className="w-full max-w-md rounded-[2rem] bg-white p-7 shadow-2xl"><span className="grid h-12 w-12 place-items-center rounded-2xl bg-[#fff0ea] text-xl">⚠</span><h2 id="delete-title" className="mt-5 text-2xl font-bold">Delete this listing?</h2><p className="mt-3 text-sm leading-6 text-[#687970]"><strong>{listing.title}</strong> will immediately disappear from customer searches. This action cannot be undone from the dashboard.</p><div className="mt-7 flex justify-end gap-3"><button type="button" disabled={deleting} onClick={() => setConfirmDelete(false)} className="rounded-full border border-[#183126]/15 px-5 py-3 text-sm font-bold transition hover:bg-[#dfead9]">Keep listing</button><button type="button" disabled={deleting} onClick={deleteListing} className="rounded-full bg-[#9a4e3a] px-5 py-3 text-sm font-bold text-white transition hover:bg-[#b5624d] disabled:opacity-60">{deleting ? "Deleting…" : "Yes, delete"}</button></div></div></div>}
    </main>
  );
}
