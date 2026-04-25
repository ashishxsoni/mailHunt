"use client";

import React, { useState } from "react";
import type { Contact, Campaign } from "@/types";
import { personalizeEmail } from "@/lib/personalizeEmail";
import { useContactStore } from "@/store/useContactStore";
import { cn } from "@/lib/utils";
import {
  Eye,
  Copy,
  Send,
  CheckCircle,
  XCircle,
  Clock,
  ExternalLink,
  Loader2,
} from "lucide-react";

interface ContactRowProps {
  contact: Contact;
  campaign: Campaign;
}

const statusConfig: Record<
  Contact["status"],
  { label: string; icon: React.ElementType; className: string }
> = {
  Pending: {
    label: "Pending",
    icon: Clock,
    className: "text-yellow-400 bg-yellow-500/10 border-yellow-500/20",
  },
  Sent: {
    label: "Sent",
    icon: CheckCircle,
    className: "text-green-400 bg-green-500/10 border-green-500/20",
  },
  Failed: {
    label: "Failed",
    icon: XCircle,
    className: "text-red-400 bg-red-500/10 border-red-500/20",
  },
};

const confidenceConfig: Record<string, string> = {
  high: "text-green-400",
  medium: "text-yellow-400",
  low: "text-red-400",
};

export function ContactRow({ contact, campaign }: ContactRowProps) {
  const { openPreview, updateContactStatus } = useContactStore();
  const [isSending, setIsSending] = useState(false);
  const [copied, setCopied] = useState(false);

  const status = statusConfig[contact.status];
  const StatusIcon = status.icon;

  function handlePreview() {
    openPreview(contact);
  }

  async function handleCopy() {
    const { subject, body } = personalizeEmail(contact, {
      targetRole: campaign.targetRole,
      skills: campaign.userBio ?? undefined,
      emailSubject: campaign.emailSubject,
      emailTemplate: campaign.emailTemplate,
    });
    const text = `Subject: ${subject}\n\n${body}`;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleSend() {
    if (contact.status === "Sent" || isSending) return;
    setIsSending(true);
    try {
      const res = await fetch("/api/send-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId: contact.id }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        error?: string;
        contact?: Contact;
      };
      if (data.success && data.contact) {
        updateContactStatus(contact.id, "Sent", new Date());
      } else {
        updateContactStatus(contact.id, "Failed");
      }
    } catch {
      updateContactStatus(contact.id, "Failed");
    } finally {
      setIsSending(false);
    }
  }

  return (
    <div className="flex items-center gap-4 rounded-xl border border-fuchsia-900/25 bg-[#160d28] px-4 py-3 transition-colors hover:bg-[#1d1135]">
      {/* Avatar */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-fuchsia-500 to-pink-600 text-sm font-bold text-white">
        {contact.name.charAt(0).toUpperCase()}
      </div>

      {/* Info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate font-medium text-white">{contact.name}</p>
          {contact.linkedinUrl && (
            <a
              href={contact.linkedinUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-fuchsia-400 hover:text-fuchsia-300"
              title="View LinkedIn profile"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
        <p className="truncate text-sm text-fuchsia-400/60">{contact.role}</p>
        <div className="mt-0.5 flex items-center gap-2">
          <p className="truncate text-xs text-fuchsia-400/40">{contact.email}</p>
          <span
            className={cn(
              "text-xs font-medium",
              confidenceConfig[contact.confidence]
            )}
          >
            •{" "}
            {contact.emailSource === "verified"
              ? "✓ Verified (Snov.io)"
              : contact.emailSource === "public"
              ? "✓ Public"
              : `Inferred (${contact.confidence} confidence)`}
          </span>
        </div>
      </div>

      {/* Status badge */}
      <div
        className={cn(
          "flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
          status.className
        )}
      >
        <StatusIcon className="h-3 w-3" />
        {status.label}
      </div>

      {/* Actions */}
      <div className="flex shrink-0 items-center gap-2">
        <button
          onClick={handlePreview}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-fuchsia-800/30 bg-fuchsia-900/20 text-fuchsia-400/60 transition-colors hover:border-fuchsia-700/50 hover:text-fuchsia-200"
          title="Preview email"
        >
          <Eye className="h-4 w-4" />
        </button>

        <button
          onClick={handleCopy}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-fuchsia-800/30 bg-fuchsia-900/20 text-fuchsia-400/60 transition-colors hover:border-fuchsia-700/50 hover:text-fuchsia-200"
          title="Copy email"
        >
          {copied ? (
            <CheckCircle className="h-4 w-4 text-green-400" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </button>

        <button
          onClick={handleSend}
          disabled={contact.status === "Sent" || isSending}
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-colors",
            contact.status === "Sent"
              ? "cursor-not-allowed border-green-500/20 bg-green-500/10 text-green-400"
              : "border-fuchsia-600/40 bg-gradient-to-r from-fuchsia-600 to-pink-600 text-white hover:from-fuchsia-500 hover:to-pink-500 disabled:opacity-50"
          )}
          title="Send email"
        >
          {isSending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
          {contact.status === "Sent" ? "Sent" : isSending ? "Sending..." : "Send"}
        </button>
      </div>
    </div>
  );
}
