import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import type Stripe from "stripe";
import { database } from "./database";
import { getStripe, getStripeMode } from "./stripe";
import { syncAffiliateCommissionForBooking } from "./affiliates";
import { BOOKING_REFUND_RECONCILIATION, bookingRefundWarning, recordPendingBookingRefund } from "./booking-refund-operations";

type Mode = "test" | "live";
type QueryClient = Pick<PoolClient, "query">;
export const REFUND_RECOVERY_REVIEW = "The customer was refunded, but provider transfer recovery is not confirmed. Admin review is required before retrying recovery.";
export const REFUND_SETTLEMENT_REVIEW = "Stripe reports that an earlier refund did not complete. The customer may still be owed money. Administrator review is required; do not issue another refund automatically.";
type Operation = {
  id: string; booking_id: string; stripe_mode: Mode; origin: string; actor_user_id: string | null; dispute_id: string | null;
  payment_intent_id: string; charge_id: string | null; currency: string; payment_flow: string | null; refund_application_fee: boolean;
  service_amount_cents: number; fee_amount_cents: number; baseline_service_cents: number; baseline_fee_cents: number;
  price_cents: number; service_fee_cents: number; provider_share_cents: number; adjusted_share_cents: number;
  transfer_id: string | null; connected_account_id: string | null; baseline_reversed_cents: number; reversal_target_cents: number;
  refund_attempted_at: Date | null; stripe_refund_id: string | null; stripe_refund_status: string | null;
  refund_confirmed_at: Date | null; effects_completed_at: Date | null; reversal_attempted_at: Date | null;
  reversal_amount_cents: number | null; recovery_completed_at: Date | null; last_error: string | null;
  decision_snapshot: { note: string; actorUserId: string; openedBy: string; againstUserId: string; outcome: "partial" | "customer" } | null;
  decision_completed_at: Date | null;
  settlement_issue_at: Date | null;
};
const idOf = (value: string | { id: string } | null | undefined) => typeof value === "string" ? value : value?.id ?? null;
const amountOf = (op: Operation) => op.service_amount_cents + op.fee_amount_cents;

/** The existing guarded booking UPDATE and immutable authorization must commit
 * together. No migration/backfill is allowed to infer this authority later. */
