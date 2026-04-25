import { create } from "zustand";
import type { Contact, Campaign } from "@/types";

interface ContactStore {
  // Data
  contacts: Contact[];
  campaign: Campaign | null;

  // UI state
  previewContact: Contact | null;
  isPreviewOpen: boolean;
  isLoading: boolean;
  error: string | null;

  // Computed (derived inline for simplicity)
  totalSent: () => number;
  totalContacts: () => number;
  remaining: () => number;

  // Actions
  setContacts: (contacts: Contact[]) => void;
  setCampaign: (campaign: Campaign) => void;
  openPreview: (contact: Contact) => void;
  closePreview: () => void;
  updateContactStatus: (
    id: string,
    status: Contact["status"],
    sentAt?: Date
  ) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

const initialState = {
  contacts: [] as Contact[],
  campaign: null,
  previewContact: null,
  isPreviewOpen: false,
  isLoading: false,
  error: null,
};

export const useContactStore = create<ContactStore>((set, get) => ({
  ...initialState,

  totalContacts: () => get().contacts.length,
  totalSent: () => get().contacts.filter((c) => c.status === "Sent").length,
  remaining: () =>
    get().contacts.filter((c) => c.status === "Pending").length,

  setContacts: (contacts) => set({ contacts }),
  setCampaign: (campaign) => set({ campaign }),

  openPreview: (contact) =>
    set({ previewContact: contact, isPreviewOpen: true }),

  closePreview: () =>
    set({ previewContact: null, isPreviewOpen: false }),

  updateContactStatus: (id, status, sentAt) =>
    set((state) => ({
      contacts: state.contacts.map((c) =>
        c.id === id ? { ...c, status, sentAt: sentAt ?? c.sentAt } : c
      ),
    })),

  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),

  reset: () => set(initialState),
}));
