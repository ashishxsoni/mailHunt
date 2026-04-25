import { NextRequest, NextResponse } from "next/server";
import { generateScoredCandidates, getLearnedPattern, learnDomainPattern } from "@/lib/ownVerifier/patternScorer";
import { lookupMx, lookupDnsExtra } from "@/lib/ownVerifier/mxLookup";
import { verifyTopCandidates } from "@/lib/ownVerifier";
import { verifyEmailZeroBounce } from "@/lib/providers/zerobounce";
import { verifyEmailAbstractApi } from "@/lib/providers/abstractapi";
import { apolloPeopleMatch } from "@/lib/providers/apollo";
import { findEmailsBatchSnovi } from "@/lib/emailVerifier";
import type { EmailCandidate } from "@/types";

// ─── Types ────────────────────────────────────────────────────────────────────

// Maps Hunter.io's "{first}.{l}" notation to our format labels
const HUNTER_PATTERN_TO_FORMAT: Record<string, string> = {
  "{first}":          "firstname",
  "{last}":           "lastname",
  "{first}.{last}":   "firstname.lastname",
  "{f}.{last}":       "f.lastname",
  "{f}{last}":        "flastname",
  "{first}{last}":    "firstnamelastname",
  "{first}.{l}":      "firstname.l",
  "{first}{l}":       "firstnamel",
  "{f}.{l}":          "f.l",
  "{last}.{first}":   "lastname.firstname",
  "{first}_{last}":   "firstname_lastname",
  "{f}_{last}":       "f_lastname",
  "{first}-{last}":   "firstname-lastname",
  "{last}.{f}":       "lastname.f",
  "{last}{f}":        "lastnamef",
};

export interface EmailCandiateResult {
  email: string;
  format: string;
  probability: number; // 0–100 from pattern scorer
  sources: {
    generatedPattern: true;
    hunterFound: boolean;
    hunterEmployeeDb: boolean;
    hunterConfidence: number | null; // Hunter's own 0–100 score
    snovFound: boolean;
  };
  verification: {
    ownSystem: {
      status: string;
      label: string;
    };
    zeroBounce: {
      checked: boolean;
      status: string;
      label: string;
    } | null;
    abstractApi: {
      checked: boolean;
      status: string;
      label: string;
      qualityScore: number | null;
    } | null;
  };
  overallConfidence: "high" | "medium" | "low";
  recipientAccepting: "yes" | "catch-all" | "no" | "unknown";
}

export interface FindEmailResult {
  firstName: string;
  lastName: string;
  company: string;
  domain: string;
  domainMxValid: boolean;
  bestEmail: string | null;
  bestEmailSource: string | null;
  isCatchAllDomain: boolean;
  candidates: EmailCandiateResult[];
  /**
   * Apollo.io employment verification — confirms whether the person
   * currently works at the target company and surfaces their LinkedIn.
   */
  employment: {
    checked: boolean;
    skipped: boolean;
    skipReason?: string;
    /** Apollo confirmed the person currently works at the searched company */
    confirmedAtCompany: boolean | null;
    /** Current job title */
    title: string | null;
    /** Current employer name as stored in Apollo */
    currentCompany: string | null;
    /** LinkedIn URL — use this to manually verify on LinkedIn */
    linkedinUrl: string | null;
    /** Email Apollo has on file (may confirm or differ from our best candidate) */
    apolloEmail: string | null;
    /** Whether Apollo's email has been independently verified */
    apolloEmailVerified: boolean;
    /** Seniority level, e.g. "senior", "manager" */
    seniority: string | null;
    /** Departments, e.g. ["engineering"] */
    departments: string[];
    /** Full employment history (most recent first) */
    history: Array<{
      organizationName: string | null;
      title: string | null;
      startDate: string | null;
      isCurrent: boolean;
    }>;
  } | null;
  /** Full report from our own engine — visible in the UI debug panel */
  ownEngine: {
    domainSource: "provided" | "hunter-resolved" | "inferred";
    mxRecords: string[];
    hasSPF: boolean;
    hasDMARC: boolean;
    spfRecord: string | null;
    dmarcRecord: string | null;
    patternsGenerated: number;
    topPatterns: { email: string; format: string; score: number }[];
    learnedPattern: string | null;
    /** Pattern Hunter.io reports is used by this company, e.g. "{first}.{l}" */
    hunterDomainPattern: string | null;
    /** Our format label mapped from Hunter's pattern, e.g. "firstname.l" */
    hunterDomainFormat: string | null;
    /** Whether SMTP probing was skipped because ports are blocked */
    smtpBlocked: boolean;
    smtpProbes: {
      email: string;
      status: string;
      code: number;
      port: number;
      serverBanner: string | null;
      log: import("@/lib/ownVerifier/smtpProbe").SmtpStep[];
    }[];
  };
}

