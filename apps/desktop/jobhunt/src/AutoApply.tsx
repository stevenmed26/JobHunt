// src/AutoApply.tsx
//
// New page for JobHunt — drop alongside App.tsx, Preferences.tsx, Scraping.tsx
//
// Wiring into App.tsx:
//   1. import AutoApply from "./AutoApply";
//   2. Add "apply" to the view type:  type View = "jobs" | "prefs" | "scrape" | "apply"
//   3. Add button in toolbar:  <button className="btn" onClick={() => setView("apply")}>Auto Apply</button>
//   4. Add branch:  if (view === "apply") return <AutoApply onBack={() => setView("jobs")} />;

import React, { useEffect, useRef, useState } from "react";
import { getJobDescription, callLLM, setGroqAPIKey, getGroqKeyStatus, scrapeForm, fillForm, ScrapedField } from "./api";

// ─── Types ──────────────────────────────────────────────────────────────────

type WorkAuth = "us_citizen" | "green_card" | "h1b" | "other";
type Gender = "male" | "female" | "non_binary" | "prefer_not";
type Race =
  | "white"
  | "black"
  | "hispanic"
  | "asian"
  | "native"
  | "pacific"
  | "two_or_more"
  | "prefer_not";
type VeteranStatus = "yes" | "no" | "prefer_not";
type DisabilityStatus = "yes" | "no" | "prefer_not";

export interface ApplicantProfile {
  // Identity
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  linkedinURL: string;
  portfolioURL: string;
  githubURL: string;
  location: string; // "City, State"

  // Work
  workAuth: WorkAuth;
  requiresSponsorship: boolean;
  yearsExperience: string;
  currentTitle: string;
  desiredSalary: string;

  // EEO (all optional on real forms)
  gender: Gender;
  race: Race;
  veteranStatus: VeteranStatus;
  disabilityStatus: DisabilityStatus;

  // Docs (stored as text — user pastes plain-text resume / cover letter)
  resumeText: string;
  coverLetterText: string;
  resumeFileName: string;     // display only (for the txt/paste version)
  coverLetterFileName: string;
  resumePdfPath: string;      // absolute path to the actual PDF on disk
  resumePdfName: string;      // display only
}

// A single application in the review queue
export interface ApplicationDraft {
  jobId: number;
  company: string;
  title: string;
  url: string;
  atsType: "greenhouse" | "lever" | "unknown"; // detected from URL
  atsSlug: string;
  atsJobId: string;
  // Status flow: pending → scraping → scraped → filling → ready → submitted
  status: "pending" | "scraping" | "scraped" | "filling" | "ready" | "submitted" | "error";
  fields: ApplicationField[];       // profile-seeded fields (for Groq context)
  scrapedFields: ScrapedField[];    // real form fields from live DOM scrape
  errorMsg?: string;
  applying?: boolean;               // fill run in progress
}

export interface ApplicationField {
  key: string; // e.g. "first_name", "cover_letter", "how_did_you_hear"
  label: string; // human-readable
  value: string;
  source: "profile" | "ai" | "manual"; // how the value was obtained
  required: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PROFILE_KEY = "jh_applicant_profile_v1";
const QUEUE_KEY = "jh_apply_queue_v1";

function loadProfile(): ApplicantProfile {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) return { ...emptyProfile(), ...JSON.parse(raw) };
  } catch {}
  return emptyProfile();
}

function saveProfile(p: ApplicantProfile) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
}

function migrateDraft(d: any): ApplicationDraft {
  // Ensure every draft has all required fields regardless of when it was saved.
  // New fields added to ApplicationDraft must have a safe default here.
  return {
    jobId:         d.jobId         ?? 0,
    company:       d.company       ?? "",
    title:         d.title         ?? "",
    url:           d.url           ?? "",
    atsType:       d.atsType       ?? "unknown",
    atsSlug:       d.atsSlug       ?? "",
    atsJobId:      d.atsJobId      ?? "",
    status:        d.status        ?? "pending",
    fields:        Array.isArray(d.fields)        ? d.fields        : [],
    scrapedFields: Array.isArray(d.scrapedFields) ? d.scrapedFields : [],
    errorMsg:      d.errorMsg,
    applying:      d.applying      ?? false,
  };
}

function loadQueue(): ApplicationDraft[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(migrateDraft);
    }
  } catch {}
  return [];
}

function saveQueue(q: ApplicationDraft[]) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
}

function emptyProfile(): ApplicantProfile {
  return {
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    linkedinURL: "",
    portfolioURL: "",
    githubURL: "",
    location: "",
    workAuth: "us_citizen",
    requiresSponsorship: false,
    yearsExperience: "",
    currentTitle: "",
    desiredSalary: "",
    gender: "prefer_not",
    race: "prefer_not",
    veteranStatus: "prefer_not",
    disabilityStatus: "prefer_not",
    resumeText: "",
    coverLetterText: "",
    resumeFileName: "",
    coverLetterFileName: "",
    resumePdfPath: "",
    resumePdfName: "",
  };
}

function detectATS(url: string): { atsType: ApplicationDraft["atsType"]; atsSlug: string; atsJobId: string } {
  const lower = url.toLowerCase();

  // Greenhouse: boards.greenhouse.io/{slug}/jobs/{id}
  const ghMatch = lower.match(/boards\.greenhouse\.io\/([^/]+)\/jobs\/(\d+)/);
  if (ghMatch) return { atsType: "greenhouse", atsSlug: ghMatch[1], atsJobId: ghMatch[2] };

  // Lever: jobs.lever.co/{slug}/{uuid}
  const lvMatch = lower.match(/jobs\.lever\.co\/([^/]+)\/([0-9a-f-]{36})/);
  if (lvMatch) return { atsType: "lever", atsSlug: lvMatch[1], atsJobId: lvMatch[2] };

  return { atsType: "unknown", atsSlug: "", atsJobId: "" };
}

// Build the known fields from the profile without calling Claude
function profileToFields(profile: ApplicantProfile, atsType: string): ApplicationField[] {
  const f = (key: string, label: string, value: string, required = true): ApplicationField => ({
    key,
    label,
    value,
    source: "profile",
    required,
  });

  const base: ApplicationField[] = [
    f("first_name", "First name", profile.firstName),
    f("last_name", "Last name", profile.lastName),
    f("email", "Email", profile.email),
    f("phone", "Phone", profile.phone),
    f("location", "Location / city", profile.location),
    f("linkedin_profile", "LinkedIn URL", profile.linkedinURL, false),
    f("website", "Portfolio / website", profile.portfolioURL, false),
    f("github", "GitHub URL", profile.githubURL, false),
    f("current_title", "Current title", profile.currentTitle, false),
    f("years_experience", "Years of experience", profile.yearsExperience, false),
    f("desired_salary", "Desired salary", profile.desiredSalary, false),
  ];

  if (atsType === "greenhouse") {
    base.push(
      f("work_authorization", "Work authorization", profile.workAuth, false),
      f("require_sponsorship", "Requires sponsorship", profile.requiresSponsorship ? "yes" : "no", false),
      f("gender", "Gender (EEO)", profile.gender, false),
      f("race", "Race / ethnicity (EEO)", profile.race, false),
      f("veteran_status", "Veteran status", profile.veteranStatus, false),
      f("disability_status", "Disability status", profile.disabilityStatus, false),
    );
  }

  return base;
}

