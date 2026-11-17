import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { database } from "@/lib/database";
import { checkAndRecordContent } from "@/lib/content-safety";
import { enforceRateLimit } from "@/lib/request-security";
import { recordAnalytics } from "@/lib/analytics";

export async function POST(request: Request, context: RouteContext<"/api/bookings/[bookingId]/review">) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!await enforceRateLimit({ request, userId: session.user.id, bucket: "review-create", limit: 8, windowSeconds: 3600 })) return NextResponse.json({ error: "Too many review attempts. Please try again later." }, { status: 429 });
  const { bookingId } = await context.params;
  const body = (await request.json()) as { rating?: unknown; review?: unknown };
  const rating = typeof body.rating === "number" ? body.rating : 0;
  const review = typeof body.review === "string" ? body.review.trim() : "";
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return NextResponse.json({ error: "Choose a rating from 1 to 5 stars." }, { status: 400 });
  }
  if (review.length < 3 || review.length > 1000) {
    return NextResponse.json({ error: "Write a review between 3 and 1,000 characters." }, { status: 400 });
  }
  const safety = await checkAndRecordContent({ userId: session.user.id, surface: "review", fields: [review] });
  if (!safety.allowed) return NextResponse.json({ error: safety.message }, { status: 422 });

  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const bookingResult = await client.query<{ provider_id: string; service_id: string; provider_user_id: string; service_title: string }>(
      `SELECT b.provider_id::text, b.service_id::text, p.user_id AS provider_user_id, s.title AS service_title
       FROM bookings b
       JOIN provider_profiles p ON p.id = b.provider_id
       JOIN services s ON s.id = b.service_id
       WHERE b.id::text = $1 AND b.customer_id = $2 AND b.status = 'completed'
         AND (b.payment_status IN ('paid','refunded') OR NOT EXISTS (SELECT 1 FROM hourly_projects project WHERE project.payment_booking_id=b.id))
       FOR UPDATE OF b`,
      [bookingId, session.user.id],
    );
    const booking = bookingResult.rows[0];
    if (!booking) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Reviews are available after a completed booking." }, { status: 409 });
    }
    const created = await client.query<{ id: string }>(
      `INSERT INTO reviews (booking_id, customer_id, provider_id, service_id, rating, body)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (booking_id) DO NOTHING
       RETURNING id::text`,
      [bookingId, session.user.id, booking.provider_id, booking.service_id, rating, review],
    );
    if (!created.rows[0]) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "You already reviewed this booking." }, { status: 409 });
    }
    await client.query(
      `INSERT INTO notifications (user_id, booking_id, type, title, message, href, dedupe_key)
       VALUES ($1, $2::uuid, 'new_review', 'New customer review', $3, '/provider/dashboard/reviews', 'review-' || $2::uuid::text || '-provider')
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [booking.provider_user_id, bookingId, `${session.user.name || "A customer"} left a ${rating}-star review for ${booking.service_title}.`],
    );
    await client.query("COMMIT");
    await recordAnalytics({ eventName: "review_submitted", userId: session.user.id, targetType: "booking", targetId: bookingId, metadata: { rating } });
    return NextResponse.json({ review: { id: created.rows[0].id, rating, body: review } }, { status: 201 });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Review creation failed", error);
    return NextResponse.json({ error: "We could not save your review. Please try again." }, { status: 500 });
  } finally {
    client.release();
  }
}
