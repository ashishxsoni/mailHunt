-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "linkedinUrl" TEXT,
    "email" TEXT NOT NULL,
    "emailSource" TEXT NOT NULL DEFAULT 'inferred',
    "confidence" TEXT NOT NULL DEFAULT 'medium',
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "sentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyName" TEXT NOT NULL,
    "targetRole" TEXT NOT NULL,
    "userBio" TEXT NOT NULL,
    "emailSubject" TEXT NOT NULL,
    "emailTemplate" TEXT NOT NULL,
    "jobDescription" TEXT,
    "linkedinProfile" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
