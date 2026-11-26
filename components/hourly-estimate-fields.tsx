import { MAX_HOURLY_ESTIMATE_MINUTES } from "@/lib/hourly-listing-estimate";

export default function HourlyEstimateFields({ shorter, longer, onShorter, onLonger, inputClass }: {
  shorter: string; longer: string; onShorter: (value: string) => void; onLonger: (value: string) => void; inputClass: string;
}) {
  return <fieldset className="mt-4 rounded-2xl border border-[#183126]/10 p-4">
    <legend className="px-2 text-sm font-bold">Estimated work duration (optional)</legend>
    <p className="text-sm leading-6">Give customers a rough idea of the time and estimated labor cost. Leave both blank if it varies too much. This is not a minimum or maximum purchase, or a guaranteed price.</p>
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      <label className="block text-sm font-bold">Shortest estimate (minutes)<input type="number" min={1} max={MAX_HOURLY_ESTIMATE_MINUTES} step={1} value={shorter} onChange={event => onShorter(event.target.value)} className={`${inputClass} mt-2`} placeholder="e.g. 60" /></label>
      <label className="block text-sm font-bold">Longest estimate (minutes)<input type="number" min={1} max={MAX_HOURLY_ESTIMATE_MINUTES} step={1} value={longer} onChange={event => onLonger(event.target.value)} className={`${inputClass} mt-2`} placeholder="e.g. 120" /></label>
    </div>
    <p className="mt-2 text-xs leading-5 text-[#718078]">For example, 60–120 minutes represents 1–2 hours. Customers still choose their own approved work limit and pay for actual approved tracked time.</p>
  </fieldset>;
}
