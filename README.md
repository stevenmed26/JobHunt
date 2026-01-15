# JobHunt

JobHunt is a backend-driven application for collecting, normalizing, and ranking job listings from multiple sources such as email alerts and company ATS feeds. It is designed as a reliable ingestion and processing pipeline rather than a simple scraper.

The goal is to turn messy, duplicate-filled job data into a clean, queryable dataset that can be used to drive filtering, scoring, and a lightweight UI.

---

## Overview

Job postings are fragmented across email alerts, ATS platforms, and company pages. JobHunt pulls these sources together into a single system that:

- Ingests jobs from multiple sources (email, ATS feeds, and configured endpoints)
- Normalizes titles, companies, locations, and links
- Deduplicates results across sources
- Applies configurable filtering and scoring
- Exposes the resulting dataset through an API and UI

The project is built to be safe to re-run and re-process historical data as parsing or filtering rules change.

---

## Architecture

JobHunt is structured as a small backend platform:

- **Go backend**  
  Handles ingestion, parsing, deduplication, scoring, persistence, and API endpoints.

- **SQLite / SQL database**  
  Stores normalized job leads, source metadata, and scoring results.

- **Desktop / UI layer (Tauri + React)**  
  Provides a lightweight interface for viewing, filtering, and managing jobs.

The system is designed to be:
- Idempotent (safe to re-run)
- Observable (clear logging and error reporting)
- Extensible (new sources and filters can be added without rewriting core logic)

---

## Key Features

- Email-based job ingestion (e.g., LinkedIn, Indeed alerts via IMAP)
- HTML parsing and link extraction
- Normalization of job metadata
- Deterministic deduplication
- Config-driven filtering and scoring
- REST API for UI and external access
- Background processing for long-running tasks

---

## Tech Stack

**Backend**
- Go
- SQLite / SQL
- IMAP for email ingestion
- HTML parsing and scraping
- REST APIs

**Frontend / Desktop**
- Tauri
- React + TypeScript

**Tooling**
- Git
- Makefile
- GitHub Actions (CI)

---

## Getting Started

### Prerequisites

- Go (1.20+ recommended)
- Node.js (for the UI)
- SQLite
- A Gmail or IMAP account for email ingestion

---

### Configuration

Create a configuration file or environment variables for:

- IMAP host, username, and app password
- Database path
- Enabled job sources
- Filters and scoring rules

(See the `config` directory for examples.)

---

### Running the backend

From the project root:

```bash
go run ./cmd/engine