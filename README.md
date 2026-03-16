# JobHunt

A self-hosted desktop application for finding, filtering, and applying to software engineering jobs. JobHunt scrapes job boards directly from company ATS platforms on a schedule, scores results against your preferences, and automates form-filling using a two-phase browser automation pipeline powered by Groq.

---

## Features

- **Multi-source job scraping** — Greenhouse, Lever, Workday, SmartRecruiters, and email (IMAP/LinkedIn alerts)
- **Config-driven scoring and filtering** — title rules, keyword rules, penalties, location allow/blocklist, remote toggle
- **Company discovery** — search by name, browse the full Lever sitemap, probe a curated Greenhouse seed list, or paste any text to extract ATS URLs
- **Auto Apply** — two-phase Playwright pipeline that scrapes real form fields from live job URLs, fills them with Groq, and lets you review before anything is submitted
- **SSE live updates** — browser push when new jobs arrive, no polling needed
- **OS keyring secret storage** — Groq API key and IMAP password never touch the frontend
- **Per-host rate limiting** — respects ATS servers with token-bucket throttling

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Tauri shell (Rust)                                  │
│  ┌───────────────────────────────────────────────┐  │
│  │  React + TypeScript UI  (Vite)                │  │
│  │  App · Preferences · Scraping · AutoApply     │  │
│  └──────────────┬────────────────────────────────┘  │
│                 │ HTTP localhost:38471               │
│  ┌──────────────▼────────────────────────────────┐  │
│  │  Go engine (sidecar)                          │  │
│  │  httpapi · scrape · rank · config · store     │  │
│  │  poll · events · secrets                      │  │
│  └──────────────┬────────────────────────────────┘  │
│                 │                                    │
│  ┌──────────────▼────────────────────────────────┐  │
│  │  SQLite  (jobhunt.db)                         │  │
│  └───────────────────────────────────────────────┘  │
│                                                      │
│  Node.js sidecar  (filler.js — Playwright)           │
│  Spawned by engine for --scrape and --fill phases    │
└─────────────────────────────────────────────────────┘
```

### Go engine packages

| Package | Responsibility |
|---------|---------------|
| `cmd/engine` | Entry point, wires everything together |
| `httpapi` | REST handlers, router, SSE hub registration |
| `scrape/greenhouse` | Greenhouse board API scraper |
| `scrape/lever` | Lever postings API scraper |
| `scrape/workday` | Workday careers page scraper |
| `scrape/smartrecruiters` | SmartRecruiters API scraper |
| `scrape/email` | IMAP ingestion, LinkedIn alert parsing |
| `scrape/filter` | Location and keyword filtering |
| `scrape/util` | Rate limiter, URL helpers, text normalisation |
| `rank` | Config-driven YAML scorer |
| `config` | Load, normalise, validate YAML config |
| `store` | SQLite schema, migrations, queries |
| `poll` | Background ticker, runs scrape every 3 hours |
| `events` | Pub/sub SSE hub |
| `secrets` | OS keyring wrapper (go-keyring) |
| `domain` | Shared data types (`JobLead`) |

### Frontend structure

```
src/
├── App.tsx              # Jobs list, routing, error boundaries
├── Scraping.tsx         # ATS config, company discovery
├── Preferences.tsx      # Scoring rules, filters, polling
├── AutoApply.tsx        # Tab shell (Profile / Review Queue)
├── ProfileTab.tsx       # Applicant profile form
├── QueueTab.tsx         # Review queue list
├── DraftCard.tsx        # Single application card (expand/scrape/fill/apply)
├── FieldRows.tsx        # Editable field rows (profile + scraped)
├── ErrorBoundary.tsx    # Catches render crashes per view
├── useApplyQueue.ts     # All queue state + scrapeDraft/fillDraft/applyDraft
├── applyLLM.ts          # Groq prompt functions
├── applyStorage.ts      # localStorage helpers, ATS detection, field seeding
├── types.ts             # Shared TypeScript types
├── api.ts               # Engine HTTP client
└── configNormalize.ts   # Safe config deserialization
```

### Auto Apply pipeline

```
1. User clicks Apply on a job
        │
        ▼
2. useAutoApplyQueue.addToQueue() — seeds profile fields, saves to localStorage
        │
        ▼
3. User clicks "Scrape Form" in DraftCard
        │
        ▼
4. POST /api/apply/scrape → engine spawns:
   node filler.js --scrape --url <url> --out <result.json>
   Playwright opens the live form (visible browser), reads every field:
     - label text, input type, CSS selector
     - clicks each React select to hydrate option lists
     - clicks "Enter manually" to expose cover letter textarea
        │
        ▼
5. Engine reads result.json, sends fields + profile to Groq via /api/llm
   Groq returns filled values; selects are validated against real options
        │
        ▼
6. User reviews fields in DraftCard — edits any value, selects from real dropdowns
        │
        ▼
7. User clicks "Open & Fill Browser"
        │
        ▼
8. POST /api/apply/fill → engine spawns:
   node filler.js --fill --job <job.json>
   Playwright opens the form (visible), injects each value by exact selector.
   Cover letter: clicks "Enter manually", fills textarea.
   Browser stays open — user uploads resume, solves CAPTCHA, clicks Submit.
