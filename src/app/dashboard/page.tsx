"use client";

import React, { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useContactStore } from "@/store/useContactStore";
import { ContactDashboard } from "@/components/ContactDashboard";
import { ArrowLeft, RefreshCcw } from "lucide-react";
import type { Contact } from "@/types";

export default function DashboardPage() {
  const router = useRouter();
  const { contacts, campaign, setContacts, setLoading, isLoading } =
    useContactStore();

  // If store is empty (e.g. after refresh), try to reload from API
  useEffect(() => {
    if (contacts.length === 0 && !isLoading) {
      setLoading(true);
      fetch("/api/contacts")
        .then((res) => res.json())
        .then((data: { contacts?: Contact[] }) => {
          if (data.contacts) setContacts(data.contacts);
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <main className="min-h-screen bg-[#06050b] px-4 py-8">
      <div className="mx-auto max-w-5xl">
        {/* Top nav */}
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push("/")}
              className="flex items-center gap-1.5 text-sm text-fuchsia-400/70 transition-colors hover:text-fuchsia-200"
            >
              <ArrowLeft className="h-4 w-4" />
              New Campaign
            </button>
            <span className="text-fuchsia-900/50">/</span>
            <h1 className="text-lg font-semibold text-white">
              Contact Dashboard
            </h1>
          </div>

          <button
            onClick={() => {
              setLoading(true);
              fetch("/api/contacts")
                .then((res) => res.json())
                .then((data: { contacts?: Contact[] }) => {
                  if (data.contacts) setContacts(data.contacts);
                })
                .catch(() => {})
                .finally(() => setLoading(false));
            }}
            disabled={isLoading}
            className="flex items-center gap-1.5 rounded-lg border border-fuchsia-800/30 bg-fuchsia-900/20 px-3 py-1.5 text-sm text-fuchsia-400 transition-colors hover:border-fuchsia-700/50 hover:text-fuchsia-200 disabled:opacity-50"
          >
            <RefreshCcw
              className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`}
            />
            Refresh
          </button>
        </div>

        {isLoading && contacts.length === 0 ? (
          <div className="flex items-center justify-center py-24 text-fuchsia-400/60">
            <RefreshCcw className="mr-2 h-4 w-4 animate-spin" />
            Loading contacts...
          </div>
        ) : !campaign && contacts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="mb-4 text-5xl">📭</div>
            <h2 className="mb-2 text-xl font-semibold text-white">
              No campaign active
            </h2>
            <p className="mb-6 text-fuchsia-400/60">
              Start a campaign from the home page to discover contacts.
            </p>
            <button
              onClick={() => router.push("/")}
              className="rounded-lg bg-gradient-to-r from-fuchsia-600 to-pink-600 px-5 py-2.5 text-sm font-medium text-white hover:from-fuchsia-500 hover:to-pink-500"
            >
              Start a Campaign
            </button>
          </div>
        ) : (
          <ContactDashboard />
        )}
      </div>
    </main>
  );
}
