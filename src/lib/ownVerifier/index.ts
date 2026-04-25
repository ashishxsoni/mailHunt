/**
 * Own email verifier — orchestrates all local verification steps.
 *
 * Verification pipeline per email address set:
 *
 *   1. Disposable domain check — instant blocklist lookup
 *   2. MX record check — is there even a mail server? (via Node.js dns)
 *   3. SMTP probe — connect to MX server and check mailbox existence
 *      Uses the candidate list sorted by probability (see patternScorer.ts).
 *      - Probes candidates in order until one is confirmed valid or all are invalid
 *      - Auto-detects catch-all domains (tests a random email after a 250 response)
 *      - Gracefully degrades when port 25 is blocked (Vercel, cloud platforms)
 *   4. Domain pattern learning — records the verified format for future lookups
 *
 * Returns:
 *   status "verified"         → SMTP confirmed the mailbox exists
 *   status "catch_all"        → domain accepts all mail; email probably works
 *   status "smtp_unavailable" → port 25 blocked; fall through to paid verifiers
 *   status "no_mx"            → domain has no mail servers; all emails invalid
 *   status "disposable"       → throwaway email service; skip
 *   status "all_invalid"      → all probed candidates rejected by SMTP
 *   status "unknown"          → inconclusive (temp failures, greylisting)
 */

import type { EmailCandidate, Confidence } from "@/types";
import { isDisposableDomain } from "./disposableDomains";
import { lookupMx } from "./mxLookup";
import { probeSmtp, type SmtpProbeStatus } from "./smtpProbe";
import { learnDomainPattern } from "./patternScorer";

// ─── Result types ─────────────────────────────────────────────────────────

export type OwnVerifierStatus =
  | "verified"        // SMTP 250 + not catch-all
  | "catch_all"       // SMTP 250 but domain is catch-all
  | "smtp_unavailable" // Port 25 blocked from this host
  | "no_mx"           // Domain has no MX records
  | "disposable"      // Throwaway email domain
  | "all_invalid"     // All probed candidates returned SMTP 5xx
  | "unknown";        // Inconclusive (temp failures)

export interface OwnVerifierResult {
  /** Best email address found, or null if none could be confirmed */
  bestEmail: string | null;
  status: OwnVerifierStatus;
  confidence: Confidence;
  isCatchAll: boolean;
  /** false when port 25 is firewalled — caller should use paid verifier */
  smtpAvailable: boolean;
  /** Which MX server was queried */
  mxHost: string | null;
  /** How many SMTP probes were run */
  probesRun: number;
}

// ─── Status → confidence mapping ─────────────────────────────────────────────

function statusToConfidence(status: OwnVerifierStatus): Confidence {
  if (status === "verified") return "high";
  if (status === "catch_all") return "medium";
  return "low";
}

// ─── Main verifier ────────────────────────────────────────────────────────────

/**
 * Verify a set of email candidates (sorted best-first) for a domain.
 * Probes up to `maxProbes` SMTP addresses. Stops early when a valid one is found.
 *
 * @param domain      e.g. "stripe.com"
 * @param candidates  Sorted list from generateScoredCandidates(), best first
 * @param maxProbes   Max SMTP probes to run (default: 5 — covers top patterns)
 */
export async function verifyTopCandidates(
  domain: string,
  candidates: EmailCandidate[],
  maxProbes = 5
): Promise<OwnVerifierResult> {
  // ── Step 1: Disposable domain check ─────────────────────────────────────
  if (isDisposableDomain(domain)) {
    return {
      bestEmail: null,
      status: "disposable",
      confidence: "low",
      isCatchAll: false,
      smtpAvailable: true,
      mxHost: null,
      probesRun: 0,
    };
  }

  // ── Step 2: MX record check ──────────────────────────────────────────────
  const mx = await lookupMx(domain);
  if (!mx.hasMx || !mx.primaryHost) {
    return {
      bestEmail: null,
      status: "no_mx",
      confidence: "low",
      isCatchAll: false,
      smtpAvailable: true,
      mxHost: null,
      probesRun: 0,
    };
  }

  // All MX hosts sorted by priority — pass up to 2 for port fallback
  const mxHosts = mx.records.map((r) => r.exchange);

  // ── Step 3: SMTP probe candidates ───────────────────────────────────────
  const probe$ = candidates.slice(0, maxProbes);
  let probesRun = 0;
  let smtpAvailable = true;
  let bestEmail: string | null = null;
  let finalStatus: OwnVerifierStatus = "unknown";
  let isCatchAll = false;

  // Track whether all probes definitively rejected (status "invalid")
  let invalidCount = 0;

  for (const candidate of probe$) {
    probesRun++;
    const result = await probeSmtp(candidate.email, mxHosts);

    if (!result.smtpAvailable) {
      smtpAvailable = false;
      finalStatus = "smtp_unavailable";
      break;
    }

    if (result.status === "valid") {
      bestEmail = result.email;
      finalStatus = "verified";
      isCatchAll = false;
      // ── Pattern learning: record this format for the domain ────────────
      learnDomainPattern(domain, candidate.formatLabel);
      break;
    }

    if (result.status === "catch_all") {
      // All emails at this domain are accepted — use the top candidate (score-wise)
      bestEmail = candidates[0]?.email ?? result.email;
      finalStatus = "catch_all";
      isCatchAll = true;
      break;
    }

    if (result.status === "invalid") {
      invalidCount++;
      // Continue to next candidate — this format doesn't exist
      continue;
    }

    // "unknown" (temp failure) — stop probing and report unknown
    finalStatus = "unknown";
    break;
  }

  // All probed candidates were definitively invalid
  if (probesRun > 0 && invalidCount === probesRun && finalStatus === "unknown") {
    finalStatus = "all_invalid";
  }

  return {
    bestEmail,
    status: finalStatus,
    confidence: statusToConfidence(finalStatus),
    isCatchAll,
    smtpAvailable,
    mxHost: mx.primaryHost,
    probesRun,
  };
}

// ─── Domain-only MX check (used when we don't need SMTP) ──────────────────

/**
 * Fast check: does this domain have MX records AND is it non-disposable?
 * Use for the initial domain guard before building candidate lists.
 */
export async function quickDomainCheck(domain: string): Promise<{
  valid: boolean;
  reason: "ok" | "disposable" | "no_mx";
  mxHost: string | null;
}> {
  if (isDisposableDomain(domain)) {
    return { valid: false, reason: "disposable", mxHost: null };
  }
  const mx = await lookupMx(domain);
  if (!mx.hasMx) {
    return { valid: false, reason: "no_mx", mxHost: null };
  }
  return { valid: true, reason: "ok", mxHost: mx.primaryHost };
}
