# Changelog

All notable changes to JobHunt are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).  
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [1.1.2] — 2026-03-17

### Added

**Browser Extension (Experimental)**
- Chrome-compatible extension that can auto-fill job application forms directly from the browser without opening JobHunt first
- Supports **Greenhouse** and **Lever** application forms
- Extension scrapes the live form fields, sends them to the JobHunt engine for Groq completion, and injects answers back into the page
- Cover letter generation handled through the same Groq pipeline used by the desktop Auto Apply system
- Automatic company detection from ATS URLs (e.g. `job-boards.greenhouse.io/gitlab/...`)
- Cover letters optionally saved to disk via the engine (`saveCoverLetterEnabled` setting)
- Safe injection guards to prevent writing text into file upload inputs (`<input type="file">`)
- Debug logging for scraping, AI prompting, cover letter generation, and injection steps

**AI Prompting Improvements**
- Two-pass Groq prompting for scraped forms:
  - **Pass 1:** short fields (text, select, yes/no)
  - **Pass 2:** long-form cover letter generation
- Prevents JSON truncation caused by long cover letters exceeding token limits
- Company name explicitly injected into cover letter prompts to prevent reuse of previous company names from resume templates
- Extended demographic field mappings for ATS EEO questions:
  - gender identity
  - race / ethnicity
  - veteran status
  - disability status
  - sexual orientation
  - transgender status

### Changed

- Cover letter prompts now explicitly enforce the target company name and ignore historical company references in templates or resumes
- Scraped form filling now prioritises textarea-based manual-entry widgets for cover letters instead of file upload fields
- Extension injection pipeline now skips file inputs entirely to prevent browser security errors

### Fixed

- Extension crash when attempting to programmatically set the value of file upload inputs (`input[type=file]`)
- Cover letter injection failing on Greenhouse forms when the hidden upload field was selected instead of the manual textarea
- Groq prompt occasionally producing cover letters referencing the wrong company due to template contamination
- Field merge logic dropping values when cover letter JSON responses exceeded token limits

## [1.1.0] — 2026-03-15

### Added

**Auto Apply**
- Two-phase Playwright pipeline for automatically filling ATS job application forms
- **Phase 1 — Scrape:** headless Chromium opens the live job URL, reads every form field by exact CSS selector, clicks each React custom dropdown to hydrate its full option list, and clicks "Enter manually" to expose cover letter textareas before capturing them
- **Phase 2 — Fill:** Groq (`llama-3.3-70b-versatile`) receives scraped field labels, types, and dropdown options alongside the applicant profile and job description, returns filled values; a visible browser window then injects each value using the exact scraped selector
- Cover letter field detection and auto-fill via the Greenhouse "Enter manually" widget
- Review queue in the UI — all scraped fields are editable before anything is submitted; select fields show real dropdown options from the live form
- Three-step progress indicator per application (Scrape → Review & fill → Open & submit)
- "Scrape all forms" batch action in the queue header
- Draft persistence across sessions via `localStorage` with forward-compatible migration (`migrateDraft`)

**Applicant Profile**
- Full profile form: identity, work details, EEO/demographic fields, resume plain text, cover letter template
- Groq API key storage via OS keyring — key never touches the frontend
- Profile persisted to `localStorage`

**Company Discovery**
- **Search by name:** probes Greenhouse boards API and Lever postings API with slug candidates generated from five normalisation strategies (no-spaces, hyphenated, suffix-stripped, first-word, acronym)
- **Browse all — Lever:** fetches `jobs.lever.co/sitemap.xml` (every company currently posting), filterable by keyword
- **Browse all — Greenhouse:** parallel probes against ~300 curated seed slugs, filterable by keyword
- **Paste URLs:** regex extracts `boards.greenhouse.io`, `job-boards.greenhouse.io`, and `jobs.lever.co` slugs from any pasted text (emails, HTML, job board pages, HN threads)
- Add button drops slug + name directly into the correct ATS source textarea; one Save writes to `companies.yml`

**Engine — new endpoints**
- `POST /api/apply/scrape` — spawns `filler.js --scrape`, waits synchronously, returns scraped field list
- `POST /api/apply/fill` — spawns `filler.js --fill` detached, browser stays open for user review
- `POST /api/llm` — Groq proxy; keeps API key server-side, bypasses Tauri CSP
- `POST /api/secrets/groq` — stores Groq API key in OS keyring
- `GET  /api/secrets/groq/status` — reports whether a key is stored
- `GET  /api/companies/search` — name-to-slug probe (`?q=stripe&ats=greenhouse`)
- `GET  /api/companies/discover` — Lever sitemap / Greenhouse seed probe (`?source=lever&q=health`)
- `POST /api/companies/extract` — ATS slug extraction from free text
- `GET  /jobs/:id/description` — returns the scraped job description stored in SQLite

