/**
 * Abstract API email verifier — validate deliverability of a single email.
 *
 * This is an EMAIL VERIFICATION tool only (not a discovery tool).
 * Given a known email address, it returns deliverability and quality signals.
 *
 * Free tier: ~100 requests/month — https://www.abstractapi.com/api/email-verification-api
 *
 * Endpoint:  GET https://emailvalidation.abstractapi.com/v1/
 * Auth:      api_key query parameter
 *
 * deliverability values:
 *   "DELIVERABLE"   → valid inbox, map to confidence "high"
 *   "RISKY"         → catch-all or role account, map to confidence "medium"
 *   "UNDELIVERABLE" → hard bounce, discard
 *   "UNKNOWN"       → inconclusive (server unreachable), treat as inconclusive
 *
 * Status → failure reason:
 *   401 / 403  → auth_error
 *   429        → rate_limit
 *   422        → plan_limit (free quota exhausted)
 *   500+       → api_error
 */

import type { Confidence } from "@/types";

export type AbstractApiFailureReason =
  | "rate_limit"
  | "plan_limit"
  | "auth_error"
  | "inconclusive"
  | "invalid_address"
  | "api_error";

export interface AbstractApiValid {
  ok: true;
  email: string;
  deliverability: "DELIVERABLE" | "RISKY";
  confidence: Confidence;
  qualityScore: number; // 0.00–1.00
}

export interface AbstractApiInvalid {
  ok: false;
  reason: AbstractApiFailureReason;
  message: string;
}

export type AbstractApiResult = AbstractApiValid | AbstractApiInvalid;

interface AbstractEmailResponse {
  email?: string;
  autocorrect?: string;
  deliverability?: string;
  quality_score?: string | number;
  is_valid_format?: { value?: boolean };
  is_free_email?: { value?: boolean };
  is_disposable_email?: { value?: boolean };
  is_role_email?: { value?: boolean };
  is_catchall_email?: { value?: boolean };
  is_mx_found?: { value?: boolean };
  is_smtp_valid?: { value?: boolean };
  error?: { message?: string; details?: string };
  // Some error states return a plain message field
  message?: string;
}

/**
 * Verify whether a single email address is deliverable using Abstract API.
 *
 * @param email   The email address to verify, e.g. "john.doe@stripe.com"
 * @param apiKey  ABSTRACTAPI_EMAIL_KEY
 */
export async function verifyEmailAbstractApi(
  email: string,
  apiKey: string
): Promise<AbstractApiResult> {
  try {
    const url = new URL("https://emailvalidation.abstractapi.com/v1/");
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("email", email);

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        reason: "auth_error",
        message: `Abstract API auth failed (${res.status}) — check ABSTRACTAPI_EMAIL_KEY`,
      };
    }

    if (res.status === 429) {
      return {
        ok: false,
        reason: "rate_limit",
        message: "Abstract API rate limit hit.",
      };
    }

    if (res.status === 422) {
      return {
        ok: false,
        reason: "plan_limit",
        message: "Abstract API: monthly email verification quota exhausted",
      };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        reason: "api_error",
        message: `Abstract API error ${res.status}: ${text.slice(0, 120)}`,
      };
    }

    const json = (await res.json()) as AbstractEmailResponse;

    // API-level error in body
    if (json.error) {
      return {
        ok: false,
        reason: "api_error",
        message: `Abstract API: ${json.error.message ?? json.error.details ?? "unknown error"}`,
      };
    }

    const deliverability = json.deliverability ?? "UNKNOWN";
    const qualityScore = parseFloat(String(json.quality_score ?? "0"));

    if (deliverability === "DELIVERABLE") {
      return {
        ok: true,
        email: json.email ?? email,
        deliverability: "DELIVERABLE",
        confidence: "high",
        qualityScore,
      };
    }

    if (deliverability === "RISKY") {
      // RISKY includes catch-all and role accounts — still worth using
      return {
        ok: true,
        email: json.email ?? email,
        deliverability: "RISKY",
        confidence: "medium",
        qualityScore,
      };
    }

    if (deliverability === "UNDELIVERABLE") {
      return {
        ok: false,
        reason: "invalid_address",
        message: `Abstract API: email is UNDELIVERABLE`,
      };
    }

    // UNKNOWN — server unreachable
    return {
      ok: false,
      reason: "inconclusive",
      message: `Abstract API: deliverability UNKNOWN for ${email}`,
    };
  } catch (err) {
    return {
      ok: false,
      reason: "api_error",
      message: `Abstract API exception: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
