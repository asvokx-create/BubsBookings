import Link from "next/link";

export default function UnavailableListing({ ownerStatus }: {
  ownerStatus?: { reasons: string[]; ageDetail: string | null };
}) {
  return <main className="min-h-screen bg-[#f8f7f3] px-4 py-16 text-[#183126]">
    <section className="mx-auto max-w-xl rounded-3xl border border-[#183126]/10 bg-white p-6 sm:p-10">
      <p className="text-sm font-bold uppercase tracking-wider text-[#5b6d64]">BubsBookings</p>
      <h1 className="mt-4 text-3xl font-bold">{ownerStatus ? "Your listing isn’t public yet" : "This listing isn’t available"}</h1>
      {ownerStatus ? <>
        <p className="mt-4 leading-7">Only you can see these details. Customers cannot view or book this listing until it is public.</p>
        <ul className="mt-4 list-disc space-y-2 pl-5">{ownerStatus.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
        {ownerStatus.ageDetail && <p className="mt-4 leading-7">{ownerStatus.ageDetail}</p>}
        <p className="mt-4 leading-7">Wait until your dashboard shows the listing is public before sharing its link or QR code.</p>
        <div className="mt-6 flex flex-wrap gap-3">
          {ownerStatus.ageDetail && <Link className="inline-flex min-h-12 items-center rounded-full bg-[#eee34d] px-5 font-bold" href="/provider/dashboard/billing#provider-eligibility">Review age verification</Link>}
          <Link className="inline-flex min-h-12 items-center rounded-full border px-5 font-bold" href="/provider/dashboard">Open dashboard</Link>
        </div>
      </> : <>
        <p className="mt-4 leading-7">This link may be incorrect, or the listing may not currently be public. You can browse other services below.</p>
        <p className="mt-4 leading-7">If this is your listing, sign in to your provider account and reopen this link to see what needs attention.</p>
        <div className="mt-6 flex flex-wrap gap-3"><Link className="inline-flex min-h-12 items-center rounded-full bg-[#eee34d] px-5 font-bold" href="/">Browse services</Link><Link className="inline-flex min-h-12 items-center rounded-full border px-5 font-bold" href="/login">Sign in</Link></div>
      </>}
    </section>
  </main>;
}
