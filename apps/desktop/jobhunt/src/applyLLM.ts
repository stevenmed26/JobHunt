// src/applyLLM.ts — Groq fill logic for both profile fields and scraped form fields

import { callLLM, getJobDescription, saveCoverLetter, ScrapedField } from "./api";
import { appendCoverLetterLog } from "./ProfileTab";
import type { ApplicantProfile, ApplicationDraft, ApplicationField } from "./types";

export async function fetchJobDescription(jobId: number): Promise<string> {
  try {
    return await getJobDescription(jobId);
  } catch {
    return "";
  }
}

// ─── Fill profile-seeded fields ───────────────────────────────────────────────

export async function fillWithLLM(
  draft: ApplicationDraft,
  profile: ApplicantProfile,
  jobDescription: string,
): Promise<ApplicationField[]> {
  const unknownFields = draft.fields.filter((f) => f.value === "" || f.source === "ai");
  if (unknownFields.length === 0) return draft.fields;

  const systemPrompt = `You are an assistant helping a job applicant fill out their application form.
Given the applicant's resume, cover letter template, job description, and a list of fields to fill:

Return ONLY a valid JSON array (no markdown, no explanation):
  [{ "key": "<field_key>", "value": "<answer>" }, ...]

Rules:
- For cover_letter fields, customize the template for this specific job. Keep it 3-4 paragraphs.
- For "why do you want to work here" questions, write 2-3 genuine sentences from the job description.
- For salary fields, use the desired salary from the profile, or "Open to discussion".
- For EEO fields (gender, race, veteran, disability), use the values already in the fields — do not change them.
- Answer in plain text, no markdown.
- Keep all answers concise and professional.`;

  const userMessage = `RESUME:
${profile.resumeText || "(not provided)"}

COVER LETTER TEMPLATE:
${profile.coverLetterText || "(not provided)"}

JOB DESCRIPTION:
${jobDescription || "(not available)"}

FIELDS TO FILL:
${JSON.stringify(unknownFields.map((f) => ({ key: f.key, label: f.label })), null, 2)}

APPLICANT:
Name: ${profile.firstName} ${profile.lastName}
Email: ${profile.email}
Location: ${profile.location}
Current title: ${profile.currentTitle}
Years of experience: ${profile.yearsExperience}
Desired salary: ${profile.desiredSalary}
Work authorization: ${profile.workAuth}`.trim();

  const text = await callLLM({
    system:     systemPrompt,
    messages:   [{ role: "user", content: userMessage }],
    max_tokens: 1000,
  });

  let aiAnswers: { key: string; value: string }[] = [];
  try {
    aiAnswers = JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    throw new Error("Failed to parse LLM response as JSON");
  }

  return draft.fields.map((field) => {
    if (field.value !== "" && field.source === "profile") return field;
    const ai = aiAnswers.find((a) => a.key === field.key);
    return ai ? { ...field, value: ai.value, source: "ai" } : field;
  });
}

// ─── Fill scraped form fields ─────────────────────────────────────────────────
//
// Uses two separate Groq calls to avoid token limit truncation:
//   Pass 1 — all short fields (text, select, yes/no) — fast, compact JSON
//   Pass 2 — cover letter only — full tokens for a long-form answer
//
// This ensures a truncated cover letter never cuts off the JSON array and
// silently drops every field that comes after it.

