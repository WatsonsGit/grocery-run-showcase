# Grocery Run

A dead-simple, iPhone-first grocery list. Speak it, type it, cross it off.

Built by Watson Saintsulne with Claude Code. Grocery Run was extracted from the grocery feature inside a larger personal-finance app into its own standalone app, sharing the same database so a list edited in one shows up in the other. This repository is a clean public copy of the code, published as a portfolio piece. It runs privately, so there is no public live link.

## What it shows

- **Voice input.** Say "milk, two dozen eggs and coffee" and it becomes three items.
- **Works offline.** A service worker (`public/sw.js`) queues changes while the phone has no signal and saves them when it reconnects.
- **Undo that feels native.** Every delete and check-off has a 10-second undo.
- **Installs like an app.** Home-screen icons and a web app manifest, so it opens full-screen from the iPhone home screen.
- **Safe data access.** The browser never touches the database. Every read and write goes through server routes (`src/app/api/`), and no database code reaches the browser bundle.
- **Shared database, zero migrations.** The schema in `src/lib/schema.ts` is declared for type safety only. This app never changes the database it shares.

## Stack

Next.js 16 (App Router, TypeScript), Tailwind CSS v4, Postgres on Neon through Drizzle ORM, Vaul drawers, deployed on Vercel.

## Run it locally

```bash
npm install
cp .env.local.example .env.local   # set DATABASE_URL to your own Postgres database with the two shopping tables
npm run dev
```

Then open http://localhost:3000.
