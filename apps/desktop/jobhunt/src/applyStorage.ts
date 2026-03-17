// src/applyStorage.ts — localStorage helpers for profile and queue

import type { ApplicantProfile, ApplicationDraft, ApplicationField } from "./types";

export const PROFILE_KEY = "jh_applicant_profile_v1";
export const QUEUE_KEY   = "jh_apply_queue_v1";

export function emptyProfile(): ApplicantProfile {
  return {
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    linkedinURL: "",
    portfolioURL: "",
    githubURL: "",
    location: "",
    city: "",
    state: "",
    country: "United States",
    workAuth: "us_citizen",
    requiresSponsorship: false,
    authorizedToWork: true,
    yearsExperience: "",
    currentTitle: "",
    desiredSalary: "",
    noticePeriod: "",
    previouslyEmployed: false,
    employmentRestrictions: "",
    gender: "prefer_not",
    race: "prefer_not",
    veteranStatus: "prefer_not",
    disabilityStatus: "prefer_not",
    resumeText: "",
    coverLetterText: "",
    resumeFileName: "",
    coverLetterFileName: "",
    coverLetterSaveDir: "",
  };
}

export function loadProfile(): ApplicantProfile {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) return { ...emptyProfile(), ...JSON.parse(raw) };
  } catch {}
  return emptyProfile();
}

export function saveProfile(p: ApplicantProfile): void {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
  // Sync to engine so the browser extension can read the profile.
  // Fire-and-forget — if it fails the app still works normally.
  fetch("http://127.0.0.1:38471/api/profile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(p),
  }).catch(() => null);
}

// Normalises a persisted draft to the current shape.
// Add a safe default here whenever a new field is added to ApplicationDraft.
export function migrateDraft(d: any): ApplicationDraft {
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

export function loadQueue(): ApplicationDraft[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(migrateDraft);
    }
  } catch {}
  return [];
}

export function saveQueue(q: ApplicationDraft[]): void {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
}

export function detectATS(url: string): {
  atsType: ApplicationDraft["atsType"];
  atsSlug: string;
  atsJobId: string;
} {
  const lower = url.toLowerCase();
  const ghMatch = lower.match(/boards\.greenhouse\.io\/([^/]+)\/jobs\/(\d+)/);
  if (ghMatch) return { atsType: "greenhouse", atsSlug: ghMatch[1], atsJobId: ghMatch[2] };
  const lvMatch = lower.match(/jobs\.lever\.co\/([^/]+)\/([0-9a-f-]{36})/);
  if (lvMatch) return { atsType: "lever", atsSlug: lvMatch[1], atsJobId: lvMatch[2] };
  return { atsType: "unknown", atsSlug: "", atsJobId: "" };
}

export function profileToFields(
  profile: ApplicantProfile,
  atsType: string,
): ApplicationField[] {
  const f = (
    key: string,
    label: string,
    value: string,
    required = true,
  ): ApplicationField => ({ key, label, value, source: "profile", required });

  const base: ApplicationField[] = [
    f("first_name",       "First name",          profile.firstName),
    f("last_name",        "Last name",            profile.lastName),
    f("email",            "Email",                profile.email),
    f("phone",            "Phone",                profile.phone),
    f("location",         "Location / city",      profile.location),
    f("linkedin_profile", "LinkedIn URL",         profile.linkedinURL,    false),
    f("website",          "Portfolio / website",  profile.portfolioURL,   false),
    f("github",           "GitHub URL",           profile.githubURL,      false),
    f("current_title",    "Current title",        profile.currentTitle,   false),
    f("years_experience", "Years of experience",  profile.yearsExperience, false),
    f("desired_salary",   "Desired salary",       profile.desiredSalary,  false),
  ];

  if (atsType === "greenhouse") {
    base.push(
      f("work_authorization",  "Work authorization",     profile.workAuth,                          false),
      f("require_sponsorship", "Requires sponsorship",   profile.requiresSponsorship ? "yes" : "no", false),
      f("gender",              "Gender (EEO)",            profile.gender,                             false),
      f("race",                "Race / ethnicity (EEO)", profile.race,                               false),
      f("veteran_status",      "Veteran status",         profile.veteranStatus,                      false),
      f("disability_status",   "Disability status",      profile.disabilityStatus,                   false),
    );
  }

  return base;
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}