/**
 * GitHub provider — discover real employees from public GitHub profiles.
 *
 * GitHub users often list their employer in the "company" field of their
 * profile. This is 100% public data and requires no API key.
 *
 * Free tier: 10 req/min unauthenticated, 30 req/min with GITHUB_TOKEN.
 * No monthly cap — only per-minute rate limits.
 *
 * Strategy:
 *   Query 1: company:"Company Name"     → users who listed exact company
 *   Query 2: company:domain-slug        → users who listed domain as company
 *   Query 3: "Company Name" in:bio      → users who mention company in bio
 *
 * This reliably finds real tech employees since GitHub is the professional
 * network for engineers and developers.
 */

import type { DiscoveredPerson } from "@/types";

export type GitHubFailureReason = "rate_limit" | "no_results" | "api_error";

export interface GitHubSuccess {
  ok: true;
  people: DiscoveredPerson[];
  emailMap: Map<string, string>; // nameKey → public email (if set)
}

export interface GitHubFailure {
  ok: false;
  reason: GitHubFailureReason;
  message: string;
}

export type GitHubSearchResult = GitHubSuccess | GitHubFailure;

interface GitHubUser {
  login: string;
  name: string | null;
  company: string | null;
  bio: string | null;
  html_url: string;
  blog: string | null;
  email: string | null;
  location: string | null;
  type: string;
}

interface GitHubSearchResponse {
  total_count?: number;
  items?: GitHubUser[];
  message?: string;
}

// ─── Role inference from bio ─────────────────────────────────────────────────

function inferRole(bio: string | null, company: string | null): string {
  const text = `${bio ?? ""} ${company ?? ""}`.toLowerCase();

  if (/recruit|talent acquisition|head of talent|sourcer/i.test(text)) return "Technical Recruiter";
  if (/\bhr\b|human resources|people ops|people partner/i.test(text)) return "HR Manager";
  if (/\b(vp|vice president) (of )?(engineering|tech)/i.test(text)) return "VP Engineering";
  if (/head of eng|director of eng|engineering director/i.test(text)) return "Director of Engineering";
  if (/engineering manager|em |eng manager|team lead/i.test(text)) return "Engineering Manager";
  if (/principal|staff (engineer|swe)|senior staff/i.test(text)) return "Staff Engineer";
  if (/\bsre\b|site reliability|platform eng|devops|infrastructure/i.test(text)) return "Platform / DevOps Engineer";
  if (/data engineer|data scientist|machine learning|ml engineer|\bmlops\b/i.test(text)) return "Data / ML Engineer";
  if (/mobile|ios|android|react native/i.test(text)) return "Mobile Engineer";
  if (/frontend|front.end|react|vue|angular|ux engineer/i.test(text)) return "Frontend Engineer";
  if (/backend|back.end|api engineer|server.side/i.test(text)) return "Backend Engineer";
  if (/full.?stack/i.test(text)) return "Full Stack Engineer";
  if (/qa|quality assurance|test engineer|sdet/i.test(text)) return "QA / SDET Engineer";
  if (/security|appsec|infosec|penetration/i.test(text)) return "Security Engineer";
  if (/product manager|\bpm\b|product owner/i.test(text)) return "Product Manager";
  if (/cto|chief technology|founder|co-founder/i.test(text)) return "CTO / Founder";

  return "Software Engineer";
}

// ─── Extract LinkedIn URL from blog field ────────────────────────────────────

function extractLinkedIn(blog: string | null): string | undefined {
  if (!blog) return undefined;
  if (/linkedin\.com\/in\//i.test(blog)) {
    // Normalise to https://
    return blog.startsWith("http") ? blog : `https://${blog}`;
  }
  return undefined;
}

// ─── GitHub REST call ────────────────────────────────────────────────────────

async function searchGitHubUsers(
  query: string,
  perPage: number,
  token?: string
): Promise<GitHubUser[]> {
  const url = new URL("https://api.github.com/search/users");
  url.searchParams.set("q", query);
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("type", "Users"); // exclude orgs from results

  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "mailhunt-outreach-tool/1.0",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(url.toString(), { headers });

  if (res.status === 403 || res.status === 429) {
    throw Object.assign(new Error("rate_limit"), { isRateLimit: true });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 120)}`);
  }

  const data = (await res.json()) as GitHubSearchResponse;

  if (data.message?.toLowerCase().includes("rate limit")) {
    throw Object.assign(new Error(data.message), { isRateLimit: true });
  }

  return data.items ?? [];
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Search GitHub for real employees of a company using public profile data.
 *
 * @param companyName  e.g. "Automation Anywhere"
 * @param domain       e.g. "automationanywhere.com"
 * @param githubToken  Optional GITHUB_TOKEN — raises rate limit from 10 to 30 req/min
 */
export async function searchGitHubByCompany(
  companyName: string,
  domain: string,
  githubToken?: string
): Promise<GitHubSearchResult> {
  // Build the domain prefix (strip TLD) for fuzzy company field matching
  // "automationanywhere.com" → "automationanywhere"
  const domainSlug = domain.replace(/\.[a-z]{2,}$/i, "");

  // Three query strategies ordered by precision
  const queries = [
    `company:"${companyName}" type:user`,              // exact company name
    `company:${domainSlug} type:user`,                 // domain-based match
    `"${companyName}" in:bio type:user`,               // company mentioned in bio
  ];

  const seen = new Map<string, GitHubUser>();

  for (const query of queries) {
    try {
      const users = await searchGitHubUsers(query, 30, githubToken);

      for (const user of users) {
        if (!seen.has(user.login) && user.type === "User") {
          seen.set(user.login, user);
        }
      }

      // Enough real people — stop burning rate limit budget
      if (seen.size >= 25) break;
    } catch (err) {
      const isRL = (err as { isRateLimit?: boolean }).isRateLimit;
      if (isRL && seen.size > 0) break; // use what we have before being cut off
      if (isRL) {
        return {
          ok: false,
          reason: "rate_limit",
          message: "GitHub API rate limit hit. Trying next provider.",
        };
      }
      // Other errors — try next query
      continue;
    }
  }

  if (seen.size === 0) {
    return {
      ok: false,
      reason: "no_results",
      message: `GitHub found 0 users with company set to "${companyName}". Trying next provider.`,
    };
  }

  // Filter to users who set a real name (excludes bots and orgs)
  const withNames = Array.from(seen.values()).filter(
    (u) => u.name && u.name.trim().length > 1 && !u.name.includes("[bot]")
  );

  if (withNames.length === 0) {
    return {
      ok: false,
      reason: "no_results",
      message: `GitHub found ${seen.size} accounts for "${companyName}" but none set a public name.`,
    };
  }

  const emailMap = new Map<string, string>();
  const people: DiscoveredPerson[] = withNames.slice(0, 20).map((u) => {
    const name = u.name!.trim();
    const role = inferRole(u.bio, u.company);
    const linkedinUrl =
      extractLinkedIn(u.blog) ?? `https://github.com/${u.login}`;

    // Index public email for use in email resolution Case A
    if (u.email) {
      emailMap.set(name.toLowerCase(), u.email);
    }

    return {
      name,
      role,
      company: companyName,
      linkedinUrl,
      publicEmail: u.email ?? undefined,
      source: "github",
    };
  });

  return { ok: true, people, emailMap };
}
