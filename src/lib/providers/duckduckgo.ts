/**
 * DuckDuckGo LinkedIn X-Ray scraper — FREE, no API key required.
 *
 * Performs the same site:linkedin.com/in "Company" "Role" search as SerpAPI
 * but through DuckDuckGo's public HTML endpoint. Used as a free fallback when
 * SerpAPI quota is exhausted (100 searches/month).
 *
 * Approach:
 *   GET https://html.duckduckgo.com/html/?q=site:linkedin.com/in "Company" "Role"
 *   Parse response HTML for result titles and LinkedIn profile URLs.
 *   Return the same SerpResult[] format so the existing resultsParser works unchanged.
 *
 * Rate limit: DDG has no hard per-key limit. Keep requests reasonable (~1/sec).
 * Note: DDG does not require authentication and does not block server-side requests
 *       as aggressively as Google does. Works well for infrequent searches.
 */

import type { SerpResult } from "../serpapi";

// ─── HTML parser ─────────────────────────────────────────────────────────────

/**
 * Parse DuckDuckGo HTML response and extract LinkedIn profile results.
 *
 * DDG HTML result format (html.duckduckgo.com):
 *   <h2 class="result__title">
 *     <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=ENCODED_URL&rut=...">Title</a>
 *   </h2>
 *   <div class="result__snippet">Snippet text</div>
 *
 * The actual URL is percent-encoded in the `uddg` query param.
 * Snippets are in adjacent result__snippet divs.
 */
function parseDDGHtml(html: string): SerpResult[] {
  const results: SerpResult[] = [];

  // Strategy: find all uddg= params (these are the real URLs after DDG redirect)
  // then walk backwards to find the anchor title and forwards for the snippet.
  // This is more robust than relying on a single anchor regex.
  const uddgRe = /uddg=([^&"'\s]+)/g;
  let m: RegExpExecArray | null;

  while ((m = uddgRe.exec(html)) !== null) {
    try {
      const link = decodeURIComponent(m[1]);

      // Only keep LinkedIn profile pages
      if (!/linkedin\.com\/in\//i.test(link)) continue;

      // Find the anchor tag that contains this uddg param.
      // Look backwards from the match position for <a
      const aStart = html.lastIndexOf("<a ", m.index);
      if (aStart === -1) continue;

      // Find the closing > of this <a tag, then get its text content
      const aTagEnd = html.indexOf(">", aStart);
      if (aTagEnd === -1) continue;

      const closeAnchor = html.indexOf("</a>", aTagEnd);
      if (closeAnchor === -1) continue;

      const titleHtml = html.substring(aTagEnd + 1, closeAnchor);
      const title = titleHtml
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();

      if (!title || title.length < 5) continue;

      // Look for the snippet: find result__snippet div after this position
      const snippetStart = html.indexOf('result__snippet', closeAnchor);
      let snippet = "";
      if (snippetStart !== -1 && snippetStart - closeAnchor < 800) {
        const snippetBodyStart = html.indexOf(">", snippetStart) + 1;
        const snippetBodyEnd = html.indexOf("</", snippetBodyStart);
        if (snippetBodyEnd !== -1 && snippetBodyEnd - snippetBodyStart < 400) {
          snippet = html
            .substring(snippetBodyStart, snippetBodyEnd)
            .replace(/<[^>]+>/g, "")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/\s+/g, " ")
            .trim();
        }
      }

      results.push({ title, link, snippet });
    } catch {
      continue;
    }
  }

  return results;
}

// ─── Single query ─────────────────────────────────────────────────────────────

/**
 * Execute one DuckDuckGo HTML search and return raw LinkedIn profile results.
 */
async function searchDDG(query: string): Promise<SerpResult[]> {
  const url =
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=us-en`;

  const res = await fetch(url, {
    headers: {
      // DDG requires a browser-like user-agent or it returns a CAPTCHA page
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
    // No caching — always fresh results
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`DuckDuckGo returned ${res.status}`);
  }

  const html = await res.text();
  return parseDDGHtml(html);
}

// ─── Main export ─────────────────────────────────────────────────────────────

export type DDGFailureReason = "rate_limit" | "no_results" | "api_error";

export interface DDGSuccess {
  ok: true;
  results: SerpResult[];
}

export interface DDGFailure {
  ok: false;
  reason: DDGFailureReason;
  message: string;
}

export type DDGSearchResult = DDGSuccess | DDGFailure;

/**
 * Run DuckDuckGo X-Ray search for LinkedIn profiles of company employees.
 *
 * Queries used (same logic as SerpAPI but free):
 *   site:linkedin.com/in "Company" "primary role"
 *   site:linkedin.com/in "Company"          ← broad catch-all
 *   site:linkedin.com/in "Company" recruiter
 *
 * @param companyName  e.g. "Razorpay"
 * @param targetRole   e.g. "Software Engineer"  (empty = use broad queries)
 */
export async function searchDDGLinkedIn(
  companyName: string,
  targetRole: string
): Promise<DDGSearchResult> {
  const c = companyName.trim();
  const r = targetRole.trim();

  // Build queries (quoted role = exact phrase match)
  const queries: string[] = [];
  if (r) queries.push(`site:linkedin.com/in "${c}" "${r}"`);
  queries.push(
    `site:linkedin.com/in "${c}" "software engineer"`,
    `site:linkedin.com/in "${c}" "engineering manager"`,
    `site:linkedin.com/in "${c}" "technical recruiter"`,
    `site:linkedin.com/in "${c}"`,
  );

  const seen = new Set<string>();
  const allResults: SerpResult[] = [];

  for (const query of queries) {
    try {
      const batch = await searchDDG(query);

      for (const item of batch) {
        // Normalise LinkedIn URL (strip trailing slash / query params)
        const normLink = item.link
          .replace(/\?.*$/, "")
          .replace(/\/+$/, "")
          .toLowerCase();

        if (!seen.has(normLink)) {
          seen.add(normLink);
          allResults.push(item);
        }
      }

      // Enough profiles collected — stop to be polite to DDG servers
      if (allResults.length >= 20) break;

      // Small delay between requests to avoid hitting rate limits
      await new Promise((r) => setTimeout(r, 800));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // "429" means we're being rate limited by DDG
      if (msg.includes("429")) {
        if (allResults.length > 0) break;
        return {
          ok: false,
          reason: "rate_limit",
          message: "DuckDuckGo rate limited. Try again in a few minutes.",
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
      message: `DuckDuckGo found 0 LinkedIn profiles for "${c}".`,
    };
  }

  return { ok: true, results: allResults };
}
