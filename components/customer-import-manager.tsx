"use client";

import { useState } from "react";
import ManualClientForm from "@/components/manual-client-form";
import CustomSelect from "@/components/custom-select";

const fields: Record<string, string> = {
  firstName: "First name",
  lastName: "Last name",
  fullName: "Full name",
  email: "Email",
  phone: "Phone",
  serviceHistory: "Service history",
  notes: "Notes",
  lastServiceDate: "Last service date",
  marketingConsent: "Marketing consent",
};

type ImportSummary = { valid?: number; invalid?: number; duplicates?: number };
type ImportPreview = { summary?: ImportSummary };
type ImportResult = { added?: number; updated?: number; skipped?: number };
type ImportedCustomer = { id: string; full_name?: string | null; email?: string | null; phone?: string | null };
type CustomerListResponse = { customers?: ImportedCustomer[]; error?: string };
type ColumnResponse = { headers?: string[]; mapping?: Record<string, string>; error?: string };
type ImportResponse = ImportPreview & ImportResult & { error?: string };

function responseError(response: unknown, fallback: string) {
  return typeof response === "object" && response !== null && "error" in response && typeof response.error === "string"
    ? response.error
    : fallback;
}

export default function CustomerImportManager({ search }: { search: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [step, setStep] = useState(1);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [data, setData] = useState<ImportPreview | { result: ImportResult } | null>(null);
  const [rows, setRows] = useState<ImportedCustomer[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshingCustomers, setRefreshingCustomers] = useState(false);
  const [lawful, setLawful] = useState(false);
  const [consent, setConsent] = useState(false);
  const [mode, setMode] = useState("skip");

  async function loadCustomers() {
    setRefreshingCustomers(true);
    try {
      const response = await fetch(`/api/providers/customer-imports?search=${encodeURIComponent(search)}`);
      const result = await response.json().catch((): CustomerListResponse | null => null);
      if (response.ok) setRows(result?.customers ?? []);
      else setError(responseError(result, "Imported contacts could not be loaded."));
    } catch {
      setError("Imported contacts could not be loaded. Please check your connection and try again.");
    } finally {
      setRefreshingCustomers(false);
    }
  }

  async function send(action: "columns" | "preview" | "import") {
    if (!file) return;
    setBusy(true);
    setError("");
    const form = new FormData();
    form.set("file", file);
    form.set("action", action);
    form.set("mapping", JSON.stringify(mapping));
    form.set("lawfulBasis", String(lawful));
    form.set("consentEvidence", String(consent));
    form.set("duplicateMode", mode);

    try {
      const response = await fetch("/api/providers/customer-imports", { method: "POST", body: form });
      const result = await response.json().catch((): ImportResponse | ColumnResponse | null => null);
      if (!response.ok || !result) {
        setError(responseError(result, "Import failed."));
        return;
      }
      if (action === "columns") {
        const columns = result as ColumnResponse;
        setHeaders(columns.headers ?? []);
        setMapping(columns.mapping ?? {});
        setStep(2);
      } else if (action === "preview") {
        setData(result as ImportPreview);
        setStep(3);
      } else {
        setData({ result: result as ImportResult });
        setStep(4);
        void loadCustomers();
      }
    } catch {
      setError("Import failed. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteImportedCustomer(customer: ImportedCustomer) {
    const label = customer.full_name ?? customer.email ?? customer.phone ?? "this imported customer";
    if (!window.confirm(`Delete ${label}? This removes the imported record from your provider workspace.`)) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/providers/customer-imports", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: customer.id }),
      });
      const result = await response.json().catch((): CustomerListResponse | null => null);
      if (!response.ok) {
        setError(responseError(result, "Imported customer could not be deleted."));
        return;
      }
      setRows((current) => current.filter((row) => row.id !== customer.id));
    } catch {
      setError("Imported customer could not be deleted. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const preview = data && "summary" in data ? data : null;
  const importResult = data && "result" in data ? data.result : null;

  return <section className="rounded-[2rem] border bg-white p-5">
    <ManualClientForm onSaved={() => void loadCustomers()} />
    <h2 className="text-xl font-bold">Import customers</h2>
    <p className="mt-2 text-sm">CSV or XLSX, up to 2 MB / 5,000 rows. No accounts, invitations, or marketing are created.</p>
    <a className="mt-3 inline-block text-sm underline" download="customer-template.csv" href="data:text/csv,First name,Last name,Email,Phone%0AJane,Doe,jane@example.com,4255550100">Download CSV template</a>
    {error && <p role="alert">{error}</p>}
    {step === 1 && <div className="mt-4"><input type="file" accept=".csv,.xlsx" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /><button disabled={!file || busy} onClick={() => void send("columns")} className="ml-3 rounded-full bg-[#183126] px-4 py-3 text-white">Upload and match columns</button></div>}
    {step === 2 && <div className="mt-4 grid gap-2 sm:grid-cols-2">{Object.entries(fields).map(([key, label]) => <label key={key}>{label}<CustomSelect ariaLabel={`${label} column`} value={mapping[key] ?? ""} onChange={(value) => setMapping((current) => ({ ...current, [key]: value }))} buttonClassName="mt-1 min-h-11 w-full rounded-xl border bg-white px-3 text-sm"><option value="">Do not import</option>{headers.map((header) => <option key={header} value={header}>{header}</option>)}</CustomSelect></label>)}<button onClick={() => void send("preview")} disabled={busy} className="rounded-full bg-[#183126] px-4 py-3 text-white">Preview</button></div>}
    {step === 3 && <div className="mt-4"><p>{preview?.summary?.valid ?? 0} ready · {preview?.summary?.invalid ?? 0} invalid · {preview?.summary?.duplicates ?? 0} duplicates</p><label><input type="checkbox" checked={lawful} onChange={(event) => setLawful(event.target.checked)} /> I have a lawful basis to import these records.</label><label><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /> I have documented consent evidence where marked.</label><CustomSelect ariaLabel="Duplicate handling" value={mode} onChange={setMode} buttonClassName="min-h-11 rounded-xl border bg-white px-3 text-sm"><option value="skip">Skip existing contacts</option><option value="update">Update existing contacts</option></CustomSelect><button disabled={!lawful || busy} onClick={() => void send("import")} className="ml-3 rounded-full bg-[#eee25a] px-4 py-3">Confirm import</button></div>}
    {step === 4 && <p className="mt-4">{importResult?.added ?? 0} imported, {importResult?.updated ?? 0} updated, {importResult?.skipped ?? 0} skipped.</p>}
    <div className="mt-5 border-t pt-4"><div className="flex flex-wrap gap-3"><a className="text-sm underline" href="/api/providers/customer-imports?export=csv">Export my contacts</a><button type="button" disabled={refreshingCustomers} onClick={() => void loadCustomers()} className="text-sm underline disabled:opacity-50">{refreshingCustomers ? "Refreshing contacts…" : "Show saved contacts"}</button></div>{rows.map((row) => <div key={row.id} className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#183126]/10 bg-[#fafaf6] px-3 py-2 text-sm"><p>{row.full_name ?? row.email ?? row.phone} · {row.email ?? "No email"} · {row.phone ?? "No phone"}</p><button type="button" disabled={busy} onClick={() => void deleteImportedCustomer(row)} className="rounded-full px-3 py-1.5 font-bold text-[#9a4e25] hover:bg-[#fff0e8] disabled:opacity-50">Delete</button></div>)}</div>
  </section>;
}
