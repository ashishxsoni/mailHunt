/**
 * Multi-provider fallback chain for contact discovery.
 *
 * Discovery providers (tried in order, each falls through on failure):
 *   1. Snov.io       — 150 credits/month, structured profiles + email finder
 *   2. Hunter.io     — 25 searches/month, returns real people AND emails directly
 *   +. SerpAPI       — ALWAYS runs (merged): site:linkedin.com/in "Company" "Role"
 *                      Finds real LinkedIn profiles → email guessing → validation
 *   3. GitHub        — FREE, unlimited; real employees from public GitHub profiles
 *
 * Email resolution per contact (in order):
 *   A) Provider already returned an email (Hunter.io)
 *   B) Snov.io batch email finder
 *   C) Own SMTP verifier — free, unlimited; MX check + SMTP handshake + catch-all detect
 *      ↳ Falls through when port 25 is firewalled (Vercel/cloud)
 *   D) ZeroBounce SMTP verifier (100/month — cloud fallback)
 *   E) Abstract API email verifier (100/month — second cloud fallback)
 *   F) Snov.io SMTP verifier on top-5 generated formats
 *   G) Top probability pattern inference (free, always works)
 *
 * Each provider either succeeds (people found) or fails with a typed reason.
 * Failures are collected as ProviderWarnings and returned in the response
 * so the frontend can show toast notifications.
 *
 * When "rate_limit" / "plan_limit" / "no_results": → try next provider
 * When "auth_error":                               → skip provider, try next
 * When "api_error":                               → try next provider
 */

import type { DiscoveredPerson, Confidence } from "@/types";
import {
  findProspectsByDomain,
  findEmailsBatchSnovi,
  verifyEmailCandidates,
  type SnoviLookupInput,
} from "./emailVerifier";
import { searchHunterByDomain } from "./providers/hunter";
import { searchGitHubByCompany } from "./providers/github";
import { verifyEmailZeroBounce } from "./providers/zerobounce";
import { verifyEmailAbstractApi } from "./providers/abstractapi";
import { verifyTopCandidates } from "./ownVerifier";
import { generateScoredCandidates } from "./ownVerifier/patternScorer";
import { runDiscoveryQueries } from "./serpapi";
import { searchDDGLinkedIn } from "./providers/duckduckgo";
import { searchGoogleCSELinkedIn } from "./providers/googleCSE";
import { searchBingLinkedIn } from "./providers/bingSearch";
import { extractPeopleFromResults } from "./resultsParser";
import { parseName, bestInferredEmail } from "./emailInference";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ProviderWarning {
  provider: "snov.io" | "github" | "hunter.io" | "serpapi" | "duckduckgo" | "google-cse" | "bing";
  reason: "rate_limit" | "plan_limit" | "auth_error" | "no_results" | "api_error";
  message: string;
}

export interface ResolvedContact {
  name: string;
  role: string;
  company: string;
  linkedinUrl?: string | null;
  email: string;
  emailSource: "verified" | "inferred" | "public";
  confidence: Confidence;
}

export interface ChainResult {
  contacts: ResolvedContact[];
  discoverySource: string;
  warnings: ProviderWarning[];
  rolesSearched: string[];
  domainMxValid: boolean;
  verifiedCount: number;
  inferredCount: number;
}

export interface ProviderConfig {
  snoviClientId: string;
  snoviClientSecret: string;
  githubToken: string;   // optional — raises rate limit from 10 to 30 req/min
  zeroBounceApiKey: string;
  abstractApiEmailKey: string;
  hunterApiKey: string;
  serpApiKey: string;
  googleCseApiKey: string;
  googleCseCx: string;
  bingSearchApiKey: string;
}

// ─── Default roles when targetRole is blank ─────────────────────────────────

export const DEFAULT_DISCOVERY_ROLES = [
  "Engineering Manager",
  "Software Engineer",
  "Senior Software Engineer",
  "Recruiter",
  "Technical Recruiter",
  "HR Manager",
  "Talent Acquisition",
  "Head of Engineering",
  "VP Engineering",
  "Director of Engineering",
];

// ─── Main chain function ─────────────────────────────────────────────────────