export async function fillScrapedFieldsWithGroq(
  fields: ScrapedField[],
  profile: ApplicantProfile,
  jobDescription: string,
): Promise<ScrapedField[]> {
  if (fields.length === 0) return fields;

  // Detect cover letter fields by label OR by being a textarea with selector
  // matching known cover letter IDs — catches cases where the label is "Enter manually"
  // (the Greenhouse button text) instead of "Cover Letter".
  const isCoverLetter = (f: ScrapedField) =>
    f.label.toLowerCase().includes("cover") ||
    f.label.toLowerCase().includes("letter") ||
    f.selector === "#cover_letter_text" ||
    f.selector === "#cover_letter";

  const shortFields  = fields.filter((f) => f.type !== "file" && !isCoverLetter(f));
  const coverFields  = fields.filter((f) => f.type !== "file" && isCoverLetter(f));

  // Build a compact profile string reused in both passes
  const profileBlock = buildProfileBlock(profile);

  // ── Pass 1: short fields ──────────────────────────────────────────────────
  let shortAnswers: { selector: string; value: string }[] = [];

  if (shortFields.length > 0) {
    const fieldSummary = shortFields.map((f) => ({
      selector: f.selector,
      label:    f.label,
      type:     f.type,
      required: f.required,
      // Limit options to 30 entries — country lists have 190+ and bloat the prompt.
      // Groq is told to use the closest match, fuzzy matching handles the rest.
      options:  f.options.slice(0, 30).map((o) => o.label),
      optionsTruncated: f.options.length > 30 ? `(${f.options.length - 30} more not shown — pick closest match)` : undefined,
    }));

    const systemPrompt = `You are filling out a job application form.
Return ONLY a JSON array — no markdown, no explanation, no trailing text:
[{ "selector": "<selector>", "value": "<answer>" }, ...]

Rules:
- For select/react-select fields, value MUST exactly match one of the provided options.
  If the full options list was truncated, write the closest natural match (e.g. "United States" for country).
- For yes/no/boolean questions, match the closest option label exactly.
- For EEO fields (gender, race, veteran, disability): map profile values to available options.
  gender mappings: male→"Male", female→"Female", non_binary→"Non-binary" or closest, prefer_not→"I prefer not to say" or closest.
  race mappings: white→"White", black→"Black or African American", hispanic→"Hispanic or Latino", asian→"Asian", prefer_not→"Decline to self identify" or closest.
  veteran mappings: yes→"Protected Veteran" or closest, no→"I am not a protected veteran" or closest, prefer_not→"I prefer not to say" or closest.
  disability mappings: yes→"Yes, I have a disability", no→"No, I don't have a disability", prefer_not→"I Don't Wish to Answer" or closest.
- For sponsorship questions, answer based on work authorization: us_citizen/green_card → No, h1b/other → Yes.
- For country-of-residence/location questions, use the applicant's country (United States if US-based).
- For unknown custom questions, write a brief professional answer based on the resume.
- Keep all answers concise (one sentence max). Do NOT write explanations or markdown.`;

    const userMessage = `${profileBlock}

JOB DESCRIPTION:
${(jobDescription || "(not available)").slice(0, 800)}

FORM FIELDS:
${JSON.stringify(fieldSummary, null, 2)}`;

    const text = await callLLM({
      system:     systemPrompt,
      messages:   [{ role: "user", content: userMessage }],
      max_tokens: 1500,
    });

    try {
      shortAnswers = JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch {
      console.warn("[AutoApply] Pass 1 parse failed — short fields will be empty");
    }
  }

  // ── Pass 2: cover letter — plain string call, JSON built here ───────────────
  // Groq returns the cover letter as plain text only (no JSON).
  // We wrap it into the answer array ourselves — zero parse risk.
  let coverAnswers: { selector: string; value: string }[] = [];

  if (coverFields.length > 0) {
    const systemPrompt = `You are writing a cover letter for a job application.
Write ONLY the cover letter text — plain text, no JSON, no markdown, no explanation, nothing else.
3 short paragraphs separated by a blank line:
- Paragraph 1: Genuine interest in the specific role and company (2 sentences, use real company name).
- Paragraph 2: 2-3 relevant experiences from the resume that match the job requirements.
- Paragraph 3: Enthusiasm, cultural fit, and a brief call to action (1-2 sentences).
Keep it under 300 words. No placeholders like [Company Name].`;

    const userMessage = `${profileBlock}

RESUME:
${profile.resumeText || "(not provided)"}

COVER LETTER TEMPLATE (style guide only, do not copy verbatim):
${profile.coverLetterText || "(not provided)"}

JOB DESCRIPTION:
${jobDescription || "(not available)"}`;

    try {
      const coverText = await callLLM({
        system:   systemPrompt,
        messages: [{ role: "user", content: userMessage }],
        max_tokens: 600,
      });

      const trimmed = coverText.trim();
      if (trimmed) {
        coverAnswers = coverFields.map((f) => ({
          selector: f.selector,
          value:    trimmed,
        }));

        // Save to file as fallback — useful when form injection fails
        // Company name is extracted from the job description (first line heuristic)
        const companyGuess = jobDescription
          ? jobDescription.split(/[.]/)[0].replace(/^(about|at|join|work at)\s+/i, "").trim().slice(0, 40)
: "Company";
        if (profile.saveCoverLetterEnabled !== false) {
          saveCoverLetter(
            profile.firstName,
            profile.lastName,
            companyGuess,
            trimmed,
            profile.coverLetterSaveDir || undefined,
          ).then(({ path }) => {
            console.log(`[AutoApply] ✓ Cover letter saved → ${path}`);
            appendCoverLetterLog({ status: "saved", company: companyGuess, path, message: `Saved → ${path}` });
          }).catch((e) => {
            const msg = String(e?.message ?? e);
            console.warn(`[AutoApply] ✗ Cover letter save failed: ${msg}`);
            appendCoverLetterLog({ status: "failed", company: companyGuess, message: msg });
          });
        } else {
          console.log("[AutoApply] Cover letter save skipped (disabled in profile)");
          appendCoverLetterLog({ status: "skipped", company: companyGuess, message: "Save disabled in profile settings" });
        }
      }
    } catch (e) {
      console.warn("[AutoApply] Cover letter call failed:", e);
    }
  }

  const allAnswers = [...shortAnswers, ...coverAnswers];

  // ── Merge answers back into fields ────────────────────────────────────────
  return fields.map((f) => {
    if (f.type === "file") return f;
    const answer = allAnswers.find((a) => a.selector === f.selector);
    if (!answer?.value) return f;

    if ((f.type === "select" || f.isReactSelect) && f.options.length > 0) {
      // Exact match first
      const exact = f.options.find(
        (o) =>
          o.label.toLowerCase() === answer.value.toLowerCase() ||
          o.value.toLowerCase() === answer.value.toLowerCase(),
      );
      if (exact) return { ...f, value: exact.label };

      // Fuzzy: option label contains the answer or vice versa
      const fuzzy = f.options.find(
        (o) =>
          o.label.toLowerCase().includes(answer.value.toLowerCase().slice(0, 6)) ||
          answer.value.toLowerCase().includes(o.label.toLowerCase().slice(0, 6)),
      );
      if (fuzzy) return { ...f, value: fuzzy.label };

      // Fall through with raw answer — user can correct in review
      return { ...f, value: answer.value };
    }

    return { ...f, value: answer.value };
  });
}

// ── Shared profile block ──────────────────────────────────────────────────────

function buildProfileBlock(profile: ApplicantProfile): string {
  return `APPLICANT PROFILE:
Name: ${profile.firstName} ${profile.lastName}
Email: ${profile.email}
Phone: ${profile.phone}
Location: ${profile.location}
Country: ${profile.country}
City: ${profile.city}
State: ${profile.state}
Current title: ${profile.currentTitle}
Years experience: ${profile.yearsExperience}
Work authorization (US): ${profile.workAuth}
Requires sponsorship: ${profile.requiresSponsorship ? "yes" : "no"}
Authorized to work in current country: ${profile.authorizedToWork ? "yes" : "no"}
Desired salary: ${profile.desiredSalary}
Notice period / availability: ${profile.noticePeriod}
LinkedIn: ${profile.linkedinURL}
GitHub: ${profile.githubURL}
Gender (EEO): ${profile.gender}
Race/ethnicity (EEO): ${profile.race}
Veteran status (EEO): ${profile.veteranStatus}
Disability status (EEO): ${profile.disabilityStatus}
Previously employed here: ${profile.previouslyEmployed ? "yes" : "no"}
Employment agreements/restrictions: ${profile.employmentRestrictions || "none"}`;
}