// ─── Claude API call ─────────────────────────────────────────────────────────

async function fillWithLLM(
  draft: ApplicationDraft,
  profile: ApplicantProfile,
  jobDescription: string,
): Promise<ApplicationField[]> {
  const systemPrompt = `You are an assistant helping a job applicant fill out their application form.
Given:
- The applicant's resume (plain text)
- Their default cover letter template
- The job description
- A list of application fields that need answers

Return ONLY a valid JSON array (no markdown, no explanation) where each object has:
  { "key": "<field_key>", "value": "<answer>" }

Rules:
- For cover_letter fields, customize the template for this specific job/company. Keep it professional and concise (3-4 paragraphs max).
- For "why do you want to work here" style questions, write 2-3 genuine-sounding sentences using the job description.
- For salary fields, use the desired salary from the profile if available, otherwise write "Open to discussion".
- For EEO demographic fields (gender, race, veteran, disability), use the values already in the fields — do NOT change them.
- Answer in plain text, no markdown.
- Keep all answers concise and professional.`;

  const unknownFields = draft.fields.filter((f) => f.value === "" || f.source === "ai");

  if (unknownFields.length === 0) return draft.fields;

  const userMessage = `
RESUME:
${profile.resumeText || "(not provided)"}

COVER LETTER TEMPLATE:
${profile.coverLetterText || "(not provided)"}

JOB DESCRIPTION:
${jobDescription || "(not available)"}

FIELDS TO FILL:
${JSON.stringify(unknownFields.map((f) => ({ key: f.key, label: f.label })), null, 2)}

KNOWN APPLICANT INFO:
Name: ${profile.firstName} ${profile.lastName}
Email: ${profile.email}
Location: ${profile.location}
Current title: ${profile.currentTitle}
Years of experience: ${profile.yearsExperience}
Desired salary: ${profile.desiredSalary}
Work authorization: ${profile.workAuth}
  `.trim();

  // Route through engine proxy — direct fetch to api.groq.com is blocked
  // by Tauri's webview security policy. The engine holds the API key in keyring.
  const text = await callLLM({
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    max_tokens: 1000,
  });

  let aiAnswers: { key: string; value: string }[] = [];
  try {
    const clean = text.replace(/```json|```/g, "").trim();
    aiAnswers = JSON.parse(clean);
  } catch {
    throw new Error("Failed to parse Claude response as JSON");
  }

  // Merge: start from profile fields, overlay AI answers
  return draft.fields.map((field) => {
    if (field.value !== "" && field.source === "profile") return field; // don't overwrite known fields
    const ai = aiAnswers.find((a) => a.key === field.key);
    if (ai) return { ...field, value: ai.value, source: "ai" };
    return field;
  });
}

// Fill scraped form fields using Groq — uses label text + options list
async function fillScrapedFieldsWithGroq(
  fields: ScrapedField[],
  profile: ApplicantProfile,
  jobDescription: string,
): Promise<ScrapedField[]> {
  if (fields.length === 0) return fields;

  const systemPrompt = `You are filling out a job application form.
Given the applicant profile and each field's label and available options, return the best value for each field.

Return ONLY a JSON array — no markdown, no explanation:
[{ "selector": "<selector>", "value": "<answer>" }, ...]

Rules:
- For select fields, value MUST exactly match one of the provided options (use the option label, not the value).
- For file fields, leave value as empty string "".
- For cover letter fields, write a tailored 3-paragraph cover letter.
- For EEO fields (gender, race, veteran, disability), use the applicant's profile values.
- For unknown custom questions not answerable from the profile, write a brief professional answer.
- Keep all non-cover-letter answers concise (1 sentence or less).`;

  const fieldSummary = fields
    .filter(f => f.type !== "file")
    .map(f => ({
      selector: f.selector,
      label:    f.label,
      type:     f.type,
      required: f.required,
      options:  f.options.map(o => o.label),
    }));

  const userMessage = `APPLICANT PROFILE:
Name: ${profile.firstName} ${profile.lastName}
Email: ${profile.email}
Phone: ${profile.phone}
Location: ${profile.location}
Current title: ${profile.currentTitle}
Years experience: ${profile.yearsExperience}
Work authorization: ${profile.workAuth}
Requires sponsorship: ${profile.requiresSponsorship ? "yes" : "no"}
Desired salary: ${profile.desiredSalary}
LinkedIn: ${profile.linkedinURL}
GitHub: ${profile.githubURL}
Gender: ${profile.gender}
Race: ${profile.race}
Veteran status: ${profile.veteranStatus}
Disability status: ${profile.disabilityStatus}

RESUME:
${profile.resumeText || "(not provided)"}

COVER LETTER TEMPLATE:
${profile.coverLetterText || "(not provided)"}

JOB DESCRIPTION:
${jobDescription || "(not available)"}

FORM FIELDS TO FILL:
${JSON.stringify(fieldSummary, null, 2)}`;

  const text = await callLLM({
    system:     systemPrompt,
    messages:   [{ role: "user", content: userMessage }],
    max_tokens: 2000,
  });

  let answers: { selector: string; value: string }[] = [];
  try {
    const clean = text.replace(/```json|```/g, "").trim();
    answers = JSON.parse(clean);
  } catch {
    console.warn("[AutoApply] Failed to parse Groq response for scraped fields");
    return fields;
  }

  return fields.map((f) => {
    if (f.type === "file") return f;
    const answer = answers.find((a) => a.selector === f.selector);
    if (!answer || !answer.value) return f;
    // For selects, validate the answer is one of the options
    if ((f.type === "select" || f.isReactSelect) && f.options.length > 0) {
      const match = f.options.find(
        (o) => o.label.toLowerCase() === answer.value.toLowerCase() ||
               o.value.toLowerCase() === answer.value.toLowerCase()
      );
      return { ...f, value: match ? match.label : answer.value };
    }
    return { ...f, value: answer.value };
  });
}

