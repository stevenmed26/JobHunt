// src/applyLLM.ts — Groq fill logic for both profile fields and scraped form fields

import { callLLM, getJobDescription, ScrapedField } from "./api";
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

export async function fillScrapedFieldsWithGroq(
  fields: ScrapedField[],
  profile: ApplicantProfile,
  jobDescription: string,
): Promise<ScrapedField[]> {
  if (fields.length === 0) return fields;

  const systemPrompt = `You are filling out a job application form.
Return ONLY a JSON array — no markdown, no explanation:
[{ "selector": "<selector>", "value": "<answer>" }, ...]

Rules:
- For select fields, value MUST exactly match one of the provided options (use the option label).
- For file fields, leave value as empty string "".
- For fields labelled "Cover Letter" or similar: you MUST write a tailored 3-paragraph cover letter using the resume and job description. Never leave this empty.
- For EEO fields (gender, race, veteran, disability), map the applicant's profile values to the available options.
- For yes/no sponsorship questions, answer based on the work authorization in the profile.
- For unknown custom questions not answerable from the profile, write a brief professional answer.
- Keep all non-cover-letter answers concise (1 sentence or less).`;

  const fieldSummary = fields
    .filter((f) => f.type !== "file")
    .map((f) => ({
      selector: f.selector,
      label:    f.label,
      type:     f.type,
      required: f.required,
      options:  f.options.map((o) => o.label),
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
    answers = JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    console.warn("[AutoApply] Failed to parse Groq response for scraped fields");
    return fields;
  }

  return fields.map((f) => {
    if (f.type === "file") return f;
    const answer = answers.find((a) => a.selector === f.selector);
    if (!answer?.value) return f;

    // For selects, snap to a valid option label
    if ((f.type === "select" || f.isReactSelect) && f.options.length > 0) {
      const match = f.options.find(
        (o) =>
          o.label.toLowerCase() === answer.value.toLowerCase() ||
          o.value.toLowerCase() === answer.value.toLowerCase(),
      );
      return { ...f, value: match ? match.label : answer.value };
    }

    return { ...f, value: answer.value };
  });
}