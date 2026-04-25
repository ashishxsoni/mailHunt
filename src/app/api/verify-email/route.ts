import { NextRequest, NextResponse } from "next/server";
import { lookupMx, lookupDnsExtra } from "@/lib/ownVerifier/mxLookup";
import { isDisposableDomain } from "@/lib/ownVerifier/disposableDomains";
import { probeSmtp, type SmtpStep } from "@/lib/ownVerifier/smtpProbe";
import { verifyEmailZeroBounce } from "@/lib/providers/zerobounce";
import { verifyEmailAbstractApi } from "@/lib/providers/abstractapi";

export interface EngineStep {
  id: string;
  label: string;
  status: "pass" | "fail" | "warn" | "blocked" | "skip";
  detail: string;
  raw?: string;
}

export interface EmailVerifyResult {
  email: string;
  domain: string;
  score: number;
  status: "active" | "likely" | "risky" | "inactive" | "unknown";
  details: {
    formatValid: boolean;
    mxFound: boolean;
    mxRecords: string[];
    isDisposable: boolean;
    isCatchAll: boolean | null;
    isSmtpProbed: boolean;
    suggestion: string | null;
  };
  checkers: {
    ownSystem: { checked: true; status: string; label: string; confidence: string };
    zeroBounce: { checked: boolean; status: string; label: string; qualityScore: number | null; skipped: boolean; skipReason?: string };
    abstractApi: { checked: boolean; status: string; label: string; qualityScore: number | null; skipped: boolean; skipReason?: string };
  };
  ownEngine: {
    steps: EngineStep[];
    smtp: { connected: boolean; port: number | null; serverBanner: string | null; log: SmtpStep[]; } | null;
  };
}

function isValidEmailFormat(email: string): boolean {
  return /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(email.trim());
}

function computeScore(formatValid: boolean, mxFound: boolean, isDisposable: boolean, signals: number[]): number {
  if (!formatValid) return 0;
  let base = 15;
  if (mxFound) base += 15;
  if (!isDisposable) base += 10;
  if (!mxFound) return base;
  if (signals.length === 0) return base;
  const avg = signals.reduce((a, b) => a + b, 0) / signals.length;
  return Math.min(100, Math.round(base + (avg * 60) / 100));
}

