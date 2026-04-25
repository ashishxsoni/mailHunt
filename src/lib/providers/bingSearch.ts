/**
 * Bing Web Search API provider — LinkedIn X-Ray.
 *
 * FREE tier: 1,000 queries/month via Microsoft Azure.
 * Official API — works server-side, no bot blocking.
 *
 * Setup (one-time, ~10 minutes):
 *   1. Go to https://portal.azure.com/
 *   2. Create resource → "Bing Search v7" → Free tier (F0: 1,000 tx/month)
 *   3. Keys and Endpoint → copy Key 1
 *   4. Add to .env:  BING_SEARCH_API_KEY="..."
 *
 * Alternative (faster): https://www.microsoft.com/en-us/bing/apis/bing-web-search-api
 *   → Try it free → Get API key instantly
 *
 * Returns the same SerpResult[] format used by the existing parser.
 */

import type { SerpResult } from "../serpapi";

export type BingFailureReason = "rate_limit" | "no_results" | "auth_error" | "api_error";

export interface BingSuccess {
  ok: true;
  results: SerpResult[];
}

export interface BingFailure {
  ok: false;
  reason: BingFailureReason;
  message: string;
}

export type BingSearchResult = BingSuccess | BingFailure;

interface BingWebPage {
  name: string;       // title
  url: string;        // link
  snippet: string;
}

interface BingSearchResponse {
  webPages?: {
    value?: BingWebPage[];
    totalEstimatedMatches?: number;
  };
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Run a single Bing Web Search query.
 */
async function searchBing(
  query: string,
  apiKey: string
): Promise<SerpResult[]> {
  const params = new URLSearchParams({
    q: query,
    count: "10",
    mkt: "en-US",
    responseFilter: "Webpages",
  });

  const res = await fetch(
    `https://api.bing.microsoft.com/v7.0/search?${params.toString()}`,
    {
      headers: {
        "Ocp-Apim-Subscription-Key": apiKey,
        "Accept": "application/json",
      },
      cache: "no-store",
    }
  );

  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error("auth_error"), { code: res.status });
  }
  if (res.status === 429) {
    throw Object.assign(new Error("rate_limit"), { code: 429 });
  }

  const data = (await res.json()) as BingSearchResponse;

  if (data.error) {
    if (data.error.code === "RateLimitExceeded" || data.error.code === "QuotaExceeded") {
      throw Object.assign(new Error("rate_limit"), { code: 429 });
    }
    throw new Error(`Bing API error: ${data.error.message}`);
  }

  return (data.webPages?.value ?? []).map((page) => ({
    title: page.name,
    link: page.url,
    snippet: page.snippet ?? "",
  }));
}

/**
 * Search Bing for LinkedIn profiles of company employees.
 *
 * Uses site:linkedin.com/in "Company" "Role" queries.
 * 1,000 free queries/month — nearly unlimited for job search use.
 *
 * @param companyName  e.g. "Razorpay"
 * @param targetRole   e.g. "Software Engineer"
 * @param apiKey       BING_SEARCH_API_KEY
 */
export async function searchBingLinkedIn(
  companyName: string,
  targetRole: string,
  apiKey: string
): Promise<BingSearchResult> {
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
  const deduped = [...new Set(queries)];

  const seen = new Set<string>();
  const allResults: SerpResult[] = [];

  for (const query of deduped.slice(0, 4)) {  // 4 queries × 10 = up to 40 profiles
    try {
      const batch = await searchBing(query, apiKey);

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
        if (allResults.length > 0) break;
        return {
          ok: false,
          reason: "rate_limit",
          message: "Bing Search monthly quota reached (1,000 queries/month). Trying next provider.",
        };
      }
      if (e.code === 401 || e.code === 403 || e.message === "auth_error") {
        return {
          ok: false,
          reason: "auth_error",
          message: "Bing Search auth failed — check BING_SEARCH_API_KEY.",
        };
      }
      continue;
    }
  }

  if (allResults.length === 0) {
    return {
      ok: false,
      reason: "no_results",
      message: `Bing found 0 LinkedIn profiles for "${c}".`,
    };
  }

  return { ok: true, results: allResults };
}
