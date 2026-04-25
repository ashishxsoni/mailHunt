import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";
import { updateContactStatus, getAllContacts } from "@/lib/db/contacts";
import { getLatestCampaign } from "@/lib/db/campaigns";
import { personalizeEmail } from "@/lib/personalizeEmail";
import type { Contact } from "@/types";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let contactId: string | undefined;

  try {
    const body = (await req.json()) as { contactId: string };
    contactId = body.contactId;

    if (!contactId) {
      return NextResponse.json({ error: "contactId is required." }, { status: 400 });
    }

    // Fetch the specific contact
    const allContacts = await getAllContacts();
    const contact = allContacts.find((c) => c.id === contactId) as Contact | undefined;

    if (!contact) {
      return NextResponse.json({ error: "Contact not found." }, { status: 404 });
    }

    // Prevent duplicate sends
    if (contact.status === "Sent") {
      return NextResponse.json(
        { error: "Email already sent to this contact." },
        { status: 409 }
      );
    }

    // Load the latest campaign for template data
    const campaign = await getLatestCampaign();
    if (!campaign) {
      return NextResponse.json({ error: "No campaign found." }, { status: 404 });
    }

    // Personalize the email
    const { subject, body: emailBody } = personalizeEmail(contact, {
      targetRole: campaign.targetRole,
      skills: campaign.userBio ?? "",
      emailSubject: campaign.emailSubject,
      emailTemplate: campaign.emailTemplate,
    });

    // Build the transporter
    const emailUser = process.env.EMAIL_USER;
    const emailPass = process.env.EMAIL_APP_PASSWORD;

    if (!emailUser || !emailPass) {
      return NextResponse.json(
        { error: "Email credentials not configured. Please set EMAIL_USER and EMAIL_APP_PASSWORD in .env." },
        { status: 500 }
      );
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: emailUser,
        pass: emailPass,
      },
    });

    await transporter.sendMail({
      from: `"mailHunt" <${emailUser}>`,
      to: contact.email,
      subject,
      text: emailBody,
      html: emailBody.replace(/\n/g, "<br>"),
    });

    // Update status to Sent
    const updated = await updateContactStatus(contactId, "Sent", new Date());

    return NextResponse.json({ success: true, contact: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";

    if (contactId) {
      await updateContactStatus(contactId, "Failed").catch(() => {});
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
