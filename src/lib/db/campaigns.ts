import { prisma } from "@/lib/prisma";
import type { Campaign, CampaignFormData } from "@/types";

export async function createCampaign(data: CampaignFormData): Promise<Campaign> {
  const campaign = await prisma.campaign.create({
    data: {
      companyName: data.companyName,
      targetRole: data.targetRole ?? "All Hiring Roles",
      userBio: data.userBio ?? "",
      emailSubject: data.emailSubject,
      emailTemplate: data.emailTemplate,
      jobDescription: data.jobDescription ?? null,
      linkedinProfile: data.linkedinProfile ?? null,
    },
  });
  return campaign as unknown as Campaign;
}

export async function getLatestCampaign(): Promise<Campaign | null> {
  const campaign = await prisma.campaign.findFirst({
    orderBy: { createdAt: "desc" },
  });
  return campaign as unknown as Campaign | null;
}

export async function getCampaignById(id: string): Promise<Campaign | null> {
  const campaign = await prisma.campaign.findUnique({ where: { id } });
  return campaign as unknown as Campaign | null;
}
