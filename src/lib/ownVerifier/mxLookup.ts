/**
 * MX record lookup — check whether a domain has email servers.
 *
 * Uses Node.js built-in `dns` module (zero cost, unlimited).
 * Returns the MX servers sorted by priority (lowest = highest preference),
 * which is what the smtpProbe module uses to pick which server to connect to.
 *
 * If no MX records exist → domain cannot receive email → all addresses invalid.
 */

import { promises as dns } from "dns";

export interface MxRecord {
  /** Mail exchange hostname, e.g. "aspmx.l.google.com" */
  exchange: string;
  /** Lower number = higher preference per RFC 5321 */
  priority: number;
}

export interface MxLookupResult {
  hasMx: boolean;
  records: MxRecord[];
  /** The highest-preference MX host to connect to for SMTP */
  primaryHost: string | null;
}

/**
 * Look up MX records for a domain.
 *
 * @param domain  e.g. "google.com" (no "@", no subdirectory)
 */
export async function lookupMx(domain: string): Promise<MxLookupResult> {
  try {
    const raw = await dns.resolveMx(domain.toLowerCase().trim());

    if (!raw || raw.length === 0) {
      return { hasMx: false, records: [], primaryHost: null };
    }

    // Sort ascending by priority — lowest priority number = preferred server
    const records: MxRecord[] = raw
      .map((r) => ({ exchange: r.exchange, priority: r.priority }))
      .sort((a, b) => a.priority - b.priority);

    return {
      hasMx: true,
      records,
      primaryHost: records[0]?.exchange ?? null,
    };
  } catch {
    // ENOTFOUND, ENODATA, ESERVFAIL, ENORECORDS — domain has no MX
    return { hasMx: false, records: [], primaryHost: null };
  }
}

// ─── SPF / DMARC DNS lookup ───────────────────────────────────────────────────

export interface DnsExtraResult {
  hasSPF: boolean;
  spfRecord: string | null;
  hasDMARC: boolean;
  dmarcRecord: string | null;
  txtRecordCount: number;
}

/**
 * Check for SPF (v=spf1 TXT on domain) and DMARC (TXT on _dmarc.domain).
 * Both signals confirm the domain is properly configured for legitimate email.
 * Neither requires additional API keys — pure DNS lookups.
 */
export async function lookupDnsExtra(domain: string): Promise<DnsExtraResult> {
  const d = domain.toLowerCase().trim();
  const [txtRes, dmarcRes] = await Promise.allSettled([
    dns.resolveTxt(d),
    dns.resolveTxt(`_dmarc.${d}`),
  ]);

  const txtRecords =
    txtRes.status === "fulfilled"
      ? txtRes.value.map((chunks) => chunks.join(""))
      : [];

  const dmarcRecords =
    dmarcRes.status === "fulfilled"
      ? dmarcRes.value.map((chunks) => chunks.join(""))
      : [];

  const spfRecord = txtRecords.find((r) => r.startsWith("v=spf1")) ?? null;
  const dmarcRecord = dmarcRecords.find((r) => r.startsWith("v=DMARC1")) ?? null;

  return {
    hasSPF: !!spfRecord,
    spfRecord,
    hasDMARC: !!dmarcRecord,
    dmarcRecord,
    txtRecordCount: txtRecords.length,
  };
}
