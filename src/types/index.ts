export type ContactStatus = "Pending" | "Sent" | "Failed";
export type EmailSource = "public" | "inferred" | "verified";
export type Confidence = "high" | "medium" | "low";

/** One email format candidate with a probability score (0–100). */
export interface EmailCandidate {
  email: string;
  /** Human-readable pattern label e.g. "firstname.lastname" */
  formatLabel: string;
  /** Approximate % likelihood based on Hunter.io industry research */
  score: number;
  /** Set after Snov.io SMTP verification */
  smtpStatus?: "valid" | "unknown" | "not_valid";
}

export interface Contact {
  id: string;
  name: string;
  role: string;
  company: string;
  linkedinUrl?: string | null;
  email: string;
  emailSource: EmailSource;
  confidence: Confidence;
  status: ContactStatus;
  sentAt?: Date | null;
  createdAt: Date;
}

export interface Campaign {
  id: string;
  companyName: string;
  targetRole: string;
  userBio?: string | null;
  emailSubject: string;
  emailTemplate: string;
  jobDescription?: string | null;
  linkedinProfile?: string | null;
  createdAt: Date;
}

export interface CampaignFormData {
  companyName: string;
  /**
   * Optional — if left blank the system searches all common hiring roles
   * (Engineering Manager, Recruiter, Software Engineer, HR Manager, etc.)
   */
  targetRole?: string;
  userBio?: string;
  emailSubject: string;
  emailTemplate: string;
  jobDescription?: string;
  linkedinProfile?: string;
}

/** @deprecated Use EmailCandidate instead */
export interface InferredEmail {
  format: string;
  confidence: "Likely" | "Public";
}

export interface DiscoveredPerson {
  name: string;
  role: string;
  company: string;
  linkedinUrl?: string;
  publicEmail?: string;
  source: string;
}

export interface PersonalizedEmail {
  subject: string;
  body: string;
}
