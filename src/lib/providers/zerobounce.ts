/**
 * ZeroBounce email verifier — SMTP-validate a single email address.
 *
 * This is an EMAIL VERIFICATION tool only (not a discovery tool).
 * Given a known email address, it tells you whether it is deliverable.
 *
 * Free tier: 100 validations/month (resets monthly) — https://zerobounce.net
 *
 * Endpoint:  GET https://api.zerobounce.net/v2/validate
 * Auth:      api_key query parameter
 *
 * result values:
 *   "valid"       → deliverable, map to confidence "high"
 *   "catch-all"   → domain accepts all mail, map to confidence "medium"
 *   "unknown"     → timed out or unreachable, treat as inconclusive
 *   "invalid"     → hard bounce, discard
 *   "spamtrap"    → discard
 *   "abuse"       → discard
 *   "do_not_mail" → discard
 *
 * Status → failure reason:
 *   402            → plan_limit (credits exhausted)
 *   401 / 403      → auth_error
 *   429            → rate_limit
 *   500+           → api_error
 */

import type { Confidence } from "@/types";

export type ZeroBounceFailureReason =
  | "rate_limit"
  | "plan_limit"
  | "auth_error"
  | "inconclusive"
  | "invalid_address"
  | "api_error";

export interface ZeroBounceValid {
  ok: true;
  email: string;
  result: "valid" | "catch-all";
  confidence: Confidence;
}

export interface ZeroBounceInvalid {
  ok: false;
  reason: ZeroBounceFailureReason;
  message: string;
}

export type ZeroBounceResult = ZeroBounceValid | ZeroBounceInvalid;

interface ZeroBounceResponse {
  address?: string;
  status?: string;        // "valid" | "invalid" | "catch-all" | "unknown" | "spamtrap" | "abuse" | "do_not_mail"
  sub_status?: string;
  free_email?: boolean;
  did_you_mean?: string;
  account?: string;
  domain?: string;
  domain_age_days?: string;
  smtp_provider?: string;
  mx_found?: string;
  mx_record?: string;
  firstname?: string | null;
  lastname?: string | null;
  error?: string;
  message?: string;
}

/**
 * Verify whether a single email address is deliverable using ZeroBounce.
 *
 * @param email   The email address to verify, e.g. "john.doe@stripe.com"
 * @param apiKey  ZEROBOUNCE_API_KEY
 */
export async function verifyEmailZeroBounce(
  email: string,
  apiKey: string
): Promise<ZeroBounceResult> {
  try {
    const url = new URL("https://api.zerobounce.net/v2/validate");
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("email", email);
    url.searchParams.set("ip_address", "");

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        reason: "auth_error",
        message: `ZeroBounce auth failed (${res.status}) — check ZEROBOUNCE_API_KEY`,
      };
    }

    if (res.status === 402) {
      return {
        ok: false,
        reason: "plan_limit",
        message: "ZeroBounce: monthly validation credits exhausted",
      };
    }

    if (res.status === 429) {
      return {
        ok: false,
        reason: "rate_limit",
        message: "ZeroBounce rate limit hit.",
      };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        reason: "api_error",
        message: `ZeroBounce error ${res.status}: ${text.slice(0, 120)}`,
      };
    }

    const json = (await res.json()) as ZeroBounceResponse;

    // API-level error (e.g. malformed email, zero credits returned in body)
    if (json.error || (json.status === undefined && json.message)) {
      const msg = json.error ?? json.message ?? "unknown error";
      const reason: ZeroBounceFailureReason = msg.toLowerCase().includes("credit")
        ? "plan_limit"
        : "api_error";
      return { ok: false, reason, message: `ZeroBounce: ${msg}` };
    }

    const status = json.status ?? "unknown";

    if (status === "valid") {
      return { ok: true, email: json.address ?? email, result: "valid", confidence: "high" };
    }

    if (status === "catch-all") {
      return { ok: true, email: json.address ?? email, result: "catch-all", confidence: "medium" };
    }

    if (status === "invalid" || status === "spamtrap" || status === "abuse" || status === "do_not_mail") {
      return {
        ok: false,
        reason: "invalid_address",
        message: `ZeroBounce: email is ${status} (${json.sub_status ?? ""})`,
      };
    }

    // "unknown" — couldn't reach the mail server; treat as inconclusive
    return {
      ok: false,
      reason: "inconclusive",
      message: `ZeroBounce: result is '${status}' for ${email}`,
    };
  } catch (err) {
    return {
      ok: false,
      reason: "api_error",
      message: `ZeroBounce exception: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