// ─── Hunter email-finder (single person) ─────────────────────────────────────

interface HunterFinderResponse {
  data?: {
    email?: string;
    score?: number;
    domain?: string;
    accept_all?: boolean;
    verification?: { status?: string | null };
  };
  errors?: Array<{ details: string }>;
}

async function hunterFindEmail(
  firstName: string,
  lastName: string,
  domain: string,
  apiKey: string
): Promise<{ email: string; score: number; acceptAll: boolean } | null> {
  try {
    const params = new URLSearchParams({
      domain,
      first_name: firstName,
      last_name: lastName,
      api_key: apiKey,
    });
    const res = await fetch(
      `https://api.hunter.io/v2/email-finder?${params.toString()}`,
      { next: { revalidate: 0 } }
    );
    if (!res.ok) return null;
    const json = (await res.json()) as HunterFinderResponse;
    const email = json.data?.email;
    if (!email) return null;
    return {
      email,
      score: json.data?.score ?? 0,
      acceptAll: json.data?.accept_all ?? false,
    };
  } catch {
    return null;
  }
}

// ─── Hunter domain-search: extracts company email pattern AND known employee ──
// This is much more reliable than email-finder alone:
// 1. Returns the VERIFIED pattern the company actually uses (e.g. "{first}.{l}")
// 2. Returns known employee emails — if our person is in the database, we get
//    their exact email with high confidence without any guessing.
interface HunterDomainSearchResult {
  /** Hunter's pattern notation, e.g. "{first}.{l}" */
  domainPattern: string | null;
  /** Mapped to our format label, e.g. "firstname.l" */
  domainFormatLabel: string | null;
  /** If this specific person is in Hunter's employee database */
  employeeEmail: string | null;
  employeeConfidence: number | null;
  acceptAll: boolean;
}

