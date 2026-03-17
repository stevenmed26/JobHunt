// src/applyLLM.ts — Groq fill logic for both profile fields and scraped form fields

import { callLLM, getJobDescription, saveCoverLetter, ScrapedField } from "./api";
import { appendCoverLetterLog } from "./ProfileTab";
import type { ApplicantProfile, ApplicationDraft, ApplicationField } from "./types";

function llmLog(step: string, payload?: unknown) {
  const ts = new Date().toISOString();
  if (payload === undefined) {
    console.log(`[JobHunt:llm] ${ts} ${step}`);
    return;
  }
  console.log(`[JobHunt:llm] ${ts} ${step}`, payload);
}

function isCoverField(field: ScrapedField) {
  return (
    (field.label || "").toLowerCase().includes("cover") ||
    (field.label || "").toLowerCase().includes("letter") ||
    field.selector === "#cover_letter_text" ||
    field.selector === "#cover_letter"
  );
}

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

  const systemPrompt = `You are filling in a job application draft.
Return ONLY a JSON array — no markdown, no explanation, no extra text:
[{ "key": "<field_key>", "value": "<answer>" }, ...]

Rules:
- Keep answers concise and professional.
- Use the applicant profile and resume context.
- For salary, work authorization, availability, and location, use the profile directly.
- For "why this company" / "why this role" style fields, tailor the answer to the job description.
- For cover letter style fields in this profile-draft mode, provide a short professional paragraph unless a separate cover-letter field is handled elsewhere.
- No placeholders.`;

  const userMessage = `RESUME:
${profile.resumeText || "(not provided)"}

JOB DESCRIPTION:
${jobDescription || "(not available)"}

FIELDS TO FILL:
${JSON.stringify(unknownFields.map((f) => ({ key: f.key, label: f.label })), null, 2)}

APPLICANT:
Name: ${profile.firstName} ${profile.lastName}
Email: ${profile.email}
Phone: ${profile.phone}
Location: ${profile.location}
Country: ${profile.country}
City: ${profile.city}
State: ${profile.state}
Current title: ${profile.currentTitle}
Years of experience: ${profile.yearsExperience}
Desired salary: ${profile.desiredSalary}
Work authorization: ${profile.workAuth}
Requires sponsorship: ${profile.requiresSponsorship ? "yes" : "no"}
Authorized to work in current country: ${profile.authorizedToWork ? "yes" : "no"}
Notice period / availability: ${profile.noticePeriod}
LinkedIn: ${profile.linkedinURL}
GitHub: ${profile.githubURL}`.trim();

  const text = await callLLM({
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
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
  companyName?: string,
): Promise<ScrapedField[]> {
  if (fields.length === 0) {
    llmLog("fillScrapedFieldsWithGroq.empty");
    return fields;
  }

  const shortFields = fields.filter((f) => f.type !== "file" && !isCoverField(f));
  const coverFields = fields.filter((f) => f.type !== "file" && isCoverField(f));
  const resolvedCompany = (companyName || "").trim() || "Company";

  llmLog("fillScrapedFieldsWithGroq.start", {
    totalFields: fields.length,
    shortFieldCount: shortFields.length,
    coverFieldCount: coverFields.length,
    resolvedCompany,
    coverFields: coverFields.map((f) => ({
      label: f.label,
      selector: f.selector,
      type: f.type,
      required: f.required,
      incomingValueLength: f.value?.length || 0,
    })),
    jobDescriptionLength: jobDescription.length,
    saveCoverLetterEnabled: profile.saveCoverLetterEnabled !== false,
    coverLetterSaveDir: profile.coverLetterSaveDir || "(default)",
  });

  const profileBlock = buildProfileBlock(profile);

  // ── Pass 1: short fields ──────────────────────────────────────────────────
  let shortAnswers: { selector: string; value: string }[] = [];

  if (shortFields.length > 0) {
    const fieldSummary = shortFields.map((f) => ({
      selector: f.selector,
      label: f.label,
      type: f.type,
      required: f.required,
      options: f.options.slice(0, 30).map((o) => o.label),
      optionsTruncated:
        f.options.length > 30
          ? `(${f.options.length - 30} more not shown — pick closest match)`
          : undefined,
    }));

    const systemPrompt = `You are filling out a job application form.
Return ONLY a JSON array — no markdown, no explanation, no trailing text:
[{ "selector": "<selector>", "value": "<answer>" }, ...]

Rules:
- For select/react-select fields, value MUST exactly match one of the provided options.
  If the full options list was truncated, write the closest natural match.
- For yes/no/boolean questions, match the closest option label exactly.
- For EEO/demographic fields (gender, race, veteran, disability, sexual orientation, transgender): map profile values to available options.
  gender mappings: male→"Male", female→"Female", non_binary→"Non-binary" or closest, prefer_not→"I prefer not to say" or closest.
  race mappings: white→"White", black→"Black or African American", hispanic→"Hispanic or Latino", asian→"Asian", prefer_not→"Decline to self identify" or closest.
  veteran mappings: yes→"Protected Veteran" or closest, no→"I am not a protected veteran" or closest, prefer_not→"I prefer not to say" or closest.
  disability mappings: yes→"Yes, I have a disability", no→"No, I don't have a disability", prefer_not→"I Don't Wish to Answer" or closest.
  sexual orientation mappings: straight→"Straight / Heterosexual" or closest, gay_or_lesbian→"Gay or Lesbian" or closest, bisexual→"Bisexual" or closest, asexual→"Asexual" or closest, queer→"Queer" or closest, other→"Other" or closest, prefer_not→"Prefer not to say" or closest.
  transgender mappings: yes→"Yes" or closest, no→"No" or closest, prefer_not→"Prefer not to say" or closest.
- For sponsorship questions, answer based on work authorization: us_citizen/green_card → No, h1b/other → Yes.
- For country-of-residence/location questions, use the applicant's country.
- For unknown custom questions, write a brief professional answer based on the resume.
- Keep all answers concise (one sentence max). Do NOT write explanations or markdown.`;

    const userMessage = `${profileBlock}

JOB DESCRIPTION:
${(jobDescription || "(not available)").slice(0, 800)}

FORM FIELDS:
${JSON.stringify(fieldSummary, null, 2)}`;

    llmLog("shortFields.request", {
      fieldCount: shortFields.length,
      messageLength: userMessage.length,
    });

    const text = await callLLM({
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      max_tokens: 1500,
    });

    llmLog("shortFields.response", {
      textLength: text.length,
      preview: text.slice(0, 200),
    });

    try {
      shortAnswers = JSON.parse(text.replace(/```json|```/g, "").trim());
      llmLog("shortFields.parsed", {
        answerCount: shortAnswers.length,
      });
    } catch (err) {
      console.warn("[AutoApply] Pass 1 parse failed — short fields will be empty");
      llmLog("shortFields.parseError", {
        message: String((err as Error)?.message || err),
        rawPreview: text.slice(0, 400),
      });
    }
  }

  // ── Pass 2: cover letter — plain string call ─────────────────────────────
  let coverAnswers: { selector: string; value: string }[] = [];

  if (coverFields.length > 0) {
    llmLog("coverLetter.request.start", {
      resolvedCompany,
      coverFields: coverFields.map((f) => ({
        label: f.label,
        selector: f.selector,
        type: f.type,
      })),
    });

    const systemPrompt = `You are writing a cover letter for a job application.
Write ONLY the cover letter text — plain text, no JSON, no markdown, no explanation, nothing else.
3 short paragraphs separated by a blank line:
- Paragraph 1: Genuine interest in the specific role and company (2 sentences).
- Paragraph 2: 2-3 relevant experiences from the resume that match the job requirements.
- Paragraph 3: Enthusiasm, cultural fit, and a brief call to action (1-2 sentences).
Keep it under 300 words.

Rules:
- The company name is exactly "${resolvedCompany}".
- The resume or template may contain references to other companies from older applications. Ignore those old company names.
- Do NOT mention Amazon unless the company is actually Amazon.
- Use "${resolvedCompany}" naturally in the first paragraph.
- No placeholders like [Company Name].`;

    const userMessage = `COMPANY:
${resolvedCompany}

${profileBlock}

RESUME:
${profile.resumeText || "(not provided)"}

COVER LETTER TEMPLATE (style guide only, do not copy verbatim):
${profile.coverLetterText || "(not provided)"}

JOB DESCRIPTION:
${jobDescription || "(not available)"}`;

    try {
      const coverText = await callLLM({
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
        max_tokens: 600,
      });

      llmLog("coverLetter.response.raw", {
        textLength: coverText.length,
        preview: coverText.slice(0, 220),
      });

      const trimmed = coverText.trim();
      if (trimmed) {
        llmLog("coverLetter.response.trimmed", {
          textLength: trimmed.length,
          preview: trimmed.slice(0, 220),
        });

        coverAnswers = coverFields.map((f) => ({
          selector: f.selector,
          value: trimmed,
        }));

        if (profile.saveCoverLetterEnabled !== false) {
          llmLog("coverLetter.save.start", {
            resolvedCompany,
            saveDir: profile.coverLetterSaveDir || "(default)",
            textLength: trimmed.length,
          });

          saveCoverLetter(
            profile.firstName,
            profile.lastName,
            resolvedCompany,
            trimmed,
            profile.coverLetterSaveDir || undefined,
          )
            .then(({ path }) => {
              console.log(`[AutoApply] ✓ Cover letter saved → ${path}`);
              llmLog("coverLetter.save.success", { resolvedCompany, path });
              appendCoverLetterLog({
                status: "saved",
                company: resolvedCompany,
                path,
                message: `Saved → ${path}`,
              });
            })
            .catch((e) => {
              const msg = String(e?.message ?? e);
              console.warn(`[AutoApply] ✗ Cover letter save failed: ${msg}`);
              llmLog("coverLetter.save.failed", { resolvedCompany, message: msg });
              appendCoverLetterLog({
                status: "failed",
                company: resolvedCompany,
                message: msg,
              });
            });
        } else {
          console.log("[AutoApply] Cover letter save skipped (disabled in profile)");
          llmLog("coverLetter.save.skipped", {
            reason: "disabled in profile settings",
            resolvedCompany,
          });
          appendCoverLetterLog({
            status: "skipped",
            company: resolvedCompany,
            message: "Save disabled in profile settings",
          });
        }
      } else {
        llmLog("coverLetter.response.empty");
      }
    } catch (e) {
      console.warn("[AutoApply] Cover letter call failed:", e);
      llmLog("coverLetter.request.failed", {
        message: String((e as Error)?.message || e),
      });
    }
  } else {
    llmLog("coverLetter.request.skipped", { reason: "no cover fields detected" });
  }

  const allAnswers = [...shortAnswers, ...coverAnswers];
  llmLog("fillScrapedFieldsWithGroq.merge", {
    shortAnswerCount: shortAnswers.length,
    coverAnswerCount: coverAnswers.length,
    totalAnswerCount: allAnswers.length,
  });

  const merged = fields.map((f) => {
    if (f.type === "file") return f;
    const answer = allAnswers.find((a) => a.selector === f.selector);
    if (!answer?.value) return f;

    if ((f.type === "select" || f.isReactSelect) && f.options.length > 0) {
      const exact = f.options.find(
        (o) =>
          o.label.toLowerCase() === answer.value.toLowerCase() ||
          o.value.toLowerCase() === answer.value.toLowerCase(),
      );
      if (exact) return { ...f, value: exact.label };

      const fuzzy = f.options.find(
        (o) =>
          o.label.toLowerCase().includes(answer.value.toLowerCase().slice(0, 6)) ||
          answer.value.toLowerCase().includes(o.label.toLowerCase().slice(0, 6)),
      );
      if (fuzzy) return { ...f, value: fuzzy.label };

      return { ...f, value: answer.value };
    }

    return { ...f, value: answer.value };
  });

  llmLog("fillScrapedFieldsWithGroq.done", {
    totalFields: merged.length,
    populatedCoverFields: merged.filter((f) => isCoverField(f)).map((f) => ({
      label: f.label,
      selector: f.selector,
      valueLength: f.value?.length || 0,
    })),
  });

  return merged;
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
Sexual orientation (optional demographic): ${profile.sexualOrientation}
Transgender status (optional demographic): ${profile.transgenderStatus}
Previously employed here: ${profile.previouslyEmployed ? "yes" : "no"}
Employment agreements/restrictions: ${profile.employmentRestrictions || "none"}`;
}