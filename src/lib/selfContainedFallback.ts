/**
 * Self-contained discovery fallback — generates likely contacts using only the domain.
 *
 * Used as Provider 5 when ALL external discovery APIs fail or return 0 results.
 * Requires NO API keys or external services (except optional ownVerifier SMTP probe).
 *
 * Strategy:
 *  1. Build a list of role-based department email aliases common in companies:
 *     recruiter@, hr@, hiring@, careers@, talent@, engineering@, etc.
 *  2. SMTP-verify each one using our free ownVerifier
 *  3. Also generate per-targetRole synthetic contacts with probability-ranked
 *     email patterns (using the patternScorer for realistic email guesses)
 *  4. Return verified contacts (or inferred if SMTP is unavailable)
 *
 * This gives the user SOMETHING even when every API is down/over-quota.
 */

import type { DiscoveredPerson, Confidence } from "@/types";
import { verifyTopCandidates, quickDomainCheck } from "./ownVerifier";
import type { ResolvedContact } from "./providerChain";

// ─── Role → department alias mapping ─────────────────────────────────────────
// Maps target role keywords → ordered list of likely alias emails to try first.

const ROLE_ALIASES: Array<{
  label: string;       // Display role name
  keywords: string[];  // Words that trigger this entry
  aliases: string[];   // Ordered best→worst email alias to try
  fakeName: string;    // Synthetic name for display
}> = [
  {
    label: "Technical Recruiter",
    keywords: ["recruit", "talent", "hiring", "sourcer"],
    aliases: ["recruiter", "recruiting", "talent", "hiring", "careers", "jobs"],
    fakeName: "Talent Acquisition",
  },
  {
    label: "HR Manager",
    keywords: ["hr", "human resources", "people", "people ops"],
    aliases: ["hr", "humanresources", "people", "peopleteam"],
    fakeName: "HR Team",
  },
  {
    label: "Engineering Manager",
    keywords: ["engineering manager", "eng manager", "head of eng"],
    aliases: ["engineering", "tech", "dev"],
    fakeName: "Engineering Team",
  },
  {
    label: "Head of Engineering",
    keywords: ["head of engineering", "vp engineering", "vp eng", "director of engineering"],
    aliases: ["cto", "engineering", "tech", "dev"],
    fakeName: "Engineering Leadership",
  },
  {
    label: "Software Engineer",
    keywords: ["engineer", "developer", "dev", "swe", "software"],
    aliases: ["dev", "developers", "engineering", "tech"],
    fakeName: "Engineering Team",
  },
];

// Generic aliases that are tried for ANY company regardless of role
const GENERIC_ALIASES = ["careers", "jobs", "hiring", "hello", "info", "contact"];

// ─── Helper: find matching role entry ─────────────────────────────────────────

function findRoleEntry(roleName: string): typeof ROLE_ALIASES[number] | null {
  const lower = roleName.toLowerCase();
  for (const entry of ROLE_ALIASES) {
    if (entry.keywords.some((kw) => lower.includes(kw))) return entry;
  }
  return null;
}

// ─── Main function ─────────────────────────────────────────────────────────

export interface SelfContainedResult {
  contacts: ResolvedContact[];
  /** true if SMTP was available and verified at least one address */
  smtpVerified: boolean;
  mxHost: string | null;
}

/**
 * Discover contacts using only the company domain (no external APIs needed).
 *
 * @param companyName   e.g. "Stripe"
 * @param domain        e.g. "stripe.com"
 * @param rolesToSearch Target roles to look for
 * @param domainHasMx   Pre-computed MX result from the outer chain
 */
