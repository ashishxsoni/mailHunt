"use client";

import React from "react";
import { useContactStore } from "@/store/useContactStore";
import { personalizeEmail } from "@/lib/personalizeEmail";
import { X, ExternalLink } from "lucide-react";

export function MailPreviewModal() {
  const { previewContact, isPreviewOpen, closePreview, campaign } =
    useContactStore();

  if (!isPreviewOpen || !previewContact || !campaign) return null;

  const { subject, body } = personalizeEmail(previewContact, {
    targetRole: campaign.targetRole,
    skills: campaign.userBio ?? undefined,
    emailSubject: campaign.emailSubject,
    emailTemplate: campaign.emailTemplate,
  });

  return (
    // Backdrop
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) closePreview();
      }}
    >
      {/* Modal */}
      <div className="relative w-full max-w-2xl rounded-2xl border border-zinc-700 bg-zinc-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
          <div>
            <h2 className="font-semibold text-white">Email Preview</h2>
            <p className="text-sm text-zinc-400">
              This is a preview only — no email will be sent.
            </p>
          </div>
          <button
            onClick={closePreview}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Recipient */}
        <div className="border-b border-zinc-800 px-6 py-4">
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-purple-600 text-sm font-bold text-white">
              {previewContact.name.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <p className="font-medium text-white">{previewContact.name}</p>
                {previewContact.linkedinUrl && (
                  <a
                    href={previewContact.linkedinUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:text-blue-300"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
              </div>
              <p className="text-sm text-zinc-400">{previewContact.role}</p>
              <p className="text-xs text-zinc-500">{previewContact.email}</p>
            </div>
            <div className="text-right">
              <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
                {previewContact.emailSource === "verified"
                  ? "✓ Verified (Snov.io)"
                  : previewContact.emailSource === "public"
                  ? "✓ Public email"
                  : "⚠ Inferred email"}
              </span>
            </div>
          </div>
        </div>

        {/* Email content */}
        <div className="px-6 py-4">
          {/* Subject */}
          <div className="mb-4">
            <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-zinc-500">
              Subject
            </label>
            <p className="rounded-lg border border-zinc-800 bg-zinc-800/50 px-3 py-2 text-sm text-white">
              {subject}
            </p>
          </div>

          {/* Body */}
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-zinc-500">
              Message
            </label>
            <div className="max-h-72 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-800/50 px-4 py-3 text-sm leading-relaxed text-zinc-200 whitespace-pre-wrap">
              {body}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-zinc-800 px-6 py-4">
          <p className="text-center text-xs text-zinc-500">
            Use the <strong className="text-zinc-400">Send</strong> button on the dashboard to send this email.
          </p>
        </div>
      </div>
    </div>
  );
}
