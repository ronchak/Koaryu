# Koaryu

**CRM for Martial arts studios that doesn't scam you!!**

> **A warrior's flow.** The daily operating system for independent martial arts studios.

Koaryu blends "Koa" (Hawaiian for warrior) with "Ryu" (Japanese for flow / school of martial arts). A flat-rate vertical SaaS that replaces spreadsheets and overpriced legacy tools with purpose-built software for student management, belt progression, scheduling, billing, and retention.

My first paid job in high school was in a martial arts studio, and I saw firsthand just how suffocating CRM software for Martial Arts was, sometimes costing more than $150-$200 a month. In fact, the absolute cheapest purpose built software for martial arts studios I could find was still $49 a month. I think we can do better (or at the very least, way cheaper).

## Architecture

```
koaryu/
├── frontend/           # Next.js 14 App Router (TypeScript, Tailwind)
├── backend/            # FastAPI (Python 3.11+)
├── supabase/           # Database migrations
└── README.md
```

## Getting Started

### Prerequisites

- Node.js 18+
- Python 3.11+
- A Supabase project (free tier works)

### Frontend

```bash
cd frontend
cp .env.example .env.local
# Fill in your Supabase credentials
npm install
npm run dev
```

### Backend

```bash
cd backend
cp .env.example .env
# Fill in your Supabase credentials
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

### Database

Run the migration SQL in `supabase/migrations/001_init.sql` via the Supabase SQL Editor.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14, TypeScript, Tailwind CSS, lucide-react |
| Backend | FastAPI, Pydantic v2, Supabase-py |
| Database | PostgreSQL via Supabase (RLS for multi-tenancy) |
| Auth | Supabase Auth (email/password + magic link) |
| Payments | Stripe Billing (Phase 6) |
| Email | Resend (Phase 7) |
| Deployment | Vercel + Render |

## License

Proprietary. All rights reserved.
