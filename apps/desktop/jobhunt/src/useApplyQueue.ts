// src/useApplyQueue.ts — queue state + all draft actions as a single custom hook

import { useState } from "react";
import { scrapeForm, fillForm } from "./api";
import {
  loadQueue, saveQueue, loadProfile,
  detectATS, profileToFields,
} from "./applyStorage";
import { fetchJobDescription, fillWithLLM, fillScrapedFieldsWithGroq } from "./applyLLM";
import type { ApplicantProfile, ApplicationDraft, ApplicationField } from "./types";
import type { ScrapedField } from "./api";

// ─── Exported hook ────────────────────────────────────────────────────────────

export function useApplyQueue(profile: ApplicantProfile) {
  const [queue, setQueue] = useState<ApplicationDraft[]>(loadQueue);

  // Helper: update a single draft immutably
  function patchDraft(jobId: number, patch: Partial<ApplicationDraft>) {
    setQueue((q) => {
      const next = q.map((d) => d.jobId === jobId ? { ...d, ...patch } : d);
      saveQueue(next);
      return next;
    });
  }

  // ── Read draft synchronously inside a state updater ───────────────────────
  function withDraft(
    jobId: number,
    patch: Partial<ApplicationDraft>,
    cb: (draft: ApplicationDraft) => void,
  ): Promise<void> {
    return new Promise((resolve) => {
      let captured: ApplicationDraft | undefined;
      setQueue((q) => {
        captured = q.find((d) => d.jobId === jobId);
        const next = q.map((d) => d.jobId === jobId ? { ...d, ...patch } : d);
        saveQueue(next);
        return next;
      });
      // One tick for React to flush
      setTimeout(() => { if (captured) cb(captured); resolve(); }, 0);
    });
  }

  // ── Phase 1: scrape live form ─────────────────────────────────────────────

  async function scrapeDraft(jobId: number) {
    let draft: ApplicationDraft | undefined;
    await withDraft(jobId, { status: "scraping", errorMsg: undefined }, (d) => { draft = d; });
    if (!draft) return;

    try {
      const scraped    = await scrapeForm(draft.jobId, draft.url, draft.atsType);
      const jobDesc    = await fetchJobDescription(jobId);
      const filled     = await fillScrapedFieldsWithGroq(scraped, profile, jobDesc);
      patchDraft(jobId, { status: "scraped", scrapedFields: filled, errorMsg: undefined });
    } catch (err: any) {
      patchDraft(jobId, { status: "error", errorMsg: String(err?.message ?? err) });
    }
  }

  // ── Re-fill scraped fields with Groq ─────────────────────────────────────

  async function fillDraft(jobId: number) {
    let draft: ApplicationDraft | undefined;
    await withDraft(jobId, { status: "filling" }, (d) => { draft = d; });
    if (!draft) return;

    try {
      // Re-fill scraped fields if present
      if (draft.scrapedFields.length > 0) {
        const jobDesc = await fetchJobDescription(jobId);
        const filled  = await fillScrapedFieldsWithGroq(draft.scrapedFields, profile, jobDesc);
        patchDraft(jobId, { status: "scraped", scrapedFields: filled, errorMsg: undefined });
        return;
      }

      // Fallback: fill profile-seeded fields
      const withProfile: ApplicationDraft = {
        ...draft,
        fields: draft.fields.length === 0 ? profileToFields(profile, draft.atsType) : draft.fields,
      };
      const openFields: ApplicationField[] = [
        { key: "cover_letter",    label: "Cover letter",                     value: "", source: "ai", required: false },
        { key: "why_this_company",label: "Why do you want to work here?",    value: "", source: "ai", required: false },
        { key: "how_did_you_hear",label: "How did you hear about this role?",value: "", source: "ai", required: false },
      ];
      for (const of_ of openFields) {
        if (!withProfile.fields.some((f) => f.key === of_.key)) withProfile.fields.push(of_);
      }
      const jobDesc = await fetchJobDescription(jobId);
      const filledFields = await fillWithLLM(withProfile, profile, jobDesc);
      patchDraft(jobId, { status: "ready", fields: filledFields, errorMsg: undefined });
    } catch (err: any) {
      patchDraft(jobId, { status: "error", errorMsg: String(err?.message ?? err) });
    }
  }

  // ── Phase 2: open browser and fill ───────────────────────────────────────

  async function applyDraft(jobId: number) {
    let draft: ApplicationDraft | undefined;
    await withDraft(jobId, { applying: true, errorMsg: undefined }, (d) => { draft = d; });
    if (!draft) return;

    const fieldsToFill: ScrapedField[] =
      draft.scrapedFields.length > 0
        ? draft.scrapedFields
        : draft.fields.map((f) => ({
            selector:      "",
            label:         f.label,
            type:          "text",
            required:      f.required,
            options:       [],
            value:         f.value,
            isFile:        false,
            isReactSelect: false,
          }));

    try {
      await fillForm({ jobId: draft.jobId, url: draft.url, fields: fieldsToFill });
      patchDraft(jobId, { applying: false, status: "submitted" });
    } catch (err: any) {
      patchDraft(jobId, { applying: false, status: "error", errorMsg: String(err?.message ?? err) });
    }
  }

  // ── Mutations ─────────────────────────────────────────────────────────────

  function removeDraft(jobId: number) {
    setQueue((q) => {
      const next = q.filter((d) => d.jobId !== jobId);
      saveQueue(next);
      return next;
    });
  }

  function updateField(jobId: number, fieldKey: string, value: string) {
    setQueue((q) => {
      const next = q.map((d) =>
        d.jobId === jobId
          ? { ...d, fields: d.fields.map((f) => f.key === fieldKey ? { ...f, value, source: "manual" as const } : f) }
          : d,
      );
      saveQueue(next);
      return next;
    });
  }

  function updateScrapedField(jobId: number, idx: number, value: string) {
    setQueue((q) => {
      const next = q.map((d) =>
        d.jobId === jobId
          ? { ...d, scrapedFields: d.scrapedFields.map((f, i) => i === idx ? { ...f, value } : f) }
          : d,
      );
      saveQueue(next);
      return next;
    });
  }

  return {
    queue,
    scrapeDraft,
    fillDraft,
    applyDraft,
    removeDraft,
    updateField,
    updateScrapedField,
  };
}

// ─── Lightweight hook used by App.tsx for the queue badge ─────────────────────

export function useAutoApplyQueue() {
  const [queue, setQueue] = useState<ApplicationDraft[]>(loadQueue);

  function addToQueue(job: { id: number; company: string; title: string; url: string }) {
    if (queue.some((d) => d.jobId === job.id)) return;

    const { atsType, atsSlug, atsJobId } = detectATS(job.url);
    const profile = loadProfile();
    const draft: ApplicationDraft = {
      jobId:         job.id,
      company:       job.company,
      title:         job.title,
      url:           job.url,
      atsType,
      atsSlug,
      atsJobId,
      status:        "pending",
      fields:        profileToFields(profile, atsType),
      scrapedFields: [],
    };
    const next = [draft, ...queue];
    setQueue(next);
    saveQueue(next);
  }

  return { addToQueue, queueCount: queue.length };
}