```

---

## Getting Started

### Prerequisites

- Go 1.22+
- Node.js 18+ (for the Playwright filler sidecar)
- Rust + `cargo` (for Tauri)
- A Groq API key (free at [console.groq.com](https://console.groq.com)) — required for Auto Apply

### Install Playwright browser

```bash
cd filler
npm install
npx playwright install chromium
```

### Build and run (development)

```bash
# From apps/desktop/jobhunt
npm run tauri:dev
```

This script:
1. Builds the Go engine binary
2. Installs filler dependencies if needed
3. Stages the filler directory into Tauri resources
4. Launches `tauri dev`

### Build for distribution

```bash
npm run tauri:build
```

### Run the engine standalone

```bash
cd engine
go run ./cmd/engine
# Listens on http://127.0.0.1:38471
```

---

## Configuration

Config lives at `~/.config/jobhunt/config.yml` (Linux/macOS) or `%APPDATA%\jobhunt\config.yml` (Windows). The UI writes to this file — you rarely need to edit it directly.

### Key config sections

```yaml
polling:
  email_seconds: 60
  fast_lane_seconds: 60       # Greenhouse/Lever check interval
  normal_lane_seconds: 300

filters:
  remote_ok: true
  locations_allow: ["Texas", "Dallas", "Austin"]
  locations_block: ["London", "Toronto"]

scoring:
  notify_min_score: 5
  title_rules:
    - tag: senior-eng
      weight: 20
      any: ["senior engineer", "staff engineer", "principal"]
  keyword_rules:
    - tag: golang
      weight: 10
      any: ["golang", "go lang"]
  penalties:
    - reason: too-junior
      weight: -15
      any: ["intern", "entry level", "new grad"]

sources:
  greenhouse:
    enabled: true
    companies:
      - slug: stripe
        name: Stripe
  lever:
    enabled: true
    companies:
      - slug: openai
        name: OpenAI
```

### Secret storage

Secrets are stored in the OS keyring — never in config files or environment variables.

| Secret | Stored as |
|--------|-----------|
| IMAP app password | `jobhunt:imap:password` |
| Groq API key | `jobhunt:groq:api_key` |

Set them through the UI: **Scraping → Email** for IMAP, **Auto Apply → Profile → Groq API Key** for Groq.

---

## API

The engine exposes a local REST API on `http://127.0.0.1:38471`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/jobs` | List jobs (`?sort=score&window=7d`) |
| `DELETE` | `/jobs/:id` | Remove a job |
| `GET` | `/jobs/:id/description` | Fetch scraped job description |
| `GET` | `/config` | Get current config |
| `PUT` | `/config` | Save config (validates before writing) |
| `POST` | `/scrape/run` | Trigger a scrape immediately |
| `GET` | `/scrape/status` | Last run time, error, jobs added |
| `GET` | `/events` | SSE stream (`job_created`, `job_deleted`) |
| `GET` | `/api/companies/search` | Probe GH/Lever for a company name (`?q=stripe`) |
| `GET` | `/api/companies/discover` | Browse all (`?source=lever&q=health`) |
| `POST` | `/api/companies/extract` | Extract ATS slugs from pasted text |
| `POST` | `/api/apply/scrape` | Scrape real form fields from a job URL |
| `POST` | `/api/apply/fill` | Launch Playwright filler with reviewed fields |
| `POST` | `/api/llm` | Groq proxy (keeps key server-side) |
| `POST` | `/api/secrets/groq` | Store Groq API key in OS keyring |
| `GET` | `/api/secrets/groq/status` | Check whether key is stored |
| `POST` | `/api/secrets/imap` | Store IMAP password in OS keyring |

---

## Testing

```bash
cd engine
go test ./...
```

Test coverage is focused on the pure-function core: filtering, scoring, config validation, and text normalisation. These are the most critical paths and have no I/O dependencies.

| Package | Test file | What's covered |
|---------|-----------|----------------|
| `scrape` | `filter_test.go` | `ShouldKeepJob`, `passesLocation`, `matchesAnyRule` |
| `rank` | `yaml_scorer_test.go` | `YAMLScorer.Score`, `uniq` |
| `config` | `validate_test.go` | `NormalizeAndValidate` — errors, warnings, deduplication |
| `scrape/util` | `normalize_test.go` | `CleanText`, `NormalizeLocation`, `InferWorkModeFromText`, `ExtractLocationFromLabeledText`, `LooksLikeJunkTitle` |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Tauri 2 (Rust) |
| Frontend | React 19 + TypeScript, Vite |
| Engine | Go 1.22 |
| Database | SQLite (modernc/sqlite — pure Go, no CGO) |
| Browser automation | Playwright (Node.js sidecar) |
| AI fill | Groq (`llama-3.3-70b-versatile`) via engine proxy |
| Email | IMAP via `go-imap/v2` |
| Secret storage | OS keyring via `go-keyring` |
| Rate limiting | `golang.org/x/time/rate` (per-host token bucket) |
| Config | YAML via `gopkg.in/yaml.v3` |
| HTML parsing | `github.com/PuerkitoBio/goquery` |

---

## Project Structure

```
JobHunt/
├── engine/                          # Go backend
│   ├── cmd/engine/main.go
│   └── internal/
│       ├── config/                  # Load, validate, save config
│       ├── domain/                  # Shared types (JobLead)
│       ├── events/                  # SSE pub/sub hub
│       ├── httpapi/                 # REST handlers + router
│       ├── poll/                    # Background polling loop
│       ├── rank/                    # Job scoring
│       ├── scrape/                  # ATS + email scrapers, filter, utils
│       ├── secrets/                 # OS keyring wrapper
│       └── store/                   # SQLite schema + queries
├── apps/desktop/jobhunt/            # Tauri + React app
│   ├── src/                         # TypeScript source
│   ├── src-tauri/                   # Tauri config + Rust shell
│   └── scripts/dev-tauri.js         # Dev build orchestration
└── filler/                          # Node.js Playwright sidecar
    ├── filler.js                    # --scrape and --fill modes
    └── package.json
```