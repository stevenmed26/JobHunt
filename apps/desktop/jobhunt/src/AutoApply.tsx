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
import { getJobDescription, callLLM, setGroqAPIKey, getGroqKeyStatus } from "./api";

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
  resumeFileName: string; // display only
  coverLetterFileName: string;
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
  status: "pending" | "filling" | "ready" | "submitted" | "error";
  fields: ApplicationField[];
  errorMsg?: string;
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

function loadQueue(): ApplicationDraft[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (raw) return JSON.parse(raw);
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

async function fillWithClaude(
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

function DraftCard({
  draft,
  profile,
  onFill,
  onRemove,
  onFieldChange,
}: {
  draft: ApplicationDraft;
  profile: ApplicantProfile;
  onFill: () => void;
  onRemove: () => void;
  onFieldChange: (key: string, val: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const atsBadge: Record<string, string> = {
    greenhouse: "#1D9E75",
    lever: "#0A84FF",
    unknown: "rgba(255,255,255,0.3)",
  };

  const statusLabel: Record<ApplicationDraft["status"], string> = {
    pending: "Pending",
    filling: "Filling…",
    ready: "Ready",
    submitted: "Submitted",
    error: "Error",
  };
  const statusColor: Record<ApplicationDraft["status"], string> = {
    pending: "rgba(255,255,255,0.4)",
    filling: "rgba(253,200,0,0.9)",
    ready: "rgba(30,215,96,0.9)",
    submitted: "rgba(30,215,96,0.5)",
    error: "rgba(255,69,58,0.9)",
  };

  const filledCount = draft.fields.filter((f) => f.value.trim() !== "").length;
  const totalCount = draft.fields.length;
  const pct = totalCount > 0 ? Math.round((filledCount / totalCount) * 100) : 0;

  return (
    <div
      style={{
        borderBottom: "1px solid rgba(255,255,255,0.07)",
        background: expanded ? "rgba(255,255,255,0.025)" : "transparent",
        transition: "background 150ms ease",
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "12px 14px",
          cursor: "pointer",
        }}
        onClick={() => setExpanded((x) => !x)}
      >
        {/* ATS badge */}
        <span
          style={{
            fontSize: 10,
            padding: "2px 7px",
            borderRadius: 999,
            background: atsBadge[draft.atsType],
            color: "white",
            fontWeight: 600,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            flexShrink: 0,
          }}
        >
          {draft.atsType}
        </span>

        {/* Title / company */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              letterSpacing: "-0.01em",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {draft.title}
          </div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginTop: 2 }}>
            {draft.company}
          </div>
        </div>

        {/* Progress bar */}
        <div style={{ width: 60, flexShrink: 0 }}>
          <div
            style={{
              height: 3,
              borderRadius: 999,
              background: "rgba(255,255,255,0.1)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${pct}%`,
                background:
                  pct === 100 ? "rgba(30,215,96,0.8)" : "rgba(253,72,37,0.7)",
                borderRadius: 999,
                transition: "width 300ms ease",
              }}
            />
          </div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", marginTop: 3, textAlign: "right" }}>
            {filledCount}/{totalCount}
          </div>
        </div>

        {/* Status */}
        <span
          style={{
            fontSize: 11,
            color: statusColor[draft.status],
            minWidth: 56,
            textAlign: "right",
            flexShrink: 0,
          }}
        >
          {statusLabel[draft.status]}
        </span>

        {/* Chevron */}
        <span
          style={{
            fontSize: 11,
            color: "rgba(255,255,255,0.3)",
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 150ms ease",
            flexShrink: 0,
          }}
        >
          ›
        </span>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div>
          {/* Error banner */}
          {draft.status === "error" && draft.errorMsg && (
            <div className="atsWarning" style={{ margin: "0 14px 10px" }}>
              {draft.errorMsg}
            </div>
          )}

          {/* Fields */}
          <div
            style={{
              margin: "0 14px",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 14,
              overflow: "hidden",
              background: "rgba(255,255,255,0.03)",
            }}
          >
            {draft.fields.length === 0 && (
              <div style={{ padding: 14, fontSize: 12, color: "rgba(255,255,255,0.4)" }}>
                Click "Fill with Claude" to generate application fields.
              </div>
            )}
            {draft.fields.map((f) => (
              <FieldRow
                key={f.key}
                field={f}
                onChange={(val) => onFieldChange(f.key, val)}
              />
            ))}
          </div>

          {/* Action row */}
          <div
            style={{
              display: "flex",
              gap: 8,
              padding: "10px 14px 14px",
              alignItems: "center",
            }}
          >
            <button
              className="btn btnPrimary"
              style={{ fontSize: 12, padding: "7px 14px" }}
              onClick={(e) => {
                e.stopPropagation();
                onFill();
              }}
              disabled={draft.status === "filling"}
            >
              {draft.status === "filling"
                ? "Filling…"
                : draft.fields.length === 0
                ? "Fill with Claude"
                : "Re-fill with Claude"}
            </button>

            <a
              className="btn"
              style={{ fontSize: 12, padding: "7px 14px", textDecoration: "none" }}
              href={draft.url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
            >
              Open job ↗
            </a>

            <div style={{ flex: 1 }} />

            <button
              className="btn"
              style={{ fontSize: 12, padding: "7px 10px", opacity: 0.5 }}
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
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

  const resumeInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);

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


  async function fillDraft(jobId: number) {
    // Capture current draft synchronously from the functional updater to avoid
    // stale-closure reads. We extract it inside setQueue so it reflects the
    // latest state even if the job was just added this render cycle.
    let currentDraft: ApplicationDraft | undefined;
    setQueue((q) => {
      currentDraft = q.find((d) => d.jobId === jobId);
      return q.map((d) => (d.jobId === jobId ? { ...d, status: "filling" } : d));
    });

    // Give React one tick to flush before we proceed
    await new Promise((r) => setTimeout(r, 0));

    if (!currentDraft) return;
    const draft = currentDraft;

    try {
      // Ensure profile fields are seeded
      const withProfile: ApplicationDraft = {
        ...draft,
        fields:
          draft.fields.length === 0
            ? profileToFields(profile, draft.atsType)
            : draft.fields,
      };

      // Add common open-ended fields if not already present
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
      const filledFields = await fillWithClaude(withProfile, profile, jobDesc);

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
          d.jobId === jobId
            ? { ...d, status: "error", errorMsg: String(err?.message ?? err) }
            : d,
        ),
      );
    }
  }

  function removeDraft(jobId: number) {
    setQueue((q) => q.filter((d) => d.jobId !== jobId));
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

  // ── Profile tab ────────────────────────────────────────────────────────────


  // ── Render ─────────────────────────────────────────────────────────────────

  const pendingBadge = queue.filter((d) => d.status === "pending").length;

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
          fillDraft={fillDraft}
          removeDraft={removeDraft}
          updateField={updateField}
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
          Paste or upload plain-text versions. Claude uses these as context when filling unknown fields and customizing cover letters.
        </p>

        {/* Resume */}
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Resume</span>
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
            style={{ minHeight: 160 }}
            value={profile.resumeText}
            placeholder="Paste your resume as plain text here. This is what Claude reads — not a PDF."
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
  fillDraft,
  removeDraft,
  updateField,
}: {
  queue: ApplicationDraft[];
  profile: ApplicantProfile;
  fillDraft: (jobId: number) => void;
  removeDraft: (jobId: number) => void;
  updateField: (jobId: number, fieldKey: string, value: string) => void;
}) {
  const pendingCount = queue.filter((d) => d.status === "pending" || d.status === "error").length;

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
        {pendingCount > 0 && (
          <span style={{ fontSize: 12, color: "rgba(253,72,37,0.85)" }}>
            · {pendingCount} need filling
          </span>
        )}
        <div style={{ flex: 1 }} />
        {pendingCount > 0 && (
          <button
            className="btn btnPrimary"
            style={{ fontSize: 12, padding: "6px 14px" }}
            onClick={async () => {
              const toFill = queue
                .filter((d) => d.status === "pending" || d.status === "error")
                .map((d) => d.jobId);
              for (const id of toFill) {
                await fillDraft(id);
              }
            }}
          >
            Fill all with Claude
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
            onFill={() => fillDraft(draft.jobId)}
            onRemove={() => removeDraft(draft.jobId)}
            onFieldChange={(key, val) => updateField(draft.jobId, key, val)}
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
    };

    const next = [draft, ...queue];
    setQueue(next);
    saveQueue(next);
  }

  return { queue, addToQueue, queueCount: queue.length };
}