export async function discoverWithFallback(
  companyName: string,
  domain: string,
  domainHasMx: boolean,
  rolesToSearch: string[],
  cfg: ProviderConfig
): Promise<ChainResult> {
  const warnings: ProviderWarning[] = [];
  let discovered: DiscoveredPerson[] = [];
  // Pre-populated email map from providers that return emails directly (Hunter.io)
  let providerEmailMap = new Map<string, string>();
  let discoverySource = "none";

  // ── Provider 1: Snov.io ─────────────────────────────────────────────────
  if (cfg.snoviClientId && cfg.snoviClientSecret) {
    try {
      const people = await findProspectsByDomain(
        domain,
        rolesToSearch,
        cfg.snoviClientId,
        cfg.snoviClientSecret
      );

      if (people.length > 0) {
        discovered = people.map((p) => ({ ...p, company: companyName }));
        discoverySource = "snov.io";
      } else {
        warnings.push({
          provider: "snov.io",
          reason: "no_results",
          message: `Snov.io returned 0 prospects for ${domain}. Trying next provider.`,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // "not_enough_credits" signals quota exhaustion
      const reason = msg.toLowerCase().includes("credit") ? "rate_limit" : "api_error";
      warnings.push({
        provider: "snov.io",
        reason,
        message: `Snov.io discovery failed: ${msg}`,
      });
    }
  }

  // ── Provider 2: Hunter.io ──────────────────────────────────────────────
  // Direct database lookup: returns real employees WITH emails already included.
  // Moved up to Provider 2 because it's the most reliable for real people.
  if (discovered.length === 0 && cfg.hunterApiKey) {
    const result = await searchHunterByDomain(domain, cfg.hunterApiKey, rolesToSearch);

    if (result.ok) {
      discovered = result.people.map((p) => ({ ...p, company: companyName }));
      providerEmailMap = result.emailMap;
      discoverySource = "hunter.io";
    } else {
      warnings.push({
        provider: "hunter.io",
        reason: result.reason,
        message: result.message,
      });
    }
  }

  // ── LinkedIn X-Ray Search (cascade: SerpAPI → Google CSE → Bing → DDG) ──
  // All four use site:linkedin.com/in "Company" "Role" to find real profiles.
  // Tries each tier in order, uses results from the first that returns people.
  const primaryRole = rolesToSearch[0] ?? "software engineer";
  let linkedinXrayDone = false;

  // Tier 1: SerpAPI (100/month — fastest, most reliable)
  if (cfg.serpApiKey) {
    try {
      const searchResults = await runDiscoveryQueries(companyName, primaryRole, cfg.serpApiKey);
      const serpPeople = await extractPeopleFromResults(searchResults, companyName, primaryRole);
      if (serpPeople.length > 0) {
        const existingNames = new Set(discovered.map((p) => p.name.toLowerCase()));
        discovered = [...discovered, ...serpPeople.filter((p) => !existingNames.has(p.name.toLowerCase()))];
        if (!discoverySource || discoverySource === "none") discoverySource = "serpapi";
        linkedinXrayDone = true;
      } else if (discovered.length === 0) {
        warnings.push({ provider: "serpapi", reason: "no_results", message: `SerpAPI found 0 LinkedIn profiles for "${companyName} ${primaryRole}".` });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const reason = msg.includes("401") || msg.includes("403") ? "auth_error" : msg.includes("429") ? "rate_limit" : "api_error";
      if (discovered.length === 0) warnings.push({ provider: "serpapi", reason, message: `SerpAPI failed: ${msg}` });
    }
  }

  // Tier 2: Google Custom Search Engine (3,000/month free — official Google JSON API)
  if (!linkedinXrayDone && cfg.googleCseApiKey && cfg.googleCseCx) {
    const cseResult = await searchGoogleCSELinkedIn(companyName, primaryRole, cfg.googleCseApiKey, cfg.googleCseCx);
    if (cseResult.ok) {
      const csePeople = await extractPeopleFromResults(cseResult.results, companyName, primaryRole);
      if (csePeople.length > 0) {
        const existingNames = new Set(discovered.map((p) => p.name.toLowerCase()));
        discovered = [...discovered, ...csePeople.filter((p) => !existingNames.has(p.name.toLowerCase()))];
        if (!discoverySource || discoverySource === "none") discoverySource = "google-cse";
        linkedinXrayDone = true;
      }
    } else {
      warnings.push({ provider: "google-cse", reason: cseResult.reason, message: cseResult.message });
    }
  }

  // Tier 3: Bing Web Search API (1,000/month free — official Microsoft API via Azure)
  if (!linkedinXrayDone && cfg.bingSearchApiKey) {
    const bingResult = await searchBingLinkedIn(companyName, primaryRole, cfg.bingSearchApiKey);
    if (bingResult.ok) {
      const bingPeople = await extractPeopleFromResults(bingResult.results, companyName, primaryRole);
      if (bingPeople.length > 0) {
        const existingNames = new Set(discovered.map((p) => p.name.toLowerCase()));
        discovered = [...discovered, ...bingPeople.filter((p) => !existingNames.has(p.name.toLowerCase()))];
        if (!discoverySource || discoverySource === "none") discoverySource = "bing";
        linkedinXrayDone = true;
      }
    } else {
      warnings.push({ provider: "bing", reason: bingResult.reason, message: bingResult.message });
    }
  }

  // Tier 4: DuckDuckGo (free, no key — but blocked server-side on cloud hosts)
  if (!linkedinXrayDone) {
    try {
      const ddgResult = await searchDDGLinkedIn(companyName, primaryRole);
      if (ddgResult.ok && ddgResult.results.length > 0) {
        const ddgPeople = await extractPeopleFromResults(ddgResult.results, companyName, primaryRole);
        if (ddgPeople.length > 0) {
          const existingNames = new Set(discovered.map((p) => p.name.toLowerCase()));
          discovered = [...discovered, ...ddgPeople.filter((p) => !existingNames.has(p.name.toLowerCase()))];
          if (!discoverySource || discoverySource === "none") discoverySource = "duckduckgo";
        }
      } else if (!ddgResult.ok && discovered.length === 0) {
        warnings.push({ provider: "duckduckgo", reason: ddgResult.reason, message: ddgResult.message });
      }
    } catch {
      // DDG scraping failed (network error / bot-block) — continue with whatever we have
    }
  }

  // ── Provider 4: GitHub (FREE — real employees from public profiles) ─────
  // No API key required. Only uses githubToken if it looks like a real token
  // (length ≥ 20). Invalid short values like "12" are ignored.
  // Rate limit: 10 req/min unauthenticated, 30 req/min with valid token.
  if (discovered.length === 0) {
    const ghToken =
      cfg.githubToken && cfg.githubToken.length >= 20 ? cfg.githubToken : undefined;
    const ghResult = await searchGitHubByCompany(companyName, domain, ghToken);

    if (ghResult.ok) {
      discovered = ghResult.people.map((p) => ({ ...p, company: companyName }));
      // Index any public GitHub emails into the provider email map
      ghResult.emailMap.forEach((email, key) => providerEmailMap.set(key, email));
      discoverySource = "github";
    } else if (ghResult.reason !== "no_results") {
      // Only warn for actual errors — "no_results" is expected for non-tech companies
      warnings.push({
        provider: "github",
        reason: ghResult.reason,
        message: ghResult.reason === "rate_limit"
          ? "GitHub rate limited. Add GITHUB_TOKEN to .env for higher limits."
          : ghResult.message,
      });
    }
  }

  // ── No results from any provider → return empty (no fake contacts) ────
  // We only surface contacts that are real LinkedIn people. Department alias
  // emails from the self-contained fallback are misleading and unwanted.
  if (discovered.length === 0) {
    return {
      contacts: [],
      discoverySource,
      warnings,
      rolesSearched: rolesToSearch,
      domainMxValid: domainHasMx,
      verifiedCount: 0,
      inferredCount: 0,
    };
  }

  // ── Email resolution ─────────────────────────────────────────────────────
  // Priority per contact:
  //  A) Provider already returned email (Hunter.io)
  //  B) Snov.io Email Finder (from their verified database)
  //  C) Snov.io Email Verifier (SMTP-checks top 5 of 11 generated formats)
  //  D) Top probability pattern (free, always works)

  const useSnovio = !!(cfg.snoviClientId && cfg.snoviClientSecret);

  // Step B: Snov.io batch email finder
  let snoviEmailMap = new Map<string, { email: string; confidence: Confidence }>();
  if (useSnovio) {
    const snoviPeople: SnoviLookupInput[] = discovered.map((p) => {
      const { firstName, lastName } = parseName(p.name);
      return { firstName, lastName, key: p.name.toLowerCase() };
    });
    try {
      snoviEmailMap = await findEmailsBatchSnovi(
        snoviPeople,
        domain,
        cfg.snoviClientId,
        cfg.snoviClientSecret
      );
    } catch {
      // Non-fatal — fall through to verifier / inference
    }
  }

  // Build contacts in parallel
  const contacts: ResolvedContact[] = await Promise.all(
    discovered.slice(0, 20).map(async (person): Promise<ResolvedContact> => {
      const nameKey = person.name.toLowerCase();

      // Case A: Provider already has the email (Hunter.io, Apollo.io)
      const providerEmail = providerEmailMap.get(nameKey);
      if (providerEmail) {
        return {
          name: person.name,
          role: person.role,
          company: person.company,
          linkedinUrl: person.linkedinUrl ?? null,
          email: providerEmail,
          emailSource: "public",
          confidence: "high",
        };
      }

      // Case B: Snov.io email finder
      const snoviHit = snoviEmailMap.get(nameKey);
      if (snoviHit) {
        return {
          name: person.name,
          role: person.role,
          company: person.company,
          linkedinUrl: person.linkedinUrl ?? null,
          email: snoviHit.email,
          emailSource: "verified",
          confidence: snoviHit.confidence,
        };
      }

      // Case C: Own SMTP verifier (free, unlimited locally)
      const { firstName, lastName } = parseName(person.name);
      // Uses MX lookup + TCP handshake + catch-all detection.
      // Uses generateScoredCandidates (advanced patterns + domain learning).
      // Gracefully skips when port 25 is blocked (cloud platforms).
      const candidates = generateScoredCandidates(firstName, lastName, domain);
      const ownResult = await verifyTopCandidates(domain, candidates, 5);

      if (ownResult.status === "verified" && ownResult.bestEmail) {
        return {
          name: person.name,
          role: person.role,
          company: person.company,
          linkedinUrl: person.linkedinUrl ?? null,
          email: ownResult.bestEmail,
          emailSource: "verified",
          confidence: "high",
        };
      }

      if (ownResult.status === "catch_all" && ownResult.bestEmail) {
        // Domain accepts all mail — use top candidate, confidence medium
        return {
          name: person.name,
          role: person.role,
          company: person.company,
          linkedinUrl: person.linkedinUrl ?? null,
          email: ownResult.bestEmail,
          emailSource: "inferred",
          confidence: "medium",
        };
      }

      if (ownResult.status === "no_mx" || ownResult.status === "all_invalid") {
        // Domain has no mail servers or every tested format is rejected —
        // skip all paid verifiers (they'd hit the same wall) and infer
        const bestEmail = candidates[0]?.email ?? bestInferredEmail(person.name, domain);
        return {
          name: person.name,
          role: person.role,
          company: person.company,
          linkedinUrl: person.linkedinUrl ?? null,
          email: bestEmail,
          emailSource: "inferred",
          confidence: "low",
        };
      }

      // ownResult.status: "smtp_unavailable" | "unknown" — fall through to paid verifiers
      const topCandidate = candidates[0]?.email;

      // Case E: ZeroBounce SMTP verifier — check best candidate email
      if (cfg.zeroBounceApiKey && topCandidate) {
        try {
          const zbResult = await verifyEmailZeroBounce(topCandidate, cfg.zeroBounceApiKey);
          if (zbResult.ok) {
            return {
              name: person.name,
              role: person.role,
              company: person.company,
              linkedinUrl: person.linkedinUrl ?? null,
              email: zbResult.email,
              emailSource: zbResult.result === "valid" ? "verified" : "inferred",
              confidence: zbResult.confidence,
            };
          }
          // If invalid_address, don't fall through — skip to next candidate
        } catch {
          // Non-fatal — fall through
        }
      }

      // Case F: Abstract API verifier — check best candidate
      if (cfg.abstractApiEmailKey && topCandidate) {
        try {
          const abResult = await verifyEmailAbstractApi(topCandidate, cfg.abstractApiEmailKey);
          if (abResult.ok) {
            return {
              name: person.name,
              role: person.role,
              company: person.company,
              linkedinUrl: person.linkedinUrl ?? null,
              email: abResult.email,
              emailSource: abResult.deliverability === "DELIVERABLE" ? "verified" : "inferred",
              confidence: abResult.confidence,
            };
          }
        } catch {
          // Non-fatal — fall through
        }
      }

      // Case G: Snov.io Email Verifier on top 5 generated formats
      if (useSnovio && candidates.length > 0) {
        try {
          const verified = await verifyEmailCandidates(
            candidates,
            cfg.snoviClientId,
            cfg.snoviClientSecret,
            5
          );

          if (verified && verified.smtpStatus !== "not_verified") {
            return {
              name: person.name,
              role: person.role,
              company: person.company,
              linkedinUrl: person.linkedinUrl ?? null,
              email: verified.email,
              emailSource: verified.smtpStatus === "valid" ? "verified" : "inferred",
              confidence: verified.confidence,
            };
          }
        } catch {
          // Non-fatal
        }
      }

      // Case H: Top probability pattern inference (free, always works)
      const bestEmail = candidates[0]?.email ?? bestInferredEmail(person.name, domain);
      return {
        name: person.name,
        role: person.role,
        company: person.company,
        linkedinUrl: person.linkedinUrl ?? null,
        email: bestEmail,
        emailSource: "inferred",
        confidence: domainHasMx ? "medium" : "low",
      };
    })
  );

  return {
    contacts,
    discoverySource,
    warnings,
    rolesSearched: rolesToSearch,
    domainMxValid: domainHasMx,
    verifiedCount: contacts.filter((c) => c.emailSource === "verified").length,
    inferredCount: contacts.filter((c) => c.emailSource === "inferred" || c.emailSource === "public").length,
  };
}
