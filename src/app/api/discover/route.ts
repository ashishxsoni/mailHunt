import { NextRequest, NextResponse } from "next/server";
import { guessDomain } from "@/lib/emailInference";
import { validateDomainMx } from "@/lib/emailVerifier";
import { createContacts } from "@/lib/db/contacts";
import { createCampaign } from "@/lib/db/campaigns";
import {
  discoverWithFallback,
  DEFAULT_DISCOVERY_ROLES,
  type ProviderConfig,
} from "@/lib/providerChain";
import type { CampaignFormData, Contact } from "@/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as CampaignFormData;

    const {
      companyName,
      targetRole,
      userBio,
      emailSubject,
      emailTemplate,
      jobDescription,
      linkedinProfile,
    } = body;

    if (!companyName || !emailSubject || !emailTemplate) {
      return NextResponse.json(
        { error: "Missing required fields: companyName, emailSubject, emailTemplate." },
        { status: 400 }
      );
    }

    const cfg: ProviderConfig = {
      snoviClientId: process.env.SNOV_CLIENT_ID ?? "",
      snoviClientSecret: process.env.SNOV_CLIENT_SECRET ?? "",
      githubToken: process.env.GITHUB_TOKEN ?? "",
      zeroBounceApiKey: process.env.ZEROBOUNCE_API_KEY ?? "",
      abstractApiEmailKey: process.env.ABSTRACTAPI_EMAIL_KEY ?? "",
      hunterApiKey: process.env.HUNTER_API_KEY ?? "",
      serpApiKey: process.env.SERPAPI_KEY ?? "",
      googleCseApiKey: process.env.GOOGLE_CSE_API_KEY ?? "",
      googleCseCx: process.env.GOOGLE_CSE_CX ?? "",
      bingSearchApiKey: process.env.BING_SEARCH_API_KEY ?? "",
    };

    // NOTE: No hard guard here — even with NO API keys, GitHub (free, no key)
    // and Hunter.io will still run. Company name is required (caught above).

    const rolesToSearch: string[] =
      targetRole?.trim() ? [targetRole.trim()] : DEFAULT_DISCOVERY_ROLES;

    const targetRoleLabel =
      targetRole?.trim() || "Engineering / HR (all hiring roles)";

    // ── Domain resolution ─────────────────────────────────────────────────
    const domain = guessDomain(companyName);
    const domainHasMx = await validateDomainMx(domain);

    // ── Multi-provider discovery + email resolution ───────────────────────
    const result = await discoverWithFallback(
      companyName,
      domain,
      domainHasMx,
      rolesToSearch,
      cfg
    );

    if (result.contacts.length === 0) {
      return NextResponse.json(
        {
          error: "No contacts discovered. Try a different company name or role.",
          warnings: result.warnings,
        },
        { status: 404 }
      );
    }

    // ── Persist ───────────────────────────────────────────────────────────
    const campaign = await createCampaign({
      companyName,
      targetRole: targetRoleLabel,
      userBio: userBio ?? "",
      emailSubject,
      emailTemplate,
      jobDescription,
      linkedinProfile,
    });

    const contactData: Omit<Contact, "id" | "createdAt">[] = result.contacts.map((c) => ({
      name: c.name,
      role: c.role,
      company: c.company,
      linkedinUrl: c.linkedinUrl ?? null,
      email: c.email,
      emailSource: c.emailSource,
      confidence: c.confidence,
      status: "Pending" as const,
      sentAt: null,
    }));

    const contacts = await createContacts(contactData);

    return NextResponse.json({
      campaign,
      contacts,
      total: contacts.length,
      meta: {
        domainMxValid: result.domainMxValid,
        discoverySource: result.discoverySource,
        rolesSearched: result.rolesSearched,
        verifiedCount: result.verifiedCount,
        inferredCount: result.inferredCount,
        warnings: result.warnings,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

