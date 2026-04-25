import { prisma } from "@/lib/prisma";
import type { Contact, ContactStatus } from "@/types";

export async function getContactsByCampaign(
  campaignId?: string
): Promise<Contact[]> {
  const raw = await prisma.contact.findMany({
    where: campaignId ? { id: campaignId } : undefined,
    orderBy: { createdAt: "desc" },
  });
  return raw as unknown as Contact[];
}

export async function getAllContacts(): Promise<Contact[]> {
  const raw = await prisma.contact.findMany({
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });
  return raw as unknown as Contact[];
}

export async function createContacts(
  contacts: Omit<Contact, "id" | "createdAt">[]
): Promise<Contact[]> {
  const created = await Promise.all(
    contacts.map((c) =>
      prisma.contact.create({
        data: {
          name: c.name,
          role: c.role,
          company: c.company,
          linkedinUrl: c.linkedinUrl ?? null,
          email: c.email,
          emailSource: c.emailSource,
          confidence: c.confidence,
          status: c.status ?? "Pending",
        },
      })
    )
  );
  return created as unknown as Contact[];
}

export async function updateContactStatus(
  id: string,
  status: ContactStatus,
  sentAt?: Date
): Promise<Contact> {
  const updated = await prisma.contact.update({
    where: { id },
    data: {
      status,
      sentAt: sentAt ?? (status === "Sent" ? new Date() : undefined),
    },
  });
  return updated as unknown as Contact;
}

export async function deleteAllContacts(): Promise<void> {
  await prisma.contact.deleteMany({});
}
