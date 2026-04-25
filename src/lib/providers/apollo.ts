/**
 * Apollo.io People Match — employment verification & email enrichment.
 *
 * Apollo is the most reliable free-tier enrichment API:
 *   - 50 exports/month free (people match)
 *   - Returns current employer, job title, LinkedIn URL, seniority
 *   - Can confirm whether the person CURRENTLY works at a company
 *   - Often has the actual email in their database (100M+ profiles)
 *
 * Free tier:  https://app.apollo.io/settings/integrations/api_keys
 * Docs:       https://apolloio.github.io/apollo-api-docs/#people-match-api
 *
 * Endpoint:  POST https://api.apollo.io/v1/people/match
 * Auth:      x-api-key header OR api_key in body
 *
 * We use "people/match" (not "people/search") because we have a specific
 * person in mind — match is more accurate and uses fewer credits.
 */

export interface ApolloEmployment {
  /** Current employer name, e.g. "Automation Anywhere" */
  organizationName: string | null;
  /** Current job title, e.g. "Senior Software Engineer" */
  title: string | null;
  /** When they started (ISO date string) */
  startDate: string | null;
  /** True = currently active at this org */
  isCurrent: boolean;
}

export interface ApolloPersonResult {
  ok: true;
  /** Apollo's own database ID */
  apolloId: string | null;
  /** Full name as stored in Apollo */
  name: string | null;
  /** Email Apollo has on file — may differ from what we searched */
  email: string | null;
  /** Whether Apollo's email has been verified */
  emailVerified: boolean;
  /** LinkedIn profile URL */
  linkedinUrl: string | null;
  /** Current employer (first current employment record) */
  currentEmployment: ApolloEmployment | null;
  /** All employment records (most recent first) */
  employmentHistory: ApolloEmployment[];
  /** Seniority level, e.g. "senior", "manager", "c_suite" */
  seniority: string | null;
  /** Department, e.g. "engineering", "sales" */
  departments: string[];
  /** Whether this person is confirmed to CURRENTLY work at the target domain */
  confirmedAtCompany: boolean;
  /** The domain we searched against */
  searchedDomain: string;
}

export interface ApolloPersonError {
  ok: false;
  reason: "not_found" | "auth_error" | "rate_limit" | "plan_limit" | "api_error";
  message: string;
}

export type ApolloResult = ApolloPersonResult | ApolloPersonError;

// ─── Apollo API response shape ────────────────────────────────────────────────

interface ApolloOrganization {
  id?: string;
  name?: string;
  website_url?: string;
  primary_domain?: string;
}

interface ApolloEmploymentRecord {
  _id?: string;
  current?: boolean;
  organization_id?: string;
  organization?: ApolloOrganization;
  title?: string;
  start_date?: string;
  end_date?: string;
}

interface ApolloPerson {
  id?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  email_status?: string; // "verified" | "guessed" | "unavailable" | "bounced" | "pending_manual_fulfillment"
  linkedin_url?: string;
  title?: string;
  seniority?: string;
  departments?: string[];
  organization?: ApolloOrganization;
  employment_history?: ApolloEmploymentRecord[];
}

interface ApolloMatchResponse {
  person?: ApolloPerson | null;
}

/**
 * Match a person by name + company domain to verify their current employment
 * and surface their actual email if Apollo has it.
 *
 * @param firstName   Given name
 * @param lastName    Surname
 * @param domain      Company domain, e.g. "automationanywhere.com"
 * @param company     Company name, e.g. "Automation Anywhere"
 * @param apiKey      Apollo.io API key
 * @param emailHint   Optional: if we already have a candidate email, pass it
 *                    so Apollo can confirm it (uses fewer credits than a full match)
 */
export async function apolloPeopleMatch(
  firstName: string,
  lastName: string,
  domain: string,
  company: string,
  apiKey: string,
  emailHint?: string
): Promise<ApolloResult> {
  try {
    const body: Record<string, string> = {
      first_name: firstName,
      last_name: lastName,
      organization_name: company,
      domain,
    };
    if (emailHint) body.email = emailHint; // narrows the match significantly

    const res = await fetch("https://api.apollo.io/v1/people/match", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "Cache-Control": "no-cache",
      },
      body: JSON.stringify(body),
      // Don't cache this in Next.js — each person lookup is unique
      next: { revalidate: 0 },
    });

    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: "auth_error", message: "Apollo API key is invalid or expired" };
    }
    if (res.status === 429) {
      return { ok: false, reason: "rate_limit", message: "Apollo rate limit reached — too many requests" };
    }
    if (res.status === 422) {
      // Unprocessable — person not found or insufficient data
      return { ok: false, reason: "not_found", message: "Person not found in Apollo database" };
    }
    if (!res.ok) {
      if (res.status >= 500 || res.status === 402) {
        const reason = res.status === 402 ? "plan_limit" : "api_error";
        return { ok: false, reason, message: `Apollo returned HTTP ${res.status}` };
      }
      return { ok: false, reason: "api_error", message: `Apollo returned HTTP ${res.status}` };
    }

    const json = (await res.json()) as ApolloMatchResponse;
    const person = json.person;

    if (!person) {
      return { ok: false, reason: "not_found", message: "Not found in Apollo database" };
    }

    // ── Parse employment history ───────────────────────────────────────────
    const employmentHistory: ApolloEmployment[] = (person.employment_history ?? []).map((e) => ({
      organizationName: e.organization?.name ?? null,
      title: e.title ?? null,
      startDate: e.start_date ?? null,
      isCurrent: e.current === true,
    }));

    // Find current employment
    const currentRecord = employmentHistory.find((e) => e.isCurrent) ?? null;
    const currentEmployment = currentRecord ?? (employmentHistory[0] ?? null);

    // ── Confirm they currently work at the target domain ──────────────────
    const targetDomainClean = domain.toLowerCase().replace(/^www\./, "");
    const orgWebsite = (person.organization?.website_url ?? "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "").replace(/^www\./, "");
    const orgDomain = (person.organization?.primary_domain ?? "").toLowerCase().replace(/^www\./, "");

    const confirmedAtCompany =
      orgDomain === targetDomainClean ||
      orgWebsite === targetDomainClean ||
      orgWebsite.endsWith(`.${targetDomainClean}`) ||
      (currentRecord?.organizationName ?? "").toLowerCase().trim() !== "" &&
      (person.organization?.name ?? "").toLowerCase().includes(company.toLowerCase().replace(/[^a-z0-9]/gi, "").slice(0, 8));

    return {
      ok: true,
      apolloId: person.id ?? null,
      name: person.name ?? null,
      email: person.email?.toLowerCase() ?? null,
      emailVerified: person.email_status === "verified",
      linkedinUrl: person.linkedin_url ?? null,
      currentEmployment,
      employmentHistory,
      seniority: person.seniority ?? null,
      departments: person.departments ?? [],
      confirmedAtCompany,
      searchedDomain: domain,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "api_error", message: `Apollo request failed: ${msg}` };
  }
}
