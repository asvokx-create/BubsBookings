import { requiresHourlyProject } from "@/lib/hourly-project-policy";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { database } from "@/lib/database";
import { checkAndRecordContent } from "@/lib/content-safety";
import { sendBookingUpdateEmails } from "@/lib/booking-email";
import { enforceRateLimit, recordActivity } from "@/lib/request-security";
import { recordAnalytics } from "@/lib/analytics";
import { calculateBookingFinancialSnapshot, type BookingFinancialPlan } from "@/lib/booking-financials";
import { isServiceDeliveryType, serviceSupportsMethod, type BookingDeliveryMethod, type ServiceDeliveryType } from "@/lib/service-delivery";
import { calculateCommerceSelection, isRecurrenceOption, nextOccurrence, type CouponRule, type ServiceAddOn, type ServicePackage } from "@/lib/service-commerce";
import { PLAN_ENTITLEMENTS } from "@/lib/plans";
import { readMarketingToken } from "@/lib/provider-marketing";
import { calculateHourlyBasePriceCents, formatDurationMinutes, validateHourlyDuration, type HourlyPricingConfig, type PricingType } from "@/lib/service-pricing";
import { AGE_CONFIRMATION_REQUIRED_MESSAGE, hasConfirmedAge } from "@/lib/account-age";
import { getStripeMode } from "@/lib/stripe";
import { zonedDateTimeToUtc } from "@/lib/zoned-date-time";

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const usStateCodes = new Set("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" "));

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!await hasConfirmedAge(session.user.id)) return NextResponse.json({ error: AGE_CONFIRMATION_REQUIRED_MESSAGE }, { status: 403 });

  const result = await database.query<{
    id: string; service_id: string; provider_id: string; service: string; service_slug: string; category: string; provider: string;
    starts_at: Date; price_cents: number; location: string; delivery_method: BookingDeliveryMethod; status: "requested" | "confirmed" | "completed" | "cancelled"; assignee_name: string;
  }>(
    `SELECT b.id::text, s.id::text AS service_id, p.id::text AS provider_id,
            s.title AS service, s.slug AS service_slug, s.category,
            s.business_name AS provider, b.starts_at, b.price_cents,
            b.service_address AS location, b.delivery_method, b.status,
            COALESCE((SELECT string_agg(CASE WHEN assigned.is_owner THEN owner_user.name ELSE assigned_member.name END, ', ' ORDER BY assigned.is_owner DESC, assigned_member.name)
              FROM booking_assignees assigned LEFT JOIN provider_team_members assigned_member ON assigned_member.id = assigned.team_member_id
              WHERE assigned.booking_id = b.id), COALESCE(member.name, owner_user.name)) AS assignee_name
     FROM bookings b
     JOIN services s ON s.id = b.service_id
     JOIN provider_profiles p ON p.id = b.provider_id
     JOIN "user" owner_user ON owner_user.id = p.user_id
     LEFT JOIN provider_team_members member ON member.id = b.assigned_team_member_id
     WHERE b.customer_id = $1
     ORDER BY b.starts_at DESC`,
    [session.user.id],
  );
  return NextResponse.json({ bookings: result.rows.map((row) => ({
    id: row.id, serviceId: row.service_id, providerId: row.provider_id,
    service: row.service, serviceSlug: row.service_slug, category: row.category,
    provider: row.provider, startsAt: row.starts_at, price: row.price_cents / 100,
    location: row.location, deliveryMethod: row.delivery_method, state: row.status,
    assigneeName: row.assignee_name,
  })) });
}

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Log in before requesting a booking." }, { status: 401 });
  if (!await hasConfirmedAge(session.user.id)) return NextResponse.json({ error: AGE_CONFIRMATION_REQUIRED_MESSAGE }, { status: 403 });
  const campaignCookie = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith("bb_campaign="))?.slice("bb_campaign=".length) ?? "";
  const campaignAttribution = readMarketingToken(decodeURIComponent(campaignCookie));
  if (!await enforceRateLimit({ request, userId: session.user.id, bucket: "booking-create", limit: 8 })) {
    return NextResponse.json({ error: "Too many booking requests. Please wait a minute and try again." }, { status: 429 });
  }

  const body = (await request.json()) as { serviceId?: unknown; date?: unknown; time?: unknown; durationMinutes?: unknown; deliveryMethod?: unknown; addressLine1?: unknown; addressLine2?: unknown; city?: unknown; state?: unknown; postalCode?: unknown; accessInstructions?: unknown; notes?: unknown; answers?: unknown; parentBookingId?: unknown; packageId?: unknown; addOns?: unknown; recurrence?: unknown; couponCode?: unknown };
  const serviceId = typeof body.serviceId === "string" ? body.serviceId : "";
  const date = typeof body.date === "string" ? body.date : "";
  const time = typeof body.time === "string" ? body.time : "";
  const addressLine1 = typeof body.addressLine1 === "string" ? body.addressLine1.trim() : "";
  const addressLine2 = typeof body.addressLine2 === "string" ? body.addressLine2.trim() : "";
  const city = typeof body.city === "string" ? body.city.trim() : "";
  const state = typeof body.state === "string" ? body.state.trim().toUpperCase() : "";
  const postalCode = typeof body.postalCode === "string" ? body.postalCode.trim() : "";
  const accessInstructions = typeof body.accessInstructions === "string" ? body.accessInstructions.trim() : "";
  const requestedDeliveryMethod = body.deliveryMethod === "REMOTE" || body.deliveryMethod === "IN_PERSON" ? body.deliveryMethod as BookingDeliveryMethod : "";
  const notes = typeof body.notes === "string" ? body.notes.trim() : "";
  const submittedAnswers = body.answers && typeof body.answers === "object" && !Array.isArray(body.answers) ? body.answers as Record<string, unknown> : {};
  const parentBookingId = typeof body.parentBookingId === "string" ? body.parentBookingId : "";
  const packageId = typeof body.packageId === "string" ? body.packageId : "";
  const requestedAddOns = Array.isArray(body.addOns) ? body.addOns.slice(0, 10).map((entry) => entry && typeof entry === "object" ? entry as Record<string, unknown> : {}).map((entry) => ({ addOnId: typeof entry.addOnId === "string" ? entry.addOnId : "", quantity: Number(entry.quantity) })) : [];
  const recurrence = isRecurrenceOption(body.recurrence) ? body.recurrence : "one_time";
  const couponCode = typeof body.couponCode === "string" ? body.couponCode.trim().toUpperCase() : "";
  const requestedDurationMinutes = Number(body.durationMinutes);
  if (!serviceId || !datePattern.test(date) || !timePattern.test(time) || !requestedDeliveryMethod || addressLine1.length > 120 || addressLine2.length > 80 || city.length > 80 || accessInstructions.length > 500 || notes.length > 1000) {
    return NextResponse.json({ error: "Complete the delivery, date, and time fields." }, { status: 400 });
  }
  const serviceResult = await database.query<{
    id: string; provider_id: string; duration_minutes: number; price_cents: number; pricing_type: PricingType;
    hourly_rate_cents: number | null; minimum_duration_minutes: number | null; maximum_duration_minutes: number | null;
    billing_increment_minutes: 15 | 30 | 60 | null; default_duration_minutes: number | null;
    timezone: string; provider_user_id: string; title: string; booking_questions: unknown; plan: BookingFinancialPlan; delivery_type: ServiceDeliveryType; recurrence_options: string[]; service_kind: "standard" | "consultation";
  }>(
    `SELECT s.id::text, s.provider_id::text, s.duration_minutes, s.price_cents, s.pricing_type, s.hourly_rate_cents,
            s.minimum_duration_minutes,s.maximum_duration_minutes,s.billing_increment_minutes,s.default_duration_minutes,
            s.title, s.delivery_type, s.recurrence_options, s.service_kind,
            CASE WHEN entitlement.effective_plan IN ('pro', 'business', 'owner') THEN s.booking_questions ELSE '[]'::jsonb END AS booking_questions,
            COALESCE((SELECT timezone FROM availability WHERE provider_id = p.id AND (service_id = s.id OR service_id IS NULL) ORDER BY (service_id = s.id) DESC LIMIT 1),
                     (SELECT hours.timezone FROM team_member_availability hours JOIN provider_team_members member ON member.id = hours.team_member_id JOIN provider_team_member_locations assigned_location ON assigned_location.team_member_id = member.id WHERE member.provider_id = p.id AND assigned_location.location_id = s.location_id LIMIT 1),
                     'America/Los_Angeles') AS timezone,
            p.user_id AS provider_user_id, entitlement.effective_plan AS plan
     FROM services s
     JOIN provider_profiles p ON p.id = s.provider_id AND p.is_active = true AND p.age_verification_status = 'verified'
     CROSS JOIN LATERAL (SELECT CASE
       WHEN p.plan IN ('owner', 'business') THEN p.plan
       WHEN EXISTS (SELECT 1 FROM complimentary_pro_grants complimentary WHERE complimentary.provider_id = p.id
         AND complimentary.revoked_at IS NULL AND complimentary.starts_at <= now() AND (complimentary.expires_at IS NULL OR complimentary.expires_at > now())) THEN 'pro'
       WHEN p.stripe_subscription_id IS NOT NULL AND p.stripe_billing_mode = $2
         AND p.stripe_subscription_status IN ('active', 'trialing', 'past_due') THEN 'pro'
       ELSE 'starter' END AS effective_plan) entitlement
     WHERE s.id::text = $1 AND s.is_active = true AND s.provider_deleted_at IS NULL
     LIMIT 1`,
    [serviceId, getStripeMode()],
  );
  const service = serviceResult.rows[0];
  if (!service) return NextResponse.json({ error: "This provider is not available on that day." }, { status: 409 });
  if (requiresHourlyProject(service.pricing_type)) {
    return NextResponse.json({ error: "Hourly work now uses tracked projects. Set a work limit and pay only after reviewing the final timesheet.", code: "HOURLY_PROJECT_REQUIRED", serviceId: service.id }, { status: 409 });
  }
  const quoteOnly = service.pricing_type === "QUOTE_ONLY";
  if (quoteOnly && (packageId || requestedAddOns.length > 0 || couponCode || recurrence !== "one_time")) {
    return NextResponse.json({ error: "Quote-only services cannot use fixed-price booking options before a quote is accepted." }, { status: 400 });
  }
  if (quoteOnly && notes.length < 3) return NextResponse.json({ error: "Describe what you need so the provider can prepare an accurate quote." }, { status: 400 });
  if (!isServiceDeliveryType(service.delivery_type) || !serviceSupportsMethod(service.delivery_type, requestedDeliveryMethod)) return NextResponse.json({ error: "That delivery method is not available for this service." }, { status: 400 });
  if (!service.recurrence_options.includes(recurrence)) return NextResponse.json({ error: "That booking frequency is not available for this service." }, { status: 400 });
  const isRemote = requestedDeliveryMethod === "REMOTE";
  if (!isRemote && (!addressLine1 || !city || !usStateCodes.has(state) || !/^\d{5}(?:-\d{4})?$/.test(postalCode))) return NextResponse.json({ error: "Complete the US service address." }, { status: 400 });
  const location = isRemote ? "Remote service" : [addressLine1, addressLine2, `${city}, ${state} ${postalCode}`].filter(Boolean).join(", ");
  if (location.length > 320) return NextResponse.json({ error: "The service address is too long." }, { status: 400 });
  if (parentBookingId) {
    const prior = await database.query(`SELECT 1 FROM bookings WHERE id::text = $1 AND customer_id = $2 AND service_id::text = $3 AND status = 'completed'`, [parentBookingId, session.user.id, serviceId]);
    if (!prior.rows[0]) return NextResponse.json({ error: "That completed booking cannot be repeated." }, { status: 400 });
  }
  const selectedPackageResult = packageId ? await database.query<ServicePackage>(`SELECT id::text,name,description,price_cents AS "priceCents",duration_minutes AS "durationMinutes",delivery_days AS "deliveryDays",revision_count AS "revisionCount",features FROM service_packages WHERE id::text=$1 AND service_id::text=$2 AND is_active=true`, [packageId,serviceId]) : null;
  const selectedPackage = selectedPackageResult?.rows[0] ?? null;
  if (packageId && !selectedPackage) return NextResponse.json({ error: "That package is no longer available." }, { status: 409 });
  if (service.pricing_type === "HOURLY" && selectedPackage) return NextResponse.json({ error: "Packages cannot be combined with hourly pricing." }, { status: 400 });
  const addOnIds = requestedAddOns.map((item) => item.addOnId).filter(Boolean);
  const addOnResult = addOnIds.length ? await database.query<ServiceAddOn>(`SELECT id::text,name,description,price_cents AS "priceCents",additional_minutes AS "additionalMinutes",allows_quantity AS "allowsQuantity",max_quantity AS "maxQuantity" FROM service_add_ons WHERE service_id::text=$1 AND id::text=ANY($2::text[]) AND is_active=true`, [serviceId,addOnIds]) : { rows: [] as ServiceAddOn[] };
  if (new Set(addOnIds).size !== addOnIds.length || addOnResult.rows.length !== addOnIds.length) return NextResponse.json({ error: "One of those add-ons is no longer available." }, { status: 409 });
  const addOnById = new Map(addOnResult.rows.map((item) => [item.id,item]));
  let coupon: CouponRule | null = null;
  if (couponCode) {
    if (!PLAN_ENTITLEMENTS[service.plan].promotions) return NextResponse.json({ error: "That coupon is not valid for this service." }, { status: 400 });
    const couponResult = await database.query<CouponRule & { provider_id: string; service_id: string | null }>(`SELECT id::text,code,discount_type AS "discountType",discount_value AS "discountValue",minimum_subtotal_cents AS "minimumSubtotalCents",first_booking_only AS "firstBookingOnly",repeat_customer_only AS "repeatCustomerOnly",expires_at AS "expiresAt",usage_limit AS "usageLimit",redemption_count AS "redemptionCount",provider_id::text,service_id::text FROM provider_coupons WHERE provider_id::text=$1 AND upper(code)=$2 AND is_active=true AND (service_id IS NULL OR service_id::text=$3)`, [service.provider_id,couponCode,serviceId]);
    coupon = couponResult.rows[0] ?? null;
    if (!coupon) return NextResponse.json({ error: "That coupon is not valid for this service." }, { status: 400 });
    const priorCount = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM bookings WHERE customer_id=$1 AND provider_id::text=$2 AND payment_status IN ('paid','refunded')", [session.user.id,service.provider_id]);
    if (coupon.firstBookingOnly && priorCount.rows[0].count > 0) return NextResponse.json({ error: "That coupon is for first-time customers." }, { status: 400 });
    if (coupon.repeatCustomerOnly && priorCount.rows[0].count < 1) return NextResponse.json({ error: "That coupon is for returning customers." }, { status: 400 });
  }
  let billableDurationMinutes = selectedPackage?.durationMinutes ?? service.duration_minutes;
  let serviceBasePriceCents = quoteOnly ? 0 : selectedPackage?.priceCents ?? service.price_cents;
  if (service.pricing_type === "HOURLY") {
    try {
      const config: HourlyPricingConfig = { pricingType: "HOURLY", hourlyRateCents: service.hourly_rate_cents!, minimumDurationMinutes: service.minimum_duration_minutes!, maximumDurationMinutes: service.maximum_duration_minutes, billingIncrementMinutes: service.billing_increment_minutes!, defaultDurationMinutes: service.default_duration_minutes! };
      billableDurationMinutes = validateHourlyDuration(config, requestedDurationMinutes);
      serviceBasePriceCents = calculateHourlyBasePriceCents(config.hourlyRateCents, billableDurationMinutes);
    } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Choose a valid booking duration." }, { status: 400 }); }
  }
  let commerce;
  try { commerce = calculateCommerceSelection({ servicePriceCents: serviceBasePriceCents, selectedPackage, addOns: requestedAddOns.map((item) => ({ addOn: addOnById.get(item.addOnId)!, quantity: item.quantity })), coupon }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Choose valid booking options." }, { status: 400 }); }
  if (!quoteOnly && commerce.serviceSubtotalCents < 50) return NextResponse.json({ error: "The discounted booking total must be at least $0.50." }, { status: 400 });
  const calculatedFinancialSnapshot = calculateBookingFinancialSnapshot(commerce.serviceSubtotalCents, service.plan);
  const financialSnapshot = quoteOnly ? { ...calculatedFinancialSnapshot, customerServiceFeeCents: 0, customerTotalCents: 0 } : calculatedFinancialSnapshot;
  const selectedDurationMinutes = billableDurationMinutes + commerce.selectedAddOns.reduce((total,item) => total + item.additionalMinutes * item.quantity,0);
  const pricingSummary = quoteOnly ? "Custom quote requested. No price has been approved yet."
    : service.pricing_type === "HOURLY"
    ? `${formatDurationMinutes(billableDurationMinutes)} at $${(service.hourly_rate_cents! / 100).toFixed(2)}/hr; $${(commerce.serviceSubtotalCents / 100).toFixed(2)} service subtotal.`
    : `$${(commerce.serviceSubtotalCents / 100).toFixed(2)} service subtotal.`;
  const questions = Array.isArray(service.booking_questions) ? service.booking_questions.filter((question): question is string => typeof question === "string") : [];
  const answers: Record<string, string> = {};
  for (const question of questions) {
    const answer = typeof submittedAnswers[question] === "string" ? submittedAnswers[question].trim() : "";
    if (!answer || answer.length > 500) return NextResponse.json({ error: "Answer every provider question before requesting this booking." }, { status: 400 });
    answers[question] = answer;
  }
  const safety = await checkAndRecordContent({ userId: session.user.id, surface: "booking", fields: [location, accessInstructions, notes, ...Object.values(answers)] });
  if (!safety.allowed) return NextResponse.json({ error: safety.message }, { status: 422 });

  if (Number(time.slice(3, 5)) % 30 !== 0) return NextResponse.json({ error: "Choose a listed 30-minute time." }, { status: 409 });

  const startsAt = zonedDateTimeToUtc(date, time, service.timezone);
  if (!startsAt) return NextResponse.json({ error: "That local time is skipped or repeated by daylight saving time. Choose another listed time." }, { status: 409 });
  const endsAt = new Date(startsAt.getTime() + selectedDurationMinutes * 60_000);
  if (startsAt <= new Date()) return NextResponse.json({ error: "Choose a future time." }, { status: 409 });

  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [service.provider_id]);
    if (quoteOnly) {
      const openRequest = await client.query(`SELECT 1 FROM bookings WHERE customer_id=$1 AND service_id::text=$2 AND pricing_type_snapshot='QUOTE_ONLY' AND status='requested' LIMIT 1`, [session.user.id, service.id]);
      if (openRequest.rowCount) { await client.query("ROLLBACK"); return NextResponse.json({ error: "You already have an open quote request for this service." }, { status: 409 }); }
    }
    if (coupon) {
      const reserved = await client.query(`UPDATE provider_coupons coupon SET redemption_count=coupon.redemption_count+1 WHERE coupon.id=$1::uuid AND coupon.is_active=true AND (coupon.expires_at IS NULL OR coupon.expires_at>now()) AND (coupon.usage_limit IS NULL OR coupon.redemption_count<coupon.usage_limit) AND EXISTS (SELECT 1 FROM provider_profiles provider WHERE provider.id=coupon.provider_id AND provider.plan IN ('pro','business','owner') AND provider.is_active=true) RETURNING coupon.id`, [coupon.id]);
      if (!reserved.rowCount) { await client.query("ROLLBACK"); return NextResponse.json({ error: "That coupon is no longer available." }, { status: 409 }); }
    }
    const candidate = await client.query<{ member_id: string | null; name: string }>(
      `WITH staff_hours AS (
         SELECT NULL::uuid AS member_id, 'Company owner'::text AS name, a.weekday, a.start_time, a.end_time, a.timezone, 0 AS priority
         FROM availability a WHERE a.provider_id::text = $1
           AND (a.service_id::text = $5 OR (a.service_id IS NULL AND NOT EXISTS (
             SELECT 1 FROM availability configured WHERE configured.provider_id = a.provider_id AND configured.service_id::text = $5
           )))
         UNION ALL
         SELECT member.id, member.name, hours.weekday, hours.start_time, hours.end_time, hours.timezone, 1 AS priority
         FROM provider_team_members member JOIN team_member_availability hours ON hours.team_member_id = member.id
         WHERE member.provider_id::text = $1 AND member.status = 'active'
           AND ((SELECT location_id FROM services WHERE id::text = $5) IS NULL OR EXISTS (
             SELECT 1 FROM provider_team_member_locations assigned_location
             WHERE assigned_location.team_member_id = member.id AND assigned_location.location_id = (SELECT location_id FROM services WHERE id::text = $5)
           ))
       )
       SELECT staff.member_id::text, staff.name FROM staff_hours staff
       WHERE staff.weekday = EXTRACT(DOW FROM $2::timestamptz AT TIME ZONE staff.timezone)
         AND ($2::timestamptz AT TIME ZONE staff.timezone)::time >= staff.start_time
         AND ($3::timestamptz AT TIME ZONE staff.timezone)::time <= staff.end_time
         AND NOT EXISTS (SELECT 1 FROM provider_time_off blocked WHERE blocked.provider_id::text = $1
           AND blocked.team_member_id IS NOT DISTINCT FROM staff.member_id AND blocked.starts_at < $3 AND blocked.ends_at > $2)
         AND NOT EXISTS (SELECT 1 FROM bookings existing
           JOIN booking_assignees assigned ON assigned.booking_id = existing.id
           WHERE existing.provider_id::text = $1
           AND ((staff.member_id IS NULL AND assigned.is_owner = true) OR assigned.team_member_id = staff.member_id)
           AND existing.status = 'confirmed'
           AND existing.starts_at < $3 AND existing.ends_at > $2)
         AND NOT EXISTS (SELECT 1 FROM provider_calendly_connections connection
           JOIN provider_calendly_events external_event ON external_event.connection_id = connection.id
           WHERE staff.member_id IS NULL AND connection.provider_id::text = $1 AND connection.disconnected_at IS NULL
             AND connection.block_conflicting_bookings = true AND external_event.status = 'active'
             AND external_event.starts_at < $3 AND external_event.ends_at > $2)
         AND NOT EXISTS (SELECT 1 FROM provider_calendly_connections connection
           WHERE staff.member_id IS NULL AND connection.provider_id::text = $1 AND connection.disconnected_at IS NULL
             AND connection.block_conflicting_bookings = true
             AND (connection.last_sync_succeeded_at IS NULL
               OR connection.last_sync_succeeded_at < now()-interval '20 minutes'
               OR connection.last_sync_error IS NOT NULL))
         AND NOT EXISTS (SELECT 1 FROM bookings own_request WHERE own_request.customer_id = $4 AND own_request.provider_id::text = $1
           AND own_request.status = 'requested' AND own_request.starts_at < $3 AND own_request.ends_at > $2)
       ORDER BY staff.priority, staff.name LIMIT 1`,
      [service.provider_id, startsAt, endsAt, session.user.id, service.id],
    );
    if (!candidate.rows[0]) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "That time is no longer available. Choose another listed time." }, { status: 409 });
    }
    let recurringSeriesId: string | null = null;
    if (recurrence !== "one_time") {
      const series = await client.query<{ id: string }>(`INSERT INTO recurring_booking_series (customer_id,provider_id,service_id,frequency,starts_at,next_occurrence_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id::text`, [session.user.id,service.provider_id,service.id,recurrence,startsAt,nextOccurrence(startsAt,recurrence)]);
      recurringSeriesId = series.rows[0].id;
    }
    const created = await client.query<{ id: string }>(
      `INSERT INTO bookings (customer_id, provider_id, service_id, starts_at, ends_at, service_address,
          service_address_line1, service_address_line2, service_city, service_state, service_postal_code,
          access_instructions, notes, price_cents, assigned_team_member_id, booking_answers,
          provider_plan_snapshot, provider_fee_basis_points, provider_fee_cap_cents, platform_fee_cents, provider_payout_cents,
          customer_service_fee_cents, customer_total_cents, parent_booking_id, delivery_method,
          base_price_cents,add_on_total_cents,discount_cents,package_snapshot,add_on_snapshot,coupon_id,coupon_code_snapshot,recurring_series_id,recurrence_index,booking_kind,
          pricing_type_snapshot,hourly_rate_cents_snapshot,billable_duration_minutes,billing_increment_minutes_snapshot,minimum_duration_minutes_snapshot,maximum_duration_minutes_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''), NULLIF($12, ''), $13, $14, $15::uuid, $16::jsonb,
          $17, $18, $19, $20, $21, $22, $23, NULLIF($24, '')::uuid, $25,
          $26,$27,$28,$29::jsonb,$30::jsonb,$31::uuid,$32,$33::uuid,$34,$35,$36,$37,$38,$39,$40,$41)
       RETURNING id::text`,
      [session.user.id, service.provider_id, service.id, startsAt, endsAt, location, addressLine1, addressLine2, city, state, postalCode, accessInstructions, notes, commerce.serviceSubtotalCents, candidate.rows[0].member_id, JSON.stringify(answers),
        financialSnapshot.providerPlan, financialSnapshot.providerFeeBasisPoints, financialSnapshot.providerFeeCapCents, financialSnapshot.providerFeeCents,
        financialSnapshot.providerNetCents, financialSnapshot.customerServiceFeeCents, financialSnapshot.customerTotalCents, parentBookingId, requestedDeliveryMethod,
        commerce.basePriceCents,commerce.addOnTotalCents,commerce.discountCents,selectedPackage ? JSON.stringify(selectedPackage) : null,JSON.stringify(commerce.selectedAddOns),coupon?.id ?? null,coupon?.code ?? null,recurringSeriesId,recurringSeriesId ? 1 : null,service.service_kind,
        service.pricing_type,service.pricing_type === "HOURLY" ? service.hourly_rate_cents : null,billableDurationMinutes,
        service.pricing_type === "HOURLY" ? service.billing_increment_minutes : null,service.pricing_type === "HOURLY" ? service.minimum_duration_minutes : null,
        service.pricing_type === "HOURLY" ? service.maximum_duration_minutes : null],
    );
    const bookingId = created.rows[0].id;
    if (campaignAttribution?.r && campaignAttribution.p === service.provider_id && campaignAttribution.u === session.user.id) {
      await client.query(`UPDATE marketing_attributions SET booking_id=$2,attributed_at=now() WHERE recipient_id::text=$1 AND provider_id::text=$3 AND customer_id=$4 AND booking_id IS NULL`, [campaignAttribution.r,bookingId,service.provider_id,session.user.id]);
      await client.query(`INSERT INTO marketing_email_events(recipient_id,provider_id,event_type,metadata) SELECT id,provider_id,'booking',$4::jsonb FROM marketing_campaign_recipients WHERE id::text=$1 AND provider_id::text=$2 AND customer_id=$3`, [campaignAttribution.r,service.provider_id,session.user.id,JSON.stringify({bookingId})]);
    }
    await client.query(
      `INSERT INTO booking_assignees (booking_id, team_member_id, is_owner)
       VALUES ($1::uuid, $2::uuid, $2::uuid IS NULL)`,
      [bookingId, candidate.rows[0].member_id],
    );
    await client.query(
      `INSERT INTO booking_events (booking_id, actor_user_id, event_type, message)
       VALUES ($1::uuid, $2, 'requested', $3)`,
      [bookingId, session.user.id, `Customer sent the booking request. Assigned to ${candidate.rows[0].name}.`],
    );
    await client.query(
      `INSERT INTO conversations (customer_id, provider_id, service_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (customer_id, provider_id, service_id) WHERE service_id IS NOT NULL DO UPDATE
         SET customer_deleted_at = NULL, provider_deleted_at = NULL, updated_at = now()`,
      [session.user.id, service.provider_id, service.id],
    );
    await client.query(
      `INSERT INTO notifications (user_id, booking_id, type, title, message, href, dedupe_key)
       VALUES
         ($1, $3::uuid, 'booking_requested', 'New booking request', $4, '/provider/dashboard/bookings', 'booking-requested-' || ($3::uuid)::text || '-provider'),
         ($2, $3::uuid, 'booking_requested', 'Booking request sent', $5, '/account/bookings/' || ($3::uuid)::text, 'booking-requested-' || ($3::uuid)::text || '-customer')
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        service.provider_user_id,
        session.user.id,
        bookingId,
        `${session.user.name || "A customer"} requested ${service.title}: ${pricingSummary}`,
        `Your request for ${service.title} was sent to the provider: ${pricingSummary}`,
      ],
    );
    await client.query("COMMIT");
    await recordActivity({ userId: session.user.id, action: "booking_created", targetType: "booking", targetId: bookingId });
    await recordAnalytics({ eventName: "booking_requested", userId: session.user.id, targetType: "booking", targetId: bookingId, metadata: { deliveryMethod: requestedDeliveryMethod, packageSelected: Boolean(selectedPackage), addOnCount: commerce.selectedAddOns.length, recurrence, couponApplied: Boolean(coupon), bookingKind: service.service_kind, pricingType: service.pricing_type, billableDurationMinutes } });
    if (selectedPackage) await recordAnalytics({ eventName: "package_selected", userId: session.user.id, targetType: "booking", targetId: bookingId });
    if (commerce.selectedAddOns.length) await recordAnalytics({ eventName: "add_on_purchased", userId: session.user.id, targetType: "booking", targetId: bookingId, metadata: { count: commerce.selectedAddOns.length } });
    if (recurringSeriesId) await recordAnalytics({ eventName: "recurring_booking_created", userId: session.user.id, targetType: "recurring_series", targetId: recurringSeriesId, metadata: { recurrence } });
    if (coupon) await recordAnalytics({ eventName: "coupon_redeemed", userId: session.user.id, targetType: "booking", targetId: bookingId, metadata: { discountCents: commerce.discountCents } });
    if (service.service_kind === "consultation") await recordAnalytics({ eventName: "consultation_booked", userId: session.user.id, targetType: "booking", targetId: bookingId });
    await recordAnalytics({ eventName: isRemote ? "remote_booking_requested" : "local_booking_requested", userId: session.user.id, targetType: "booking", targetId: bookingId });
    const providerBookingCount = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM bookings WHERE provider_id::text = $1", [service.provider_id]);
    if (providerBookingCount.rows[0]?.count === 1) await recordAnalytics({ eventName: "first_booking_received", userId: service.provider_user_id, targetType: "booking", targetId: bookingId });
    if (parentBookingId) await recordAnalytics({ eventName: "customer_rebooked", userId: session.user.id, targetType: "booking", targetId: bookingId, metadata: { parentBookingId } });
    await sendBookingUpdateEmails(bookingId, "requested");
    return NextResponse.json({
      id: bookingId,
      status: "requested",
      pricing: {
        originalSubtotalCents: commerce.originalSubtotalCents,
        discountCents: commerce.discountCents,
        serviceSubtotalCents: commerce.serviceSubtotalCents,
        customerServiceFeeCents: financialSnapshot.customerServiceFeeCents,
        customerTotalCents: financialSnapshot.customerTotalCents,
        couponCode: coupon?.code ?? null,
        pricingType: service.pricing_type,
        hourlyRateCents: service.pricing_type === "HOURLY" ? service.hourly_rate_cents : null,
        billableDurationMinutes,
      },
    }, { status: 201 });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Booking request failed", error);
    return NextResponse.json({ error: "We could not send your request. Please try again." }, { status: 500 });
  } finally {
    client.release();
  }
}
