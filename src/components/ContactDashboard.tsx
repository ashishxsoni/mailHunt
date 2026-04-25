"use client";

import React, { useState } from "react";
import { useContactStore } from "@/store/useContactStore";
import { StatsBar } from "./StatsBar";
import { ContactRow } from "./ContactRow";
import { MailPreviewModal } from "./MailPreviewModal";
import { cn } from "@/lib/utils";
import type { Contact } from "@/types";

type FilterTab = "All" | "Pending" | "Sent" | "Failed";

export function ContactDashboard() {
  const { contacts, campaign } = useContactStore();
  const [activeTab, setActiveTab] = useState<FilterTab>("All");
  const [searchQuery, setSearchQuery] = useState("");

  if (!campaign || contacts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="mb-4 text-6xl">📭</div>
        <h2 className="mb-2 text-xl font-semibold text-white">No contacts yet</h2>
        <p className="text-zinc-400">
          Run a discovery search to find professionals at your target company.
        </p>
      </div>
    );
  }

  const tabs: FilterTab[] = ["All", "Pending", "Sent", "Failed"];

  const tabCounts: Record<FilterTab, number> = {
    All: contacts.length,
    Pending: contacts.filter((c) => c.status === "Pending").length,
    Sent: contacts.filter((c) => c.status === "Sent").length,
    Failed: contacts.filter((c) => c.status === "Failed").length,
  };

  const filtered = contacts.filter((c: Contact) => {
    const matchesTab = activeTab === "All" || c.status === activeTab;
    const q = searchQuery.toLowerCase();
    const matchesSearch =
      !q ||
      c.name.toLowerCase().includes(q) ||
      c.role.toLowerCase().includes(q) ||
      c.email.toLowerCase().includes(q);
    return matchesTab && matchesSearch;
  });

  return (
    <div>
      <StatsBar />

      {/* Campaign context */}
      <div className="mb-6 rounded-xl border border-fuchsia-800/25 bg-[#160d28] px-4 py-3">
        <p className="text-sm text-fuchsia-400/60">
          Campaign:{" "}
          <span className="font-medium text-white">
            {campaign.targetRole}
          </span>{" "}
          at{" "}
          <span className="font-medium text-fuchsia-400">{campaign.companyName}</span>
        </p>
      </div>

      {/* Filter tabs + search */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-1 rounded-xl border border-fuchsia-900/30 bg-[#0f0920] p-1">
          {tabs.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                activeTab === tab
                  ? "bg-fuchsia-700/40 text-fuchsia-200"
                  : "text-fuchsia-400/50 hover:text-fuchsia-200"
              )}
            >
              {tab}
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.5 text-xs",
                  activeTab === tab
                    ? "bg-fuchsia-600/40 text-fuchsia-200"
                    : "bg-fuchsia-900/30 text-fuchsia-500/60"
                )}
              >
                {tabCounts[tab]}
              </span>
            </button>
          ))}
        </div>

        <input
          type="text"
          placeholder="Search contacts..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full rounded-lg border border-fuchsia-900/30 bg-[#0f0920] px-3 py-2 text-sm text-white placeholder-fuchsia-900/60 outline-none transition-colors focus:border-fuchsia-600/50 sm:w-64"
        />
      </div>

      {/* Contact list */}
      {filtered.length === 0 ? (
        <div className="py-12 text-center text-zinc-500">
          No contacts match your filter.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((contact) => (
            <ContactRow
              key={contact.id}
              contact={contact}
              campaign={campaign}
            />
          ))}
        </div>
      )}

      {/* Mail preview modal */}
      <MailPreviewModal />
    </div>
  );
}
