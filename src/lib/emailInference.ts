import type { EmailCandidate } from "@/types";

/**
 * Generate ALL common email format combinations for a person.
 *
 * For "Ashish Soni" at stripe.com this produces:
 *   ashish.soni@stripe.com  (37% — most common globally)
 *   ashish@stripe.com       (21%)
 *   a.soni@stripe.com       (9%)
 *   ashishsoni@stripe.com   (7%)
 *   asoni@stripe.com        (6%)
 *   soni@stripe.com         (5%)
 *   soni.ashish@stripe.com  (4%)
 *   ashish.s@stripe.com     (2%)
 *   ashishs@stripe.com      (2%)
 *   a.s@stripe.com          (1%)
 *
 * Score = approximate % likelihood based on Hunter.io format research.
 * Sorted highest → lowest probability.
 */
export function generateEmailCandidates(
  firstName: string,
  lastName: string,
  domain: string
): EmailCandidate[] {
  const f = firstName.toLowerCase().trim();
  const l = lastName.toLowerCase().trim();
  const fi = f[0] ?? "";
  const li = l[0] ?? "";

  if (!f || !l || !domain) return [];

  const candidates: EmailCandidate[] = [
    { email: `${f}.${l}@${domain}`, formatLabel: "firstname.lastname", score: 37 },
    { email: `${f}@${domain}`,       formatLabel: "firstname",          score: 21 },
    { email: `${fi}.${l}@${domain}`, formatLabel: "f.lastname",         score: 9  },
    { email: `${f}${l}@${domain}`,   formatLabel: "firstnamelastname",  score: 7  },
    { email: `${fi}${l}@${domain}`,  formatLabel: "flastname",          score: 6  },
    { email: `${l}@${domain}`,       formatLabel: "lastname",           score: 5  },
    { email: `${l}.${f}@${domain}`,  formatLabel: "lastname.firstname", score: 4  },
    { email: `${f}.${li}@${domain}`, formatLabel: "firstname.l",        score: 2  },
    { email: `${f}${li}@${domain}`,  formatLabel: "firstnamel",         score: 2  },
    { email: `${fi}.${li}@${domain}`,formatLabel: "f.l",                score: 1  },
    { email: `${fi}_${l}@${domain}`, formatLabel: "f_lastname",         score: 1  },
  ].filter((c) => {
    // Drop malformed entries (single-char names, leading dots)
    const local = c.email.split("@")[0] ?? "";
    return local.length >= 2 && !local.startsWith(".") && !local.startsWith("_");
  });

  // Deduplicate (can happen when first === last, very short names, etc.)
  const seen = new Set<string>();
  return candidates.filter((c) => {
    if (seen.has(c.email)) return false;
    seen.add(c.email);
    return true;
  });
}

/**
 * Extract the most likely company domain from a company name.
 * e.g. "Stripe" → "stripe.com"
 */
export function guessDomain(companyName: string): string {
  const slug = companyName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
  return `${slug}.com`;
}

/**
 * Parse a full name into first and last components.
 * Handles middle names by using the last token as surname.
 */
export function parseName(fullName: string): {
  firstName: string;
  lastName: string;
} {
  const parts = fullName.trim().split(/\s+/);
  const firstName = parts[0] ?? "";
  const lastName = parts[parts.length - 1] ?? "";
  return { firstName, lastName };
}

/**
 * Return the single highest-probability email candidate (top of sorted list).
 * Used as a last resort when Snov.io verification isn't available.
 */
export function bestInferredEmail(fullName: string, domain: string): string {
  const { firstName, lastName } = parseName(fullName);
  const candidates = generateEmailCandidates(firstName, lastName, domain);
  return candidates[0]?.email ?? `${firstName.toLowerCase()}@${domain}`;
}

