"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowLeft, Mail, Search, Copy, CheckCircle2, XCircle, AlertCircle,
  HelpCircle, Loader2, ChevronDown, ChevronUp, ShieldCheck, Building2,
  User, Terminal, Zap, Eye, EyeOff,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { EmailVerifyResult, EngineStep } from "@/app/api/verify-email/route";
import type { FindEmailResult } from "@/app/api/find-email/route";

// ─── Color tokens ─────────────────────────────────────────────────────────────
// Palette: slate-950 bg / slate-900 cards / cyan accent / emerald pass / rose fail / amber warn

function ScoreRing({ score }: { score: number }) {
  const r = 38;
  const circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;
  const color = score >= 80 ? "#34d399" : score >= 60 ? "#fbbf24" : score >= 35 ? "#fb923c" : "#f87171";
  const glow = score >= 80 ? "drop-shadow(0 0 8px #34d39966)" : "";
  return (
    <div className="relative flex items-center justify-center" style={{ width: 100, height: 100 }}>
      <svg width="100" height="100" viewBox="0 0 100 100" style={{ filter: glow }}>
        <circle cx="50" cy="50" r={r} fill="none" stroke="#1e293b" strokeWidth="9" />
        <circle cx="50" cy="50" r={r} fill="none" stroke={color} strokeWidth="9"
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
          transform="rotate(-90 50 50)" style={{ transition: "stroke-dasharray 0.7s cubic-bezier(.4,0,.2,1)" }} />
      </svg>
      <div className="absolute flex flex-col items-center gap-0">
        <span className="text-2xl font-extrabold text-white leading-none">{score}</span>
        <span className="text-[10px] text-slate-500 leading-none">/ 100</span>
      </div>
    </div>
  );
}

const STATUS_CFG = {
  active:   { label: "Active",        dot: "bg-emerald-400", pill: "bg-emerald-400/10 text-emerald-400 border-emerald-400/20" },
  likely:   { label: "Likely Active", dot: "bg-amber-400",   pill: "bg-amber-400/10   text-amber-400   border-amber-400/20"   },
  risky:    { label: "Risky",         dot: "bg-orange-400",  pill: "bg-orange-400/10  text-orange-400  border-orange-400/20"  },
  inactive: { label: "Inactive",      dot: "bg-rose-400",    pill: "bg-rose-400/10    text-rose-400    border-rose-400/20"    },
  unknown:  { label: "Unknown",       dot: "bg-slate-500",   pill: "bg-slate-700/40   text-slate-400   border-slate-700"      },
} as const;

function StatusPill({ status }: { status: keyof typeof STATUS_CFG }) {
  const c = STATUS_CFG[status] ?? STATUS_CFG.unknown;
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold", c.pill)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", c.dot)} />
      {c.label}
    </span>
  );
}

function ConfChip({ level }: { level: "high" | "medium" | "low" }) {
  return (
    <span className={cn("inline-flex rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-widest",
      level === "high"   && "bg-emerald-400/10 text-emerald-400",
      level === "medium" && "bg-amber-400/10   text-amber-400",
      level === "low"    && "bg-slate-700/50   text-slate-500")}>
      {level}
    </span>
  );
}

