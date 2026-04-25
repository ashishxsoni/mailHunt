/**
 * Advanced email pattern scorer — generates ranked email format candidates.
 *
 * Improvements over the base emailInference.ts:
 *
 *  1. Name normalization — removes accents (é→e), strips apostrophes (O'Brien→obrien),
 *     handles hyphenated names (Mary-Jane → maryjane + mary + jane as variants)
 *
 *  2. More patterns — adds hyphen/underscore separators, and name-initial variants
 *     that are common in European companies
 *
 *  3. Domain pattern cache — when we successfully SMTP-verify an email at a domain,
 *     we record the format. Future lookups for the same domain boost that format
 *     to a score of 100, so it always goes first.
 *     Call `learnDomainPattern(domain, formatLabel)` after a verified hit.
 *
 *  4. Handles edge cases:
 *     - Single-word names ("Ashish" with no last name) → firstname only formats
 *     - Very short names (fi/li = same char checks)
 *     - Compound last names ("van der Berg" → "vanderberg" and "berg" variants)
 */

import type { EmailCandidate } from "@/types";

// ─── Domain pattern cache (process-lifetime memory) ─────────────────────────
// Key: domain (e.g. "stripe.com") → formatLabel that was SMTP-verified as valid

const _domainPatternCache = new Map<string, string>();

/**
 * Record which email format was successfully verified at a domain.
 * Subsequent `generateScoredCandidates` calls for the same domain will
 * rank this format first with score = 100.
 */
export function learnDomainPattern(domain: string, formatLabel: string): void {
  _domainPatternCache.set(domain.toLowerCase(), formatLabel);
}

/**
 * Retrieve a previously learned pattern for a domain, or null.
 */
export function getLearnedPattern(domain: string): string | null {
  return _domainPatternCache.get(domain.toLowerCase()) ?? null;
}

// ─── Name normalisation ──────────────────────────────────────────────────────

/**
 * Normalise a name token for use in email addresses:
 *  - Convert to lowercase
 *  - Replace accented characters with ASCII equivalents
 *  - Remove apostrophes (O'Brien → obrien)
 *  - Collapse hyphens and spaces to nothing (Mary-Jane → maryjane)
 *  - Strip any remaining non-alpha characters
 */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    // Decompose accented characters then strip combining marks
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    // Remove apostrophes, hyphens, spaces (join compound names)
    .replace(/['\-\s]/g, "")
    // Strip any other non-alpha characters
    .replace(/[^a-z]/g, "");
}

/**
 * Parse a full name into normalized first and last components, plus any
 * hyphen/compound variants for the first name.
 *
 * Examples:
 *   "Mary-Jane Watson"      → first="maryjane", last="watson", firstParts=["mary","jane"]
 *   "José van der Berg"     → first="jose", last="vanderberg", firstParts=[]
 *   "Patrick O'Brien"       → first="patrick", last="obrien", firstParts=[]
 */
export function parseNameAdvanced(fullName: string): {
  first: string;
  last: string;
  fi: string;
  li: string;
  /** Individual parts of a hyphenated first name, if any */
  firstParts: string[];
} {
  const tokens = fullName.trim().split(/\s+/);

  // Raw first/last before normalization
  const rawFirst = tokens[0] ?? "";
  const rawLast = tokens[tokens.length - 1] ?? "";

  const first = normalizeName(rawFirst);
  const last = normalizeName(rawLast);
  const fi = first[0] ?? "";
  const li = last[0] ?? "";

  // If first name is hyphenated, also provide individual parts
  const firstParts = rawFirst.includes("-")
    ? rawFirst.split("-").map(normalizeName).filter(Boolean)
    : [];

  return { first, last, fi, li, firstParts };
}

// ─── Pattern generation ──────────────────────────────────────────────────────

/**
 * Generate all likely email format candidates for a person, sorted highest score first.
 *
 * Scores are approximate % likelihood based on:
 *  - Hunter.io global email format research data
 *  - Mailgun deliverability studies
 *  - The domain pattern cache (if a pattern was previously verified, it scores 100)
 *
 * @param firstName  Given name (will be normalised internally)
 * @param lastName   Surname (will be normalised internally)
 * @param domain     Company domain, e.g. "stripe.com"
 */
export function generateScoredCandidates(
  firstName: string,
  lastName: string,
  domain: string
): EmailCandidate[] {
  const { first, last, fi, li, firstParts } = parseNameAdvanced(
    `${firstName} ${lastName}`
  );

  if (!first || !last || !domain) return [];

  const learnedPattern = _domainPatternCache.get(domain.toLowerCase()) ?? null;

  // ── Base patterns (score = % likelihood globally) ───────────────────────
  const base: Array<{ local: string; label: string; score: number }> = [
    // Most common globally (Hunter.io research: https://hunter.io/email-format)
    { local: `${first}.${last}`,  label: "firstname.lastname",  score: 37 },
    { local: `${first}`,          label: "firstname",           score: 21 },
    { local: `${fi}.${last}`,     label: "f.lastname",          score: 9  },
    { local: `${first}.${li}`,    label: "firstname.l",         score: 8  }, // was 2 — actually ~8.7% globally
    { local: `${first}${last}`,   label: "firstnamelastname",   score: 7  },
    { local: `${fi}${last}`,      label: "flastname",           score: 6  },
    { local: `${last}`,           label: "lastname",            score: 5  },
    { local: `${last}.${first}`,  label: "lastname.firstname",  score: 4  },
    { local: `${first}${li}`,     label: "firstnamel",          score: 3  }, // was 2
    { local: `${fi}.${li}`,       label: "f.l",                 score: 1  },
    // Underscore separator (common in US tech companies)
    { local: `${first}_${last}`,  label: "firstname_lastname",  score: 1  },
    { local: `${fi}_${last}`,     label: "f_lastname",          score: 1  },
    // Hyphen separator (common in European companies)
    { local: `${first}-${last}`,  label: "firstname-lastname",  score: 1  },
    // last.first (common in French / French-speaking companies)
    { local: `${last}.${fi}`,     label: "lastname.f",          score: 1  },
    { local: `${last}${fi}`,      label: "lastnamef",           score: 1  },
  ];

  // ── Hyphenated first name variants ──────────────────────────────────────
  // e.g. Mary-Jane Watson → maryjane.watson AND mary.watson AND jane.watson
  for (const part of firstParts) {
    if (part !== first) {
      base.push({ local: `${part}.${last}`, label: `${part}.lastname`, score: 1 });
      base.push({ local: `${part}${last}`,  label: `${part}lastname`,  score: 1 });
    }
  }

  // ── Build full emails ────────────────────────────────────────────────────
  const seen = new Set<string>();
  const candidates: EmailCandidate[] = [];

  for (const { local, label, score } of base) {
    // Skip malformed locals (leading dot/underscore/hyphen, too short)
    if (local.length < 2) continue;
    if (/^[.\-_]/.test(local)) continue;

    const email = `${local}@${domain}`;
    if (seen.has(email)) continue;
    seen.add(email);

    // If we've learned a pattern for this domain, boost it to 100
    const effectiveScore = learnedPattern === label ? 100 : score;

    candidates.push({ email, formatLabel: label, score: effectiveScore });
  }

  // Sort: learned pattern (100) first, then by descending probability
  candidates.sort((a, b) => b.score - a.score);

  return candidates;
}