// Fetch job description from engine DB (already scraped)
// Delegates to api.ts so the base URL stays in one place.
async function fetchJobDescription(jobId: number): Promise<string> {
  try {
    return await getJobDescription(jobId);
  } catch {
    return "";
  }
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function FieldRow({
  field,
  onChange,
}: {
  field: ApplicationField;
  onChange: (val: string) => void;
}) {
  const sourceColor: Record<ApplicationField["source"], string> = {
    profile: "rgba(30,215,96,0.85)",
    ai: "rgba(253,72,37,0.85)",
    manual: "rgba(255,199,0,0.85)",
  };
  const sourceLabel: Record<ApplicationField["source"], string> = {
    profile: "profile",
    ai: "claude",
    manual: "edited",
  };

  const isLong = field.value.length > 80 || field.key.includes("cover") || field.key.includes("letter") || field.key.includes("why");

  return (
    <div style={{ padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", flex: 1 }}>
          {field.label}
          {field.required && <span style={{ color: "rgba(253,72,37,0.8)", marginLeft: 3 }}>*</span>}
        </span>
        <span
          style={{
            fontSize: 10,
            padding: "2px 7px",
            borderRadius: 999,
            border: `1px solid ${sourceColor[field.source]}`,
            color: sourceColor[field.source],
            letterSpacing: "0.03em",
          }}
        >
          {sourceLabel[field.source]}
        </span>
      </div>
      {isLong ? (
        <textarea
          className="atsTextarea"
          style={{ minHeight: 90, fontSize: 13 }}
          value={field.value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="—"
        />
      ) : (
        <input
          className="input"
          style={{ width: "100%", fontSize: 13 }}
          value={field.value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="—"
        />
      )}
    </div>
  );
}

// ─── ScrapedFieldRow ─────────────────────────────────────────────────────────

function ScrapedFieldRow({
  field,
  idx,
  onChange,
}: {
  field: ScrapedField;
  idx: number;
  onChange: (idx: number, val: string) => void;
}) {
  const isLong = field.type === "textarea" ||
    field.label.toLowerCase().includes("cover") ||
    field.label.toLowerCase().includes("why") ||
    (field.value?.length ?? 0) > 80;

  const pill = (color: string, label: string) => (
    <span style={{
      fontSize: 10, padding: "2px 7px", borderRadius: 999,
      border: `1px solid ${color}`, color, letterSpacing: "0.03em", flexShrink: 0,
    }}>{label}</span>
  );

  return (
    <div style={{ padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", flex: 1, minWidth: 0 }}>
          {field.label}
          {field.required && <span style={{ color: "rgba(253,72,37,0.8)", marginLeft: 3 }}>*</span>}
        </span>
        {pill("rgba(255,255,255,0.25)", field.type)}
        {field.value ? pill("rgba(30,215,96,0.8)", "groq") : pill("rgba(255,255,255,0.2)", "empty")}
      </div>

      {field.type === "file" ? (
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", fontStyle: "italic" }}>
          Resume file — injected automatically
        </div>
      ) : field.type === "select" || field.type === "react-select" ? (
        <select
          style={{ width: "100%", borderRadius: 10, padding: "8px 12px",
            background: "#1c1c1e", border: "1px solid rgba(255,255,255,0.12)",
            color: "rgba(255,255,255,0.92)", fontSize: 13, colorScheme: "dark" }}
          value={field.value}
          onChange={(e) => onChange(idx, e.target.value)}
        >
          <option value="">— select —</option>
          {field.options.map((o) => (
            <option key={o.value} value={o.label}>{o.label}</option>
          ))}
          {/* Allow free-text if Groq picked something not in the list */}
          {field.value && !field.options.find(o => o.label === field.value) && (
            <option value={field.value}>{field.value}</option>
          )}
        </select>
      ) : isLong ? (
        <textarea
          className="atsTextarea"
          style={{ minHeight: 90, fontSize: 13 }}
          value={field.value}
          onChange={(e) => onChange(idx, e.target.value)}
          placeholder="—"
        />
      ) : (
        <input
          className="input"
          style={{ width: "100%", fontSize: 13 }}
          value={field.value}
          onChange={(e) => onChange(idx, e.target.value)}
          placeholder="—"
        />
      )}
    </div>
  );
}

// ─── DraftCard ────────────────────────────────────────────────────────────────

function DraftCard({
  draft,
  profile,
  onScrape,
  onFill,
  onRemove,
  onScrapedFieldChange,
  onFieldChange,
  onApply,
}: {
  draft: ApplicationDraft;
  profile: ApplicantProfile;
  onScrape: () => void;
  onFill: () => void;
  onRemove: () => void;
  onScrapedFieldChange: (idx: number, val: string) => void;
  onFieldChange: (key: string, val: string) => void;
  onApply: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const atsBadge: Record<string, string> = {
    greenhouse: "#1D9E75",
    lever:      "#0A84FF",
    unknown:    "rgba(255,255,255,0.3)",
  };

  const statusLabel: Record<ApplicationDraft["status"], string> = {
    pending:   "Pending",
    scraping:  "Scraping…",
    scraped:   "Review fields",
    filling:   "Filling…",
    ready:     "Ready",
    submitted: "Submitted",
    error:     "Error",
  };
  const statusColor: Record<ApplicationDraft["status"], string> = {
    pending:   "rgba(255,255,255,0.4)",
    scraping:  "rgba(253,200,0,0.9)",
    scraped:   "rgba(10,132,255,0.9)",
    filling:   "rgba(253,200,0,0.9)",
    ready:     "rgba(30,215,96,0.9)",
    submitted: "rgba(30,215,96,0.5)",
    error:     "rgba(255,69,58,0.9)",
  };

  // Progress: use scraped fields if available, else profile fields
  const displayFields   = draft.scrapedFields.length > 0 ? draft.scrapedFields : null;
  const filledCount     = displayFields
    ? displayFields.filter(f => f.type !== "file" && f.value?.trim()).length
    : draft.fields.filter(f => f.value.trim()).length;
  const totalCount      = displayFields
    ? displayFields.filter(f => f.type !== "file").length
    : draft.fields.length;
  const pct = totalCount > 0 ? Math.round((filledCount / totalCount) * 100) : 0;

  const canFill    = draft.status === "scraped" || draft.status === "ready" || draft.status === "error";
  const canApply   = draft.status === "scraped" || draft.status === "ready";
  const isWorking  = draft.status === "scraping" || draft.status === "filling" || draft.applying;

  return (
    <div style={{
      borderBottom: "1px solid rgba(255,255,255,0.07)",
      background: expanded ? "rgba(255,255,255,0.025)" : "transparent",
      transition: "background 150ms ease",
    }}>
      {/* ── Header row ── */}
      <div
        style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", cursor: "pointer" }}
        onClick={() => setExpanded(x => !x)}
      >
        <span style={{
          fontSize: 10, padding: "2px 7px", borderRadius: 999,
          background: atsBadge[draft.atsType], color: "white",
          fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", flexShrink: 0,
        }}>
          {draft.atsType}
        </span>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: "-0.01em",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {draft.title}
          </div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginTop: 2 }}>
            {draft.company}
          </div>
        </div>

        {/* Progress bar */}
        <div style={{ width: 60, flexShrink: 0 }}>
          <div style={{ height: 3, borderRadius: 999, background: "rgba(255,255,255,0.1)", overflow: "hidden" }}>
            <div style={{
              height: "100%", width: `${pct}%`,
              background: pct === 100 ? "rgba(30,215,96,0.8)" : "rgba(253,72,37,0.7)",
              borderRadius: 999, transition: "width 300ms ease",
            }} />
          </div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", marginTop: 3, textAlign: "right" }}>
            {filledCount}/{totalCount}
          </div>
        </div>

        <span style={{ fontSize: 11, color: statusColor[draft.status], minWidth: 80, textAlign: "right", flexShrink: 0 }}>
          {statusLabel[draft.status]}
        </span>

        <span style={{
          fontSize: 11, color: "rgba(255,255,255,0.3)",
          transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
          transition: "transform 150ms ease", flexShrink: 0,
        }}>›</span>
      </div>

      {/* ── Expanded body ── */}
      {expanded && (
        <div>
          {/* Error */}
          {draft.status === "error" && draft.errorMsg && (
            <div className="atsWarning" style={{ margin: "0 14px 10px" }}>{draft.errorMsg}</div>
          )}

          {/* Step indicator */}
          <div style={{ display: "flex", gap: 0, margin: "0 14px 12px", borderRadius: 10, overflow: "hidden", border: "1px solid rgba(255,255,255,0.08)" }}>
            {[
              { label: "1  Scrape form",    done: ["scraped","filling","ready","submitted"].includes(draft.status), active: draft.status === "scraping" },
              { label: "2  Review & fill",  done: ["ready","submitted"].includes(draft.status),                    active: draft.status === "scraped" || draft.status === "filling" },
              { label: "3  Open & submit",  done: draft.status === "submitted",                                    active: draft.applying ?? false },
            ].map((step, i) => (
              <div key={i} style={{
                flex: 1, padding: "6px 10px", fontSize: 11, textAlign: "center",
                background: step.done ? "rgba(30,215,96,0.12)" : step.active ? "rgba(10,132,255,0.12)" : "rgba(255,255,255,0.02)",
                color: step.done ? "rgba(30,215,96,0.9)" : step.active ? "rgba(10,132,255,0.9)" : "rgba(255,255,255,0.3)",
                borderRight: i < 2 ? "1px solid rgba(255,255,255,0.08)" : "none",
              }}>
                {step.done ? "✓ " : ""}{step.label}
              </div>
            ))}
          </div>

          {/* Fields panel */}
          <div style={{ margin: "0 14px", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 14, overflow: "hidden", background: "rgba(255,255,255,0.03)" }}>
            {draft.scrapedFields.length > 0 ? (
              <>
                <div style={{ padding: "8px 14px", fontSize: 11, color: "rgba(255,255,255,0.4)", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                  {draft.scrapedFields.length} fields scraped from the live form — edit any value before submitting
                </div>
                {draft.scrapedFields.map((f, i) => (
                  <ScrapedFieldRow
                    key={i}
                    field={f}
                    idx={i}
                    onChange={onScrapedFieldChange}
                  />
                ))}
              </>
            ) : draft.status === "pending" || draft.status === "error" ? (
              <div style={{ padding: 16, fontSize: 12, color: "rgba(255,255,255,0.4)", lineHeight: 1.6 }}>
                <strong style={{ color: "rgba(255,255,255,0.7)", display: "block", marginBottom: 4 }}>Step 1: Scrape the form</strong>
                Click <strong>Scrape Form</strong> — the filler opens the job URL in a headless browser,
                reads every field (labels, dropdowns, options), then Groq fills them using your profile.
                You review before anything is submitted.
              </div>
            ) : draft.status === "scraping" ? (
              <div style={{ padding: 16, fontSize: 12, color: "rgba(253,200,0,0.8)" }}>
                Opening form in headless browser and reading all fields…
              </div>
            ) : null}
          </div>

          {/* ── Action row ── */}
          <div style={{ display: "flex", gap: 8, padding: "10px 14px 14px", alignItems: "center", flexWrap: "wrap" }}>

            {/* Step 1: Scrape */}
            <button
              className="btn btnPrimary"
              style={{ fontSize: 12, padding: "7px 14px" }}
              onClick={(e) => { e.stopPropagation(); onScrape(); }}
              disabled={isWorking}
            >
              {draft.status === "scraping" ? "Scraping…" :
               draft.scrapedFields.length > 0 ? "Re-scrape form" : "Scrape form"}
            </button>

            {/* Step 2: Re-fill with Groq after scrape */}
            {draft.scrapedFields.length > 0 && (
              <button
                className="btn"
                style={{ fontSize: 12, padding: "7px 14px",
                  background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)" }}
                onClick={(e) => { e.stopPropagation(); onFill(); }}
                disabled={isWorking}
              >
                {draft.status === "filling" ? "Filling…" : "Re-fill with Groq"}
              </button>
            )}

            {/* Step 3: Open & Fill in browser */}
            {canApply && (
              <button
                className="btn"
                style={{
                  fontSize: 12, padding: "7px 14px",
                  background: draft.applying ? "rgba(255,255,255,0.06)" :
                    draft.status === "submitted" ? "rgba(30,215,96,0.15)" : "rgba(30,215,96,0.22)",
                  border: `1px solid ${draft.status === "submitted" ? "rgba(30,215,96,0.3)" : "rgba(30,215,96,0.5)"}`,
                  color: draft.status === "submitted" ? "rgba(30,215,96,0.6)" : "rgba(30,215,96,1)",
                  cursor: draft.applying || draft.status === "submitted" ? "default" : "pointer",
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!draft.applying && draft.status !== "submitted") onApply();
                }}
                disabled={draft.applying || draft.status === "submitted"}
              >
                {draft.applying ? "Launching…" : draft.status === "submitted" ? "✓ Launched" : "Open & Fill Browser"}
              </button>
            )}

            <a
              className="btn"
              style={{ fontSize: 12, padding: "7px 14px", textDecoration: "none" }}
              href={draft.url} target="_blank" rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
            >
              Open job ↗
            </a>

            <div style={{ flex: 1 }} />

            <button
              className="btn"
              style={{ fontSize: 12, padding: "7px 10px", opacity: 0.5 }}
              onClick={(e) => { e.stopPropagation(); onRemove(); }}
            >
              Remove
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── File reader utility ──────────────────────────────────────────────────────

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function AutoApply({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState<"profile" | "queue">("profile");
  const [profile, setProfile] = useState<ApplicantProfile>(loadProfile);
  const [queue, setQueue] = useState<ApplicationDraft[]>(loadQueue);
  const [saved, setSaved] = useState(false);
  const [apiKeySet, setApiKeySet] = useState(false);
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKeyError, setApiKeyError] = useState("");

  const resumeInputRef    = useRef<HTMLInputElement>(null);
  const resumePdfInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef     = useRef<HTMLInputElement>(null);

  // Check on mount whether a key is already stored
  useEffect(() => {
    getGroqKeyStatus().then(setApiKeySet).catch(() => setApiKeySet(false));
  }, []);

  // Persist profile on change
  useEffect(() => {
    saveProfile(profile);
  }, [profile]);

  // Persist queue on change
  useEffect(() => {
    saveQueue(queue);
  }, [queue]);

  function updateProfile(key: keyof ApplicantProfile, value: any) {
    setProfile((p) => ({ ...p, [key]: value }));
  }

  async function handleFileUpload(
    file: File,
    textKey: "resumeText" | "coverLetterText",
    nameKey: "resumeFileName" | "coverLetterFileName",
  ) {
    const text = await readFileAsText(file);
    setProfile((p) => ({ ...p, [textKey]: text, [nameKey]: file.name }));
  }


  // Phase 1: scrape the live form to discover all real fields
  async function scrapeDraft(jobId: number) {
    let currentDraft: ApplicationDraft | undefined;
    setQueue((q) => {
      currentDraft = q.find((d) => d.jobId === jobId);
      return q.map((d) => d.jobId === jobId ? { ...d, status: "scraping", errorMsg: undefined } : d);
    });
    await new Promise((r) => setTimeout(r, 0));
    if (!currentDraft) return;
    const draft = currentDraft;

    try {
      // Scrape real fields from the live form
      const scraped = await scrapeForm(draft.jobId, draft.url, draft.atsType);

      // Use Groq to fill in values based on scraped labels + profile
      const jobDesc = await fetchJobDescription(jobId);
      const filledScraped = await fillScrapedFieldsWithGroq(scraped, profile, jobDesc);

      setQueue((q) =>
        q.map((d) =>
          d.jobId === jobId
            ? { ...d, status: "scraped", scrapedFields: filledScraped, errorMsg: undefined }
            : d,
        ),
      );
    } catch (err: any) {
      setQueue((q) =>
        q.map((d) =>
          d.jobId === jobId
            ? { ...d, status: "error", errorMsg: String(err?.message ?? err) }
            : d,
        ),
      );
    }
  }

  // Legacy: fill profile-seeded fields with Groq (used as context in scrape mode too)
  async function fillDraft(jobId: number) {
    let currentDraft: ApplicationDraft | undefined;
    setQueue((q) => {
      currentDraft = q.find((d) => d.jobId === jobId);
      return q.map((d) => (d.jobId === jobId ? { ...d, status: "filling" } : d));
    });
    await new Promise((r) => setTimeout(r, 0));
    if (!currentDraft) return;
    const draft = currentDraft;
    try {
      const withProfile: ApplicationDraft = {
        ...draft,
        fields: draft.fields.length === 0 ? profileToFields(profile, draft.atsType) : draft.fields,
        scrapedFields: draft.scrapedFields,
      };
      const openFields: ApplicationField[] = [
        { key: "cover_letter", label: "Cover letter", value: "", source: "ai", required: false },
        { key: "why_this_company", label: "Why do you want to work here?", value: "", source: "ai", required: false },
        { key: "how_did_you_hear", label: "How did you hear about this role?", value: "", source: "ai", required: false },
      ];
      for (const of_ of openFields) {
        if (!withProfile.fields.some((f) => f.key === of_.key)) {
          withProfile.fields.push(of_);
        }
      }
      const jobDesc = await fetchJobDescription(jobId);
      const filledFields = await fillWithLLM(withProfile, profile, jobDesc);
      setQueue((q) =>
        q.map((d) =>
          d.jobId === jobId
            ? { ...d, status: "ready", fields: filledFields, errorMsg: undefined }
            : d,
        ),
      );
    } catch (err: any) {
      setQueue((q) =>
        q.map((d) =>
          d.jobId === jobId ? { ...d, status: "error", errorMsg: String(err?.message ?? err) } : d,
        ),
      );
    }
  }

  function removeDraft(jobId: number) {
    setQueue((q) => q.filter((d) => d.jobId !== jobId));
  }

  async function applyDraft(jobId: number) {
    let currentDraft: ApplicationDraft | undefined;
    setQueue((q) => {
      currentDraft = q.find((d) => d.jobId === jobId);
      return q.map((d) => d.jobId === jobId ? { ...d, applying: true, errorMsg: undefined } : d);
    });
    await new Promise((r) => setTimeout(r, 0));
    if (!currentDraft) return;
    const draft = currentDraft;

    // Use scraped fields if available (preferred), fall back to profile fields
    const fieldsToFill = draft.scrapedFields.length > 0
      ? draft.scrapedFields
      : draft.fields.map((f) => ({
          selector: "",
          label:    f.label,
          type:     "text",
          required: f.required,
          options:  [],
          value:    f.value,
        }));

    try {
      await fillForm({
        jobId:         draft.jobId,
        url:           draft.url,
        resumePdfPath: profile.resumePdfPath,
        resumeText:    profile.resumePdfPath ? "" : profile.resumeText,
        fields:        fieldsToFill,
      });
      setQueue((q) =>
        q.map((d) => d.jobId === jobId ? { ...d, applying: false, status: "submitted" } : d)
      );
    } catch (err: any) {
      setQueue((q) =>
        q.map((d) =>
          d.jobId === jobId
            ? { ...d, applying: false, status: "error", errorMsg: String(err?.message ?? err) }
            : d
        )
      );
    }
  }

  function updateField(jobId: number, fieldKey: string, value: string) {
    setQueue((q) =>
      q.map((d) =>
        d.jobId === jobId
          ? {
              ...d,
              fields: d.fields.map((f) =>
                f.key === fieldKey ? { ...f, value, source: "manual" } : f,
              ),
            }
          : d,
      ),
    );
  }

  function updateScrapedField(jobId: number, idx: number, value: string) {
    setQueue((q) =>
      q.map((d) =>
        d.jobId === jobId
          ? {
              ...d,
              scrapedFields: d.scrapedFields.map((f, i) =>
                i === idx ? { ...f, value } : f,
              ),
            }
          : d,
      ),
    );
  }

  // ── Profile tab ────────────────────────────────────────────────────────────


  // ── Render ─────────────────────────────────────────────────────────────────

  const pendingBadge = queue.filter((d) => d.scrapedFields.length === 0).length;

  return (
    <div className="app">
      {/* Page header */}
      <div className="pageTop">
        <button className="btn" onClick={onBack}>
          Back
        </button>
        <h2 style={{ margin: 0 }}>Auto Apply</h2>
        <div className="spacer" />
        {tab === "profile" && (
          <button
            className="btn btnPrimary"
            onClick={() => {
              saveProfile(profile);
              setSaved(true);
              setTimeout(() => setSaved(false), 2000);
            }}
          >
            {saved ? "Saved ✓" : "Save profile"}
          </button>
        )}
      </div>

      {/* Tab bar */}
      <div
        style={{
          display: "flex",
          gap: 4,
          marginBottom: 20,
          background: "rgba(255,255,255,0.04)",
          borderRadius: 999,
          padding: 4,
          border: "1px solid rgba(255,255,255,0.08)",
          width: "fit-content",
        }}
      >
        {(["profile", "queue"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: "7px 18px",
              borderRadius: 999,
              border: "none",
              background: tab === t ? "rgba(255,255,255,0.10)" : "transparent",
              color: tab === t ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.45)",
              fontSize: 13,
              fontWeight: tab === t ? 600 : 400,
              cursor: "pointer",
              transition: "all 120ms ease",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            {t === "profile" ? "Profile" : "Review Queue"}
            {t === "queue" && pendingBadge > 0 && (
              <span
                style={{
                  fontSize: 10,
                  background: "rgba(253,72,37,0.85)",
                  color: "white",
                  borderRadius: 999,
                  padding: "1px 6px",
                  fontWeight: 700,
                }}
              >
                {pendingBadge}
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === "profile" ? (
        <ProfileTab
          profile={profile}
          updateProfile={updateProfile}
          resumeInputRef={resumeInputRef}
          resumePdfInputRef={resumePdfInputRef}
          coverInputRef={coverInputRef}
          handleFileUpload={handleFileUpload}
          apiKeySet={apiKeySet}
          apiKeySaving={apiKeySaving}
          apiKeyInput={apiKeyInput}
          apiKeyError={apiKeyError}
          onApiKeyChange={setApiKeyInput}
          onApiKeySave={async () => {
            setApiKeySaving(true);
            setApiKeyError("");
            try {
              await setGroqAPIKey(apiKeyInput);
              setApiKeySet(true);
              setApiKeyInput("");
            } catch (e: any) {
              setApiKeyError(String(e?.message ?? e));
            } finally {
              setApiKeySaving(false);
            }
          }}
        />
      ) : (
        <QueueTab
          queue={queue}
          profile={profile}
          scrapeDraft={scrapeDraft}
          fillDraft={fillDraft}
          removeDraft={removeDraft}
          updateField={updateField}
          updateScrapedField={updateScrapedField}
          applyDraft={applyDraft}
        />
      )}
    </div>
  );
}

// ─── ProfileTab ───────────────────────────────────────────────────────────────
// Defined at module level so React never unmounts it on parent re-render.

function ProfileField({
  label,
  fieldKey,
  type = "text",
  placeholder = "",
  profile,
  updateProfile,
}: {
  label: string;
  fieldKey: keyof ApplicantProfile;
  type?: string;
  placeholder?: string;
  profile: ApplicantProfile;
  updateProfile: (key: keyof ApplicantProfile, value: any) => void;
}) {
  return (
    <label className="formLabel" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
      <span style={{ fontSize: 12, color: "rgba(255,255,255,0.55)" }}>{label}</span>
      <input
        className="input"
        style={{ width: "100%" }}
        type={type}
        value={profile[fieldKey] as string}
        placeholder={placeholder}
        onChange={(e) => updateProfile(fieldKey, e.target.value)}
      />
    </label>
  );
}

function ProfileSelectField({
  label,
  fieldKey,
  options,
  profile,
  updateProfile,
}: {
  label: string;
  fieldKey: keyof ApplicantProfile;
  options: { value: string; label: string }[];
  profile: ApplicantProfile;
  updateProfile: (key: keyof ApplicantProfile, value: any) => void;
}) {
  return (
    <label className="formLabel" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
      <span style={{ fontSize: 12, color: "rgba(255,255,255,0.55)" }}>{label}</span>
      <select
        style={{ width: "100%", borderRadius: 10, padding: "8px 12px" }}
        value={profile[fieldKey] as string}
        onChange={(e) => updateProfile(fieldKey, e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function TwoCol({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
      {children}
    </div>
  );
}

function ProfileTab({
  profile,
  updateProfile,
  resumeInputRef,
  resumePdfInputRef,
  coverInputRef,
  handleFileUpload,
  apiKeySet,
  apiKeySaving,
  apiKeyInput,
  apiKeyError,
  onApiKeyChange,
  onApiKeySave,
}: {
  profile: ApplicantProfile;
  updateProfile: (key: keyof ApplicantProfile, value: any) => void;
  resumeInputRef: React.RefObject<HTMLInputElement | null>;
  resumePdfInputRef: React.RefObject<HTMLInputElement | null>;
  coverInputRef: React.RefObject<HTMLInputElement | null>;
  handleFileUpload: (
    file: File,
    textKey: "resumeText" | "coverLetterText",
    nameKey: "resumeFileName" | "coverLetterFileName",
  ) => void;
  apiKeySet: boolean;
  apiKeySaving: boolean;
  apiKeyInput: string;
  apiKeyError: string;
  onApiKeyChange: (val: string) => void;
  onApiKeySave: () => void;
}) {
  return (
    <div className="settingsPanel">
      {/* ── Identity ── */}
      <div className="sectionHead">Identity</div>
      <div style={{ padding: "14px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
        <TwoCol>
          <ProfileField label="First name *" fieldKey="firstName" placeholder="Jane" profile={profile} updateProfile={updateProfile} />
          <ProfileField label="Last name *" fieldKey="lastName" placeholder="Smith" profile={profile} updateProfile={updateProfile} />
        </TwoCol>
        <TwoCol>
          <ProfileField label="Email *" fieldKey="email" type="email" placeholder="jane@example.com" profile={profile} updateProfile={updateProfile} />
          <ProfileField label="Phone *" fieldKey="phone" placeholder="+1 (555) 000-0000" profile={profile} updateProfile={updateProfile} />
        </TwoCol>
        <ProfileField label="City, State *" fieldKey="location" placeholder="Dallas, TX" profile={profile} updateProfile={updateProfile} />
        <TwoCol>
          <ProfileField label="LinkedIn URL" fieldKey="linkedinURL" placeholder="https://linkedin.com/in/jane" profile={profile} updateProfile={updateProfile} />
          <ProfileField label="Portfolio / website" fieldKey="portfolioURL" placeholder="https://jane.dev" profile={profile} updateProfile={updateProfile} />
        </TwoCol>
        <ProfileField label="GitHub URL" fieldKey="githubURL" placeholder="https://github.com/janesmith" profile={profile} updateProfile={updateProfile} />
      </div>

      {/* ── Work ── */}
      <div className="sectionHead">Work</div>
      <div style={{ padding: "14px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
        <TwoCol>
          <ProfileField label="Current / most recent title" fieldKey="currentTitle" placeholder="Senior Software Engineer" profile={profile} updateProfile={updateProfile} />
          <ProfileField label="Years of experience" fieldKey="yearsExperience" placeholder="5" profile={profile} updateProfile={updateProfile} />
        </TwoCol>
        <TwoCol>
          <ProfileSelectField
            label="Work authorization (US)"
            fieldKey="workAuth"
            options={[
              { value: "us_citizen", label: "US Citizen" },
              { value: "green_card", label: "Permanent Resident (Green Card)" },
              { value: "h1b", label: "H-1B / Work Visa" },
              { value: "other", label: "Other" },
            ]}
            profile={profile}
            updateProfile={updateProfile}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, color: "rgba(255,255,255,0.55)" }}>Requires sponsorship?</span>
            <div className="checkRow" style={{ padding: "8px 0" }}>
              <input
                className="checkbox"
                type="checkbox"
                checked={profile.requiresSponsorship}
                onChange={(e) => updateProfile("requiresSponsorship", e.target.checked)}
              />
              <span style={{ fontSize: 13 }}>Yes, requires sponsorship</span>
            </div>
          </div>
        </TwoCol>
        <ProfileField label="Desired salary (used for salary questions)" fieldKey="desiredSalary" placeholder="e.g. $130,000 or Open to discussion" profile={profile} updateProfile={updateProfile} />
      </div>

      {/* ── EEO ── */}
      <div className="sectionHead">EEO / Demographic (optional)</div>
      <div style={{ padding: "14px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
        <p className="help" style={{ marginTop: 0 }}>
          These are auto-filled on voluntary EEO questions. All default to "prefer not to say".
        </p>
        <TwoCol>
          <ProfileSelectField
            label="Gender"
            fieldKey="gender"
            options={[
              { value: "male", label: "Male" },
              { value: "female", label: "Female" },
              { value: "non_binary", label: "Non-binary" },
              { value: "prefer_not", label: "Prefer not to say" },
            ]}
            profile={profile}
            updateProfile={updateProfile}
          />
          <ProfileSelectField
            label="Race / ethnicity"
            fieldKey="race"
            options={[
              { value: "white", label: "White" },
              { value: "black", label: "Black or African American" },
              { value: "hispanic", label: "Hispanic or Latino" },
              { value: "asian", label: "Asian" },
              { value: "native", label: "American Indian / Alaska Native" },
              { value: "pacific", label: "Native Hawaiian / Pacific Islander" },
              { value: "two_or_more", label: "Two or more races" },
              { value: "prefer_not", label: "Prefer not to say" },
            ]}
            profile={profile}
            updateProfile={updateProfile}
          />
        </TwoCol>
        <TwoCol>
          <ProfileSelectField
            label="Veteran status"
            fieldKey="veteranStatus"
            options={[
              { value: "yes", label: "Protected veteran" },
              { value: "no", label: "Not a protected veteran" },
              { value: "prefer_not", label: "Prefer not to disclose" },
            ]}
            profile={profile}
            updateProfile={updateProfile}
          />
          <ProfileSelectField
            label="Disability status"
            fieldKey="disabilityStatus"
            options={[
              { value: "yes", label: "Yes, I have a disability" },
              { value: "no", label: "No, I don't have a disability" },
              { value: "prefer_not", label: "Prefer not to disclose" },
            ]}
            profile={profile}
            updateProfile={updateProfile}
          />
        </TwoCol>
      </div>

      {/* ── Documents ── */}
      <div className="sectionHead">Documents</div>
      <div style={{ padding: "14px 14px", display: "flex", flexDirection: "column", gap: 16 }}>
        <p className="help" style={{ marginTop: 0 }}>
          Upload your formatted PDF resume for form uploads, plus a plain-text version for Groq to read when filling fields.
        </p>

        {/* Resume — PDF for uploading + txt/paste for Groq context */}
        <div>
          {/* PDF upload row */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Resume PDF</span>
            {profile.resumePdfName ? (
              <span style={{ fontSize: 11, color: "rgba(30,215,96,0.8)", padding: "2px 8px", borderRadius: 999, border: "1px solid rgba(30,215,96,0.3)" }}>
                {profile.resumePdfName}
              </span>
            ) : (
              <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>
                No PDF — will upload plain text instead
              </span>
            )}
            <input
              ref={resumePdfInputRef}
              type="file"
              accept=".pdf,.doc,.docx"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  // Tauri exposes the real filesystem path on the File object
                  // via a non-standard property. We store it for the engine to use.
                  const filePath: string = (f as any).path || (f as any)._path || f.name;
                  updateProfile("resumePdfPath", filePath);
                  updateProfile("resumePdfName", f.name);
                }
              }}
            />
            <button
              className="btn miniBtn"
              style={{ marginLeft: "auto" }}
              onClick={() => resumePdfInputRef.current?.click()}
            >
              Upload PDF
            </button>
            {profile.resumePdfName && (
              <button
                className="btn miniBtn"
                style={{ opacity: 0.5 }}
                onClick={() => { updateProfile("resumePdfPath", ""); updateProfile("resumePdfName", ""); }}
              >
                Remove
              </button>
            )}
          </div>

          {/* Plain text for Groq context */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: "rgba(255,255,255,0.55)" }}>Plain text (for AI context)</span>
            {profile.resumeFileName && (
              <span style={{ fontSize: 11, color: "rgba(30,215,96,0.8)", padding: "2px 8px", borderRadius: 999, border: "1px solid rgba(30,215,96,0.3)" }}>
                {profile.resumeFileName}
              </span>
            )}
            <input
              ref={resumeInputRef}
              type="file"
              accept=".txt,.md"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFileUpload(f, "resumeText", "resumeFileName");
              }}
            />
            <button
              className="btn miniBtn"
              style={{ marginLeft: "auto" }}
              onClick={() => resumeInputRef.current?.click()}
            >
              Upload .txt
            </button>
          </div>
          <textarea
            className="atsTextarea"
            style={{ minHeight: 140 }}
            value={profile.resumeText}
            placeholder="Paste your resume as plain text — Groq reads this to fill out fields and write cover letters."
            onChange={(e) => updateProfile("resumeText", e.target.value)}
          />
        </div>

        {/* Cover letter */}
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Default cover letter</span>
            {profile.coverLetterFileName && (
              <span style={{ fontSize: 11, color: "rgba(30,215,96,0.8)", padding: "2px 8px", borderRadius: 999, border: "1px solid rgba(30,215,96,0.3)" }}>
                {profile.coverLetterFileName}
              </span>
            )}
            <input
              ref={coverInputRef}
              type="file"
              accept=".txt,.md"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFileUpload(f, "coverLetterText", "coverLetterFileName");
              }}
            />
            <button
              className="btn miniBtn"
              style={{ marginLeft: "auto" }}
              onClick={() => coverInputRef.current?.click()}
            >
              Upload .txt
            </button>
          </div>
          <textarea
            className="atsTextarea"
            style={{ minHeight: 120 }}
            value={profile.coverLetterText}
            placeholder="Paste a cover letter template. Claude will customize it for each job using the job description."
            onChange={(e) => updateProfile("coverLetterText", e.target.value)}
          />
        </div>
      </div>

      {/* ── Groq API Key ── */}
      <div className="sectionHead">Groq API Key</div>
      <div style={{ padding: "14px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
        <p className="help" style={{ marginTop: 0 }}>
          Required for the "Fill with Claude" feature. Stored securely in the OS keyring — never sent to the frontend.
          Get a free key at <a href="https://console.groq.com" target="_blank" rel="noreferrer" style={{ color: "rgba(10,132,255,0.9)" }}>console.groq.com</a>.
        </p>

        {apiKeySet && (
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "8px 12px", borderRadius: 10,
            background: "rgba(30,215,96,0.08)",
            border: "1px solid rgba(30,215,96,0.25)",
            fontSize: 12, color: "rgba(30,215,96,0.9)",
          }}>
            <span>✓</span>
            <span>API key is stored. Enter a new key below to replace it.</span>
          </div>
        )}

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            className="input"
            style={{ flex: 1, fontFamily: "monospace", fontSize: 12, letterSpacing: "0.04em" }}
            type="password"
            value={apiKeyInput}
            placeholder={apiKeySet ? "gsk_••••••••••••••••" : "gsk_..."}
            onChange={(e) => onApiKeyChange(e.target.value)}
          />
          <button
            className="btn btnPrimary"
            style={{ fontSize: 12, padding: "8px 14px", flexShrink: 0 }}
            onClick={onApiKeySave}
            disabled={apiKeySaving || apiKeyInput.trim() === ""}
          >
            {apiKeySaving ? "Saving…" : "Save key"}
          </button>
        </div>

        {apiKeyError && (
          <div style={{ fontSize: 12, color: "rgba(255,69,58,0.9)", marginTop: 2 }}>
            {apiKeyError}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── QueueTab ─────────────────────────────────────────────────────────────────
// Defined at module level so React never unmounts it on parent re-render.

function QueueTab({
  queue,
  profile,
  scrapeDraft,
  fillDraft,
  removeDraft,
  updateField,
  updateScrapedField,
  applyDraft,
}: {
  queue: ApplicationDraft[];
  profile: ApplicantProfile;
  scrapeDraft: (jobId: number) => void;
  fillDraft: (jobId: number) => void;
  removeDraft: (jobId: number) => void;
  updateField: (jobId: number, fieldKey: string, value: string) => void;
  updateScrapedField: (jobId: number, idx: number, value: string) => void;
  applyDraft: (jobId: number) => void;
}) {
  const pendingCount = queue.filter((d) => d.status === "pending" || d.status === "error").length;
  const unscrapeCount = queue.filter((d) => d.scrapedFields.length === 0 && d.status !== "scraping").length;

  return (
    <div>
      {/* Queue summary bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 16,
          padding: "10px 14px",
          background: "rgba(255,255,255,0.04)",
          borderRadius: 12,
          border: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <span style={{ fontSize: 13, color: "rgba(255,255,255,0.6)" }}>
          {queue.length} job{queue.length !== 1 ? "s" : ""} queued
        </span>
        {unscrapeCount > 0 && (
          <span style={{ fontSize: 12, color: "rgba(253,72,37,0.85)" }}>
            · {unscrapeCount} not yet scraped
          </span>
        )}
        <div style={{ flex: 1 }} />
        {unscrapeCount > 0 && (
          <button
            className="btn btnPrimary"
            style={{ fontSize: 12, padding: "6px 14px" }}
            onClick={async () => {
              const toScrape = queue
                .filter((d) => d.scrapedFields.length === 0 && d.status !== "scraping")
                .map((d) => d.jobId);
              for (const id of toScrape) {
                await scrapeDraft(id);
              }
            }}
          >
            Scrape all forms
          </button>
        )}
      </div>

      {/* Empty state */}
      {queue.length === 0 && (
        <div
          style={{
            padding: "24px 20px",
            textAlign: "center",
            color: "rgba(255,255,255,0.35)",
            fontSize: 13,
            border: "1px dashed rgba(255,255,255,0.1)",
            borderRadius: 14,
            lineHeight: 1.6,
          }}
        >
          No jobs in the queue yet.
          <br />
          Go to the{" "}
          <span style={{ color: "rgba(253,72,37,0.8)" }}>Jobs</span> view and
          click{" "}
          <strong style={{ color: "rgba(255,255,255,0.6)" }}>Apply</strong> on
          any job to add it here.
        </div>
      )}

      {/* Draft cards */}
      <div
        style={{
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 16,
          overflow: "hidden",
          background: "rgba(255,255,255,0.03)",
        }}
      >
        {queue.map((draft) => (
          <DraftCard
            key={draft.jobId}
            draft={draft}
            profile={profile}
            onScrape={() => scrapeDraft(draft.jobId)}
            onFill={() => fillDraft(draft.jobId)}
            onRemove={() => removeDraft(draft.jobId)}
            onScrapedFieldChange={(idx, val) => updateScrapedField(draft.jobId, idx, val)}
            onFieldChange={(key, val) => updateField(draft.jobId, key, val)}
            onApply={() => applyDraft(draft.jobId)}
          />
        ))}
      </div>
    </div>
  );
}

export function useAutoApplyQueue() {
  const [queue, setQueue] = useState<ApplicationDraft[]>(loadQueue);

  function addToQueue(job: { id: number; company: string; title: string; url: string }) {
    const { atsType, atsSlug, atsJobId } = detectATS(job.url);
    const alreadyQueued = queue.some((d) => d.jobId === job.id);
    if (alreadyQueued) return;

    const profile = loadProfile();
    const draft: ApplicationDraft = {
      jobId: job.id,
      company: job.company,
      title: job.title,
      url: job.url,
      atsType,
      atsSlug,
      atsJobId,
      status: "pending",
      fields: profileToFields(profile, atsType),
      scrapedFields: [],
    };

    const next = [draft, ...queue];
    setQueue(next);
    saveQueue(next);
  }

  return { queue, addToQueue, queueCount: queue.length };
}