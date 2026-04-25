# mailHunt

Discover professionals at any company, find their work emails, and send personalized outreach — all from one place.

Built with Next.js 16, TypeScript, Prisma (SQLite), and Tailwind CSS.

---

## Features

- **Contact Discovery** — Multi-provider chain: Snov.io → Hunter.io → LinkedIn X-Ray (SerpAPI / Google CSE / Bing / DuckDuckGo) → GitHub
- **Email Finder** — Given a name + company, generates 15 pattern candidates ranked by probability, cross-verified by Hunter.io, Snov.io, SMTP probe, ZeroBounce, and AbstractAPI
- **Email Verifier** — Full audit trail: format check → disposable blocklist → MX/SPF/DMARC lookup → SMTP probe → ZeroBounce → AbstractAPI → 0–100 confidence score
- **Employment Verification** — Apollo.io People Match confirms whether a person currently works at the target company, surfaces their LinkedIn URL and job title
- **Personalized Outreach** — Template variables (`{name}`, `{role}`, `{company}`, `{target_role}`, `{skills}`) auto-populated per contact, sent via Gmail SMTP
- **Contact Dashboard** — Filter by status (Pending / Sent / Failed), search by name, copy emails, preview before sending

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript |
| Styling | Tailwind CSS v4 |
| Database | Prisma + SQLite |
| State | Zustand |
| Email sending | Nodemailer (Gmail) |
| Toasts | Sonner |
| Icons | Lucide React |

---

## Getting Started

### 1. Clone and install

```bash
git clone https://github.com/ashishxsoni/mailHunt.git
cd mailHunt
npm install
```

### 2. Set up environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in the values. At minimum you need:
- `EMAIL_USER` + `EMAIL_APP_PASSWORD` — to send emails
- `HUNTER_API_KEY` — for email pattern learning (free tier works)

All other providers are optional and the app falls back gracefully without them.

### 3. Set up the database

```bash
npx prisma generate
npx prisma db push
```

### 4. Run the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Environment Variables

See [`.env.example`](.env.example) for the full list with setup instructions.

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | SQLite path — `file:./dev.db` for local |
| `EMAIL_USER` | Yes | Gmail address to send from |
| `EMAIL_APP_PASSWORD` | Yes | Gmail App Password (16 chars) |
| `HUNTER_API_KEY` | Recommended | Email pattern learning + person lookup |
| `SNOV_CLIENT_ID` / `SNOV_CLIENT_SECRET` | Optional | People discovery + email finding |
| `GITHUB_TOKEN` | Optional | Raises GitHub rate limit from 10 to 30 req/min |
| `SERPAPI_KEY` | Optional | Google X-Ray LinkedIn search |
| `GOOGLE_CSE_API_KEY` / `GOOGLE_CSE_CX` | Optional | Google Custom Search fallback |
| `BING_SEARCH_API_KEY` | Optional | Bing LinkedIn X-Ray fallback |
| `ZEROBOUNCE_API_KEY` | Optional | SMTP email verification (100/month free) |
| `ABSTRACTAPI_EMAIL_KEY` | Optional | Email deliverability fallback |
| `APOLLO_API_KEY` | Optional | Employment verification (50/month free) |
| `ADMIN_SECRET` | Optional | Protects the `DELETE /api/contacts` endpoint |

---

## Deployment

### Vercel (recommended)

1. Push to GitHub
2. Import the repo at [vercel.com/new](https://vercel.com/new)
3. Add all environment variables from `.env.example` in the Vercel dashboard
4. For the database, switch `DATABASE_URL` to a hosted provider (e.g. [Turso](https://turso.tech) for SQLite-compatible or [PlanetScale](https://planetscale.com))

> **Note:** SQLite (`file:./dev.db`) does not persist on Vercel's serverless filesystem. Use a hosted database for production.

---

## Project Structure

```
src/
├── app/
│   ├── page.tsx              # Home — campaign form
│   ├── dashboard/page.tsx    # Contact dashboard
│   ├── tools/page.tsx        # Email Verifier + Finder tools
│   └── api/
│       ├── discover/         # Multi-provider contact discovery
│       ├── find-email/       # Email finder for a specific person
│       ├── verify-email/     # Single email verifier
│       ├── send-email/       # Gmail sender
│       └── contacts/         # Contact CRUD
├── components/
│   ├── ContactDashboard.tsx
│   ├── ContactRow.tsx
│   ├── StatsBar.tsx
│   └── MailPreviewModal.tsx
├── lib/
│   ├── providers/            # Hunter, ZeroBounce, AbstractAPI, Apollo, GitHub, Bing, DDG, GoogleCSE
│   ├── ownVerifier/          # SMTP probe, MX lookup, pattern scorer, disposable blocklist
│   ├── providerChain.ts      # Discovery orchestrator
│   ├── emailVerifier.ts      # Snov.io integration
│   └── personalizeEmail.ts   # Template variable substitution
├── store/
│   └── useContactStore.ts    # Zustand state
└── types/
    └── index.ts
```

---

## License

MIT

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
