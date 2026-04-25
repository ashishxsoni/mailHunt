/**
 * Hunter.io provider — domain search.
 *
 * Free tier: 25 searches/month — https://hunter.io/api-documentation
 * Returns people at a company domain WITH emails already included.
 *
 * Status → failure reason mapping:
 *   400 pagination_error  → plan_limit  (free plan result cap — soft warning)
 *   401 / 403             → auth_error
 *   429                   → rate_limit  (monthly quota gone)
 *   500+                  → api_error
 */

import type { DiscoveredPerson } from "@/types";

export type HunterFailureReason =
  | "rate_limit"
  | "plan_limit"
  | "auth_error"
  | "no_results"
  | "api_error";

export interface HunterSuccess {
  ok: true;
  people: DiscoveredPerson[];
  /** Pre-resolved emails keyed by lowercase full name */
  emailMap: Map<string, string>;
}

export interface HunterFailure {
  ok: false;
  reason: HunterFailureReason;
  message: string;
}

export type HunterSearchResult = HunterSuccess | HunterFailure;

interface HunterEmail {
  value: string;
  type: "personal" | "generic";
  first_name: string | null;
  last_name: string | null;
  position: string | null;
  linkedin: string | null;
  confidence: number;
}

interface HunterDomainResponse {
  data?: {
    domain: string;
    emails?: HunterEmail[];
  };
  errors?: Array<{ id: string; code?: number; details: string }>;
  meta?: { results: number };
}

/**
 * Search Hunter.io for all people at a domain.
 * Free plan hits a "pagination_error" (400) when results exceed plan limit.
 * This is treated as a soft plan_limit — falls through to next provider.
 */
export async function searchHunterByDomain(
  domain: string,
  apiKey: string,
  roles?: string[]
): Promise<HunterSearchResult> {
  try {
    const params = new URLSearchParams({
      domain,
      api_key: apiKey,
      limit: "10",
      type: "personal",
    });

    const res = await fetch(
      `https://api.hunter.io/v2/domain-search?${params.toString()}`,
      { next: { revalidate: 0 } }
    );

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        reason: "auth_error",
        message: `Hunter.io auth failed (${res.status}) — check HUNTER_API_KEY`,
      };
    }

    if (res.status === 429) {
      return {
        ok: false,
        reason: "rate_limit",
        message: "Hunter.io monthly quota exceeded (25 searches/month). Trying next provider.",
      };
    }

    if (res.status === 400) {
      // Free plan returns 400 with "pagination_error" when results are capped
      const json = await res.json().catch(() => ({})) as HunterDomainResponse;
      const errId = json.errors?.[0]?.id ?? "unknown";
      return {
        ok: false,
        reason: "plan_limit",
        message: `Hunter.io free plan limit for this domain (${errId}). Trying next provider.`,
      };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        reason: "api_error",
        message: `Hunter.io API error ${res.status}: ${text.slice(0, 120)}`,
      };
    }

    const json = (await res.json()) as HunterDomainResponse;
    const allEmails = json.data?.emails ?? [];

    // Filter to only personal emails with a name
    const personal = allEmails.filter(
      (e) => e.first_name && e.last_name && e.value && e.type === "personal"
    );

    if (personal.length === 0) {
      return { ok: false, reason: "no_results", message: "Hunter.io returned 0 personal contacts for this domain." };
    }

    // Optional role filter (client-side)
    const roleLower = roles?.map((r) => r.toLowerCase()) ?? [];
    const filtered =
      roleLower.length > 0
        ? personal.filter((e) => {
            if (!e.position) return false;
            const pos = e.position.toLowerCase();
            return roleLower.some((r) => pos.includes(r.split(" ")[0]!));
          })
        : personal;

    // If role filter removed everything, use all personal results
    const toUse = filtered.length > 0 ? filtered : personal;

    const people: DiscoveredPerson[] = toUse.map((e) => ({
      name: `${e.first_name} ${e.last_name}`.trim(),
      role: e.position ?? "Unknown",
      company: domain,
      linkedinUrl: e.linkedin ?? undefined,
      publicEmail: e.value,
      source: "hunter.io",
    }));

    const emailMap = new Map<string, string>();
    toUse.forEach((e) => {
      const key = `${e.first_name} ${e.last_name}`.trim().toLowerCase();
      emailMap.set(key, e.value);
    });

    return { ok: true, people, emailMap };
  } catch (err) {
    return {
      ok: false,
      reason: "api_error",
      message: `Hunter.io exception: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
