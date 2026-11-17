"use client";

import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { SERVICE_CATEGORIES } from "@/lib/service-categories";
import { LISTING_IMAGE_MAX_BYTES, LISTING_IMAGE_MAX_MB } from "@/lib/listing-images";
import { ALL_DAY_END_TIME, ALL_DAY_START_TIME } from "@/lib/availability-hours";
import RadiusSelector from "@/components/radius-selector";
import UsCitySelector from "@/components/us-city-selector";
import UiIcon from "@/components/ui-icon";
import TimePicker from "@/components/time-picker";
import CustomSelect from "@/components/custom-select";
import { formatUsPhone } from "@/lib/phone";
import { deliveryLabel, type ServiceDeliveryType } from "@/lib/service-delivery";
import { previewHourlyBasePriceCents, type PricingType } from "@/lib/service-pricing";
import { recordProviderOnboardingStarted } from "@/components/provider-signup-actions";

const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default function OnboardingForm({ plan = "starter", returnPath = "/providers/join" }: { plan?: "starter" | "pro"; returnPath?: string }) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [error, setError] = useState("");
  const [business, setBusiness] = useState("");
  type CompanyChoice = { id: string; name: string; slug: string; location: string; serviceRadiusMiles: number; listingCount: number; locations: Array<{ id: string; name: string; location: string; serviceRadiusMiles: number; primary?: boolean }> };
  const [companies, setCompanies] = useState<CompanyChoice[]>([]);
  const [useNewCompany, setUseNewCompany] = useState(true);
  const [locationId, setLocationId] = useState("");
  const [category, setCategory] = useState("");
  const [deliveryType, setDeliveryType] = useState<ServiceDeliveryType>("IN_PERSON");
  const [remoteDeliveryDetails, setRemoteDeliveryDetails] = useState("");
  const [customCategory, setCustomCategory] = useState("");
  const [city, setCity] = useState("");
  const [serviceRadiusMiles, setServiceRadiusMiles] = useState("25");
  const [service, setService] = useState("");
  const [price, setPrice] = useState("");
  const [pricingType, setPricingType] = useState<PricingType>("FIXED");
  const [minimumDurationHours] = useState("2");
  const [billingIncrementMinutes] = useState<15 | 30 | 60>(30);
  const [maximumDurationHours] = useState("8");
  const [durationAmount, setDurationAmount] = useState("2");
  const hourlyPreview = previewHourlyBasePriceCents(Math.round(Number(price) * 100), 60);
  const [durationUnit, setDurationUnit] = useState<"hours" | "days">("hours");
  const [phone, setPhone] = useState("");
  const [referralCode, setReferralCode] = useState("");
  const [description, setDescription] = useState("");
  const [selectedDays, setSelectedDays] = useState(["Mon", "Tue", "Wed", "Thu", "Fri"]);
  const [dayHours, setDayHours] = useState<Record<string, { startTime: string; endTime: string; open24Hours: boolean }>>(() => Object.fromEntries(days.map((day) => [day, { startTime: "09:00", endTime: "17:00", open24Hours: false }])));
  const [acceptedProviderAgreement, setAcceptedProviderAgreement] = useState(false);
  const [saving, setSaving] = useState(false);
  const [photos, setPhotos] = useState<Array<{ file: File; preview: string }>>([]);
  const previewUrls = useRef<string[]>([]);
  const onboardingRecorded = useRef(false);

  useEffect(() => () => previewUrls.current.forEach((url) => URL.revokeObjectURL(url)), []);
  useEffect(() => {
    fetch("/api/account/settings", { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<{ phone?: string; city?: string; state?: string }> : null)
      .then((data) => { if (data?.phone) setPhone(formatUsPhone(data.phone)); if (data?.city && data?.state) setCity((current) => current || `${data.city}, ${data.state}`); })
      .catch(() => null);
  }, []);
  useEffect(() => {
    let active = true;
    fetch("/api/providers/companies", { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<{ companies: CompanyChoice[] }> : null)
      .then((data) => {
        if (!active || !data?.companies.length) return;
        setCompanies(data.companies);
        setBusiness(data.companies[0].name);
        const firstLocation = data.companies[0].locations?.find((item) => item.primary) ?? data.companies[0].locations?.[0];
        setLocationId(firstLocation?.id ?? "");
        setCity(firstLocation?.location ?? data.companies[0].location);
        setServiceRadiusMiles(String(firstLocation?.serviceRadiusMiles ?? data.companies[0].serviceRadiusMiles));
        setUseNewCompany(false);
      })
      .catch(() => null);
    return () => { active = false; };
  }, []);

  function choosePhotos(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (selected.some((file) => !["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > LISTING_IMAGE_MAX_BYTES)) {
      setError(`Use JPG, PNG, or WebP photos under ${LISTING_IMAGE_MAX_MB} MB each.`);
      return;
    }
    if (photos.length + selected.length > 5) {
      setError(`You can add up to 5 photos.`);
      return;
    }
    setError("");
    const additions = selected.map((file) => {
      const preview = URL.createObjectURL(file);
      previewUrls.current.push(preview);
      return { file, preview };
    });
    setPhotos((current) => [...current, ...additions]);
  }

  function removePhoto(preview: string) {
    URL.revokeObjectURL(preview);
    previewUrls.current = previewUrls.current.filter((url) => url !== preview);
    setPhotos((current) => current.filter((photo) => photo.preview !== preview));
  }

  async function next(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const phoneDigits = phone.replace(/\D/g, "");
    if (step === 1 && (!business.trim() || (deliveryType !== "REMOTE" && !city.trim()) || phoneDigits.length !== 10)) {
      setError(phoneDigits.length !== 10 ? "Enter a valid 10-digit contact number, such as (425) 555-0123." : "Complete each field to continue.");
      return;
    }
    const finalCategory = category === "__custom__" ? customCategory.trim() : category;
    const durationMinutes = Math.round(Number(durationAmount) * (durationUnit === "days" ? 1440 : 60));
    const minimumMinutes = Math.round(Number(minimumDurationHours) * 60);
    const maximumMinutes = maximumDurationHours ? Math.round(Number(maximumDurationHours) * 60) : null;
    const invalidHourly = pricingType === "HOURLY" && (!Number.isInteger(minimumMinutes) || minimumMinutes < billingIncrementMinutes || minimumMinutes % billingIncrementMinutes !== 0 || durationMinutes < minimumMinutes || durationMinutes % billingIncrementMinutes !== 0 || (maximumMinutes !== null && (!Number.isInteger(maximumMinutes) || maximumMinutes < durationMinutes || maximumMinutes % billingIncrementMinutes !== 0)));
    const invalidPrice = pricingType === "HOURLY" ? hourlyPreview === null : pricingType !== "QUOTE_ONLY" && (!price || Number(price) < 0.5);
    if (step === 2 && (!finalCategory || finalCategory.length > 80 || !service.trim() || invalidPrice || !Number.isFinite(durationMinutes) || durationMinutes < 15 || invalidHourly || description.trim().length < 30)) {
      setError(pricingType === "QUOTE_ONLY" ? "Add a service title, estimated duration, and a clear description of at least 30 characters." : "Add a service title, price, and a clear description of at least 30 characters.");
      return;
    }
    const invalidDay = selectedDays.find((day) => !dayHours[day].open24Hours && dayHours[day].startTime >= dayHours[day].endTime);
    if (step === 3 && (selectedDays.length === 0 || invalidDay)) {
      setError(selectedDays.length === 0 ? "Choose at least one available day." : `${invalidDay} needs a start time earlier than its end time.`);
      return;
    }
    if (step === 3 && !acceptedProviderAgreement) {
      setError("Read and accept the Provider Agreement to finish setup.");
      return;
    }
    setError("");
    if (step < 3) {
      if (step === 1 && !onboardingRecorded.current) {
        onboardingRecorded.current = true;
        recordProviderOnboardingStarted();
      }
      setStep(step + 1);
      return;
    }

    setSaving(true);
    const response = await fetch("/api/providers/onboarding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ business, locationId, category: finalCategory, deliveryType, remoteDeliveryDetails, city, serviceRadiusMiles: Number(serviceRadiusMiles), phone, referralCode, service, price, durationMinutes, pricingType, hourlyRate: pricingType === "HOURLY" ? Number(price) : null, minimumDurationMinutes: pricingType === "HOURLY" ? minimumMinutes : null, billingIncrementMinutes: pricingType === "HOURLY" ? billingIncrementMinutes : null, defaultDurationMinutes: pricingType === "HOURLY" ? durationMinutes : null, maximumDurationMinutes: pricingType === "HOURLY" ? maximumMinutes : null, description, availabilitySlots: selectedDays.map((day) => ({ day, startTime: dayHours[day].open24Hours ? ALL_DAY_START_TIME : dayHours[day].startTime, endTime: dayHours[day].open24Hours ? ALL_DAY_END_TIME : dayHours[day].endTime })), plan, acceptedProviderAgreement }),
    });
    const result = (await response.json()) as { error?: string; serviceId?: string };

    if (response.status === 401) {
      router.push(`/login?redirect=${encodeURIComponent(returnPath)}`);
      return;
    }
    if (!response.ok) {
      setSaving(false);
      setError(result.error ?? "We could not save your profile. Please try again.");
      return;
    }

    let photoUploadFailed = false;
    if (photos.length > 0 && result.serviceId) {
      for (const photo of photos) {
        const formData = new FormData();
        formData.set("image", photo.file);
        const imageResponse = await fetch(`/api/providers/services/${result.serviceId}/images`, { method: "POST", body: formData });
        if (!imageResponse.ok) {
          photoUploadFailed = true;
          break;
        }
      }
    }

    router.push(`/provider/dashboard?welcome=1${photoUploadFailed ? "&photos=failed" : ""}`);
    router.refresh();
  }

  function toggleDay(day: string) {
    setSelectedDays((current) => current.includes(day) ? current.filter((item) => item !== day) : [...current, day]);
  }

  function updateDayHours(day: string, changes: Partial<{ startTime: string; endTime: string; open24Hours: boolean }>) {
    setDayHours((current) => ({ ...current, [day]: { ...current[day], ...changes } }));
  }

  const inputClass = "w-full rounded-2xl border border-[#183126]/15 bg-[#faf9f5] px-4 py-3.5 text-sm outline-none transition focus:border-[#4d725d] focus:ring-2 focus:ring-[#4d725d]/10";

  return (
    <div className="rounded-[2rem] border border-[#183126]/10 bg-white p-6 shadow-[0_24px_60px_rgba(24,49,38,.12)] sm:p-9">
      <div className="flex items-center justify-between">
        <div><p className="text-xs font-bold uppercase tracking-[.14em] text-[#718078]">Step {step} of 3</p><h2 className="mt-1 text-2xl font-bold tracking-tight">{step === 1 ? "Choose or create a company page" : step === 2 ? "Create a service under that company" : "Set your availability"}</h2></div>
        <span className="grid h-11 w-11 place-items-center rounded-2xl bg-[#edf3e7]"><UiIcon name={step === 1 ? "profile" : step === 2 ? "services" : "calendar"} className="h-5 w-5" /></span>
      </div>
      <div className="mt-6 grid grid-cols-3 gap-2">{[1, 2, 3].map((number) => <span key={number} className={`h-1.5 rounded-full ${number <= step ? "bg-[#183126]" : "bg-[#dfe3df]"}`} />)}</div>

      <form onSubmit={next} className="mt-8">
        {step === 1 && <div className="space-y-5">
          <fieldset><legend className="mb-2 text-sm font-bold">How do you provide this service?</legend><div className="grid gap-2 sm:grid-cols-3">{(["IN_PERSON", "REMOTE", "BOTH"] as const).map((value) => <label key={value} className={`cursor-pointer rounded-2xl border p-4 ${deliveryType === value ? "border-[#4d725d] bg-[#edf3e7]" : "border-[#183126]/12 bg-white"}`}><input type="radio" name="deliveryType" value={value} checked={deliveryType === value} onChange={() => setDeliveryType(value)} className="sr-only" /><span className="font-bold">{deliveryLabel(value)}</span><span className="mt-1 block text-xs leading-5 text-[#687970]">{value === "IN_PERSON" ? "You travel to the customer or they come to you." : value === "REMOTE" ? "The service is completed online within the U.S. marketplace." : "Customers can choose online or in person."}</span></label>)}</div></fieldset>
          {companies.length > 0 && <label className="block"><span className="mb-2 block text-sm font-bold">Company page</span><CustomSelect ariaLabel="Company page" searchable={companies.length > 8} value={useNewCompany ? "__new__" : business} onChange={(value) => { if (value === "__new__") { setUseNewCompany(true); setBusiness(""); setLocationId(""); } else { const company = companies.find((item) => item.name === value); const firstLocation = company?.locations?.find((item) => item.primary) ?? company?.locations?.[0]; setUseNewCompany(false); setBusiness(value); setLocationId(firstLocation?.id ?? ""); if (company) { setCity(firstLocation?.location ?? company.location); setServiceRadiusMiles(String(firstLocation?.serviceRadiusMiles ?? company.serviceRadiusMiles)); } } }} buttonClassName={inputClass}>{companies.map((company) => <option key={company.id} value={company.name}>{company.name} · {company.listingCount} {company.listingCount === 1 ? "listing" : "listings"}</option>)}<option value="__new__">+ Create another company page</option></CustomSelect></label>}
          {(useNewCompany || companies.length === 0) && <label className="block"><span className="mb-2 block text-sm font-bold">Company name</span><input value={business} onChange={(event) => setBusiness(event.target.value)} placeholder="e.g. BubsBookings" className={inputClass} /><span className="mt-2 block text-xs text-[#74827b]">This creates the main public page that holds the company&apos;s listings, team, and identity.</span></label>}
          {deliveryType !== "REMOTE" ? <>{!useNewCompany && (companies.find((item) => item.name === business)?.locations.length ?? 0) > 0 ? <label className="block"><span className="mb-2 block text-sm font-bold">Service location</span><CustomSelect ariaLabel="Service location" searchable value={locationId} onChange={(value) => { const company = companies.find((item) => item.name === business); const selected = company?.locations.find((item) => item.id === value); setLocationId(value); if (selected) { setCity(selected.location); setServiceRadiusMiles(String(selected.serviceRadiusMiles)); } }} buttonClassName={inputClass}>{companies.find((item) => item.name === business)?.locations.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.location}</option>)}</CustomSelect><span className="mt-2 block text-xs text-[#74827b]">Add or edit branches from Service locations in your dashboard.</span></label> : <label className="block"><span className="mb-2 block text-sm font-bold">Primary service area</span><UsCitySelector value={city} onChange={setCity} className={inputClass} /><span className="mt-2 block text-xs text-[#74827b]">Choose where customers can book the in-person service.</span></label>}<div className="block"><p className="mb-2 text-sm font-bold">Working radius</p><RadiusSelector value={Number(serviceRadiusMiles)} onChange={(value) => setServiceRadiusMiles(String(value))} /><span className="mt-2 block text-xs text-[#74827b]">Your in-person listing appears to customers in this range.</span></div></> : <div className="rounded-2xl bg-[#edf3e7] p-4 text-sm leading-6 text-[#52675b]"><strong>No service radius needed.</strong> Your account location remains private and is used only for account, payment, and marketplace eligibility, not remote search distance.</div>}
          <label className="block"><span className="mb-2 block text-sm font-bold">Business contact number</span><input type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(event) => setPhone(formatUsPhone(event.target.value))} placeholder="(425) 555-0123" className={inputClass} /><span className="mt-2 block text-xs text-[#74827b]">Required for provider screening. We check it here so you can fix it before continuing.</span></label>
          {companies.length === 0 && <label className="block"><span className="mb-2 block text-sm font-bold">Creator or partner referral code <span className="font-normal text-[#74827b]">(optional)</span></span><input value={referralCode} onChange={(event) => setReferralCode(event.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 32))} autoCapitalize="characters" autoComplete="off" placeholder="e.g. MIKE" className={inputClass} /><span className="mt-2 block text-xs leading-5 text-[#74827b]">If you followed a partner link, we already saved it. Entering a valid code here intentionally replaces that saved referral before your provider profile is created. Attribution locks after setup.</span></label>}
        </div>}

        {step === 2 && <div className="space-y-5">
          <div className="rounded-2xl bg-[#edf3e7] p-4 text-sm"><span className="font-bold">Company:</span> {business}</div>
          <label className="block"><span className="mb-2 block text-sm font-bold">Service category</span><CustomSelect ariaLabel="Service category" searchable value={category} onChange={(value) => setCategory(value)} buttonClassName={inputClass}><option value="">Choose a category</option>{SERVICE_CATEGORIES.map((item) => <option key={item}>{item}</option>)}<option value="__custom__">Other / custom category…</option></CustomSelect>{category === "__custom__" && <input value={customCategory} onChange={(event) => setCustomCategory(event.target.value)} maxLength={80} placeholder="Type your service category" className={`${inputClass} mt-3`} />}</label>
          <label className="block"><span className="mb-2 block text-sm font-bold">Service title</span><input value={service} onChange={(event) => setService(event.target.value)} placeholder="e.g. Weekly lawn care" className={inputClass} /></label>
          <label className="flex cursor-pointer items-start justify-between gap-4 rounded-2xl border border-[#183126]/12 bg-[#fafaf6] p-4"><span><strong className="block text-sm">Custom Quote Only</strong><span className="mt-1 block text-xs leading-5 text-[#718078]">Customers will contact you for a personalized quote instead of booking at a fixed price.</span></span><input type="checkbox" className="mt-1 h-5 w-5" checked={pricingType === "QUOTE_ONLY"} onChange={(event) => setPricingType(event.target.checked ? "QUOTE_ONLY" : "FIXED")} /></label>
          {pricingType !== "QUOTE_ONLY" && <fieldset><legend className="mb-2 text-sm font-bold">Pricing type</legend><div className="grid gap-2 sm:grid-cols-2">{(["FIXED", "HOURLY"] as const).map((value) => <label key={value} className={`cursor-pointer rounded-2xl border p-4 ${pricingType === value ? "border-[#4d725d] bg-[#edf3e7]" : "border-[#183126]/12"}`}><input type="radio" className="sr-only" name="pricingType" checked={pricingType === value} onChange={() => { setPricingType(value); if (value === "HOURLY") { setDurationUnit("hours"); setDurationAmount("2"); } }} /><span className="font-bold">{value === "FIXED" ? "Fixed price" : "Hourly rate"}</span><span className="mt-1 block text-xs text-[#718078]">{value === "FIXED" ? "One price for the described service." : "Track actual work; customers review the final timesheet before paying."}</span></label>)}</div></fieldset>}
          <div className="grid gap-4 sm:grid-cols-2">{pricingType !== "QUOTE_ONLY" && <label className="block"><span className="mb-2 block text-sm font-bold">{pricingType === "HOURLY" ? "Hourly rate" : "Starting price"}</span><div className="relative"><span className="absolute left-4 top-3.5 text-sm text-[#65766d]">$</span><input type="number" min="0.50" max={pricingType === "HOURLY" ? "1000000" : undefined} step="0.01" value={price} onChange={(event) => setPrice(event.target.value)} placeholder="75.00" className={`${inputClass} pl-8`} /></div><span className="mt-2 block text-xs text-[#74827b]">{pricingType === "HOURLY" ? "The rate for one hour." : "Decimals are allowed."}</span></label>}{pricingType !== "HOURLY" && <label className="block"><span className="mb-2 block text-sm font-bold">Estimated job duration</span><div className="grid grid-cols-[minmax(0,1fr)_7.5rem] gap-2"><input aria-label="Estimated job duration" type="number" min={durationUnit === "hours" ? "0.25" : "0.01"} step={durationUnit === "hours" ? "0.25" : "0.01"} value={durationAmount} onChange={(event) => setDurationAmount(event.target.value)} placeholder="2" className={inputClass} /><CustomSelect ariaLabel="Duration unit" value={durationUnit} onChange={(value) => setDurationUnit(value as "hours" | "days")} buttonClassName={inputClass}><option value="hours">Hours</option><option value="days">Days</option></CustomSelect></div><span className="mt-2 block text-xs font-normal leading-5 text-[#75837c]">This duration is reserved on the provider calendar.</span></label>}</div>
          {pricingType === "HOURLY" && hourlyPreview === null && <p role="alert" className="text-sm font-bold text-[#9b4934]">Enter a valid hourly rate ($0.50–$1,000,000).</p>}
          {pricingType === "HOURLY" && hourlyPreview !== null && <p aria-live="polite" className="text-sm font-bold">Rate preview: ${(hourlyPreview / 100).toFixed(2)}/hr. Final payment is based on the approved timesheet.</p>}
          {pricingType === "HOURLY" && <p className="rounded-2xl bg-[#f5f7f2] p-5 text-sm leading-6">Customers request a project with a maximum approved work limit, not prepaid hours. Track time, submit one final timesheet, and get paid after review. The rate is locked per project. No minimum duration, old billing increments, or automatic charges apply.</p>}
          <label className="block"><span className="mb-2 block text-sm font-bold">What&apos;s included?</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Describe what customers can expect..." rows={4} minLength={30} maxLength={2000} className={`${inputClass} resize-none`} /><span className="mt-2 block text-xs text-[#74827b]">Use at least 30 characters so customers and the automated safety check can understand the service.</span></label>
          {deliveryType !== "IN_PERSON" && <label className="block"><span className="mb-2 block text-sm font-bold">How remote delivery works <span className="font-normal text-[#74827b]">(optional)</span></span><textarea value={remoteDeliveryDetails} onChange={(event) => setRemoteDeliveryDetails(event.target.value)} placeholder="For example: We meet by video call and share final files through an agreed secure method." rows={3} maxLength={1000} className={`${inputClass} resize-none`} /></label>}
          <div className="rounded-2xl border border-dashed border-[#183126]/20 bg-[#faf9f5] p-5">
            <div className="flex items-start justify-between gap-4"><div><p className="text-sm font-bold">Listing photos <span className="font-normal text-[#7a8881]">(optional)</span></p><p className="mt-1 text-xs leading-5 text-[#74827b]">Add up to 5 JPG, PNG, or WebP photos. The first becomes your cover.</p></div><UiIcon name="camera" className="h-5 w-5 shrink-0" /></div>
            {photos.length > 0 && <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-5">{photos.map((photo, index) => <div key={photo.preview} className="relative aspect-square"><div role="img" aria-label={`Selected listing photo ${index + 1}`} style={{ backgroundImage: `url("${photo.preview}")` }} className="h-full rounded-xl bg-cover bg-center" />{index === 0 && <span className="absolute bottom-1.5 left-1.5 rounded-full bg-white/90 px-2 py-1 text-[9px] font-bold">Cover</span>}<button type="button" onClick={() => removePhoto(photo.preview)} aria-label={`Remove photo ${index + 1}`} className="absolute -right-1.5 -top-1.5 grid h-6 w-6 place-items-center rounded-full bg-[#183126] text-white shadow transition hover:bg-[#b24f42]"><UiIcon name="close" className="h-3.5 w-3.5" /></button></div>)}</div>}
            <label className="mt-4 inline-flex cursor-pointer rounded-full border border-[#183126]/15 bg-white px-4 py-2.5 text-xs font-bold hover:border-[#4d725d]">{photos.length === 0 ? "+ Choose photos" : "+ Add more"}<input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={choosePhotos} className="sr-only" /></label>
          </div>
        </div>}

        {step === 3 && <div>
          <p className="text-sm leading-6 text-[#687970]">Turn on each day you accept bookings, then set that day&apos;s own hours.</p>
          <div className="mt-6 space-y-3">{days.map((day) => { const enabled = selectedDays.includes(day); const hours = dayHours[day]; return <div key={day} className={`rounded-2xl border p-4 ${enabled ? "border-[#8eaa91] bg-[#f4f8f1]" : "border-[#183126]/10 bg-[#f7f7f2]"}`}><div className="flex flex-wrap items-center justify-between gap-3"><button type="button" onClick={() => toggleDay(day)} className={`rounded-full px-4 py-2 text-sm font-bold ${enabled ? "bg-[#183126] text-white" : "border border-[#183126]/15 bg-white"}`}>{enabled ? "✓ " : "+ "}{day}</button><label className="flex items-center gap-2 text-xs font-bold"><input type="checkbox" checked={hours.open24Hours} disabled={!enabled} onChange={(event) => updateDayHours(day, { open24Hours: event.target.checked })} className="h-4 w-4 accent-[#183126] disabled:opacity-40" />Open 24 hours</label></div>{enabled && !hours.open24Hours && <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-2"><TimePicker ariaLabel={`${day} start time`} value={hours.startTime} onChange={(startTime) => updateDayHours(day, { startTime })} minuteStep={5} buttonClassName={inputClass} /><span className="text-xs text-[#718078]">to</span><TimePicker ariaLabel={`${day} end time`} value={hours.endTime} onChange={(endTime) => updateDayHours(day, { endTime })} minuteStep={5} buttonClassName={inputClass} /></div>}</div>; })}</div>
          <div className="mt-4 rounded-2xl border border-[#b9cdbb] bg-[#edf5e9] p-5"><p className="flex items-center gap-2 text-sm font-bold"><UiIcon name="shield" className="h-4 w-4" />Automated screening and provider eligibility</p><p className="mt-2 text-xs leading-5 text-[#5f7067]">When you finish, BubsBookings checks your verified email, contact number, profile completeness, and listing language. Your listing stays private until you complete Stripe&apos;s document check confirming you are at least 18 and finish any required payout setup.</p></div>
          <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-2xl border border-[#183126]/15 bg-white p-5"><input type="checkbox" required checked={acceptedProviderAgreement} onChange={(event) => setAcceptedProviderAgreement(event.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-[#183126]" /><span className="text-sm leading-6 text-[#5f7067]">I have read and agree to the <Link href="/provider-agreement" target="_blank" className="font-bold text-[#183126] underline">Provider Agreement</Link>, including the <Link href="/payment-billing" target="_blank" className="font-bold text-[#183126] underline">payment and billing</Link>, payout-delay, refund, and transfer-reversal terms.</span></label>
        </div>}

        {error && <p role="alert" className="mt-5 rounded-xl bg-[#fff1e8] px-3 py-2.5 text-xs font-semibold text-[#9a4e25]">{error}</p>}
        <div className="mt-8 flex items-center justify-between gap-4">
          {step > 1 ? <button type="button" onClick={() => { setStep(step - 1); setError(""); }} className="inline-flex items-center gap-2 rounded-full px-5 py-3 text-sm font-bold hover:bg-[#183126]/5"><UiIcon name="arrow-left" className="h-4 w-4" />Back</button> : <span />}
          <button type="submit" disabled={saving} className="inline-flex items-center gap-2 rounded-full bg-[#eee25a] px-7 py-3.5 text-sm font-bold transition hover:bg-[#f5ea6b] disabled:cursor-wait disabled:opacity-60">{saving ? photos.length > 0 ? "Saving & uploading…" : "Saving…" : step === 3 ? "Finish setup" : <>Continue<UiIcon name="arrow-right" className="h-4 w-4" /></>}</button>
        </div>
      </form>
    </div>
  );
}