function scoreToStatus(score: number, hasSignals: boolean, mxFound: boolean): EmailVerifyResult["status"] {
  if (!mxFound) return "inactive";
  if (!hasSignals) return "unknown";
  if (score >= 80) return "active";
  if (score >= 60) return "likely";
  if (score >= 35) return "risky";
  return "inactive";
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { email?: string; domain?: string };
  try { body = (await req.json()) as { email?: string; domain?: string }; }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const email = (body.email ?? "").trim().toLowerCase();
  if (!email) return NextResponse.json({ error: "email is required" }, { status: 400 });

  const atIdx = email.lastIndexOf("@");
  const domain = atIdx >= 0 ? email.slice(atIdx + 1) : (body.domain ?? "");
  if (!domain) return NextResponse.json({ error: "Could not determine domain" }, { status: 400 });

  const formatValid = isValidEmailFormat(email);
  const engineSteps: EngineStep[] = [];

  engineSteps.push({ id: "format", label: "Email Format", status: formatValid ? "pass" : "fail",
    detail: formatValid ? `"${email}" passes RFC 5322 format check` : `"${email}" is not a valid email format` });

  const disposable = isDisposableDomain(domain);
  engineSteps.push({ id: "disposable", label: "Disposable Domain Check", status: disposable ? "fail" : "pass",
    detail: disposable ? `${domain} is a known throwaway email provider` : `${domain} is not a disposable email service` });

  const mxResult = formatValid ? await lookupMx(domain) : { hasMx: false, records: [], primaryHost: null };
  const mxFound = mxResult.hasMx;
  const mxRecords = mxResult.records.map((r) => r.exchange);

  engineSteps.push({ id: "mx", label: "MX Record Lookup", status: mxFound ? "pass" : "fail",
    detail: mxFound ? `Found ${mxResult.records.length} MX record(s) — primary: ${mxResult.primaryHost}` : `No MX records for ${domain} — cannot receive email`,
    raw: mxFound ? mxResult.records.map((r) => `${r.exchange} (pri ${r.priority})`).join(", ") : undefined });

  if (formatValid) {
    const dns = await lookupDnsExtra(domain);
    engineSteps.push({ id: "spf", label: "SPF Record (sender policy)", status: dns.hasSPF ? "pass" : "warn",
      detail: dns.hasSPF ? `SPF found — domain is configured for outbound email` : `No SPF record on ${domain}`,
      raw: dns.spfRecord ?? undefined });
    engineSteps.push({ id: "dmarc", label: "DMARC Record (anti-spoofing)", status: dns.hasDMARC ? "pass" : "warn",
      detail: dns.hasDMARC ? `DMARC policy found — enforces email authentication` : `No DMARC record on _dmarc.${domain}`,
      raw: dns.dmarcRecord ?? undefined });
  }

  let ownStatus = "skipped", ownLabel = "Not checked", ownConfidence = "low";
  let ownSmtpProbed = false, ownCatchAll: boolean | null = null;
  let smtpBlock: EmailVerifyResult["ownEngine"]["smtp"] = null;

  if (formatValid && mxFound && mxResult.primaryHost) {
    try {
      // Pass all MX records (up to 2) so we try secondary if primary is blocked
      const mxHosts = mxResult.records.map((r) => r.exchange);
      const smtpResult = await probeSmtp(email, mxHosts);
      ownSmtpProbed = smtpResult.smtpAvailable;
      ownCatchAll = smtpResult.isCatchAll;
      smtpBlock = { connected: smtpResult.smtpAvailable, port: smtpResult.port, serverBanner: smtpResult.serverBanner, log: smtpResult.log };

      if (smtpResult.status === "valid") { ownStatus = "valid"; ownLabel = "Mailbox confirmed (SMTP 250)"; ownConfidence = "high"; }
      else if (smtpResult.status === "catch_all") { ownStatus = "catch_all"; ownLabel = "Domain accepts all mail (catch-all)"; ownConfidence = "medium"; }
      else if (smtpResult.status === "invalid") { ownStatus = "invalid"; ownLabel = `Mailbox rejected — SMTP ${smtpResult.code}`; ownConfidence = "low"; }
      else if (smtpResult.status === "unavailable") { ownStatus = "unavailable"; ownLabel = `SMTP blocked — port 25/465 firewalled by ISP or cloud host (normal on dev/cloud)`; ownConfidence = "low"; }
      else { ownStatus = "unknown"; ownLabel = "SMTP inconclusive (temp failure / greylisting)"; ownConfidence = "low"; }

      engineSteps.push({ id: "smtp", label: `SMTP Probe (port ${smtpResult.port})`,
        status: smtpResult.status === "valid" ? "pass" : smtpResult.status === "catch_all" ? "warn" : smtpResult.status === "unavailable" ? "blocked" : smtpResult.status === "invalid" ? "fail" : "warn",
        detail: ownLabel, raw: smtpResult.serverBanner ? `Server: ${smtpResult.serverBanner}` : smtpResult.status === "unavailable" ? `ISP/cloud blocks outbound SMTP — use ZeroBounce or AbstractAPI for real verification` : `${smtpResult.log.length} step(s) logged` });
    } catch {
      ownStatus = "error"; ownLabel = "SMTP probe threw an unexpected error";
      engineSteps.push({ id: "smtp", label: "SMTP Probe", status: "fail", detail: ownLabel });
    }
  } else {
    const skipReason = !formatValid ? "invalid format" : "no MX records";
    engineSteps.push({ id: "smtp", label: "SMTP Probe", status: "skip", detail: `Skipped — ${skipReason}` });
  }

  const signals: number[] = [];
  if (ownStatus === "valid") signals.push(97);
  else if (ownStatus === "catch_all") signals.push(62);
  else if (ownStatus === "invalid") signals.push(0);
  else if (ownStatus === "unknown") signals.push(35);

  const zbApiKey = process.env.ZEROBOUNCE_API_KEY ?? "";
  let zbStatus = "not_checked", zbLabel = "Not configured", zbQuality: number | null = null;
  let zbChecked = false, zbSkipped = !zbApiKey, zbSkipReason: string | undefined = zbApiKey ? undefined : "ZEROBOUNCE_API_KEY not set";
  if (zbApiKey && formatValid) {
    const r = await verifyEmailZeroBounce(email, zbApiKey);
    zbChecked = true;
    if (r.ok) { zbStatus = r.result; zbLabel = r.result === "valid" ? "Valid deliverable inbox" : "Catch-all inbox"; signals.push(r.result === "valid" ? 97 : 62); }
    else { zbStatus = r.reason; zbLabel = r.message; zbSkipped = r.reason === "plan_limit" || r.reason === "auth_error"; zbSkipReason = zbSkipped ? r.message : undefined; if (r.reason === "invalid_address") signals.push(0); }
  }

  const abApiKey = process.env.ABSTRACTAPI_EMAIL_KEY ?? "";
  let abStatus = "not_checked", abLabel = "Not configured", abQuality: number | null = null;
  let abChecked = false, abSkipped = !abApiKey, abSkipReason: string | undefined = abApiKey ? undefined : "ABSTRACTAPI_EMAIL_KEY not set";
  if (abApiKey && formatValid) {
    const r = await verifyEmailAbstractApi(email, abApiKey);
    abChecked = true;
    if (r.ok) { abStatus = r.deliverability; abLabel = r.deliverability === "DELIVERABLE" ? "Deliverable inbox confirmed" : "Risky — catch-all or role"; abQuality = typeof r.qualityScore === "number" ? Math.round(r.qualityScore * 100) : null; signals.push(r.deliverability === "DELIVERABLE" ? 95 : 60); }
    else { abStatus = r.reason; abLabel = r.message; abSkipped = r.reason === "plan_limit" || r.reason === "auth_error"; abSkipReason = abSkipped ? r.message : undefined; if (r.reason === "invalid_address") signals.push(0); }
  }

  const score = computeScore(formatValid, mxFound, disposable, signals);
  const status = scoreToStatus(score, signals.length > 0, mxFound);

  return NextResponse.json({
    email, domain, score, status,
    details: { formatValid, mxFound, mxRecords, isDisposable: disposable, isCatchAll: ownCatchAll, isSmtpProbed: ownSmtpProbed, suggestion: null },
    checkers: {
      ownSystem: { checked: true, status: ownStatus, label: ownLabel, confidence: ownConfidence },
      zeroBounce: { checked: zbChecked, status: zbStatus, label: zbLabel, qualityScore: zbQuality, skipped: zbSkipped, ...(zbSkipReason ? { skipReason: zbSkipReason } : {}) },
      abstractApi: { checked: abChecked, status: abStatus, label: abLabel, qualityScore: abQuality, skipped: abSkipped, ...(abSkipReason ? { skipReason: abSkipReason } : {}) },
    },
    ownEngine: { steps: engineSteps, smtp: smtpBlock },
  } satisfies EmailVerifyResult);
}
