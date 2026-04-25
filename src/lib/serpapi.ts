export interface SerpResult {
  title: string;
  link: string;
  snippet: string;
}

/**
 * Build Google X-Ray queries that target ONLY LinkedIn profile pages.
 *
 * Format: site:linkedin.com/in "CompanyName" "Role"
 *
 * Using quoted role gives Google an exact phrase to match against the
 * LinkedIn profile title (e.g. "Rahul Sharma - Software Engineer at Razorpay | LinkedIn")
 * which dramatically improves precision vs. OR-keyword soup.
 *
 * All non-LinkedIn queries have been removed — the parser only accepts
 * linkedin.com/in/ URLs anyway, so they just burn API quota.
 */
export function buildSearchQueries(
  companyName: string,
  targetRole: string
): string[] {
  const c = companyName.trim();
  const r = targetRole.trim();

  // Primary role given by the caller (e.g. "Software Engineer")
  const queries: string[] = [];

  if (r) {
    // Exact match for the requested role — highest precision
    queries.push(`site:linkedin.com/in "${c}" "${r}"`);
  }

  // Always include these broad LinkedIn X-Ray queries to catch more people
  queries.push(
    // Broad company search — gets anyone with company in their title
    `site:linkedin.com/in "${c}"`,
    // Engineers / developers / tech roles
    `site:linkedin.com/in "${c}" "software engineer"`,
    `site:linkedin.com/in "${c}" "senior software engineer"`,
    `site:linkedin.com/in "${c}" "engineering manager"`,
    `site:linkedin.com/in "${c}" "product manager"`,
    // Hiring / people roles (most valuable for job seekers)
    `site:linkedin.com/in "${c}" "technical recruiter"`,
    `site:linkedin.com/in "${c}" recruiter`,
    `site:linkedin.com/in "${c}" "talent acquisition"`,
    // Leadership
    `site:linkedin.com/in "${c}" "head of engineering"`,
    `site:linkedin.com/in "${c}" "director of engineering"`,
  );

  // Deduplicate while preserving order
  return [...new Set(queries)];
}

/**
 * Execute a single query against SerpAPI (Google Search).
 * Returns an array of raw search result items.
 */
export async function searchWithSerpAPI(
  query: string,
  apiKey: string
): Promise<SerpResult[]> {
  const params = new URLSearchParams({
    engine: "google",
    q: query,
    api_key: apiKey,
    num: "10",  // 10 per query × many queries = enough coverage with less quota burn
    gl: "us",
    hl: "en",
  });

  const res = await fetch(
    `https://serpapi.com/search?${params.toString()}`,
    { next: { revalidate: 0 } }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SerpAPI error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    organic_results?: { title: string; link: string; snippet: string }[];
  };

  return (data.organic_results ?? []).map((r) => ({
    title: r.title,
    link: r.link,
    snippet: r.snippet,
  }));
}

/**
 * Run LinkedIn X-Ray queries and deduplicate results by URL.
 * Runs up to `maxQueries` queries, stopping early once enough profiles found.
 */
export async function runDiscoveryQueries(
  companyName: string,
  targetRole: string,
  apiKey: string,
  maxQueries = 6
): Promise<SerpResult[]> {
  const queries = buildSearchQueries(companyName, targetRole);

  const results: SerpResult[] = [];
  const seen = new Set<string>();

  for (const query of queries.slice(0, maxQueries)) {
    try {
      const batch = await searchWithSerpAPI(query, apiKey);
      for (const item of batch) {
        if (!seen.has(item.link)) {
          seen.add(item.link);
          results.push(item);
        }
      }
      // Stop once we have enough LinkedIn profiles
      if (results.length >= 30) break;
    } catch {
      // One query failing shouldn't abort the whole batch
      continue;
    }
  }

  return results;
}
