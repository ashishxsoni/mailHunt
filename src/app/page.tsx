"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useContactStore } from "@/store/useContactStore";
import type { CampaignFormData, Contact, Campaign } from "@/types";
import { cn } from "@/lib/utils";
import { Loader2, Search, ChevronDown, ChevronUp, Wrench } from "lucide-react";

type ProviderWarning = {
  provider: string;
  reason: "rate_limit" | "plan_limit" | "auth_error" | "no_results" | "api_error";
  message: string;
};

const REASON_ICONS: Record<ProviderWarning["reason"], string> = {
  rate_limit: "⚠️",
  plan_limit: "🚫",
  auth_error: "🔑",
  no_results: "🔍",
  api_error: "❌",
};

const DEFAULT_TEMPLATE = `Hi {name},

I hope this message finds you well. My name is [Your Name], and I am actively exploring opportunities as a {target_role}.

I came across your profile and was particularly impressed by your work at {company} as a {role}. Your experience aligns closely with the kind of team I am looking to join.

My background includes: {skills}

I would love to connect and learn more about any open opportunities or simply exchange insights about the industry. Even a 15-minute conversation would be incredibly valuable.

Thank you for your time, and I look forward to hearing from you.

Best regards,
[Your Name]`;

export default function HomePage() {
  const router = useRouter();
  const { setContacts, setCampaign, setLoading, setError, isLoading, error } =
    useContactStore();

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [form, setForm] = useState<CampaignFormData>({
    companyName: "",
    targetRole: "",
    userBio: "",
    emailSubject: "Exploring Opportunities at {company} — {target_role}",
    emailTemplate: DEFAULT_TEMPLATE,
    jobDescription: "",
    linkedinProfile: "",
  });

  function handleChange(
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      const data = (await res.json()) as {
        campaign?: Campaign;
        contacts?: Contact[];
        error?: string;
        warnings?: ProviderWarning[];
        meta?: {
          discoverySource?: string;
          verifiedCount?: number;
          inferredCount?: number;
          warnings?: ProviderWarning[];
        };
      };

      // Show provider warnings as toasts regardless of success/failure
      const warnings = data.warnings ?? data.meta?.warnings ?? [];
      warnings.forEach((w) => {
        const icon = REASON_ICONS[w.reason] ?? "⚠️";
        if (w.reason === "rate_limit" || w.reason === "plan_limit") {
          toast.warning(`${icon} ${w.provider} plan limit reached`, {
            description: w.message,
          });
        } else if (w.reason === "auth_error") {
          toast.error(`${icon} ${w.provider} auth failed`, {
            description: w.message,
          });
        } else if (w.reason === "api_error") {
          toast.error(`${icon} ${w.provider} API error`, {
            description: w.message,
          });
        } else {
          toast.info(`${icon} ${w.provider}: ${w.message}`);
        }
      });

      if (!res.ok || data.error) {
        setError(data.error ?? "Something went wrong during discovery.");
        return;
      }

      if (data.campaign && data.contacts) {
        setCampaign(data.campaign);
        setContacts(data.contacts);

        // Success toast with provider info
        if (data.meta?.discoverySource) {
          toast.success(
            `Found ${data.contacts.length} contacts via ${data.meta.discoverySource}`,
            {
              description: `${data.meta.verifiedCount ?? 0} verified · ${data.meta.inferredCount ?? 0} inferred`,
            }
          );
        }

        router.push("/dashboard");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Network error. Please try again.";
      setError(msg);
      toast.error("Network error", { description: msg });
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#06050b] px-4 py-12">
      <div className="mx-auto max-w-2xl">
        {/* Top nav */}
        <div className="mb-6 flex justify-end">
          <button
            onClick={() => router.push("/tools")}
            className="flex items-center gap-1.5 rounded-lg border border-fuchsia-800/40 bg-fuchsia-900/20 px-3 py-1.5 text-xs text-fuchsia-400 transition-colors hover:border-fuchsia-700/60 hover:text-fuchsia-200"
          >
            <Wrench className="h-3.5 w-3.5" />
            Email Tools
          </button>
        </div>

        {/* Header */}
        <div className="mb-10 text-center">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-fuchsia-500/30 bg-fuchsia-500/10 px-4 py-1.5 text-sm font-medium text-fuchsia-400">
            <Search className="h-3.5 w-3.5" />
            AI-Powered Outreach
          </div>
          <h1 className="mb-3 text-4xl font-bold tracking-tight text-white">
            mailHunt
          </h1>
          <p className="text-zinc-400">
            Discover professionals, personalize emails, and manage your outreach — all in one place.
          </p>
        </div>

        {/* Form */}
        <form
          onSubmit={(e) => void handleSubmit(e)}
          className="rounded-2xl border border-fuchsia-900/30 bg-[#100c1f] p-6"
        >
          <h2 className="mb-5 text-lg font-semibold text-white">
            Start a New Campaign
          </h2>

          <div className="space-y-4">
            {/* Company Name */}
            <Field label="Company Name" required>
              <input
                name="companyName"
                value={form.companyName}
                onChange={handleChange}
                placeholder="e.g. Stripe, Notion, Linear"
                required
                className={inputClass}
              />
            </Field>

            {/* Target Role */}
            <Field
              label="Target Role"
              hint="Optional — leave blank to search all Engineering & HR hiring roles"
            >
              <input
                name="targetRole"
                value={form.targetRole}
                onChange={handleChange}
                placeholder="e.g. Engineering Manager, Recruiter, Software Engineer"
                className={inputClass}
              />
            </Field>

            {/* User Bio / Skills */}
            <Field label="Your Skills / Short Bio" hint="Optional — populates {skills} in your template">
              <textarea
                name="userBio"
                value={form.userBio}
                onChange={handleChange}
                placeholder="e.g. 3 years of React, TypeScript, Node.js. Built 2 SaaS products."
                rows={3}
                className={cn(inputClass, "resize-y")}
              />
            </Field>

            {/* Email Subject */}
            <Field
              label="Email Subject"
              hint="Use {company}, {target_role} as variables"
              required
            >
              <input
                name="emailSubject"
                value={form.emailSubject}
                onChange={handleChange}
                required
                className={inputClass}
              />
            </Field>

            {/* Email Template */}
            <Field
              label="Email Template"
              hint="Variables: {name}, {role}, {company}, {target_role}, {skills}"
              required
            >
              <textarea
                name="emailTemplate"
                value={form.emailTemplate}
                onChange={handleChange}
                required
                rows={10}
                className={cn(inputClass, "resize-y font-mono text-xs")}
              />
            </Field>

            {/* Advanced / Optional fields */}
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="flex w-full items-center justify-between rounded-lg border border-white/[0.06] px-3 py-2 text-sm text-zinc-400 transition-colors hover:border-white/[0.1] hover:text-zinc-200"
            >
              <span>Optional fields</span>
              {showAdvanced ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </button>

            {showAdvanced && (
              <div className="space-y-4 rounded-xl border border-white/[0.06] p-4">
                <Field label="Job Description / Link">
                  <input
                    name="jobDescription"
                    value={form.jobDescription}
                    onChange={handleChange}
                    placeholder="Paste job description or link"
                    className={inputClass}
                  />
                </Field>
                <Field label="Your LinkedIn Profile URL">
                  <input
                    name="linkedinProfile"
                    value={form.linkedinProfile}
                    onChange={handleChange}
                    placeholder="https://linkedin.com/in/yourprofile"
                    type="url"
                    className={inputClass}
                  />
                </Field>
              </div>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              {error}
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={isLoading}
            className={cn(
              "mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-fuchsia-600 to-pink-600 px-6 py-3 text-sm font-semibold text-white transition-all shadow-lg shadow-fuchsia-900/30",
              isLoading
                ? "cursor-not-allowed opacity-60"
                : "hover:from-fuchsia-500 hover:to-pink-500"
            )}
          >
            {isLoading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Discovering contacts...
              </>
            ) : (
              <>
                <Search className="h-4 w-4" />
                Discover Contacts
              </>
            )}
          </button>

          {isLoading && (
            <p className="mt-2 text-center text-xs text-zinc-500">
              Running X-Ray searches &amp; extracting data via AI — this may take 20–40 seconds.
            </p>
          )}
        </form>
      </div>
    </main>
  );
}

const inputClass =
  "w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm text-white placeholder-zinc-600 outline-none transition-colors focus:border-fuchsia-500 focus:bg-white/[0.06]";

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1">
        <label className="text-sm font-medium text-zinc-300">
          {label}
          {required && <span className="ml-1 text-red-400">*</span>}
        </label>
        {hint && <span className="text-xs text-zinc-500">— {hint}</span>}
      </div>
      {children}
    </div>
  );
}

