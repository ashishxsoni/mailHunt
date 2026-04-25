/**
 * Snov.io integration layer.
 *
 * When Snov.io credentials are present, this module handles:
 *  1. Prospect Discovery  — Domain Search Prospects API (replaces SerpAPI)
 *                           Cost: 1 credit per page of 20 people
 *  2. Email Finder        — Batch email lookup by name + domain
 *                           Cost: 1 credit per email found
 *  3. MX domain check     — free, unlimited, Node.js built-in dns module
 *
 * Without credentials, the discover route falls back to SerpAPI.
 */

import { promises as dns } from "dns";
import type { Confidence, DiscoveredPerson, EmailCandidate } from "@/types";

// ─── Snov.io OAuth token cache (per process lifetime) ──────────────────────

let _cachedToken: { value: string; expiresAt: number } | null = null;

async function getSnoviToken(
  clientId: string,
  clientSecret: string
): Promise<string> {
  if (_cachedToken && _cachedToken.expiresAt > Date.now()) {
    return _cachedToken.value;
  }

  const res = await fetch("https://api.snov.io/v1/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    throw new Error(`Snov.io auth failed ${res.status}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };

  // Refresh 60 s before expiry to avoid edge-of-expiry failures
  _cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };

  return _cachedToken.value;
}

// ─── Snov.io types ─────────────────────────────────────────────────────────

interface SnoviEmailEntry {
  email: string;
  smtp_status: "valid" | "unknown" | "not_valid";
  is_valid_format: boolean;
}

interface SnoviFinderResult {
  status: "completed" | "in_progress" | "not_enough_credits";
  data?: Array<{
    people: string;
    result: SnoviEmailEntry[];
  }>;
}

// ─── Polling helper ─────────────────────────────────────────────────────────

async function pollWithBackoff(
  token: string,
  taskHash: string,
  maxAttempts = 8
): Promise<SnoviFinderResult> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(
      `https://api.snov.io/v2/emails-by-domain-by-name/result?task_hash=${encodeURIComponent(taskHash)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!res.ok) throw new Error(`Snov.io poll error ${res.status}`);

    const data = (await res.json()) as SnoviFinderResult;

    if (data.status === "completed" || data.status === "not_enough_credits") {
      return data;
    }

    // Increasing back-off: 1 s, 2 s, 3 s … up to ~28 s total
    await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
  }

  throw new Error("Snov.io polling timed out after 8 attempts");
}

// ─── Public: Snov.io batch email finder ─────────────────────────────────────

export interface SnoviLookupInput {
  firstName: string;
  lastName: string;
  /** Normalised lower-case full name used as map key */
  key: string;
}

export interface ResolvedEmail {
  email: string;
  confidence: Confidence;
  source: "verified" | "inferred" | "mx-inferred";
}

const SNOVI_BATCH_SIZE = 10; // Snov.io limit per request

/**
 * Batch-find emails for up to 20 people at a given domain via Snov.io.
 * Returns a Map keyed by the lowercase full name.
 * Gracefully returns an empty Map if credentials are missing or the API fails.
 */
export async function findEmailsBatchSnovi(
  people: SnoviLookupInput[],
  domain: string,
  clientId: string,
  clientSecret: string
): Promise<Map<string, ResolvedEmail>> {
  const results = new Map<string, ResolvedEmail>();

  try {
    const token = await getSnoviToken(clientId, clientSecret);

    for (let i = 0; i < people.length; i += SNOVI_BATCH_SIZE) {
      const batch = people.slice(i, i + SNOVI_BATCH_SIZE);

      const startRes = await fetch(
        "https://api.snov.io/v2/emails-by-domain-by-name/start",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            rows: batch.map((p) => ({
              first_name: p.firstName,
              last_name: p.lastName,
              domain,
            })),
          }),
        }
      );

      if (!startRes.ok) {
        continue;
      }

      const startData = (await startRes.json()) as {
        data?: { task_hash: string };
      };
      const taskHash = startData.data?.task_hash;
      if (!taskHash) continue;

      const resultData = await pollWithBackoff(token, taskHash);

      if (resultData.status !== "completed" || !resultData.data) continue;

      resultData.data.forEach((person, idx) => {
        const original = batch[idx];
        if (!original) return;

        // Filter out invalid format and hard-invalid SMTP
        const valid = person.result.filter(
          (e) => e.is_valid_format && e.smtp_status !== "not_valid"
        );

        if (valid.length === 0) return;

        const best = valid[0];
        const confidence: Confidence =
          best.smtp_status === "valid" ? "high" : "medium";

        results.set(original.key, {
          email: best.email,
          confidence,
          source: "verified",
        });
      });
    }
  } catch {
    // Never crash the discovery flow — email resolution is best-effort
  }

  return results;
}

// ─── Public: Free MX domain validation ─────────────────────────────────────

/**
 * Check whether a domain has MX records (i.e. actually receives email).
 * Uses the Node.js built-in `dns` module — zero API cost, unlimited calls.
 *
 * Returns true  → domain is live and has mail servers
 * Returns false → domain is dead, mis-spelled, or has no MX records
 */
export async function validateDomainMx(domain: string): Promise<boolean> {
  try {
    const records = await dns.resolveMx(domain);
    return records.length > 0;
  } catch {
    return false;
  }
}

// ─── Public: Snov.io Prospect Discovery (replaces SerpAPI) ─────────────────

interface SnoviProspectItem {
  first_name: string;
  last_name: string;
  position: string;
  source_page: string;
}

interface SnoviProspectsResult {
  status: "completed" | "in_progress";
  data?: SnoviProspectItem[];
  meta?: { task_hash: string; total_count: number };
}

/**
 * Discover people at a company domain filtered by job positions.
 * Uses Snov.io Domain Search API — replaces SerpAPI entirely.
 *
 * Correct endpoints (from Snov.io docs):
 *   START:  POST /v2/domain-search/start  (form-encoded)
 *   RESULT: GET  /v2/domain-search/prospects/result/{task_hash}
 *
 * Cost: 1 credit per request (returns up to 20 structured profiles).
 */
export async function findProspectsByDomain(
  domain: string,
  positions: string[],
  clientId: string,
  clientSecret: string
): Promise<DiscoveredPerson[]> {
  try {
    const token = await getSnoviToken(clientId, clientSecret);

    // Snov.io domain-search uses form-encoded body, not JSON
    const formBody = new URLSearchParams();
    formBody.set("domain", domain);
    formBody.set("page", "1");
    positions.forEach((p) => formBody.append("positions[]", p));

    const startRes = await fetch("https://api.snov.io/v2/domain-search/start", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formBody.toString(),
    });

    if (!startRes.ok) {
      return [];
    }

    const startData = (await startRes.json()) as {
      meta?: { task_hash: string };
      links?: { result?: string };
    };

    // Task hash lives in meta
    const taskHash = startData.meta?.task_hash;
    if (!taskHash) {
      return [];
    }

    // Poll for results at the prospects result endpoint
    for (let attempt = 0; attempt < 8; attempt++) {
      const pollRes = await fetch(
        `https://api.snov.io/v2/domain-search/prospects/result/${encodeURIComponent(taskHash)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (!pollRes.ok) {
        break;
      }

      const data = (await pollRes.json()) as SnoviProspectsResult;

      if (data.status === "completed") {
        const items = data.data ?? [];
        return items.map((p) => ({
          name: `${p.first_name} ${p.last_name}`.trim(),
          role: p.position,
          company: domain,
          linkedinUrl: p.source_page || undefined,
          source: "snov.io",
        }));
      }

      await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
    }

    return [];
  } catch {
    return [];
  }
}