export async function discoverSelfContained(
  companyName: string,
  domain: string,
  rolesToSearch: string[],
  domainHasMx: boolean
): Promise<SelfContainedResult> {
  // Quick check (deduplicates with outer chain's validateDomainMx)
  const domainCheck = await quickDomainCheck(domain);
  if (!domainCheck.valid) {
    return { contacts: [], smtpVerified: false, mxHost: null };
  }

  const mxHost = domainCheck.mxHost;
  const contacts: ResolvedContact[] = [];
  let smtpVerified = false;
  const seenEmails = new Set<string>();

  // ── Step 1: Role-based alias emails ──────────────────────────────────────
  const triedAliases = new Set<string>();
  const candidateAliases: Array<{ alias: string; label: string; fakeName: string }> = [];

  // Build alias list from target roles
  for (const role of rolesToSearch) {
    const entry = findRoleEntry(role);
    if (entry) {
      for (const alias of entry.aliases) {
        if (!triedAliases.has(alias)) {
          triedAliases.add(alias);
          candidateAliases.push({
            alias,
            label: entry.label,
            fakeName: entry.fakeName,
          });
        }
      }
    }
  }

  // Add generic aliases
  for (const alias of GENERIC_ALIASES) {
    if (!triedAliases.has(alias)) {
      triedAliases.add(alias);
      candidateAliases.push({ alias, label: "General", fakeName: "Hiring Team" });
    }
  }

  // Try alias emails via SMTP probe
  for (const { alias, label, fakeName } of candidateAliases.slice(0, 10)) {
    const email = `${alias}@${domain}`;
    if (seenEmails.has(email)) continue;

    // Build a single-candidate list for the verifier
    const singleCandidate = [{ email, formatLabel: alias, score: 50 }];
    const result = await verifyTopCandidates(domain, singleCandidate, 1);

    if (result.status === "verified") {
      seenEmails.add(email);
      smtpVerified = true;
      contacts.push({
        name: `${companyName} ${fakeName}`,
        role: label,
        company: companyName,
        linkedinUrl: null,
        email,
        emailSource: "verified",
        confidence: "high",
      });
    } else if (result.status === "catch_all") {
      // Domain is catch-all — the first alias works, move on
      seenEmails.add(email);
      smtpVerified = true;
      contacts.push({
        name: `${companyName} ${fakeName}`,
        role: label,
        company: companyName,
        linkedinUrl: null,
        email,
        emailSource: "inferred",
        confidence: "medium",
      });
      // All emails at this domain are valid — no need to probe more
      break;
    } else if (result.status === "smtp_unavailable") {
      // Port 25 blocked — fall through to inference below
      break;
    }
    // "invalid" or "unknown" — try next alias
  }

  // ── Step 2: Pattern-inference contacts (always works — no SMTP needed) ───
  // Even if SMTP found nothing, produce inferred contacts for each role so the
  // user always gets SOMETHING to start from.
  const confidence: Confidence = domainHasMx ? "medium" : "low";

  // Synthetic "name" pairs for common roles — more realistic than "Engineering Team"
  const ROLE_NAMES: Record<string, string[]> = {
    "Technical Recruiter": ["Talent Team", "Recruiting"],
    "HR Manager": ["HR Team", "People Ops"],
    "Engineering Manager": ["Engineering Hiring", "Tech Team"],
    "Recruiter": ["Talent Acquisition", "Recruiting"],
  };

  for (const role of rolesToSearch.slice(0, 5)) {
    const entry = findRoleEntry(role) ?? { label: role, aliases: ["info"], fakeName: "Team" };
    const displayNames = ROLE_NAMES[role] ?? [entry.fakeName];
    const topAlias = entry.aliases[0] ?? "info";
    const email = `${topAlias}@${domain}`;

    if (!seenEmails.has(email) && contacts.length < 10) {
      const name = `${companyName} ${displayNames[contacts.length % displayNames.length]}`;
      seenEmails.add(email);
      contacts.push({
        name,
        role: entry.label,
        company: companyName,
        linkedinUrl: null,
        email,
        emailSource: "inferred",
        confidence,
      });
    }
  }

  return { contacts, smtpVerified, mxHost };
}
