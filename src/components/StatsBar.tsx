"use client";

import React from "react";
import { useContactStore } from "@/store/useContactStore";
import { cn } from "@/lib/utils";
import {
  Mail,
  Users,
  CheckCircle,
  Clock,
} from "lucide-react";

export function StatsBar() {
  const totalContacts = useContactStore((s) => s.totalContacts);
  const totalSent = useContactStore((s) => s.totalSent);
  const remaining = useContactStore((s) => s.remaining);

  const stats = [
    {
      label: "Total Contacts",
      value: totalContacts(),
      icon: Users,
      color: "text-fuchsia-400",
      bg: "bg-fuchsia-500/10 border-fuchsia-500/20",
    },
    {
      label: "Emails Sent",
      value: totalSent(),
      icon: CheckCircle,
      color: "text-emerald-400",
      bg: "bg-emerald-500/10 border-emerald-500/20",
    },
    {
      label: "Remaining",
      value: remaining(),
      icon: Clock,
      color: "text-amber-400",
      bg: "bg-amber-500/10 border-amber-500/20",
    },
  ];

  return (
    <div className="grid grid-cols-3 gap-4 mb-6">
      {stats.map((stat) => (
        <div
          key={stat.label}
          className={cn(
            "flex items-center gap-3 rounded-xl border p-4",
            stat.bg
          )}
        >
          <stat.icon className={cn("h-5 w-5 shrink-0", stat.color)} />
          <div>
            <p className="text-2xl font-bold text-white">{stat.value}</p>
            <p className="text-xs text-fuchsia-400/50">{stat.label}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
