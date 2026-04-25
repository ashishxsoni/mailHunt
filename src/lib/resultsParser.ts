/**
 * Zero-cost regex-based parser for SerpAPI / DDG search results.
 * Replaces the previous GPT-4o extractor — no LLM required, no API cost.
 *
 * LinkedIn Google/DDG result titles follow predictable patterns:
 *   "Jane Doe - Senior Engineer at Stripe | LinkedIn"
 *   "Jane Doe – Engineering Manager · Stripe | LinkedIn"
 *   "Jane Doe · Software Engineer · Stripe | LinkedIn"
 *   "Jane Doe - Senior Engineer - Stripe | LinkedIn"   ← 3-part dash
 *   "Jane Doe - Software Engineer @ Stripe | Backend | LinkedIn"  ← @ separator
 *   "Jane Doe - Stripe | LinkedIn"                     ← no role (use targetRole)
 */

import type { SerpResult } from "./serpapi";
import type { DiscoveredPerson } from "@/types";

// ─── Patterns ordered from most to least specific ────────────────────────────

const TITLE_PATTERNS: RegExp[] = [
  // "Name - Role at Company | ..."
  /^(.+?)\s*[-–]\s*(.+?)\s+at\s+[^|·\n]+[|·]/i,
  // "Name - Role @ Company | ..."  ← Indian LinkedIn titles
  /^(.+?)\s*[-–]\s*(.+?)\s*@\s*[^|·\n]+[|·]/i,
  // "Name - Role, Company | ..."
  /^(.+?)\s*[-–]\s*(.+?),\s*[^|·\n]+[|·]/i,
  // "Name - Role · Company | ..."
  /^(.+?)\s*[-–]\s*(.+?)\s*[·•]\s*[^|·\n]+[|·]/i,
  // "Name · Role · Company"
  /^(.+?)\s*[·•]\s*(.+?)\s*[·•]/i,
  // "Name - Role - Company | LinkedIn"  (3-part dash — must be checked BEFORE 2-part)
  /^(.+?)\s*[-–]\s*(.+?)\s*[-–]\s*[^|\n]+\|\s*LinkedIn/i,
  // "Name - Role | LinkedIn"  (2-part — last resort)
  /^(.+?)\s*[-–]\s*(.+?)\s*\|\s*LinkedIn/i,
  // "Name, Role at Company"
  /^([A-Z][a-z]+(?: [A-Z][a-z]+)+),\s*(.+?)\s+at\s+/i,
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip company name and trailing noise from the role field.
 * Handles separators: -  –  ·  @  |
 */
function cleanRole(raw: string, companyLower: string): string {
  return raw
    // Remove "@ CompanyName" or "- CompanyName" or "· CompanyName" trailer
    .replace(new RegExp(`\\s*[@\\-–·]\\s*${escapeRegex(companyLower)}[^,|]*$`, "i"), "")
    // Remove any trailing "| anything" pipe sections
    .replace(/\s*\|.+$/, "")
    // Remove trailing "at Company" or "@ Company"
    .replace(new RegExp(`\\s+(?:at|@)\\s+${escapeRegex(companyLower)}.*$`, "i"), "")
    .trim();
}

/**
 * Normalize ALL-CAPS name components to Title Case.
 * e.g. "ARSITHA Sathu" → "Arsitha Sathu", "PRIYA SINGH" → "Priya Singh"
 */
function normalizeName(name: string): string {
  const alpha = name.replace(/[^A-Za-z]/g, "").length;
  const upper = name.replace(/[^A-Z]/g, "").length;
  if (alpha > 0 && upper / alpha > 0.6) {
    // More than 60% uppercase → convert to Title Case
    return name
      .toLowerCase()
      .replace(/\b([a-z])/g, (c) => c.toUpperCase());
  }
  return name;
}

// Signals that indicate this person is a former employee — skip them
const ALUMNI_RE =
  /\b(former|previously at|ex-|alumni|worked at|past employee|left)\b/i;

// Roles that are highest priority for a job seeker
const HIGH_VALUE_ROLES = [
  "recruiter",
  "talent",
  "hiring",
  "hr ",
  "people ops",
  "engineering manager",
  "head of",
  "vp ",
  "vice president",
  "director",
  "lead",
];

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function parseTitle(
  title: string,
  companyLower: string
): { name: string; role: string } | null {
  for (const pattern of TITLE_PATTERNS) {
    const m = title.match(pattern);
    if (m?.[1] && m?.[2]) {
      const name = normalizeName(m[1].trim().replace(/\s+/g, " "));
      const rawRole = m[2].trim().replace(/\s+/g, " ");
      if (name.length < 3 || name.length > 70) continue;
      if (!/[A-Za-z]{2}/.test(name)) continue;
      if (rawRole.length < 2) continue;
      const role = cleanRole(rawRole, companyLower);
      return { name, role };
    }
  }
  return null;
}

function parseSnippet(
  snippet: string
): { name: string; role: string } | null {
  const p1 = snippet.match(
    /^([A-Z][a-z]+(?: [A-Z][a-z]+)+)\.\s+(.+?)\s+at\s+/
  );
  if (p1) return { name: p1[1].trim(), role: p1[2].trim() };

  const p2 = snippet.match(
    /([A-Z][a-z]+(?: [A-Z][a-z]+)+)\s+is\s+(?:a|an)\s+(.+?)\s+at\s+/i
  );
  if (p2) return { name: p2[1].trim(), role: p2[2].trim() };

  return null;
}

function relevanceScore(role: string, targetRole: string): number {
  const r = role.toLowerCase();
  const t = targetRole.toLowerCase();
  let score = 0;
  if (r.includes(t) || t.split(" ").some((w) => r.includes(w))) score += 10;
  for (const kw of HIGH_VALUE_ROLES) {
    if (r.includes(kw)) { score += 5; break; }
  }
  return score;
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Parse SerpAPI / DDG results into structured DiscoveredPerson objects.
 * Only accepts linkedin.com/in/ profile pages.
 */
export async function extractPeopleFromResults(
  results: SerpResult[],
  companyName: string,
  targetRole = ""
): Promise<DiscoveredPerson[]> {
  if (results.length === 0) return [];

  const companyLower = companyName.toLowerCase();
  const companyWords = companyLower
    .split(/\s+/)
    .filter((w) => w.length > 2);

  const seen = new Set<string>();
  const people: Array<DiscoveredPerson & { _score: number }> = [];

  for (const { title, link, snippet } of results) {
    const titleLow = title.toLowerCase();
    const snippetLow = snippet?.toLowerCase() ?? "";

    // Only trust linkedin.com/in/ profile URLs
    const isLinkedInProfile = /linkedin\.com\/in\//i.test(link);
    if (!isLinkedInProfile) continue;

    // Company relevance check
    const fullMatch =
      titleLow.includes(companyLower) || snippetLow.includes(companyLower);
    const allWordsMatch =
      companyWords.length >= 2 &&
      companyWords.every((w) => titleLow.includes(w) || snippetLow.includes(w));
    // Trust LinkedIn profiles from our company-targeted queries even if
    // Google's snippet is generic (shows only "500+ connections" etc.)
    const linkedinTrust = true;

    if (!fullMatch && !allWordsMatch && !linkedinTrust) continue;

    // Skip former employees
    if (ALUMNI_RE.test(title) || ALUMNI_RE.test(snippet ?? "")) continue;

    const linkedinUrl = link.replace(/\/+$/, "").split("?")[0];

    // Parse name + role
    const parsed =
      parseTitle(title, companyLower) ??
      (fullMatch || allWordsMatch ? parseSnippet(snippet ?? "") : null);

    if (!parsed) continue;

    const { name } = parsed;
    let { role } = parsed;

    // Sanity checks on name
    if (name.length < 3 || name.length > 70) continue;

    // When role === company name (title like "Jane - Razorpay | LinkedIn"):
    //   The person IS at this company (we found them via targeted search).
    //   Use targetRole as their role since the search was role-specific.
    const roleLow = role.toLowerCase().trim();
    const isRoleJustCompany =
      roleLow === companyLower ||
      roleLow === companyLower.replace(/[^a-z0-9]/g, "") ||
      role.trim().length < 3;

    if (isRoleJustCompany) {
      if (targetRole && targetRole.trim().length > 2) {
        // The query was site:linkedin.com/in "Company" "Role" — they ARE that role
        role = targetRole;
      } else {
        continue; // No targeted role and title has no role info — skip
      }
    }

    // Skip if role looks like a job ad title (no personal name at start of page title)
    if (/^(jobs?|careers?|openings?|hiring|vacancies)/i.test(title)) continue;

    // Deduplicate by name
    const key = name.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);

    people.push({
      name,
      role,
      company: companyName,
      linkedinUrl,
      source: `LinkedIn (${safeHostname(link)})`,
      _score: relevanceScore(role, targetRole),
    });
  }

  // Sort by relevance score, highest first
  people.sort((a, b) => b._score - a._score);

  // Strip internal _score before returning
  return people.map(({ _score: _, ...p }) => p);
}