**Engine — other**
- Schema v2 migration: adds `description TEXT` column to `jobs` table via idempotent `ALTER TABLE`; existing databases upgrade automatically on first run
- Job description stored on scrape and exposed via API for use in Groq prompts

**Frontend refactor**
- `AutoApply.tsx` split into 9 focused files: `types.ts`, `applyStorage.ts`, `applyLLM.ts`, `useApplyQueue.ts`, `ErrorBoundary.tsx`, `FieldRows.tsx`, `DraftCard.tsx`, `ProfileTab.tsx`, `QueueTab.tsx`
- `ErrorBoundary` wraps each view in `App.tsx` and the root in `main.tsx` — render crashes show a recovery UI instead of a black screen
- All queue state and draft actions extracted into `useApplyQueue` custom hook
- LLM prompt logic extracted into `applyLLM.ts` (no React, fully pure, independently testable)
- localStorage helpers, ATS detection, and field seeding extracted into `applyStorage.ts`

**Tests**
- `scrape/filter_test.go` — 16 cases covering `ShouldKeepJob`, `passesLocation`, `matchesAnyRule`
- `rank/yaml_scorer_test.go` — 11 cases covering `YAMLScorer.Score` and `uniq`
- `config/validate_test.go` — 12 cases covering `NormalizeAndValidate` (errors, warnings, deduplication)
- `scrape/util/normalize_test.go` — 26 cases covering `CleanText`, `NormalizeLocation`, `InferWorkModeFromText`, `ExtractLocationFromLabeledText`, `LooksLikeJunkTitle`
- All 40 tests pass: `go test ./...`

### Changed

- `global.css`: removed unused `.row` and `.sub` rules, added missing `.tagSource` rule, added `font-family: var(--font)` to `.input`, `.selectBtn`, `.selectItem` for consistent system font inheritance
- `App.tsx`: imports `useAutoApplyQueue` from `useApplyQueue.ts` instead of `AutoApply.tsx`; each view wrapped in `<ErrorBoundary>`
- `Cargo.toml`: updated description and author fields

### Fixed

- Black screen on Auto Apply view caused by `localStorage` queue items saved before `scrapedFields` field existed — `migrateDraft` normalises all persisted drafts to the current shape on load
- Cover letter not being filled: Greenhouse scrapes the "Enter manually" button text as a field label; fixed by filtering button-text labels and renaming `#cover_letter_text` to "Cover Letter" during scrape
- React select dropdowns showing empty options — Greenhouse renders options lazily (only after click); scraper now clicks each control, reads the open option list, then closes before moving to the next
- Focus loss when typing in profile fields caused by component functions defined inside the parent render scope; `ProfileTab`, `QueueTab`, and field primitives moved to module level
- `updateScrapedField` TypeScript error (`Expected 1 argument, but got 2`) — `setAddedSlugs` updater now explicitly constructs and returns the new `Set` rather than chaining `.add()`
- File casing conflicts on Windows (`Applystorage.ts` vs `applyStorage.ts`) — all new files use consistent casing matching TypeScript's `forceConsistentCasingInFileNames`

---

## [1.0.0] — 2026-01-16

### Added

- Greenhouse, Lever, Workday, and SmartRecruiters ATS scrapers
- Email ingestion via IMAP (LinkedIn and Indeed job alert parsing)
- Config-driven scoring: title rules, keyword rules, penalties with `any[]` matching
- Location filtering: allow list, block list, remote toggle
- Per-host token-bucket rate limiting (`golang.org/x/time/rate`)
- SQLite persistence with WAL mode and schema migrations
- SSE live updates — frontend receives `job_created` / `job_deleted` events without polling
- `atomic.Value` config hot-reload — config changes take effect without restarting the engine
- OS keyring secret storage for IMAP app password (`go-keyring`)
- File-lock single-instance guard (`gofrs/flock`)
- Graceful engine shutdown — Tauri shell sends authenticated `/shutdown` request; engine drains then exits
- DB export via Tauri `export_db` command with WAL checkpoint before copy
- Preferences UI: scoring rules editor, filter config, polling intervals
- Scraping UI: ATS source management, email IMAP config, manual scrape trigger, live status
- Company logo fetching and caching
- Auto-updater via Tauri updater plugin pointed at GitHub releases
- Tauri desktop shell with engine sidecar, stdout/stderr parsing for port and shutdown token