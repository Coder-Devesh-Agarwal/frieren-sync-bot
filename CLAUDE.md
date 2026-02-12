# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Frieren?

Frieren is a WhatsApp group message sync bot. It forwards messages between mapped WhatsApp groups (one-way or bidirectional) via whatsapp-web.js/Puppeteer. It has a React admin dashboard for login (email + password + TOTP), WhatsApp QR pairing, group browsing, and managing sync mappings.

## Commands

- `bun install` — install dependencies
- `bun run dev` — build Tailwind CSS then start server with HMR (`--hot`)
- `bun run start` — build Tailwind CSS then start server (production)
- `bun run css` — one-shot Tailwind CSS build (`tailwind.css` → `styles.css`)
- `bun run css:watch` — watch mode Tailwind CSS build
- `bun run docker:up` / `bun run docker:down` — Docker Compose lifecycle
- `bun test` — run tests (uses `bun:test`)

## Tech Stack & Conventions

- **Runtime:** Bun (not Node.js). Use Bun-native APIs everywhere:
  - `Bun.serve()` for HTTP/WebSocket (not Express)
  - `bun:sqlite` for SQLite (not better-sqlite3)
  - `Bun.file()` over `node:fs`
  - Bun auto-loads `.env` — no dotenv needed
- **Frontend:** Single-file React app (`frontend.tsx`) bundled by Bun's HTML imports. No Vite, no webpack. The HTML entry (`index.html`) imports the TSX directly.
- **CSS:** Tailwind CSS v4 compiled via `@tailwindcss/cli`. Source is `tailwind.css`, output is `styles.css` (gitignored). Custom components (spinner, toggle) live in `tailwind.css`.
- **TypeScript:** Strict mode, ESNext target, `react-jsx` transform, bundler module resolution.

## Architecture

All server code is flat in the project root (no `src/` directory):

- **`index.ts`** — HTTP server (`Bun.serve`) with route definitions for all API endpoints. Handles auth middleware via `requireAuth()`, rate limiting, and lazy WhatsApp initialization on first login.
- **`auth.ts`** — Authentication: single-admin credential check (email + password + TOTP via `otpauth`), session token generation (crypto random), cookie-based session management. Sessions stored in SQLite.
- **`db.ts`** — SQLite database layer using `bun:sqlite`. Three tables: `sessions`, `group_mappings`, `message_log`. All queries are prepared statements. Exports CRUD functions for mappings and session management.
- **`whatsapp.ts`** — WhatsApp client lifecycle (whatsapp-web.js + Puppeteer). Manages QR generation, connection state machine (`disconnected` → `qr_pending` → `connecting` → `ready`), group discovery, and message forwarding with dual loop-prevention (sent-message tracking + content-hash dedup).
- **`frontend.tsx`** — Entire React SPA. Screen-based navigation (login → QR → dashboard/mappings). Polls `/api/whatsapp/status` for QR updates. All API calls go through a single `api()` helper.
- **`constants.ts`** — Shared constants.

## API Routes

All under `/api/`. Auth-protected routes check session cookie via `requireAuth()`.

- `POST /api/auth/login` — login (rate-limited, 5 attempts per 15 min per IP)
- `POST /api/auth/logout` — logout
- `GET /api/auth/status` — check auth + WhatsApp state
- `GET /api/whatsapp/status` — WhatsApp connection state + QR data URL (protected)
- `GET /api/groups` — list WhatsApp groups (protected)
- `GET/POST /api/mappings` — list/create group mappings (protected)
- `PATCH/DELETE /api/mappings/:id` — update/delete mapping (protected)
- `GET /api/stats` — forwarded message counts per mapping (protected)

## Environment Variables

See `.env.example`: `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `TOTP_SECRET` (required), `PORT` (optional, default 3000), `DB_PATH` (used in Docker, default `frieren.db`).