async function hunterDomainSearch(
  domain: string,
  firstName: string,
  lastName: string,
  apiKey: string
): Promise<HunterDomainSearchResult> {
  try {
    const params = new URLSearchParams({
      domain,
      first_name: firstName,
      last_name: lastName,
      limit: "10",
      api_key: apiKey,
    });
    const res = await fetch(
      `https://api.hunter.io/v2/domain-search?${params.toString()}`,
      { next: { revalidate: 0 } }
    );
    if (!res.ok) return { domainPattern: null, domainFormatLabel: null, employeeEmail: null, employeeConfidence: null, acceptAll: false };

    const json = (await res.json()) as {
      data?: {
        pattern?: string;
        accept_all?: boolean;
        emails?: Array<{ value: string; first_name?: string | null; last_name?: string | null; confidence?: number }>;
      };
    };
    const data = json.data;
    const domainPattern = data?.pattern ?? null;
    const domainFormatLabel = domainPattern ? (HUNTER_PATTERN_TO_FORMAT[domainPattern] ?? null) : null;
    const acceptAll = data?.accept_all ?? false;

    // Look for an exact name match in Hunter's employee database
    const fn = firstName.toLowerCase();
    const ln = lastName.toLowerCase();
    const match = (data?.emails ?? []).find((e) => {
      const efn = (e.first_name ?? "").toLowerCase();
      const eln = (e.last_name ?? "").toLowerCase();
      return efn === fn && eln === ln;
    });

    return {
      domainPattern,
      domainFormatLabel,
      employeeEmail: match?.value?.toLowerCase() ?? null,
      employeeConfidence: match?.confidence ?? null,
      acceptAll,
    };
  } catch {
    return { domainPattern: null, domainFormatLabel: null, employeeEmail: null, employeeConfidence: null, acceptAll: false };
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: {
    firstName?: string;
    lastName?: string;
    company?: string;
    domain?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const firstName = (body.firstName ?? "").trim();
  const lastName = (body.lastName ?? "").trim();
  const company = (body.company ?? "").trim();
  let domain = (body.domain ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");

  if (!firstName || !lastName) {
    return NextResponse.json({ error: "firstName and lastName are required" }, { status: 400 });
  }
  if (!company && !domain) {
    return NextResponse.json({ error: "company or domain is required" }, { status: 400 });
  }

  // ── Resolve domain ─────────────────────────────────────────────────────────
  // If domain not provided, attempt to resolve via Hunter domain-search by company name
  const hunterApiKey = process.env.HUNTER_API_KEY ?? "";
  if (!domain && hunterApiKey && company) {
    try {
      const params = new URLSearchParams({ company, api_key: hunterApiKey });
      const res = await fetch(
        `https://api.hunter.io/v2/domain-search?${params.toString()}`,
        { next: { revalidate: 0 } }
      );
      if (res.ok) {
        const json = (await res.json()) as { data?: { domain?: string } };
        if (json.data?.domain) domain = json.data.domain;
      }
    } catch { /* keep domain empty */ }
  }

  // Fallback: naive heuristic (CompanyName → companyname.com)
  if (!domain && company) {
    domain = company.toLowerCase().replace(/[^a-z0-9]/g, "") + ".com";
  }

  if (!domain) {
    return NextResponse.json({ error: "Could not determine company domain" }, { status: 400 });
  }

  // ── MX check + DNS extra ────────────────────────────────────────────────
  const mxResult = await lookupMx(domain);
  const domainMxValid = mxResult.hasMx;
  const dnsExtra = await lookupDnsExtra(domain);

  // ── Hunter domain-search: learn email pattern + find employee directly ──
  // This is the most important step for accuracy — runs BEFORE generateScoredCandidates
  // so the learned pattern boosts the correct format to score 100.
  let hunterDomainPattern: string | null = null;
  let hunterDomainFormat: string | null = null;
  let hunterEmployeeEmail: string | null = null;
  let hunterEmployeeConfidence: number | null = null;
  let hunterAcceptAll = false;

  if (hunterApiKey && domain) {
    const ds = await hunterDomainSearch(domain, firstName, lastName, hunterApiKey);
    hunterDomainPattern = ds.domainPattern;
    hunterDomainFormat = ds.domainFormatLabel;
    hunterAcceptAll = ds.acceptAll;
    if (ds.employeeEmail) {
      hunterEmployeeEmail = ds.employeeEmail;
      hunterEmployeeConfidence = ds.employeeConfidence;
    }
    // Pre-learn the domain pattern so generateScoredCandidates ranks it #1
    if (ds.domainFormatLabel) {
      learnDomainPattern(domain, ds.domainFormatLabel);
    }
  }

  // ── Generate pattern candidates (now re-ranked if we learned a pattern) ──
  const rawCandidates = generateScoredCandidates(firstName, lastName, domain);

  // ── Hunter email-finder ────────────────────────────────────────────────────
  // Runs AFTER domain-search so we have pattern context.
  // If domain-search already found the person's email directly, skip this.
  let hunterEmail: string | null = hunterEmployeeEmail; // direct DB hit → highest confidence
  let hunterScore: number | null = hunterEmployeeConfidence;
  if (!hunterEmail && hunterApiKey) {
    const hr = await hunterFindEmail(firstName, lastName, domain, hunterApiKey);
    if (hr) {
      hunterEmail = hr.email.toLowerCase();
      hunterScore = hr.score;
      if (!hunterAcceptAll) hunterAcceptAll = hr.acceptAll;
    }
  }

  // ── Snov.io batch lookup ───────────────────────────────────────────────────
  const snoviId = process.env.SNOV_CLIENT_ID ?? "";
  const snoviSecret = process.env.SNOV_CLIENT_SECRET ?? "";
  let snoviEmail: string | null = null;
  if (snoviId && snoviSecret) {
    const snoviMap = await findEmailsBatchSnovi(
      [{ firstName, lastName, key: `${firstName} ${lastName}`.toLowerCase() }],
      domain,
      snoviId,
      snoviSecret
    );
    const entry = snoviMap.get(`${firstName} ${lastName}`.toLowerCase());
    if (entry) snoviEmail = entry.email.toLowerCase();
  }

  // ── Own SMTP verifier — top 5 candidates ──────────────────────────────────
  const topCandidates = rawCandidates.slice(0, 5);
  let ownResult: Awaited<ReturnType<typeof verifyTopCandidates>> | null = null;
  const smtpProbeResults: FindEmailResult["ownEngine"]["smtpProbes"] = [];
  let smtpBlocked = false;
  const mxHosts = mxResult.records.map((r) => r.exchange);
  if (domainMxValid && topCandidates.length > 0 && mxResult.primaryHost) {
    try {
      ownResult = await verifyTopCandidates(domain, topCandidates, 5);
      if (ownResult.status === "smtp_unavailable") smtpBlocked = true;
      // Only run per-email probes if SMTP was reachable
      if (ownResult.smtpAvailable) {
        const { probeSmtp } = await import("@/lib/ownVerifier/smtpProbe");
        for (const cand of topCandidates.slice(0, 3)) {
          try {
            const sr = await probeSmtp(cand.email, mxHosts);
            smtpProbeResults.push({
              email: cand.email,
              status: sr.status,
              code: sr.code,
              port: sr.port,
              serverBanner: sr.serverBanner,
              log: sr.log,
            });
            if (sr.status === "valid" || sr.status === "catch_all") break;
            if (!sr.smtpAvailable) { smtpBlocked = true; break; }
          } catch { break; }
        }
      }
    } catch { smtpBlocked = true; }
  }

  const ownBestEmail = ownResult?.bestEmail?.toLowerCase() ?? null;

  // ── Paid verifier for top 2 candidates ────────────────────────────────────
  // Run ZeroBounce first. If ZB key missing, try AbstractAPI. Never both
  // per-candidate (to preserve free quotas).
  const zbKey = process.env.ZEROBOUNCE_API_KEY ?? "";
  const abKey = process.env.ABSTRACTAPI_EMAIL_KEY ?? "";
  const paidCheckEmails = Array.from(
    new Set(
      [
        hunterEmail,
        snoviEmail,
        ownBestEmail,
        rawCandidates[0]?.email.toLowerCase(),
        rawCandidates[1]?.email.toLowerCase(),
      ].filter(Boolean) as string[]
    )
  ).slice(0, 3); // max 3 paid checks per request

  type PaidResult = {
    zb: { status: string; label: string } | null;
    ab: { status: string; label: string; qualityScore: number | null } | null;
  };
  const paidResults = new Map<string, PaidResult>();

  for (const e of paidCheckEmails) {
    const entry: PaidResult = { zb: null, ab: null };
    if (zbKey) {
      const zbR = await verifyEmailZeroBounce(e, zbKey);
      if (zbR.ok) {
        entry.zb = {
          status: zbR.result,
          label:
            zbR.result === "valid"
              ? "Valid deliverable inbox"
              : "Catch-all inbox (domain accepts all)",
        };
      } else {
        entry.zb = { status: zbR.reason, label: zbR.message };
      }
    } else if (abKey) {
      const abR = await verifyEmailAbstractApi(e, abKey);
      if (abR.ok) {
        entry.ab = {
          status: abR.deliverability,
          label:
            abR.deliverability === "DELIVERABLE"
              ? "Deliverable inbox confirmed"
              : "Risky — catch-all or role address",
          qualityScore:
            typeof abR.qualityScore === "number"
              ? Math.round(abR.qualityScore * 100)
              : null,
        };
      } else {
        entry.ab = { status: abR.reason, label: abR.message, qualityScore: null };
      }
    }
    paidResults.set(e, entry);
  }

  // ── Determine overall isCatchAll ────────────────────────────────────────────
  const isCatchAllDomain =
    hunterAcceptAll ||
    ownResult?.isCatchAll === true;

  // ── Build candidate list ────────────────────────────────────────────────────
  // Merge discovered emails from external providers into the candidates list
  const allEmails = new Set(rawCandidates.map((c) => c.email.toLowerCase()));
  const extraCandidates: EmailCandidate[] = [];

  // hunter employee DB hit (highest confidence — direct database match)
  if (hunterEmployeeEmail && !allEmails.has(hunterEmployeeEmail)) {
    extraCandidates.push({
      email: hunterEmployeeEmail,
      formatLabel: "hunter-employee-db",
      score: 95,
    });
    allEmails.add(hunterEmployeeEmail);
  }
  // hunter email-finder result
  if (hunterEmail && hunterEmail !== hunterEmployeeEmail && !allEmails.has(hunterEmail)) {
    extraCandidates.push({
      email: hunterEmail,
      formatLabel: "hunter-found",
      score: hunterScore ?? 50,
    });
    allEmails.add(hunterEmail);
  }
  if (snoviEmail && !allEmails.has(snoviEmail)) {
    extraCandidates.push({
      email: snoviEmail,
      formatLabel: "snov-found",
      score: 80,
    });
    allEmails.add(snoviEmail);
  }

  const mergedCandidates = [...extraCandidates, ...rawCandidates].sort(
    (a, b) => b.score - a.score
  );

  const results: EmailCandiateResult[] = mergedCandidates
    .slice(0, 10)
    .map((c): EmailCandiateResult => {
      const emailLower = c.email.toLowerCase();
      const isHunterEmployeeDbHit = emailLower === hunterEmployeeEmail;
      const isHunterFound = emailLower === hunterEmail || isHunterEmployeeDbHit;
      const isSnovFound = emailLower === snoviEmail;
      const isOwnBest = emailLower === ownBestEmail;

      // Own system status
      let ownStatus = "not_checked";
      let ownLabel = "Not checked";
      if (ownResult) {
        if (ownResult.status === "no_mx" || ownResult.status === "disposable") {
          ownStatus = ownResult.status;
          ownLabel =
            ownResult.status === "no_mx"
              ? "Domain has no MX records"
              : "Disposable email domain";
        } else if (isOwnBest && ownResult.bestEmail) {
          ownStatus = ownResult.status === "verified" ? "valid" : ownResult.status;
          ownLabel =
            ownResult.status === "verified"
              ? "Mailbox confirmed (SMTP 250)"
              : ownResult.status === "catch_all"
              ? "Catch-all domain (SMTP)"
              : ownResult.status === "smtp_unavailable"
              ? "SMTP not reachable (port 25 blocked)"
              : "SMTP inconclusive";
        } else if (ownResult.status === "smtp_unavailable") {
          ownStatus = "smtp_unavailable";
          ownLabel = "SMTP not reachable (port 25 blocked)";
        } else {
          ownStatus = "not_probed";
          ownLabel = "Not in top SMTP probes";
        }
      }

      const paid = paidResults.get(emailLower);

      // Overall confidence
      let overallConfidence: "high" | "medium" | "low" = "low";
      if (isHunterEmployeeDbHit) overallConfidence = "high"; // direct employee DB match
      else if (isHunterFound && (hunterScore ?? 0) >= 80) overallConfidence = "high";
      else if (isHunterFound && (hunterScore ?? 0) >= 50) overallConfidence = "medium";
      else if (isOwnBest && ownResult?.status === "verified") overallConfidence = "high";
      else if (isSnovFound) overallConfidence = "medium";
      else if (paid?.zb?.status === "valid") overallConfidence = "high";
      else if (paid?.zb?.status === "catch-all") overallConfidence = "medium";
      else if (paid?.ab?.status === "DELIVERABLE") overallConfidence = "high";
      else if (paid?.ab?.status === "RISKY") overallConfidence = "medium";
      // Pattern matched the known company format (Hunter domain-search pattern)
      else if (hunterDomainFormat && c.formatLabel === hunterDomainFormat) overallConfidence = "medium";
      else if (c.score >= 30) overallConfidence = "medium";

      const recipientAccepting: EmailCandiateResult["recipientAccepting"] = isCatchAllDomain
        ? "catch-all"
        : ownStatus === "valid" || paid?.zb?.status === "valid" || paid?.ab?.status === "DELIVERABLE"
        ? "yes"
        : paid?.zb?.status === "invalid_address" || paid?.ab?.status === "UNDELIVERABLE"
        ? "no"
        : "unknown";

      return {
        email: c.email,
        format: c.formatLabel,
        probability: c.score,
        sources: {
          generatedPattern: true,
          hunterFound: isHunterFound,
          hunterEmployeeDb: isHunterEmployeeDbHit,
          hunterConfidence: isHunterFound ? (isHunterEmployeeDbHit ? hunterEmployeeConfidence : hunterScore) : null,
          snovFound: isSnovFound,
        },
        verification: {
          ownSystem: { status: ownStatus, label: ownLabel },
          zeroBounce: paid?.zb
            ? { checked: true, status: paid.zb.status, label: paid.zb.label }
            : null,
          abstractApi: paid?.ab
            ? {
                checked: true,
                status: paid.ab.status,
                label: paid.ab.label,
                qualityScore: paid.ab.qualityScore,
              }
            : null,
        },
        overallConfidence,
        recipientAccepting,
      };
    });

  // ── Best email resolution ───────────────────────────────────────────────────
  let bestEmail: string | null = null;
  let bestEmailSource: string | null = null;

  const highConf = results.find((r) => r.overallConfidence === "high");
  const medConf = results.find((r) => r.overallConfidence === "medium");
  const bestCandidate = highConf ?? medConf ?? results[0] ?? null;

  if (bestCandidate) {
    bestEmail = bestCandidate.email;
    if (bestCandidate.sources.hunterEmployeeDb) bestEmailSource = "hunter.io (employee database)";
    else if (bestCandidate.sources.hunterFound) bestEmailSource = "hunter.io";
    else if (bestCandidate.sources.snovFound) bestEmailSource = "snov.io";
    else if (bestCandidate.verification.ownSystem.status === "valid")
      bestEmailSource = "smtp-verified";
    else bestEmailSource = "pattern-inference";
  }

  // ── Apollo.io employment verification ──────────────────────────────────────
  // Confirms whether the person currently works at the searched company,
  // surfaces their LinkedIn URL, and may reveal their actual email.
  // Run this AFTER best email is resolved so we can pass it as emailHint.
  type EmploymentResult = FindEmailResult["employment"];
  let employmentResult: EmploymentResult = null;
  const apolloKey = process.env.APOLLO_API_KEY ?? "";

  if (apolloKey) {
    const apolloRes = await apolloPeopleMatch(
      firstName,
      lastName,
      domain,
      company,
      apolloKey,
      bestEmail ?? undefined
    );
    if (apolloRes.ok) {
      // If Apollo has an email that isn't in our candidate list, add it to the
      // result as "apollo-found" so it shows up in the table with high confidence
      if (apolloRes.email && !results.some((r) => r.email.toLowerCase() === apolloRes.email)) {
        // We won't mutate `results` here but we surface it in the employment block.
        // If it's a better match, update bestEmail.
        if (!bestEmail || apolloRes.emailVerified) {
          bestEmail = apolloRes.email;
          bestEmailSource = "apollo.io (verified)";
        }
      }
      employmentResult = {
        checked: true,
        skipped: false,
        confirmedAtCompany: apolloRes.confirmedAtCompany,
        title: apolloRes.currentEmployment?.title ?? null,
        currentCompany: apolloRes.currentEmployment?.organizationName ?? null,
        linkedinUrl: apolloRes.linkedinUrl,
        apolloEmail: apolloRes.email,
        apolloEmailVerified: apolloRes.emailVerified,
        seniority: apolloRes.seniority,
        departments: apolloRes.departments,
        history: apolloRes.employmentHistory,
      };
    } else {
      employmentResult = {
        checked: true,
        skipped: apolloRes.reason === "plan_limit" || apolloRes.reason === "auth_error",
        skipReason: apolloRes.message,
        confirmedAtCompany: null,
        title: null,
        currentCompany: null,
        linkedinUrl: null,
        apolloEmail: null,
        apolloEmailVerified: false,
        seniority: null,
        departments: [],
        history: [],
      };
    }
  } else {
    employmentResult = {
      checked: false,
      skipped: true,
      skipReason: "APOLLO_API_KEY not configured",
      confirmedAtCompany: null,
      title: null,
      currentCompany: null,
      linkedinUrl: null,
      apolloEmail: null,
      apolloEmailVerified: false,
      seniority: null,
      departments: [],
      history: [],
    };
  }

  const result: FindEmailResult = {
    firstName,
    lastName,
    company,
    domain,
    domainMxValid,
    bestEmail,
    bestEmailSource,
    isCatchAllDomain,
    candidates: results,
    employment: employmentResult,
    ownEngine: {
      domainSource: body.domain?.trim() ? "provided" : hunterApiKey ? "hunter-resolved" : "inferred",
      mxRecords: mxResult.records.map((r) => `${r.exchange} (pri ${r.priority})`),
      hasSPF: dnsExtra.hasSPF,
      hasDMARC: dnsExtra.hasDMARC,
      spfRecord: dnsExtra.spfRecord,
      dmarcRecord: dnsExtra.dmarcRecord,
      patternsGenerated: rawCandidates.length,
      topPatterns: rawCandidates.slice(0, 5).map((c) => ({ email: c.email, format: c.formatLabel, score: c.score })),
      learnedPattern: getLearnedPattern(domain),
      hunterDomainPattern,
      hunterDomainFormat,
      smtpBlocked,
      smtpProbes: smtpProbeResults,
    },
  };

  return NextResponse.json(result);
}