export async function claimBookingRefundOperation<T extends QueryResultRow>(input: {
  bookingId: string; mode: Mode; origin: "provider" | "automatic" | "dispute_partial";
  actorUserId?: string; disputeId?: string; refundApplicationFee?: boolean;
}, claim: (client: QueryClient) => Promise<{ rows: T[]; rowCount: number | null }>) {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    // Same booking-first lock order as payout finalization and refund webhooks.
    await client.query("SELECT id FROM bookings WHERE id::text=$1 FOR UPDATE", [input.bookingId]);
    const existing = await client.query("SELECT id FROM booking_refund_operations WHERE booking_id=$1::uuid AND (settlement_issue_at IS NOT NULL OR effects_completed_at IS NULL OR recovery_completed_at IS NULL OR (dispute_id IS NOT NULL AND decision_completed_at IS NULL))", [input.bookingId]);
    if (existing.rows.length) { await client.query("ROLLBACK"); return null; }
    if (input.disputeId) {
      const prior = await client.query("SELECT id FROM booking_refund_operations WHERE stripe_mode=$1 AND dispute_id=$2",[input.mode,input.disputeId]);
      if(prior.rows.length) {await client.query("ROLLBACK");return null;}
    }
    const claimed = await claim(client);
    if (!claimed.rows[0]) { await client.query("ROLLBACK"); return null; }
    const snapshot = await client.query<{
      stripe_payment_intent_id: string; stripe_charge_id: string | null; stripe_mode: Mode; payment_flow: string | null;
      price_cents: number; customer_service_fee_cents: number; refunded_amount_cents: number; customer_service_fee_refunded_cents: number;
      refund_amount_cents: number; provider_payout_cents: number; stripe_transfer_id: string | null; stripe_transfer_reversed_cents: number;
      stripe_account_id: string | null;
    }>(`SELECT b.*, p.stripe_account_id FROM bookings b JOIN provider_profiles p ON p.id=b.provider_id WHERE b.id::text=$1`, [input.bookingId]);
    const b = snapshot.rows[0];
    if (!b?.stripe_payment_intent_id || b.stripe_mode !== input.mode) throw new Error("Refund authorization identity changed.");
    const totalService = b.refunded_amount_cents + b.refund_amount_cents;
    const fee = totalService >= b.price_cents ? b.customer_service_fee_cents - b.customer_service_fee_refunded_cents : 0;
    const remaining = b.price_cents - b.refunded_amount_cents;
    const held = b.payment_flow === "held_transfer_v1";
    if(held && b.stripe_transfer_id && totalService < b.price_cents
      && (b.refunded_amount_cents>0 || b.stripe_transfer_reversed_cents>0)) {
      throw new Error("A transferred partial refund requires a proven original refund basis; operator review is required.");
    }
    const adjusted = held && !b.stripe_transfer_id
      ? Math.max(0, Math.round(b.provider_payout_cents * (b.price_cents - totalService) / Math.max(1, remaining))) : b.provider_payout_cents;
    const target = held && b.stripe_transfer_id
      ? totalService >= b.price_cents ? b.provider_payout_cents
        : Math.max(0, b.provider_payout_cents - Math.round(b.provider_payout_cents * (b.price_cents - totalService) / b.price_cents)) : 0;
    const inserted = await client.query<Operation>(`INSERT INTO booking_refund_operations
      (id,booking_id,stripe_mode,origin,actor_user_id,dispute_id,payment_intent_id,charge_id,payment_flow,refund_application_fee,
       service_amount_cents,fee_amount_cents,baseline_service_cents,baseline_fee_cents,price_cents,service_fee_cents,
       provider_share_cents,adjusted_share_cents,transfer_id,connected_account_id,baseline_reversed_cents,reversal_target_cents)
      VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
    [randomUUID(), input.bookingId, input.mode, input.origin, input.actorUserId ?? null, input.disputeId ?? null,
      b.stripe_payment_intent_id,b.stripe_charge_id,b.payment_flow,Boolean(input.refundApplicationFee),
      b.refund_amount_cents,fee,b.refunded_amount_cents,b.customer_service_fee_refunded_cents,b.price_cents,b.customer_service_fee_cents,
      b.provider_payout_cents,adjusted,b.stripe_transfer_id,b.stripe_account_id,b.stripe_transfer_reversed_cents,target]);
    if(input.disputeId) {
      const decision=await client.query<{admin_note:string;opened_by:string;against_user_id:string}>(`UPDATE booking_disputes SET refund_operation_id=$3::uuid
        WHERE id::text=$1 AND booking_id::text=$2 AND status='resolved' AND resolution_outcome=$5
          AND resolved_by=$4 AND refund_operation_id IS NULL RETURNING admin_note,opened_by,against_user_id`,
      [input.disputeId,input.bookingId,inserted.rows[0].id,input.actorUserId,input.origin === "dispute_partial" ? "partial" : "customer"]);
      if(!decision.rows[0]) throw new Error("Dispute refund decision changed before authorization was saved.");
      const snapshot={outcome:input.origin === "dispute_partial" ? "partial" : "customer",note:decision.rows[0].admin_note,actorUserId:input.actorUserId!,openedBy:decision.rows[0].opened_by,againstUserId:decision.rows[0].against_user_id};
      await client.query("UPDATE booking_refund_operations SET decision_snapshot=$2::jsonb WHERE id=$1::uuid",[inserted.rows[0].id,JSON.stringify(snapshot)]);
    }
    await client.query("COMMIT");
    return { row: claimed.rows[0], operation: inserted.rows[0] };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

async function operation(id: string) {
  return (await database.query<Operation>("SELECT * FROM booking_refund_operations WHERE id::text=$1", [id])).rows[0];
}

async function claimMoneyAttempt(bookingId:string,sql:string,values:unknown[]) {
  const client=await database.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM bookings WHERE id::text=$1 FOR UPDATE",[bookingId]);
    const result=await client.query(sql,values);
    await client.query("COMMIT");return result;
  } catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}
  finally{client.release();}
}

/** Local effects are one transaction, independently retryable from money writes. */
async function finalizeRefund(op: Operation) {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{
      customer_id: string; provider_user_id: string; service_title: string; stripe_payment_intent_id: string; stripe_mode: Mode;
      refunded_amount_cents: number; customer_service_fee_refunded_cents: number;
      settlement_review: boolean;
    }>(`SELECT b.*,p.user_id AS provider_user_id,s.title AS service_title,
      EXISTS(SELECT 1 FROM booking_refund_operations o WHERE o.booking_id=b.id AND o.settlement_issue_at IS NOT NULL) AS settlement_review FROM bookings b
      JOIN provider_profiles p ON p.id=b.provider_id JOIN services s ON s.id=b.service_id WHERE b.id::text=$1 FOR UPDATE OF b`, [op.booking_id]);
    const locked = (await client.query<Operation>("SELECT * FROM booking_refund_operations WHERE id=$1::uuid FOR UPDATE", [op.id])).rows[0];
    const b = current.rows[0];
    if (!locked?.refund_confirmed_at || locked.effects_completed_at || locked.settlement_issue_at) { await client.query("COMMIT"); return; }
    if (!b || b.stripe_mode !== op.stripe_mode || b.stripe_payment_intent_id !== op.payment_intent_id) throw new Error("Refund booking identity changed.");
    // Refresh cross-operation evidence after any wait for the booking lock.
    b.settlement_review=Boolean((await client.query("SELECT id FROM booking_refund_operations WHERE booking_id=$1::uuid AND settlement_issue_at IS NOT NULL LIMIT 1",[op.booking_id])).rows.length);
    const serviceTarget = op.baseline_service_cents + op.service_amount_cents;
    const feeTarget = op.baseline_fee_cents + op.fee_amount_cents;
    const full = serviceTarget === op.price_cents && feeTarget === op.service_fee_cents;
    const recovery = op.reversal_target_cents > op.baseline_reversed_cents;
    // Newer/external refund totals must not be used to release a stale payout.
    const newer = b.refunded_amount_cents > serviceTarget || b.customer_service_fee_refunded_cents > feeTarget;
    await client.query(`UPDATE bookings SET
      stripe_refund_id=CASE WHEN refunded_amount_cents<=$3 AND customer_service_fee_refunded_cents<=$4 THEN $2 ELSE stripe_refund_id END,
      refund_status=CASE WHEN $12 THEN 'failed' ELSE 'refunded' END,refunded_at=COALESCE(refunded_at,now()),
      refunded_amount_cents=GREATEST(refunded_amount_cents,$3),customer_service_fee_refunded_cents=GREATEST(customer_service_fee_refunded_cents,$4),
      payment_status=CASE WHEN $5 THEN 'refunded' ELSE payment_status END,
      refund_failure_reason=CASE WHEN $10 THEN refund_failure_reason ELSE NULL END,
      provider_payout_cents=CASE WHEN payment_flow='held_transfer_v1' AND stripe_transfer_id IS NULL AND NOT $10 THEN LEAST(provider_payout_cents,$6) ELSE provider_payout_cents END,
      payment_release_status=CASE WHEN $10 THEN payment_release_status
        WHEN stripe_transfer_id IS NOT NULL AND stripe_transfer_reversed_cents>=provider_payout_cents THEN 'reversed'
        WHEN stripe_transfer_id IS NOT NULL THEN payment_release_status
        WHEN $5 THEN 'reversed'
        WHEN (payout_frozen_at IS NOT NULL OR payout_freeze_reason IS NOT NULL) AND COALESCE(payout_freeze_reason,'') NOT IN ('Refund requested','Stripe refund requires payout reconciliation')
          AND NOT ($11='dispute_partial' AND payout_freeze_reason='Open booking dispute') THEN 'frozen'
        WHEN (stripe_dispute_status IS NOT NULL AND stripe_dispute_status NOT IN ('won','warning_closed'))
          OR EXISTS (SELECT 1 FROM booking_disputes d WHERE d.booking_id=bookings.id AND d.status IN ('open','reviewing')) THEN 'frozen'
        WHEN status='completed' THEN 'awaiting_customer' ELSE 'secured' END,
      payout_frozen_at=CASE WHEN NOT $10 AND (payout_freeze_reason IN ('Refund requested','Stripe refund requires payout reconciliation')
          OR ($11='dispute_partial' AND payout_freeze_reason='Open booking dispute'))
        AND (stripe_dispute_status IS NULL OR stripe_dispute_status IN ('won','warning_closed'))
        AND NOT EXISTS (SELECT 1 FROM booking_disputes d WHERE d.booking_id=bookings.id AND d.status IN ('open','reviewing')) THEN NULL ELSE payout_frozen_at END,
      payout_frozen_by=CASE WHEN NOT $10 AND (payout_freeze_reason IN ('Refund requested','Stripe refund requires payout reconciliation')
          OR ($11='dispute_partial' AND payout_freeze_reason='Open booking dispute'))
        AND (stripe_dispute_status IS NULL OR stripe_dispute_status IN ('won','warning_closed'))
        AND NOT EXISTS (SELECT 1 FROM booking_disputes d WHERE d.booking_id=bookings.id AND d.status IN ('open','reviewing')) THEN NULL ELSE payout_frozen_by END,
      payout_freeze_reason=CASE WHEN NOT $10 AND (payout_freeze_reason IN ('Refund requested','Stripe refund requires payout reconciliation')
          OR ($11='dispute_partial' AND payout_freeze_reason='Open booking dispute'))
        AND (stripe_dispute_status IS NULL OR stripe_dispute_status IN ('won','warning_closed'))
        AND NOT EXISTS (SELECT 1 FROM booking_disputes d WHERE d.booking_id=bookings.id AND d.status IN ('open','reviewing')) THEN NULL ELSE payout_freeze_reason END,
      payout_failure_reason=CASE WHEN $7 AND stripe_transfer_reversed_cents<$8
        AND (payout_failure_reason IS NULL OR payout_failure_reason='Stripe refund after provider payout requires transfer recovery review.') THEN $9 ELSE payout_failure_reason END
      WHERE id::text=$1`, [op.booking_id,locked.stripe_refund_id,serviceTarget,feeTarget,full,op.adjusted_share_cents,recovery,op.reversal_target_cents,REFUND_RECOVERY_REVIEW,newer || b.settlement_review,op.origin,b.settlement_review]);
    await syncAffiliateCommissionForBooking(op.booking_id, client);
    await client.query(`INSERT INTO booking_events (booking_id,actor_user_id,event_type,message,metadata)
      SELECT $1::uuid,$2,'refunded',$3,jsonb_build_object('amountCents',$4::integer,'serviceFeeRefundCents',$5::integer,'stripeRefundId',$6::text,'refundOperationId',$7::text)
      WHERE NOT EXISTS (SELECT 1 FROM booking_events WHERE booking_id=$1::uuid AND event_type='refunded' AND metadata->>'stripeRefundId'=$6)`,
    [op.booking_id,op.actor_user_id,`Stripe confirmed a $${(amountOf(op)/100).toFixed(2)} refund.`,amountOf(op),op.fee_amount_cents,locked.stripe_refund_id,op.id]);
    await client.query(`INSERT INTO notifications (user_id,booking_id,type,title,message,href,dedupe_key)
      VALUES ($1,$2::uuid,'refund_approved','Refund confirmed',$3,'/account/bookings/' || $2::uuid::text,'refund-confirmed-' || $4),
        ($5,$2::uuid,'refund_approved','Customer refund confirmed',$3,'/provider/dashboard/bookings/' || $2::uuid::text,'refund-confirmed-provider-' || $4)
      ON CONFLICT (dedupe_key) DO NOTHING`, [b.customer_id,op.booking_id,
      `Stripe confirmed the $${(amountOf(op)/100).toFixed(2)} refund for ${b.service_title} to the original payment method.`,locked.stripe_refund_id,b.provider_user_id]);
    await client.query(`UPDATE booking_refund_operations SET effects_completed_at=now(),
      recovery_completed_at=CASE WHEN reversal_target_cents=0 THEN COALESCE(recovery_completed_at,now()) ELSE recovery_completed_at END,
      last_error=CASE WHEN $2 THEN 'Newer refund activity requires operator review.' ELSE NULL END WHERE id=$1::uuid`, [op.id,newer || b.settlement_review]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

/** Recover only the original owned decision, never a newer administrator edit. */
async function finalizeRefundDecision(operationId:string) {
  const op=await operation(operationId);
  if(!op || !op.dispute_id || op.decision_completed_at || op.settlement_issue_at || !op.effects_completed_at || !op.recovery_completed_at) return;
  const client=await database.connect();
  try {
    await client.query("BEGIN");
    const booking=(await client.query<{refunded_amount_cents:number;customer_service_fee_refunded_cents:number;settlement_review:boolean}>(
      `SELECT refunded_amount_cents,customer_service_fee_refunded_cents,
        EXISTS(SELECT 1 FROM booking_refund_operations o WHERE o.booking_id=b.id AND o.settlement_issue_at IS NOT NULL) AS settlement_review
        FROM bookings b WHERE id::text=$1 FOR UPDATE`,[op.booking_id])).rows[0];
    const current=(await client.query<Operation>("SELECT * FROM booking_refund_operations WHERE id=$1::uuid FOR UPDATE",[op.id])).rows[0];
    if(current.decision_completed_at || current.settlement_issue_at) {await client.query("COMMIT");return;}
    if(booking) booking.settlement_review=Boolean((await client.query("SELECT id FROM booking_refund_operations WHERE booking_id=$1::uuid AND settlement_issue_at IS NOT NULL LIMIT 1",[op.booking_id])).rows.length);
    if(!booking || booking.settlement_review || booking.refunded_amount_cents!==current.baseline_service_cents+current.service_amount_cents
      || booking.customer_service_fee_refunded_cents!==current.baseline_fee_cents+current.fee_amount_cents) {
      await client.query("UPDATE booking_refund_operations SET last_error='Newer refund activity requires operator review.' WHERE id=$1::uuid",[op.id]);
      await client.query("COMMIT");return;
    }
    const snapshot=current.decision_snapshot;
    if(!snapshot || !current.dispute_id) throw new Error("Original dispute decision is unavailable.");
    const updated=await client.query(`UPDATE booking_disputes SET status='resolved',resolution_outcome=$6,
      resolved_at=COALESCE(resolved_at,now()),resolved_by=$4,updated_at=now()
      WHERE id::text=$1 AND booking_id::text=$2 AND refund_operation_id=$3::uuid
        AND admin_note=$5 AND status IN ('open','reviewing','resolved')
        AND (resolution_outcome IS NULL OR resolution_outcome=$6) RETURNING id`,
    [current.dispute_id,current.booking_id,current.id,snapshot.actorUserId,snapshot.note,snapshot.outcome]);
    if(!updated.rowCount) {
      await client.query("UPDATE booking_refund_operations SET last_error='The dispute decision changed; administrator review is required.' WHERE id=$1::uuid",[op.id]);
      await client.query("COMMIT");return;
    }
    await client.query(`INSERT INTO admin_audit_log (actor_user_id,action,target_type,target_id,details)
      SELECT $1,'disputes_resolved','booking_dispute',$2,$3::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM admin_audit_log WHERE action='disputes_resolved' AND target_type='booking_dispute'
        AND target_id=$2 AND details->>'refundOperationId'=$4)`,[snapshot.actorUserId,current.dispute_id,
      JSON.stringify({status:'resolved',note:snapshot.note,outcome:snapshot.outcome,refunded:snapshot.outcome==="customer",partialRefunded:snapshot.outcome==="partial",amountCents:current.service_amount_cents,refundOperationId:current.id}),current.id]);
    await client.query(`INSERT INTO notifications (user_id,booking_id,type,title,message,href,dedupe_key)
      SELECT participant.user_id,$2::uuid,'dispute_resolved','Dispute decision',$3,'/disputes',
        'dispute-resolution-' || $1::text || '-' || participant.user_id
      FROM (VALUES ($4::text),($5::text)) AS participant(user_id) ON CONFLICT (dedupe_key) DO NOTHING`,
    [current.dispute_id,current.booking_id,snapshot.outcome === "customer" ? "The dispute was decided in the customer’s favor. Stripe confirmed the refund." : `The dispute was resolved with a ${(current.service_amount_cents/100).toFixed(2)} partial refund. The provider share was adjusted to match.`,snapshot.openedBy,snapshot.againstUserId]);
    await client.query(`UPDATE bookings b SET payout_frozen_at=NULL,payout_frozen_by=NULL,payout_freeze_reason=NULL,
      payment_release_status=CASE WHEN stripe_transfer_id IS NOT NULL THEN CASE WHEN stripe_transfer_reversed_cents>=provider_payout_cents THEN 'reversed' ELSE 'partially_released' END
        WHEN payment_status='refunded' THEN 'reversed' WHEN status='completed' THEN 'awaiting_customer' ELSE 'secured' END,
      refund_failure_reason=CASE WHEN refund_failure_reason=$2 THEN NULL ELSE refund_failure_reason END
      WHERE id::text=$1 AND payout_freeze_reason='Open booking dispute'
        AND (stripe_dispute_status IS NULL OR stripe_dispute_status IN ('won','warning_closed'))
        AND NOT EXISTS (SELECT 1 FROM booking_disputes d WHERE d.booking_id=b.id AND d.status IN ('open','reviewing'))`,[op.booking_id,BOOKING_REFUND_RECONCILIATION]);
    await client.query("UPDATE booking_refund_operations SET decision_completed_at=now(),last_error=NULL WHERE id=$1::uuid",[op.id]);
    await client.query("COMMIT");
  } catch(error) {await client.query("ROLLBACK").catch(()=>undefined);throw error;}
  finally{client.release();}
}

function transferMatches(op: Operation, transfer: Stripe.Transfer) {
  return op.transfer_id === transfer.id && transfer.livemode === (op.stripe_mode === "live") && transfer.currency === op.currency
    && transfer.amount === op.provider_share_cents && idOf(transfer.destination) === op.connected_account_id
    && op.charge_id !== null && idOf(transfer.source_transaction) === op.charge_id
    && transfer.metadata?.bookingId === op.booking_id && transfer.metadata?.kind === "provider_payout"
    && Number.isSafeInteger(transfer.amount_reversed) && transfer.amount_reversed >= 0 && transfer.amount_reversed <= transfer.amount;
}

/** Matching cumulative evidence can prove recovery, but is never authorization
 * to create a refund or to resend an uncertain reversal. */
export async function observeBookingRefundTransfer(transfer: Stripe.Transfer, mode: Mode, finishDecision=true) {
  if (transfer.livemode !== (mode === "live")) return;
  const pending = await database.query<Operation>("SELECT * FROM booking_refund_operations WHERE transfer_id=$1 AND stripe_mode=$2 AND refund_confirmed_at IS NOT NULL AND recovery_completed_at IS NULL", [transfer.id,mode]);
  for (const op of pending.rows) {
    if (!transferMatches(op,transfer) || transfer.amount_reversed < op.reversal_target_cents) continue;
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM bookings WHERE id::text=$1 FOR UPDATE",[op.booking_id]);
      const locked = (await client.query<Operation>("SELECT * FROM booking_refund_operations WHERE id=$1::uuid FOR UPDATE",[op.id])).rows[0];
      if (!locked?.refund_confirmed_at || locked.recovery_completed_at) {await client.query("COMMIT");continue;}
      await client.query(`UPDATE bookings SET stripe_transfer_reversed_cents=GREATEST(stripe_transfer_reversed_cents,$3),
        payment_release_status=CASE WHEN GREATEST(stripe_transfer_reversed_cents,$3)>=provider_payout_cents THEN 'reversed'
          WHEN payout_frozen_at IS NOT NULL OR payout_freeze_reason IS NOT NULL THEN 'frozen' ELSE 'partially_released' END,
        payout_failure_reason=CASE WHEN payout_failure_reason IN ($4,'Stripe refund after provider payout requires transfer recovery review.')
          AND (GREATEST(stripe_transfer_reversed_cents,$3)>=provider_payout_cents
            OR (refunded_amount_cents=$6 AND customer_service_fee_refunded_cents=$7)) THEN NULL ELSE payout_failure_reason END
        WHERE id::text=$1 AND stripe_mode=$2 AND stripe_transfer_id=$5`,[op.booking_id,mode,transfer.amount_reversed,REFUND_RECOVERY_REVIEW,transfer.id,
          op.baseline_service_cents+op.service_amount_cents,op.baseline_fee_cents+op.fee_amount_cents]);
      await client.query(`INSERT INTO booking_events (booking_id,event_type,message,metadata)
        SELECT $1::uuid,'transfer_reversed',$2,jsonb_build_object('transferId',$3::text,'amountReversed',$4::integer)
        WHERE NOT EXISTS (SELECT 1 FROM booking_events WHERE booking_id=$1::uuid AND event_type='transfer_reversed'
          AND metadata->>'transferId'=$3 AND (metadata->>'amountReversed')::integer=$4::integer)`,
      [op.booking_id,transfer.amount_reversed>=transfer.amount ? "The provider transfer was fully reversed." : "The provider transfer was partially reversed.",transfer.id,transfer.amount_reversed]);
      await client.query("UPDATE booking_refund_operations SET recovery_completed_at=COALESCE(recovery_completed_at,now()),last_error=NULL WHERE id=$1::uuid",[op.id]);
      await client.query("COMMIT");
    } catch(error) { await client.query("ROLLBACK").catch(()=>undefined);throw error; }
    finally { client.release(); }
    if(finishDecision) await finalizeRefundDecision(op.id);
  }
}

async function recoverProviderTransfer(op: Operation) {
  if (op.settlement_issue_at || !op.refund_confirmed_at || !op.effects_completed_at || op.recovery_completed_at || !op.transfer_id || !op.reversal_target_cents) return;
  const transfer = await getStripe().transfers.retrieve(op.transfer_id);
  if (!transferMatches(op,transfer)) throw new Error("Refund transfer evidence does not match its authorization.");
  await observeBookingRefundTransfer(transfer,op.stripe_mode,false);
  if (transfer.amount_reversed >= op.reversal_target_cents || op.reversal_attempted_at) return;
  // A partial/manual recovery changed the approved snapshot. Do not guess the
  // residual amount or issue a different request under the same operation.
  if (transfer.amount_reversed !== op.baseline_reversed_cents) {
    await database.query("UPDATE booking_refund_operations SET last_error='Transfer changed before recovery; operator review required.' WHERE id=$1::uuid",[op.id]);
    return;
  }
  const amount = op.reversal_target_cents - op.baseline_reversed_cents;
  const claimed = await claimMoneyAttempt(op.booking_id,`UPDATE booking_refund_operations o SET reversal_attempted_at=now(),reversal_amount_cents=$2,last_error=$3
    FROM bookings b WHERE o.id=$1::uuid AND o.booking_id=b.id AND o.reversal_attempted_at IS NULL AND o.recovery_completed_at IS NULL
      AND o.refund_confirmed_at IS NOT NULL AND o.effects_completed_at IS NOT NULL AND o.settlement_issue_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM booking_refund_operations other WHERE other.booking_id=b.id AND other.settlement_issue_at IS NOT NULL)
      AND b.stripe_transfer_id=o.transfer_id AND b.stripe_mode=o.stripe_mode AND b.stripe_payment_intent_id=o.payment_intent_id
      AND b.stripe_transfer_reversed_cents=o.baseline_reversed_cents
      AND b.refunded_amount_cents=o.baseline_service_cents+o.service_amount_cents
      AND b.customer_service_fee_refunded_cents=o.baseline_fee_cents+o.fee_amount_cents
      AND (b.stripe_dispute_status IS NULL OR b.stripe_dispute_status IN ('won','warning_closed'))
      AND ((b.payout_frozen_at IS NULL AND b.payout_freeze_reason IS NULL)
        OR b.payout_freeze_reason IN ('Refund requested','Stripe refund requires payout reconciliation')
        OR (o.origin='dispute_partial' AND b.payout_freeze_reason='Open booking dispute'
          AND NOT EXISTS (SELECT 1 FROM booking_disputes d WHERE d.booking_id=b.id AND d.status IN ('open','reviewing') AND d.id::text IS DISTINCT FROM o.dispute_id)))
    RETURNING o.id`,[op.id,amount,REFUND_RECOVERY_REVIEW]);
  if (!claimed.rowCount) return;
  try {
    const reversal = await getStripe().transfers.createReversal(op.transfer_id,{amount,
      metadata:{bookingId:op.booking_id,kind:"refund_reversal",stripeRefundId:op.stripe_refund_id!,refundOperationId:op.id}},
    {idempotencyKey:`booking-refund-recovery-${op.stripe_mode}-${op.id}`,maxNetworkRetries:0});
    if (reversal.amount !== amount || idOf(reversal.transfer) !== op.transfer_id) throw new Error("Unexpected Stripe reversal response.");
    await database.query("UPDATE booking_refund_operations SET stripe_reversal_id=$2 WHERE id=$1::uuid AND (stripe_reversal_id IS NULL OR stripe_reversal_id=$2)",[op.id,reversal.id]);
    await observeBookingRefundTransfer(await getStripe().transfers.retrieve(op.transfer_id),op.stripe_mode,false);
  } catch(error) {
    // The durable attempted flag is intentionally never reset. A lost response,
    // approval_required, or expired idempotency window is not proof of failure.
    await database.query("UPDATE booking_refund_operations SET last_error=$2 WHERE id=$1::uuid AND recovery_completed_at IS NULL",[op.id,bookingRefundWarning(error)]);
  }
}

async function recordRefundSettlementIssue(op:Operation,refund:Stripe.Refund) {
  const client=await database.connect();
  try {
    await client.query("BEGIN");
    const booking=(await client.query<{customer_id:string;provider_user_id:string}>(`SELECT b.customer_id,p.user_id AS provider_user_id
      FROM bookings b JOIN provider_profiles p ON p.id=b.provider_id WHERE b.id::text=$1 FOR UPDATE OF b`,[op.booking_id])).rows[0];
    const issue=await client.query(`UPDATE booking_refund_operations SET settlement_issue_at=COALESCE(settlement_issue_at,now()),
      stripe_refund_status=$2,last_error=$3 WHERE id=$1::uuid AND refund_confirmed_at IS NOT NULL RETURNING id`,[op.id,refund.status,REFUND_SETTLEMENT_REVIEW]);
    if(!booking || !issue.rowCount) {await client.query("ROLLBACK");return;}
    // Preserve historical amount/reversal evidence. Reconciliation of returned
    // funds or alternative customer reimbursement is a separate operator action.
    await client.query(`UPDATE bookings SET refund_status='failed',refund_failure_reason=$2,
      payout_frozen_at=COALESCE(payout_frozen_at,now()),payout_freeze_reason=COALESCE(payout_freeze_reason,'Stripe refund settlement requires review'),
      payment_release_status=CASE WHEN stripe_transfer_id IS NULL THEN 'frozen' ELSE payment_release_status END
      WHERE id::text=$1`,[op.booking_id,REFUND_SETTLEMENT_REVIEW]);
    await client.query(`INSERT INTO booking_events (booking_id,event_type,message,metadata)
      SELECT $1::uuid,'refund_settlement_issue',$2,jsonb_build_object('stripeRefundId',$3::text,'refundOperationId',$4::text,'status',$5::text)
      WHERE NOT EXISTS (SELECT 1 FROM booking_events WHERE booking_id=$1::uuid AND event_type='refund_settlement_issue' AND metadata->>'stripeRefundId'=$3)`,
    [op.booking_id,REFUND_SETTLEMENT_REVIEW,refund.id,op.id,refund.status]);
    await client.query(`INSERT INTO notifications (user_id,booking_id,type,title,message,href,dedupe_key)
      VALUES ($1,$2::uuid,'refund_failed','Refund needs review',$3,'/account/bookings/' || $2::uuid::text,'refund-settlement-issue-customer-' || $4),
        ($5,$2::uuid,'refund_failed','Customer refund needs review',$3,'/provider/dashboard/bookings/' || $2::uuid::text,'refund-settlement-issue-provider-' || $4)
      ON CONFLICT (dedupe_key) DO NOTHING`,[booking.customer_id,op.booking_id,REFUND_SETTLEMENT_REVIEW,refund.id,booking.provider_user_id]);
    await client.query("COMMIT");
  } catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}
  finally{client.release();}
}

export async function observeBookingRefund(refund: Stripe.Refund, mode: Mode, finalize=true, authoritative=false) {
  if (mode !== getStripeMode()) return false;
  const operationId = refund.metadata?.refundOperationId;
  if (!operationId || !/^[0-9a-f-]{36}$/i.test(operationId)) return false;
  const op = await operation(operationId);
  // Refund objects have no livemode field. Mode comes from the verified event
  // envelope (or this environment's authenticated Stripe read), never metadata.
  if (!op || op.stripe_mode !== mode || refund.currency !== op.currency
    || refund.amount !== amountOf(op) || idOf(refund.payment_intent) !== op.payment_intent_id
    || (op.charge_id !== null && idOf(refund.charge) !== op.charge_id) || refund.metadata?.bookingId !== op.booking_id
    || (op.stripe_refund_id !== null && op.stripe_refund_id !== refund.id)) return false;
  // Card refunds can appear succeeded and fail later. Only a fresh Stripe read,
  // not an out-of-order event/API snapshot, can establish this review state.
  if(authoritative && op.refund_confirmed_at && refund.status !== 'succeeded') {
    await recordRefundSettlementIssue(op,refund);
    return true;
  }
  if(op.settlement_issue_at) return true; // Never auto-release a returned-refund hold.
  const recorded = await database.query<Operation>(`UPDATE booking_refund_operations SET stripe_refund_id=$2,
    stripe_refund_status=CASE WHEN refund_confirmed_at IS NOT NULL THEN 'succeeded' ELSE $3 END,
    refund_confirmed_at=CASE WHEN $3='succeeded' THEN COALESCE(refund_confirmed_at,now()) ELSE refund_confirmed_at END
    WHERE id=$1::uuid AND settlement_issue_at IS NULL AND (stripe_refund_id IS NULL OR stripe_refund_id=$2) RETURNING *`,[op.id,refund.id,refund.status]);
  const confirmed = recorded.rows[0];
  if (confirmed?.refund_confirmed_at && finalize) {
    await finalizeRefund(confirmed);
    await recoverProviderTransfer((await operation(op.id))!);
    await finalizeRefundDecision(op.id);
  } else if(!confirmed?.refund_confirmed_at) await recordPendingBookingRefund(op.booking_id,BOOKING_REFUND_RECONCILIATION,refund.id);
  return true;
}

export async function submitBookingRefundOperation(operationId: string) {
  const op = await operation(operationId);
  if (!op || op.stripe_mode !== getStripeMode()) throw new Error("Refund operation environment mismatch.");
  const claimed = await claimMoneyAttempt(op.booking_id,`UPDATE booking_refund_operations o SET refund_attempted_at=now()
    FROM bookings b WHERE o.id=$1::uuid AND b.id=o.booking_id AND o.refund_attempted_at IS NULL AND o.stripe_refund_id IS NULL
      AND o.refund_confirmed_at IS NULL AND o.effects_completed_at IS NULL AND o.settlement_issue_at IS NULL
      AND b.stripe_mode=o.stripe_mode AND b.stripe_payment_intent_id=o.payment_intent_id
      AND b.stripe_transfer_id IS NOT DISTINCT FROM o.transfer_id
      AND b.refunded_amount_cents=o.baseline_service_cents AND b.customer_service_fee_refunded_cents=o.baseline_fee_cents
      AND b.refund_status='processing'
      AND NOT EXISTS (SELECT 1 FROM booking_refund_operations other WHERE other.booking_id=b.id AND other.settlement_issue_at IS NOT NULL)
    RETURNING o.id`,[op.id]);
  if (claimed.rowCount) {
    try {
      const refund = await getStripe().refunds.create({payment_intent:op.payment_intent_id,amount:amountOf(op),
        ...(op.payment_flow !== "held_transfer_v1" ? {reverse_transfer:true}:{}),
        ...(op.refund_application_fee ? {refund_application_fee:true}:{}),
        metadata:{bookingId:op.booking_id,refundOperationId:op.id,kind:op.origin === "automatic" ? "held_payment_refund" : op.origin === "dispute_partial" ? "dispute_partial_refund" : "booking_refund",
          ...(op.actor_user_id ? {approvedBy:op.actor_user_id}:{}),...(op.dispute_id ? {disputeId:op.dispute_id}:{})}},
      {idempotencyKey:`booking-refund-${op.booking_id}-total-${op.baseline_service_cents+op.baseline_fee_cents+amountOf(op)}`,maxNetworkRetries:0});
      await observeBookingRefund(refund,op.stripe_mode);
    } catch(error) {
      const warning=bookingRefundWarning(error);
      await database.query("UPDATE booking_refund_operations SET last_error=$2 WHERE id=$1::uuid AND (effects_completed_at IS NULL OR recovery_completed_at IS NULL OR (dispute_id IS NOT NULL AND decision_completed_at IS NULL))",[op.id,warning]);
      await recordPendingBookingRefund(op.booking_id,warning);
    }
  }
  return bookingRefundOperationResult(op.id);
}

export async function bookingRefundOperationResult(operationId: string) {
  const current = (await operation(operationId))!;
  const op=current;
  const booking=(await database.query<{refunded_amount_cents:number;customer_service_fee_refunded_cents:number;stripe_payment_intent_id:string;settlement_review:boolean}>(
    `SELECT refunded_amount_cents,customer_service_fee_refunded_cents,stripe_payment_intent_id,
      EXISTS(SELECT 1 FROM booking_refund_operations o WHERE o.booking_id=b.id AND o.settlement_issue_at IS NOT NULL) AS settlement_review
      FROM bookings b WHERE id::text=$1`,[op.booking_id])).rows[0];
  const newer=!booking || booking.stripe_payment_intent_id!==op.payment_intent_id
    || booking.refunded_amount_cents>op.baseline_service_cents+op.service_amount_cents
    || booking.customer_service_fee_refunded_cents>op.baseline_fee_cents+op.fee_amount_cents;
  const refunded=Boolean(current.refund_confirmed_at && current.effects_completed_at);
  const recoveryNeedsReview=refunded && (Boolean(booking?.settlement_review) || newer || !current.recovery_completed_at || Boolean(current.last_error)
    || (current.dispute_id !== null && !current.decision_completed_at));
  return {ok:refunded && !recoveryNeedsReview,refunded,amount:amountOf(op),recoveryNeedsReview,pending:!refunded || recoveryNeedsReview,
    error:booking?.settlement_review ? REFUND_SETTLEMENT_REVIEW : newer ? "Stripe confirmed this refund, but newer payment activity requires review. Do not issue another refund."
      : recoveryNeedsReview ? REFUND_RECOVERY_REVIEW : !refunded ? BOOKING_REFUND_RECONCILIATION : undefined};
}

export async function bookingDisputeRefundOperation(bookingId:string,disputeId:string,mode:Mode) {
  return (await database.query<Operation>("SELECT * FROM booking_refund_operations WHERE booking_id=$1::uuid AND dispute_id=$2 AND stripe_mode=$3",[bookingId,disputeId,mode])).rows[0];
}

export async function bookingRefundSettlementPending(paymentIntentId:string,mode:Mode) {
  return Boolean((await database.query(`SELECT id FROM booking_refund_operations
    WHERE payment_intent_id=$1 AND stripe_mode=$2 AND refund_confirmed_at IS NULL LIMIT 1`,[paymentIntentId,mode])).rows.length);
}

/** Read Stripe evidence; never re-submit a refund or an attempted reversal. */
export async function reconcileBookingRefundsForPayment(paymentIntentId: string, mode: Mode, finalize=true) {
  if (mode !== getStripeMode()) return;
  const pending = await database.query<Operation>("SELECT * FROM booking_refund_operations WHERE payment_intent_id=$1 AND stripe_mode=$2 AND (settlement_issue_at IS NOT NULL OR effects_completed_at IS NULL OR recovery_completed_at IS NULL OR (dispute_id IS NOT NULL AND decision_completed_at IS NULL))",[paymentIntentId,mode]);
  if (!pending.rows.length) return;
  for (const op of pending.rows) {
    if (op.stripe_refund_id) await observeBookingRefund(await getStripe().refunds.retrieve(op.stripe_refund_id),mode,finalize,true);
    else {
      // Pagination is deliberately bounded. Absence never permits a resend.
      let after: string | undefined;
      for(let page=0;page<10;page++) {
        const refunds=await getStripe().refunds.list({payment_intent:paymentIntentId,limit:100,...(after ? {starting_after:after}:{})});
        const matching=refunds.data.find(refund=>refund.metadata?.refundOperationId===op.id);
        if(matching) {await observeBookingRefund(matching,mode,finalize,true);break;}
        if(!refunds.has_more || !refunds.data.length) break;
        after=refunds.data.at(-1)!.id;
      }
    }
  }
}

export async function reconcilePendingBookingRefunds(mode: Mode,limit=50) {
  const pending=await database.query<{payment_intent_id:string}>(`WITH candidates AS (
    SELECT id FROM booking_refund_operations
    WHERE stripe_mode=$1 AND (settlement_issue_at IS NOT NULL OR effects_completed_at IS NULL OR recovery_completed_at IS NULL OR (dispute_id IS NOT NULL AND decision_completed_at IS NULL))
    ORDER BY last_checked_at NULLS FIRST,created_at,id LIMIT $2 FOR UPDATE SKIP LOCKED
  ) UPDATE booking_refund_operations o SET last_checked_at=now()
    FROM candidates c WHERE o.id=c.id RETURNING o.payment_intent_id`,[mode,limit]);
  const failed:string[]=[];
  for(const row of pending.rows) {
    try {await reconcileBookingRefundsForPayment(row.payment_intent_id,mode);}
    catch {failed.push(row.payment_intent_id);}
  }
  const needsReview=(await database.query<{count:number}>(`SELECT count(*)::int AS count FROM booking_refund_operations
    WHERE stripe_mode=$1 AND (settlement_issue_at IS NOT NULL OR last_error IS NOT NULL
      OR stripe_refund_status IN ('failed','canceled')
      OR (refund_attempted_at IS NULL AND created_at<now()-interval '5 minutes'))`,[mode])).rows[0]?.count ?? 0;
  return {eligible:pending.rows.length,failed,needsReview};
}
