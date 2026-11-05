import BrandLockup from "@/components/brand-lockup";
import Link from "next/link";

export default function NotFoundPage() {
  return (
    <main className="relative grid min-h-[78vh] place-items-center overflow-hidden bg-[#f8f7f3] px-5 py-16 text-[#183126]">
      <div aria-hidden="true" className="absolute -right-40 -top-40 h-[34rem] w-[34rem] rounded-full bg-[#d9ead4] blur-3xl" />
      <section className="relative w-full max-w-2xl rounded-[2.25rem] border border-[#183126]/10 bg-white/90 p-7 text-center shadow-[0_28px_90px_rgba(19,46,35,.14)] backdrop-blur-xl sm:p-12">
        <Link href="/" aria-label="BubsBookings home" className="inline-flex"><BrandLockup priority /></Link>
        <p className="mt-9 text-xs font-extrabold uppercase tracking-[.18em] text-[#718078]">Page not found · 404</p>
        <h1 className="mt-3 text-4xl font-bold tracking-[-.05em] sm:text-5xl">This page wandered off.</h1>
        <p className="mx-auto mt-5 max-w-lg text-base leading-7 text-[#63746b]">The link may be old, or the page may have moved. You can head home or keep browsing local services.</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link href="/services" className="rounded-full bg-[#eee25a] px-6 py-3.5 text-sm font-bold text-[#183126]">Find services</Link>
          <Link href="/" className="rounded-full border border-[#183126]/12 bg-white px-6 py-3.5 text-sm font-bold">Back home</Link>
        </div>
      </section>
    </main>
  );
}