// ─── Public: Rank inferred candidates via Snov.io Email Verifier ───────────

interface SnoviVerifyItem {
  email: string;
  result: {
    smtp_status: "valid" | "unknown" | "not_valid";
    is_valid_format: boolean;
    is_disposable: boolean;
  };
}

interface SnoviVerifyResult {
  status: "completed" | "in_progress";
  data?: SnoviVerifyItem[];
}

/**
 * Take a sorted list of inferred email candidates, verify the top ones via
 * Snov.io's Email Verifier, and return the best confirmed address.
 *
 * Priority: smtp_status "valid" > "unknown" > pattern score (inferred).
 * Verifies only the top `maxToVerify` candidates to conserve credits.
 *
 * Returns null when no candidates are provided or the API call fails,
 * so the caller can fall back to pure pattern inference.
 */
export async function verifyEmailCandidates(
  candidates: EmailCandidate[],
  clientId: string,
  clientSecret: string,
  maxToVerify = 5
): Promise<{ email: string; confidence: Confidence; smtpStatus: string } | null> {
  if (candidates.length === 0) return null;

  // Only verify the top N highest-scoring candidates to save credits
  const toVerify = candidates.slice(0, maxToVerify).map((c) => c.email);

  try {
    const token = await getSnoviToken(clientId, clientSecret);

    const startRes = await fetch("https://api.snov.io/v2/email-verification/start", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ emails: toVerify }),
    });

    if (!startRes.ok) {
      return null;
    }

    const startData = (await startRes.json()) as { data?: { task_hash: string } };
    const taskHash = startData.data?.task_hash;
    if (!taskHash) return null;

    // Poll for verification results
    for (let attempt = 0; attempt < 8; attempt++) {
      const pollRes = await fetch(
        `https://api.snov.io/v2/email-verification/result?task_hash=${encodeURIComponent(taskHash)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (!pollRes.ok) break;

      const data = (await pollRes.json()) as SnoviVerifyResult;

      if (data.status === "completed" && data.data) {
        // Annotate original candidates with smtp_status
        const statusMap = new Map(data.data.map((r) => [r.email, r]));

        const annotated = candidates.map((c) => ({
          ...c,
          verified: statusMap.get(c.email),
        }));

        // 1st choice: any email confirmed "valid"
        const validHit = annotated.find((c) => c.verified?.result.smtp_status === "valid");
        if (validHit) {
          return { email: validHit.email, confidence: "high", smtpStatus: "valid" };
        }

        // 2nd choice: highest-score email where smtp is "unknown" (catchall / inconclusive)
        const unknownHit = annotated.find((c) => c.verified?.result.smtp_status === "unknown");
        if (unknownHit) {
          return { email: unknownHit.email, confidence: "medium", smtpStatus: "unknown" };
        }

        // All verified = not_valid; return top pattern-score candidate as low confidence
        return {
          email: candidates[0]!.email,
          confidence: "low",
          smtpStatus: "not_verified",
        };
      }

      await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
    }

    return null;
  } catch {
    return null;
  }
}
