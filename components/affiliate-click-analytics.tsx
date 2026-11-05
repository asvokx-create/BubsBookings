"use client";

import { FormEvent, useEffect, useState } from "react";
import DatePicker from "@/components/date-picker";

type Row = {
  id: string; display_name: string; affiliate_code: string | null; status: string;
  total_clicks: number; clicks_7d: number; clicks_30d: number; range_clicks: number;
  total_first_touch_visits: number; range_first_touch_visits: number;
  referred_registrations: number; range_registrations: number; published_providers: number;
  signup_conversion_rate: string | null; range_conversion_rate: string | null;
};
type Trend = { period: string; clicks: number };
type Detail = { summary: Row & { clicks: number; first_touch_visits: number; signups: number; active_referred_providers: number; earnings_cents: number; pending_cents: number; payable_cents: number; paid_cents: number; conversion_rate: string | null }; daily: Trend[]; weekly: Trend[]; monthly: Trend[] };
type AnalyticsData = {
  window: { range: string; start: string | null; end: string | null; label: string; timezone: string };
  affiliates: Row[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  detail: Detail | null;
};

const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value / 100);
const percent = (value: string | null) => value === null ? "Not available" : `${value}%`;

export default function AffiliateClickAnalytics() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [range, setRange] = useState("30d");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [appliedCustom, setAppliedCustom] = useState<{ start: string; end: string } | null>(null);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [selected, setSelected] = useState("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (range === "custom" && !appliedCustom) return;
    let active = true;
    const params = new URLSearchParams({ range, page: String(page) });
    if (appliedSearch) params.set("search", appliedSearch);
    if (selected) params.set("affiliateId", selected);
    if (range === "custom" && appliedCustom) { params.set("start", appliedCustom.start); params.set("end", appliedCustom.end); }
    fetch(`/api/admin/affiliates/analytics?${params}`, { cache: "no-store" })
      .then(async response => ({ response, result: await response.json() as AnalyticsData & { error?: string } }))
      .then(({ response, result }) => {
        if (!active) return;
        if (!response.ok) setError(result.error ?? "Affiliate analytics could not be loaded.");
        else { setData(result); setError(""); }
      })
      .catch(() => { if (active) setError("Affiliate analytics could not be loaded. Please try again."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [appliedCustom, appliedSearch, page, range, selected]);
  function submitSearch(event: FormEvent) { event.preventDefault(); setLoading(true); setPage(1); setAppliedSearch(search.trim()); }
  function chooseRange(value: string) { setLoading(value !== "custom"); setRange(value); setPage(1); if (value !== "custom") setAppliedCustom(null); }
  function chooseAffiliate(id: string) { setLoading(true); setSelected(id); }
  const maxDaily = Math.max(1, ...(data?.detail?.daily.map((item) => item.clicks) ?? [1]));

  return <section className="mt-7 rounded-[1.75rem] border border-[#183126]/10 bg-white p-5" aria-labelledby="affiliate-click-analytics-heading">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[.14em] text-[#687970]">Referral performance</p><h2 id="affiliate-click-analytics-heading" className="mt-1 text-2xl font-bold">Affiliate click analytics</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-[#687970]">Referral-link clicks count every valid visit that reaches BubsBookings, including repeat visits. First-touch visits remain separate and are used for provider attribution.</p></div><span className="rounded-full bg-[#edf3e7] px-3 py-2 text-xs font-bold">Times shown in UTC</span></div>
    <div className="mt-5 flex flex-wrap gap-2" aria-label="Affiliate analytics date range">{[["7d","Last 7 days"],["30d","Last 30 days"],["90d","Last 90 days"],["all","All time"],["custom","Custom"]].map(([value,label])=><button key={value} type="button" onClick={()=>chooseRange(value)} className={`min-h-11 rounded-full px-4 py-2 text-xs font-bold ${range===value?"bg-[#183126] text-white":"border border-[#183126]/15 bg-[#f8f8f4]"}`}>{label}</button>)}</div>
    {range==="custom"?<div className="mt-3 flex flex-wrap items-end gap-3"><label className="w-full text-xs font-bold sm:w-52">Start date<DatePicker value={customStart} onChange={setCustomStart} ariaLabel="Affiliate analytics start date" className="mt-1" buttonClassName="bg-white" clearable/></label><label className="w-full text-xs font-bold sm:w-52">End date<DatePicker value={customEnd} onChange={setCustomEnd} ariaLabel="Affiliate analytics end date" className="mt-1" buttonClassName="bg-white" clearable/></label><button type="button" disabled={!customStart||!customEnd} onClick={()=>{setLoading(true);setPage(1);setAppliedCustom({start:customStart,end:customEnd});}} className="min-h-11 rounded-full bg-[#183126] px-5 text-sm font-bold text-white disabled:opacity-50">Apply dates</button><p className="text-xs text-[#687970]">Custom ranges support up to 366 days.</p></div>:null}
    <form onSubmit={submitSearch} className="mt-5 flex flex-col gap-2 sm:flex-row"><label className="sr-only" htmlFor="affiliate-analytics-search">Search affiliates</label><input id="affiliate-analytics-search" value={search} onChange={event=>setSearch(event.target.value)} maxLength={100} className="min-h-11 flex-1 rounded-xl border border-[#183126]/15 px-4" placeholder="Search affiliate name or referral code"/><button className="min-h-11 rounded-full bg-[#eee25a] px-5 text-sm font-bold">Search</button></form>
    {error?<p role="alert" className="mt-4 rounded-xl bg-[#fff0e7] p-3 text-sm font-bold text-[#9a4e25]">{error}</p>:null}
    {loading&&!data?<p className="mt-5 text-sm text-[#687970]">Loading affiliate analytics...</p>:null}
    {data?<><div className="mt-5 overflow-x-auto"><table className="min-w-[82rem] w-full text-left text-sm"><thead><tr className="border-b text-xs uppercase tracking-wider text-[#687970]"><th className="p-3">Affiliate</th><th className="p-3">Referral code</th><th className="p-3">Total referral clicks</th><th className="p-3">7 days</th><th className="p-3">30 days</th><th className="p-3">{data.window.label}</th><th className="p-3">First-touch visits</th><th className="p-3">Registrations</th><th className="p-3">Published providers</th><th className="p-3">First-touch signup conversion</th><th className="p-3">Details</th></tr></thead><tbody>{data.affiliates.map(item=><tr key={item.id} className="border-b border-[#183126]/10"><td className="p-3 font-bold">{item.display_name}</td><td className="p-3 font-mono text-xs">{item.affiliate_code||"Not assigned"}</td><td className="p-3">{item.total_clicks}</td><td className="p-3">{item.clicks_7d}</td><td className="p-3">{item.clicks_30d}</td><td className="p-3 font-bold">{item.range_clicks}</td><td className="p-3">{item.range_first_touch_visits}</td><td className="p-3">{item.referred_registrations}</td><td className="p-3">{item.published_providers}</td><td className="p-3">{percent(item.range_conversion_rate)}</td><td className="p-3"><button type="button" onClick={()=>chooseAffiliate(item.id)} className="min-h-10 rounded-full border border-[#183126]/15 px-4 text-xs font-bold">View performance</button></td></tr>)}</tbody></table></div>{!data.affiliates.length?<p className="mt-5 text-sm text-[#687970]">No affiliates match this search.</p>:null}
      <div className="mt-4 flex items-center justify-between gap-3"><p className="text-xs text-[#687970]">Page {data.pagination.page} of {data.pagination.totalPages} · {data.pagination.total} affiliates</p><div className="flex gap-2"><button type="button" disabled={page<=1||loading} onClick={()=>{setLoading(true);setPage(value=>value-1);}} className="min-h-10 rounded-full border px-4 text-xs font-bold disabled:opacity-40">Previous</button><button type="button" disabled={page>=data.pagination.totalPages||loading} onClick={()=>{setLoading(true);setPage(value=>value+1);}} className="min-h-10 rounded-full border px-4 text-xs font-bold disabled:opacity-40">Next</button></div></div>
    </>:null}
    {data?.detail?<section className="mt-6 rounded-2xl bg-[#f8f8f4] p-4" aria-labelledby="affiliate-performance-detail"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 id="affiliate-performance-detail" className="text-xl font-bold">{data.detail.summary.display_name}</h3><p className="mt-1 text-xs text-[#687970]">Code {data.detail.summary.affiliate_code||"not assigned"} · {data.window.label}</p></div><button type="button" onClick={()=>{setLoading(true);setSelected("");}} className="min-h-10 rounded-full border bg-white px-4 text-xs font-bold">Close details</button></div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">{[["Referral-link clicks",data.detail.summary.clicks],["First-touch visits",data.detail.summary.first_touch_visits],["Provider signups",data.detail.summary.signups],["Active referred providers",data.detail.summary.active_referred_providers],["Published providers",data.detail.summary.published_providers],["First-touch signup conversion",percent(data.detail.summary.conversion_rate)],["Commission earnings",money(data.detail.summary.earnings_cents)],["Pending commissions",money(data.detail.summary.pending_cents)],["Payable commissions",money(data.detail.summary.payable_cents)],["Paid commissions",money(data.detail.summary.paid_cents)]].map(([name,value])=><article key={String(name)} className="rounded-xl bg-white p-3"><p className="text-[10px] font-bold uppercase tracking-wider text-[#718078]">{name}</p><p className="mt-1 text-xl font-bold">{value}</p></article>)}</div>
      <div className="mt-5"><h4 className="font-bold">Daily referral-link activity</h4>{data.detail.daily.length?<div className="mt-3 grid gap-2">{data.detail.daily.map(item=><div key={item.period} className="grid grid-cols-[6.5rem_1fr_2.5rem] items-center gap-3 text-xs"><span>{item.period}</span><span className="h-3 overflow-hidden rounded-full bg-[#dfe6dc]"><span className="block h-full rounded-full bg-[#4d725d]" style={{width:`${Math.max(4,item.clicks/maxDaily*100)}%`}}/></span><strong className="text-right">{item.clicks}</strong></div>)}</div>:<p className="mt-2 text-sm text-[#687970]">No referral-link clicks were recorded in this date range.</p>}</div>
      <div className="mt-5 grid gap-4 lg:grid-cols-2"><TrendList title="Weekly trend" rows={data.detail.weekly}/><TrendList title="Monthly trend" rows={data.detail.monthly}/></div>
    </section>:null}
  </section>;
}

function TrendList({ title, rows }: { title: string; rows: Trend[] }) {
  return <section className="rounded-xl bg-white p-4"><h4 className="font-bold">{title}</h4><div className="mt-3 grid gap-2">{rows.length?rows.map(item=><div key={item.period} className="flex justify-between gap-3 text-sm"><span>{item.period}</span><strong>{item.clicks} visits</strong></div>):<p className="text-sm text-[#687970]">No activity in this range.</p>}</div></section>;
}
