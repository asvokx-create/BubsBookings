import { NextResponse } from "next/server";
import { database } from "@/lib/database";
import { getMarketingAccess } from "@/lib/provider-marketing";
import { enforceRateLimit, recordActivity } from "@/lib/request-security";
import { parseManualClient } from "@/lib/manual-client";

export async function POST(request: Request) {
  const access = await getMarketingAccess("clients");
  if (!access) return NextResponse.json({ error: "You do not have permission to add clients." }, { status: 403 });
  if (!await enforceRateLimit({ request, userId: access.session.user.id, bucket: "provider-manual-client", limit: 30, windowSeconds: 600 }))
    return NextResponse.json({ error: "Too many attempts. Please wait a few minutes." }, { status: 429 });
  let input: ReturnType<typeof parseManualClient>;
  try { input = parseManualClient(await request.json()); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Check the client details." }, { status: 400 }); }
  try {
    const result = await database.query<{ id: string }>(`INSERT INTO provider_imported_customers
      (provider_id,full_name,email,email_normalized,phone,phone_normalized,notes,marketing_consent,imported_by,source_file_name,source_row)
      VALUES ($1,$2,$3,$3,$4,$4,$5,false,$6,'Manual entry',1) ON CONFLICT DO NOTHING RETURNING id::text`,
      [access.providerId,input.name,input.email || null,input.phone || null,input.notes,access.session.user.id]);
    if (!result.rows[0]) return NextResponse.json({ error: "A contact with that email or phone already exists. No existing details were changed." }, { status: 409 });
    // Audit failures must not turn a successful save into a retry/duplicate.
    await recordActivity({ userId: access.session.user.id, action: "provider_client_added", targetType: "provider_customer", targetId: result.rows[0].id }).catch(() => {});
    return NextResponse.json({ id: result.rows[0].id }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "The client could not be saved. Please try again." }, { status: 500 });
  }
}
