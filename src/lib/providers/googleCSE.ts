/**
 * Google Custom Search Engine (CSE) provider — LinkedIn X-Ray.
 *
 * FREE tier: 100 queries/day (~3,000/month). Official Google JSON API.
 * Same quality as SerpAPI (same Google index) but called directly.
 *
 * Setup (one-time, 5 minutes):
 *   1. Create a CSE at https://programmablesearchengine.google.com/
 *      → "Sites to search" = linkedin.com/in
 *      → Copy the Search Engine ID (cx=...)
 *   2. Enable "Custom Search API" at https://console.cloud.google.com/apis
 *      → Create credentials → API key
 *   3. Add to .env:  GOOGLE_CSE_API_KEY="..."  GOOGLE_CSE_CX="..."
 *
 * Returns the same SerpResult[] format used by the existing parser.
 */

import type { SerpResult } from "../serpapi";

export type CSEFailureReason = "rate_limit" | "no_results" | "auth_error" | "api_error";

export interface CSESuccess {
  ok: true;
  results: SerpResult[];
}

export interface CSEFailure {
  ok: false;
  reason: CSEFailureReason;
  message: string;
}

export type CSESearchResult = CSESuccess | CSEFailure;

interface GoogleCSEResponse {
  items?: Array<{
    title: string;
    link: string;
    snippet?: string;
  }>;
  error?: {
    code: number;
    message: string;
    errors?: Array<{ reason: string }>;
  };
}

/**
 * Run a single Google CSE query.
 */
async function searchGoogleCSE(
  query: string,
  apiKey: string,
  cx: string
): Promise<SerpResult[]> {
  const params = new URLSearchParams({
    key: apiKey,
    cx,
    q: query,
    num: "10",       // max 10 per request
    gl: "us",
    hl: "en",
  });

  const res = await fetch(
    `https://www.googleapis.com/customsearch/v1?${params.toString()}`,
    { cache: "no-store" }
  );

  if (res.status === 429) throw Object.assign(new Error("rate_limit"), { code: 429 });
  if (res.status === 403 || res.status === 401) throw Object.assign(new Error("auth_error"), { code: res.status });

  const data = (await res.json()) as GoogleCSEResponse;

  if (data.error) {
    const reason = data.error.errors?.[0]?.reason ?? "";
    if (reason === "dailyLimitExceeded" || reason === "rateLimitExceeded") {
      throw Object.assign(new Error("rate_limit"), { code: 429 });
    }
    throw new Error(`Google CSE error ${data.error.code}: ${data.error.message}`);
  }

  return (data.items ?? []).map((item) => ({
    title: item.title,
    link: item.link,
    snippet: item.snippet ?? "",
  }));
}

/**
 * Search Google CSE for LinkedIn profiles of company employees.
 *
 * Uses site:linkedin.com/in "Company" "Role" queries.
 * Falls through on quota exhaustion so the next provider in the chain runs.
 *
 * @param companyName  e.g. "Razorpay"
 * @param targetRole   e.g. "Software Engineer"
 * @param apiKey       GOOGLE_CSE_API_KEY
 * @param cx           GOOGLE_CSE_CX (Search Engine ID)
 */
export async function searchGoogleCSELinkedIn(
  companyName: string,
  targetRole: string,
  apiKey: string,
  cx: string
): Promise<CSESearchResult> {
  const c = companyName.trim();
  const r = targetRole.trim();

  // Build queries — quoted role for exact phrase match
  const queries: string[] = [];
  if (r) queries.push(`site:linkedin.com/in "${c}" "${r}"`);
  queries.push(
    `site:linkedin.com/in "${c}" "software engineer"`,
    `site:linkedin.com/in "${c}" "engineering manager"`,
    `site:linkedin.com/in "${c}" "technical recruiter"`,
    `site:linkedin.com/in "${c}"`,
  );
  // Deduplicate
  const deduped = [...new Set(queries)];

  const seen = new Set<string>();
  const allResults: SerpResult[] = [];

  for (const query of deduped.slice(0, 4)) {  // 4 queries × 10 results = up to 40 profiles
    try {
      const batch = await searchGoogleCSE(query, apiKey, cx);

      for (const item of batch) {
        const normLink = item.link.replace(/\?.*$/, "").replace(/\/+$/, "").toLowerCase();
        if (!seen.has(normLink) && /linkedin\.com\/in\//i.test(item.link)) {
          seen.add(normLink);
          allResults.push(item);
        }
      }

      if (allResults.length >= 30) break;
    } catch (err: unknown) {
      const e = err as { code?: number; message?: string };
      if (e.code === 429 || e.message === "rate_limit") {
        if (allResults.length > 0) break; // use what we have
        return {
          ok: false,
          reason: "rate_limit",
          message: "Google CSE daily limit reached (100 queries/day). Trying next provider.",
        };
      }
      if (e.code === 401 || e.code === 403 || e.message === "auth_error") {
        return {
          ok: false,
          reason: "auth_error",
          message: "Google CSE auth failed — check GOOGLE_CSE_API_KEY and GOOGLE_CSE_CX.",
        };
      }
      // Other error — try next query
      continue;
    }
  }

  if (allResults.length === 0) {
    return {
      ok: false,
      reason: "no_results",
      message: `Google CSE found 0 LinkedIn profiles for "${c}".`,
    };
  }

  return { ok: true, results: allResults };
}