function CopyBtn({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button onClick={() => { void navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1800); }}
      className="rounded p-1 text-slate-600 transition-colors hover:text-slate-200" title="Copy">
      {ok ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

function RecipientTag({ v }: { v: "yes" | "catch-all" | "no" | "unknown" }) {
  if (v === "yes")       return <span className="text-[10px] font-semibold text-emerald-400 bg-emerald-400/10 rounded px-1.5 py-0.5">Accepting ✓</span>;
  if (v === "catch-all") return <span className="text-[10px] font-semibold text-amber-400   bg-amber-400/10   rounded px-1.5 py-0.5">Catch-all</span>;
  if (v === "no")        return <span className="text-[10px] font-semibold text-rose-400    bg-rose-400/10    rounded px-1.5 py-0.5">Rejected ✗</span>;
  return <span className="text-[10px] font-semibold text-slate-500 bg-slate-800 rounded px-1.5 py-0.5">Unknown</span>;
}

// ─── Engine step icon ─────────────────────────────────────────────────────────
function StepIcon({ s }: { s: EngineStep["status"] }) {
  if (s === "pass")    return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />;
  if (s === "fail")    return <XCircle      className="h-4 w-4 shrink-0 text-rose-400" />;
  if (s === "warn")    return <AlertCircle  className="h-4 w-4 shrink-0 text-amber-400" />;
  if (s === "blocked") return <AlertCircle  className="h-4 w-4 shrink-0 text-orange-400" />;
  return <HelpCircle className="h-4 w-4 shrink-0 text-slate-600" />;
}

// ─── SMTP step color ──────────────────────────────────────────────────────────
function smtpCodeColor(code: number) {
  if (code === 0)           return "text-slate-600";
  if (code >= 200 && code < 300) return "text-emerald-400";
  if (code >= 400 && code < 500) return "text-amber-400";
  if (code >= 500)          return "text-rose-400";
  return "text-slate-400";
}

// ─── Engine debug panel (shared) ─────────────────────────────────────────────
function EngineDebugPanel({ steps, smtp }: {
  steps: EngineStep[];
  smtp: { connected: boolean; port: number | null; serverBanner: string | null; log: import("@/app/api/verify-email/route").EmailVerifyResult["ownEngine"]["smtp"] extends infer T ? T extends null ? never : T["log"] : never } | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-fuchsia-900/40 bg-[#0e0614] overflow-hidden">
      <button onClick={() => setOpen(v => !v)}
        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-xs font-semibold text-fuchsia-400 hover:bg-fuchsia-400/5 transition-colors">
        <Terminal className="h-3.5 w-3.5" />
        <span>Our Engine Report</span>
        <span className="ml-auto flex items-center gap-1 text-[10px] font-normal text-slate-600">
          {steps.length} checks{smtp ? ` · port ${smtp.port ?? "?"}` : ""}
          {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </span>
      </button>
      {open && (
        <div className="border-t border-fuchsia-900/30 px-4 py-3 space-y-3">
          {/* DNS + checks pipeline */}
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-600 mb-2">DNS & Validation Pipeline</p>
            {steps.map((step) => (
              <div key={step.id} className="flex items-start gap-2.5">
                <StepIcon s={step.status} />
                <div className="min-w-0 flex-1">
                  <span className="text-xs font-medium text-slate-300">{step.label}</span>
                  <p className="text-[11px] text-slate-500 mt-0.5">{step.detail}</p>
                  {step.raw && (
                    <p className="mt-1 font-mono text-[10px] text-fuchsia-500/70 bg-slate-900 rounded px-2 py-1 break-all">{step.raw}</p>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* SMTP handshake log */}
          {smtp && smtp.log.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-600 mb-2">
                SMTP Handshake Log
                <span className="ml-2 text-fuchsia-600 font-normal">port {smtp.port} · {smtp.connected ? "connected" : "blocked"}</span>
              </p>
              {smtp.serverBanner && (
                <p className="font-mono text-[10px] text-fuchsia-400/60 mb-2">Server: {smtp.serverBanner}</p>
              )}
              <div className="rounded-lg bg-slate-950 border border-slate-800 overflow-hidden font-mono text-[11px]">
                {smtp.log.map((step, i) => (
                  <div key={i} className="flex items-start gap-3 px-3 py-1.5 border-b border-slate-800/50 last:border-0 hover:bg-slate-900/40">
                    <span className="text-slate-700 shrink-0 w-5 text-right">{i + 1}</span>
                    <span className={cn("shrink-0 w-[100px] text-slate-500 truncate", step.sent ? "text-fuchsia-600/70" : "text-slate-600")}>
                      {step.sent ? step.step : `← ${step.step}`}
                    </span>
                    {step.sent && <span className="text-slate-400 truncate flex-1">{step.sent}</span>}
                    {!step.sent && <span className="text-slate-500 truncate flex-1">{step.message}</span>}
                    <span className={cn("shrink-0 font-bold", smtpCodeColor(step.code))}>{step.code || "—"}</span>
                    <span className="shrink-0 text-slate-700">{step.ms}ms</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {smtp && smtp.log.length === 0 && (
            <p className="text-[11px] text-slate-600 font-mono">No SMTP steps recorded — connection may have been blocked.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function ToolsPage() {
  const router = useRouter();

  // ── Verifier state ─────────────────────────────────────────────────────────
  const [verifyEmail, setVerifyEmail]   = useState("");
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [verifyResult, setVerifyResult]   = useState<EmailVerifyResult | null>(null);
  const [verifyError, setVerifyError]     = useState<string | null>(null);

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!verifyEmail.trim()) return;
    setVerifyLoading(true); setVerifyResult(null); setVerifyError(null);
    try {
      const res = await fetch("/api/verify-email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: verifyEmail.trim() }) });
      if (!res.ok) { const err = (await res.json()) as { error?: string }; throw new Error(err.error ?? `HTTP ${res.status}`); }
      setVerifyResult((await res.json()) as EmailVerifyResult);
    } catch (err) { const m = err instanceof Error ? err.message : String(err); setVerifyError(m); toast.error(`Verification failed: ${m}`); }
    finally { setVerifyLoading(false); }
  }

  // ── Finder state ───────────────────────────────────────────────────────────
  const [findFirst, setFindFirst]     = useState("");
  const [findLast, setFindLast]       = useState("");
  const [findCompany, setFindCompany] = useState("");
  const [findDomain, setFindDomain]   = useState("");
  const [findLoading, setFindLoading] = useState(false);
  const [findResult, setFindResult]   = useState<FindEmailResult | null>(null);
  const [findError, setFindError]     = useState<string | null>(null);
  const [showAll, setShowAll]         = useState(false);

  async function handleFind(e: React.FormEvent) {
    e.preventDefault();
    if (!findFirst.trim() || !findLast.trim() || (!findCompany.trim() && !findDomain.trim())) {
      toast.error("Fill in first name, last name, and company or domain"); return;
    }
    setFindLoading(true); setFindResult(null); setFindError(null); setShowAll(false);
    try {
      const res = await fetch("/api/find-email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ firstName: findFirst.trim(), lastName: findLast.trim(), company: findCompany.trim(), domain: findDomain.trim() || undefined }) });
      if (!res.ok) { const err = (await res.json()) as { error?: string }; throw new Error(err.error ?? `HTTP ${res.status}`); }
      setFindResult((await res.json()) as FindEmailResult);
    } catch (err) { const m = err instanceof Error ? err.message : String(err); setFindError(m); toast.error(`Email finder failed: ${m}`); }
    finally { setFindLoading(false); }
  }

  const displayCands = findResult ? (showAll ? findResult.candidates : findResult.candidates.slice(0, 5)) : [];

  return (
    <main className="min-h-screen bg-[#06050b] px-4 py-8">
      <div className="mx-auto max-w-4xl space-y-10">

        {/* Nav */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => router.push("/")}
              className="flex items-center gap-1.5 text-sm text-slate-400 transition-colors hover:text-slate-200">
              <ArrowLeft className="h-4 w-4" /> Home
            </button>
            <span className="text-slate-700">/</span>
            <h1 className="text-base font-semibold text-white">Email Tools</h1>
          </div>
          <div className="flex items-center gap-1.5 rounded-full border border-fuchsia-500/20 bg-fuchsia-500/10 px-3 py-1 text-[11px] font-medium text-fuchsia-400">
            <Zap className="h-3 w-3" /> Own Engine Powered
          </div>
        </div>

        {/* ══ Section 1: Email Verifier ══════════════════════════════════════ */}
        <section className="rounded-2xl border border-fuchsia-700/25 bg-[#160d28] p-6 shadow-2xl shadow-black/60 backdrop-blur">
          <div className="mb-5 flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-fuchsia-500/20 to-pink-500/20 border border-fuchsia-500/20 text-fuchsia-400">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Email Verifier</h2>
              <p className="text-xs text-slate-500">Check deliverability, MX, SPF/DMARC, SMTP — get a 0–100 confidence score</p>
            </div>
          </div>

          <form onSubmit={(e) => void handleVerify(e)} className="flex gap-3">
            <div className="relative flex-1">
              <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-600" />
              <input type="email" value={verifyEmail} onChange={(e) => setVerifyEmail(e.target.value)}
                placeholder="e.g. john.doe@stripe.com"
                className="w-full rounded-xl border border-white/[0.07] bg-white/[0.04] py-2.5 pl-9 pr-4 text-sm text-white placeholder-slate-600 focus:border-fuchsia-500/50 focus:bg-white/[0.06] focus:outline-none transition-colors"
                required />
            </div>
            <button type="submit" disabled={verifyLoading || !verifyEmail.trim()}
              className="flex shrink-0 items-center gap-2 rounded-xl bg-gradient-to-r from-fuchsia-600 to-pink-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-fuchsia-900/30 hover:from-fuchsia-500 hover:to-pink-500 disabled:opacity-50 transition-all">
              {verifyLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              Verify
            </button>
          </form>
          <p className="mt-2 text-[11px] text-slate-700">
            Runs: Format check → Disposable blocklist → MX lookup → SPF/DMARC → SMTP probe (port 25 + 465 fallback) → ZeroBounce → AbstractAPI
          </p>

          {verifyError && <div className="mt-4 rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-sm text-rose-400">{verifyError}</div>}

          {verifyResult && (
            <div className="mt-6 space-y-5">
              {/* Score + status + email */}
              <div className="flex flex-wrap items-center gap-6 rounded-xl border border-fuchsia-700/20 bg-fuchsia-950/30 p-4">
                <ScoreRing score={verifyResult.score} />
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill status={verifyResult.status} />
                    {verifyResult.details.isCatchAll && <span className="text-xs text-amber-400 bg-amber-400/10 rounded-full px-2 py-0.5 border border-amber-400/20">Catch-all</span>}
                    {verifyResult.details.isDisposable && <span className="text-xs text-rose-400 bg-rose-400/10 rounded-full px-2 py-0.5 border border-rose-400/20">Disposable</span>}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-sm font-semibold text-white">{verifyResult.email}</span>
                    <CopyBtn text={verifyResult.email} />
                  </div>
                  <p className="text-xs text-slate-600">Domain: <span className="text-slate-400">{verifyResult.domain}</span></p>
                </div>
              </div>

              {/* Third-party checkers */}
              <div className="space-y-2">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-fuchsia-900/80">Third-Party Verification</p>
                <div className="divide-y divide-fuchsia-900/20 rounded-xl border border-fuchsia-800/20 bg-[#0f0920]">
                  {[
                    { name: "ZeroBounce", c: verifyResult.checkers.zeroBounce },
                    { name: "AbstractAPI", c: verifyResult.checkers.abstractApi },
                  ].map(({ name, c }) => (
                    <div key={name} className="flex items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-slate-300">{name}</span>
                          {c.skipped && <span className="text-[10px] text-slate-700 bg-slate-800 rounded px-1.5 py-0.5">Skipped</span>}
                          {!c.skipped && c.checked && "qualityScore" in c && typeof c.qualityScore === "number" && (
                            <span className="text-[10px] text-slate-500">Quality: {c.qualityScore}%</span>
                          )}
                        </div>
                        <p className="text-[11px] text-slate-500 mt-0.5 line-clamp-1">
                          {c.skipped ? (c.skipReason ?? "Not configured") : c.label}
                        </p>
                      </div>
                      {!c.skipped && c.checked && (
                        <ConfChip level={
                          c.status === "valid" || c.status === "DELIVERABLE" ? "high"
                          : c.status === "catch-all" || c.status === "RISKY" ? "medium" : "low"
                        } />
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* OurEngine debug */}
              <EngineDebugPanel steps={verifyResult.ownEngine.steps} smtp={verifyResult.ownEngine.smtp as never} />
            </div>
          )}
        </section>

        {/* ══ Section 2: Email Finder ════════════════════════════════════════ */}
        <section className="rounded-2xl border border-amber-700/25 bg-[#1c1003] p-6 shadow-2xl shadow-black/60 backdrop-blur">
          <div className="mb-5 flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500/20 to-orange-500/20 border border-amber-500/20 text-amber-400">
              <User className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Email Finder</h2>
              <p className="text-xs text-slate-500">Find a work email using Snov.io, Hunter + SMTP + 15 pattern formats — with full engine trace</p>
            </div>
          </div>

          <form onSubmit={(e) => void handleFind(e)} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="relative">
                <User className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-600" />
                <input type="text" value={findFirst} onChange={(e) => setFindFirst(e.target.value)}
                  placeholder="First name  e.g. John"
                  className="w-full rounded-xl border border-white/[0.07] bg-white/[0.04] py-2.5 pl-9 pr-4 text-sm text-white placeholder-slate-600 focus:border-amber-500/50 focus:outline-none transition-colors" required />
              </div>
              <input type="text" value={findLast} onChange={(e) => setFindLast(e.target.value)}
                placeholder="Last name  e.g. Doe"
                className="w-full rounded-xl border border-white/[0.07] bg-white/[0.04] py-2.5 px-4 text-sm text-white placeholder-slate-600 focus:border-amber-500/50 focus:outline-none transition-colors" required />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="relative">
                <Building2 className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-600" />
                <input type="text" value={findCompany} onChange={(e) => setFindCompany(e.target.value)}
                  placeholder="Company  e.g. Stripe"
                  className="w-full rounded-xl border border-white/[0.07] bg-white/[0.04] py-2.5 pl-9 pr-4 text-sm text-white placeholder-slate-600 focus:border-amber-500/50 focus:outline-none transition-colors" />
              </div>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-slate-700 font-mono">@</span>
                <input type="text" value={findDomain} onChange={(e) => setFindDomain(e.target.value)}
                  placeholder="Domain  e.g. stripe.com (optional)"
                  className="w-full rounded-xl border border-white/[0.07] bg-white/[0.04] py-2.5 pl-7 pr-4 text-sm text-white placeholder-slate-600 focus:border-amber-500/50 focus:outline-none transition-colors" />
              </div>
            </div>
            <div className="flex items-center justify-between gap-4 pt-1">
              <p className="text-[11px] text-slate-700">Hunter.io + Snov.io + SMTP probe + 15 pattern formats → ranked by verification confidence</p>
              <button type="submit" disabled={findLoading || !findFirst.trim() || !findLast.trim()}
                className="flex shrink-0 items-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-orange-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-amber-900/30 hover:from-amber-400 hover:to-orange-500 disabled:opacity-50 transition-all">
                {findLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                Find Email
              </button>
            </div>
          </form>

          {findError && <div className="mt-4 rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-sm text-rose-400">{findError}</div>}

          {findResult && (
            <div className="mt-6 space-y-5">
              {/* Best email */}
              {findResult.bestEmail ? (
                <div className="rounded-xl border border-amber-500/20 bg-gradient-to-br from-amber-500/5 to-orange-500/5 p-4">
                  <p className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-amber-500">Best Match</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-lg font-bold text-white">{findResult.bestEmail}</span>
                    <CopyBtn text={findResult.bestEmail} />
                    {findResult.bestEmailSource && <span className="text-xs text-slate-500">via {findResult.bestEmailSource}</span>}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span>Domain: <span className="text-slate-300">{findResult.domain}</span></span>
                    <span className="text-slate-700">·</span>
                    <span>MX: <span className={findResult.domainMxValid ? "text-emerald-400" : "text-rose-400"}>{findResult.domainMxValid ? "Valid" : "No MX"}</span></span>
                    {findResult.isCatchAllDomain && <><span className="text-slate-700">·</span><span className="text-amber-400">Catch-all domain</span></>}
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-amber-800/20 bg-amber-900/10 p-4 text-sm text-amber-700">
                  No high-confidence email found — showing pattern candidates below
                </div>
              )}

              {/* Employment Verification (Apollo.io) */}
              {findResult.employment && (
                <div className={cn(
                  "rounded-xl border p-4 space-y-3",
                  findResult.employment.confirmedAtCompany === true
                    ? "border-emerald-700/30 bg-emerald-900/10"
                    : findResult.employment.confirmedAtCompany === false
                    ? "border-rose-700/20 bg-rose-900/10"
                    : "border-fuchsia-800/20 bg-fuchsia-900/10"
                )}>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Employment Verification</span>
                    <span className="text-[10px] text-slate-600">via Apollo.io</span>
                    {findResult.employment.skipped && (
                      <span className="ml-auto text-[10px] text-slate-600 bg-slate-800 rounded px-1.5 py-0.5">
                        {findResult.employment.skipReason ?? "Not configured"}
                      </span>
                    )}
                    {!findResult.employment.skipped && findResult.employment.confirmedAtCompany === true && (
                      <span className="ml-auto text-[10px] font-bold text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 rounded-full px-2 py-0.5">
                        ✓ Currently employed here
                      </span>
                    )}
                    {!findResult.employment.skipped && findResult.employment.confirmedAtCompany === false && (
                      <span className="ml-auto text-[10px] font-bold text-rose-400 bg-rose-400/10 border border-rose-400/20 rounded-full px-2 py-0.5">
                        ✗ Not at this company
                      </span>
                    )}
                    {!findResult.employment.skipped && findResult.employment.confirmedAtCompany === null && findResult.employment.checked && (
                      <span className="ml-auto text-[10px] text-slate-500 bg-slate-800 rounded-full px-2 py-0.5">
                        Not found in Apollo DB
                      </span>
                    )}
                  </div>

                  {!findResult.employment.skipped && findResult.employment.checked && (findResult.employment.title ?? findResult.employment.currentCompany ?? findResult.employment.linkedinUrl) && (
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
                      {findResult.employment.title && (
                        <div><span className="text-slate-500">Title:</span> <span className="text-slate-200">{findResult.employment.title}</span></div>
                      )}
                      {findResult.employment.currentCompany && (
                        <div><span className="text-slate-500">Company:</span> <span className="text-slate-200">{findResult.employment.currentCompany}</span></div>
                      )}
                      {findResult.employment.seniority && (
                        <div><span className="text-slate-500">Seniority:</span> <span className="text-slate-300 capitalize">{findResult.employment.seniority.replace(/_/g, " ")}</span></div>
                      )}
                      {findResult.employment.departments.length > 0 && (
                        <div><span className="text-slate-500">Dept:</span> <span className="text-slate-300 capitalize">{findResult.employment.departments.join(", ")}</span></div>
                      )}
                      {findResult.employment.apolloEmail && (
                        <div className="col-span-2 flex items-center gap-2">
                          <span className="text-slate-500">Apollo email:</span>
                          <span className="font-mono text-amber-300">{findResult.employment.apolloEmail}</span>
                          {findResult.employment.apolloEmailVerified && (
                            <span className="text-[9px] font-bold text-emerald-400 bg-emerald-400/10 rounded px-1 py-0.5">Verified ✓</span>
                          )}
                          <CopyBtn text={findResult.employment.apolloEmail} />
                        </div>
                      )}
                      {findResult.employment.linkedinUrl && (
                        <div className="col-span-2 flex items-center gap-2">
                          <span className="text-slate-500">LinkedIn:</span>
                          <a href={findResult.employment.linkedinUrl} target="_blank" rel="noopener noreferrer"
                            className="font-mono text-[11px] text-fuchsia-400 hover:text-fuchsia-300 hover:underline truncate max-w-xs">
                            {findResult.employment.linkedinUrl.replace("https://", "")}
                          </a>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Employment history */}
                  {!findResult.employment.skipped && findResult.employment.history.length > 1 && (
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-600 mb-1.5">Employment History</p>
                      <div className="space-y-1">
                        {findResult.employment.history.slice(0, 4).map((h, i) => (
                          <div key={i} className="flex items-center gap-2 text-[10px]">
                            <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", h.isCurrent ? "bg-emerald-400" : "bg-slate-700")} />
                            <span className="text-slate-300">{h.organizationName ?? "Unknown"}</span>
                            <span className="text-slate-600">—</span>
                            <span className="text-slate-500">{h.title ?? "Unknown role"}</span>
                            {h.startDate && <span className="text-slate-700 ml-auto">{h.startDate.slice(0, 7)}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Candidates table */}
              <div>
                <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-amber-700/60">All Candidates ({findResult.candidates.length})</p>
                <div className="rounded-xl border border-amber-800/25 overflow-hidden">
                  <div className="grid grid-cols-[1fr_72px_72px_96px_80px] gap-x-3 border-b border-amber-800/20 bg-amber-900/20 px-3 py-2 text-[9px] font-bold uppercase tracking-widest text-amber-700/80">
                    <span>Email</span>
                    <span className="text-right">Score</span>
                    <span className="text-center">Hunter</span>
                    <span className="text-center">Verified</span>
                    <span className="text-center">Recipient</span>
                  </div>
                  {displayCands.map((c, i) => (
                    <div key={c.email} className={cn(
                      "grid grid-cols-[1fr_72px_72px_96px_80px] gap-x-3 items-center px-3 py-2.5 text-xs border-b border-amber-900/20 last:border-0 transition-colors",
                      i === 0 && findResult.bestEmail === c.email ? "bg-amber-500/5" : "hover:bg-white/[0.02]")}>                        <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-slate-200 truncate">{c.email}</span>
                          <CopyBtn text={c.email} />
                          {i === 0 && findResult.bestEmail === c.email && (
                            <span className="text-[9px] bg-amber-500/15 text-amber-400 rounded px-1 py-0.5 shrink-0">BEST</span>
                          )}
                          {c.sources.hunterEmployeeDb && (
                            <span className="text-[9px] bg-emerald-500/15 text-emerald-400 rounded px-1 py-0.5 shrink-0">DB ✓</span>
                          )}
                        </div>
                        <span className="text-[10px] text-slate-600">{c.format}</span>
                      </div>
                      <div className="text-right">
                        <span className={cn("font-bold", c.probability >= 30 ? "text-emerald-400" : c.probability >= 15 ? "text-amber-400" : "text-slate-600")}>{c.probability}%</span>
                      </div>
                      <div className="text-center">
                        {c.sources.hunterFound ? (
                          <span className="text-emerald-400 font-semibold">{c.sources.hunterConfidence ? `${c.sources.hunterConfidence}%` : "✓"}</span>
                        ) : <span className="text-slate-700">—</span>}
                      </div>
                      <div className="flex justify-center">
                        <ConfChip level={c.overallConfidence} />
                      </div>
                      <div className="flex justify-center">
                        <RecipientTag v={c.recipientAccepting} />
                      </div>
                    </div>
                  ))}
                </div>
                {findResult.candidates.length > 5 && (
                  <button onClick={() => setShowAll(v => !v)}
                    className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-xl border border-amber-900/30 py-2 text-xs text-amber-800/70 hover:border-amber-700/50 hover:text-amber-400 transition-colors">
                    {showAll ? <><ChevronUp className="h-3.5 w-3.5" /> Show fewer</> : <><ChevronDown className="h-3.5 w-3.5" /> Show all {findResult.candidates.length} candidates</>}
                  </button>
                )}
              </div>

              {/* Our Engine Report for finder */}
              {findResult.ownEngine && (
                <div className="rounded-xl border border-amber-900/40 bg-[#0e0904] overflow-hidden">
                  <div className="px-4 py-2.5 flex items-center gap-2 border-b border-amber-900/30">
                    <Terminal className="h-3.5 w-3.5 text-amber-400" />
                    <span className="text-xs font-semibold text-amber-400">Our Engine Report</span>
                    <span className="ml-auto text-[10px] text-slate-600">
                      {findResult.ownEngine.patternsGenerated} patterns · {findResult.ownEngine.smtpProbes.length} SMTP probe(s)
                    </span>
                  </div>
                  <div className="p-4 space-y-4">
                    {/* Domain + DNS */}
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-600 mb-2">Domain Resolution</p>
                      <div className="grid grid-cols-2 gap-2 text-[11px]">
                        <div><span className="text-slate-500">Domain:</span> <span className="text-slate-200 font-mono">{findResult.domain}</span></div>
                        <div><span className="text-slate-500">Source:</span> <span className="text-slate-400">{findResult.ownEngine.domainSource}</span></div>
                        <div><span className="text-slate-500">SPF:</span> <span className={findResult.ownEngine.hasSPF ? "text-emerald-400" : "text-slate-600"}>{findResult.ownEngine.hasSPF ? "Found ✓" : "Not found"}</span></div>
                        <div><span className="text-slate-500">DMARC:</span> <span className={findResult.ownEngine.hasDMARC ? "text-emerald-400" : "text-slate-600"}>{findResult.ownEngine.hasDMARC ? "Found ✓" : "Not found"}</span></div>
                      </div>
                      {findResult.ownEngine.mxRecords.length > 0 && (
                        <p className="mt-2 font-mono text-[10px] text-amber-500/60">{findResult.ownEngine.mxRecords.join(" · ")}</p>
                      )}
                      {/* Hunter domain pattern signal */}
                      {findResult.ownEngine.hunterDomainPattern && (
                        <div className="mt-2 flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2">
                          <span className="text-[10px] font-bold uppercase tracking-widest text-amber-500">Hunter Pattern</span>
                          <span className="font-mono text-[11px] text-amber-300">{findResult.ownEngine.hunterDomainPattern}</span>
                          {findResult.ownEngine.hunterDomainFormat && (
                            <span className="text-[10px] text-slate-500">→ <span className="text-amber-400">{findResult.ownEngine.hunterDomainFormat}</span> format — candidates re-ranked</span>
                          )}
                        </div>
                      )}
                      {findResult.ownEngine.learnedPattern && !findResult.ownEngine.hunterDomainPattern && (
                        <p className="mt-1.5 text-[11px] text-amber-400/80">
                          Previously learned pattern: <span className="font-mono text-amber-300">{findResult.ownEngine.learnedPattern}</span>
                        </p>
                      )}
                    </div>

                    {/* Top patterns */}
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-600 mb-2">
                        Pattern Candidates Generated ({findResult.ownEngine.patternsGenerated} total)
                      </p>
                      <div className="space-y-1">
                        {findResult.ownEngine.topPatterns.map((p, i) => (
                          <div key={p.email} className="flex items-center justify-between gap-3 text-[11px]">
                            <span className="text-slate-600 w-4 shrink-0">{i + 1}.</span>
                            <span className="font-mono text-amber-300/80 flex-1 truncate">{p.email}</span>
                            <span className="text-slate-500 shrink-0">{p.format}</span>
                            <span className={cn("font-bold shrink-0", p.score >= 30 ? "text-emerald-400" : "text-slate-600")}>{p.score}%</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Per-email SMTP probes */}
                    {findResult.ownEngine.smtpProbes.length > 0 && (
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-600 mb-2">SMTP Probe Results</p>
                        {findResult.ownEngine.smtpProbes.map((probe) => (
                          <div key={probe.email} className="mb-3 last:mb-0">
                            <div className="flex items-center gap-2 mb-1.5">
                              {probe.status === "valid" ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> :
                               probe.status === "invalid" ? <XCircle className="h-3.5 w-3.5 text-rose-400" /> :
                               probe.status === "catch_all" ? <AlertCircle className="h-3.5 w-3.5 text-amber-400" /> :
                               <HelpCircle className="h-3.5 w-3.5 text-slate-600" />}
                              <span className="font-mono text-[11px] text-slate-300">{probe.email}</span>
                              <span className={cn("text-[10px] font-bold rounded px-1.5 py-0.5",
                                probe.status === "valid" ? "text-emerald-400 bg-emerald-400/10" :
                                probe.status === "invalid" ? "text-rose-400 bg-rose-400/10" :
                                probe.status === "catch_all" ? "text-amber-400 bg-amber-400/10" : "text-slate-500 bg-slate-800"
                              )}>{probe.status.replace("_", "-")}</span>
                              <span className="text-[10px] text-slate-700 ml-auto">port {probe.port}</span>
                            </div>
                            {probe.log.length > 0 && (
                              <div className="rounded-lg bg-slate-950 border border-slate-800 overflow-hidden font-mono text-[10px]">
                                {probe.log.map((step, j) => (
                                  <div key={j} className="flex items-center gap-2 px-3 py-1 border-b border-slate-800/40 last:border-0">
                                    <span className="text-slate-700 w-16 shrink-0">{step.step}</span>
                                    <span className="text-slate-500 flex-1 truncate">{step.sent ?? step.message}</span>
                                    <span className={cn("font-bold shrink-0", smtpCodeColor(step.code))}>{step.code || "—"}</span>
                                    <span className="text-slate-700 shrink-0">{step.ms}ms</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    {findResult.ownEngine.smtpProbes.length === 0 && (
                      <div className={cn("rounded-lg border px-3 py-2.5 text-[11px] font-mono",
                        findResult.ownEngine.smtpBlocked
                          ? "border-orange-900/30 bg-orange-950/30 text-orange-400/70"
                          : "border-slate-800 bg-slate-900/40 text-slate-600")}>
                        {findResult.ownEngine.smtpBlocked
                          ? "⚠ SMTP ports 25/465 blocked by ISP or cloud host — this is normal on dev machines and Vercel. Verification falls back to Hunter.io + Snov.io + ZeroBounce signals."
                          : "SMTP probes not run — domain has no valid MX records."}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
