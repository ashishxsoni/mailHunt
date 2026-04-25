import type { Contact, PersonalizedEmail } from "@/types";

interface UserMeta {
  targetRole: string;
  skills?: string;   // Optional — if empty, {skills} variable is simply removed from the template
  emailSubject: string;
  emailTemplate: string;
}

/**
 * Replace template variables with contact-specific values.
 * Preserves user tone — no LLM rewriting.
 */
export function personalizeEmail(
  contact: Contact,
  userMeta: UserMeta
): PersonalizedEmail {
  const replacements: Record<string, string> = {
    "{name}": contact.name,
    "{role}": contact.role,
    "{company}": contact.company,
    "{target_role}": userMeta.targetRole,
    "{skills}": userMeta.skills ?? "",
  };

  let body = userMeta.emailTemplate;
  let subject = userMeta.emailSubject;

  for (const [key, value] of Object.entries(replacements)) {
    // Use global replace via split/join to avoid regex escaping issues
    body = body.split(key).join(value);
    subject = subject.split(key).join(value);
  }

  return { subject, body };
}
