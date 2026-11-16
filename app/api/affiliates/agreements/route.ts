import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { database } from "@/lib/database";
import { validateAffiliateAgreementConsent } from "@/lib/affiliate-agreement-consent";
import { AFFILIATE_LEGAL_DOCUMENTS } from "@/lib/legal-document-versions";
import { affiliateRequiresAgreementReacceptance } from "@/lib/affiliate-agreement-reacceptance";
import { enforceRateLimit } from "@/lib/request-security";

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Sign in to review Partner agreements." }, { status: 401 });
  if (!await enforceRateLimit({ request, userId: session.user.id, bucket: "affiliate-agreement-acceptance", limit: 8, windowSeconds: 3600 })) {
    return NextResponse.json({ error: "Too many attempts. Please try again later." }, { status: 429 });
  }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const consent = validateAffiliateAgreementConsent(body ?? {});
  if (!consent.accepted) return NextResponse.json({ error: `Complete each required acknowledgment: ${consent.missing.join(", ")}.` }, { status: 400 });

  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const profileResult = await client.query<{ id: string; partner_agreement_version: string | null; terms_version: string | null; privacy_version: string | null; agreement_reacceptance_required_at: Date | null }>(
      `SELECT id::text,partner_agreement_version,terms_version,privacy_version,agreement_reacceptance_required_at
       FROM affiliate_profiles WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [session.user.id],
    );
    const profile = profileResult.rows[0];
    if (!profile) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "No Partner profile belongs to this account." }, { status: 404 });
    }
    if (!affiliateRequiresAgreementReacceptance(profile)) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "This Partner account does not currently require reacceptance." }, { status: 409 });
    }
    const acceptedAt = new Date().toISOString();
    for (const document of Object.values(AFFILIATE_LEGAL_DOCUMENTS)) {
      await client.query(`INSERT INTO affiliate_agreement_acceptances
          (affiliate_id,user_id,document_key,document_version,content_hash,acceptance_event,accepted_at,audit_metadata)
        VALUES ($1,$2,$3,$4,$5,'affiliate_reacceptance',$6,$7::jsonb)
        ON CONFLICT (affiliate_id,document_key,document_version) DO NOTHING`, [profile.id, session.user.id,
        document.key, document.version, document.contentHash, acceptedAt,
        JSON.stringify({ source: "affiliate_dashboard", authenticated: true })]);
    }
    await client.query(`UPDATE affiliate_profiles SET
        partner_agreement_accepted_at=$2,partner_agreement_version=$3,partner_agreement_content_hash=$4,
        terms_accepted_at=$2,terms_version=$5,terms_content_hash=$6,
        privacy_acknowledged_at=$2,privacy_version=$7,privacy_content_hash=$8,
        agreement_reacceptance_required_at=NULL,agreement_reacceptance_reason=NULL
      WHERE id=$1`, [profile.id, acceptedAt,
      AFFILIATE_LEGAL_DOCUMENTS.partnerAgreement.version, AFFILIATE_LEGAL_DOCUMENTS.partnerAgreement.contentHash,
      AFFILIATE_LEGAL_DOCUMENTS.termsOfService.version, AFFILIATE_LEGAL_DOCUMENTS.termsOfService.contentHash,
      AFFILIATE_LEGAL_DOCUMENTS.privacyPolicy.version, AFFILIATE_LEGAL_DOCUMENTS.privacyPolicy.contentHash]);
    await client.query("COMMIT");
    return NextResponse.json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("Affiliate agreement reacceptance failed", error instanceof Error ? error.message : "Unknown error");
    return NextResponse.json({ error: "Your agreement acceptance could not be recorded." }, { status: 500 });
  } finally {
    client.release();
  }
}
