// src/QueueTab.tsx — review queue for pending applications

import { DraftCard } from "./DraftCard";
import type { ApplicationDraft, ApplicantProfile } from "./types";

export function QueueTab({
  queue,
  profile,
  onScrape,
  onFill,
  onRemove,
  onScrapedFieldChange,
  onApply,
  onSaveCoverLetter,
  onScrapeAll,
}: {
  queue: ApplicationDraft[];
  profile: ApplicantProfile;
  onScrape: (jobId: number) => void;
  onFill: (jobId: number) => void;
  onRemove: (jobId: number) => void;
  onScrapedFieldChange: (jobId: number, idx: number, val: string) => void;
  onFieldChange: (jobId: number, key: string, val: string) => void;
  onApply: (jobId: number) => void;
  onSaveCoverLetter: (jobId: number) => void | Promise<void>;
  onScrapeAll: () => void;
}) {
  const unscrapeCount = queue.filter(
    (d) => d.scrapedFields.length === 0 && d.status !== "scraping",
  ).length;

  return (
    <div>
      {/* Summary bar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12, marginBottom: 16,
        padding: "10px 14px", background: "rgba(255,255,255,0.04)",
        borderRadius: 12, border: "1px solid rgba(255,255,255,0.08)",
      }}>
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
            onClick={onScrapeAll}
          >
            Scrape all forms
          </button>
        )}
      </div>

      {/* Empty state */}
      {queue.length === 0 && (
        <div style={{
          padding: "24px 20px", textAlign: "center", lineHeight: 1.6,
          color: "rgba(255,255,255,0.35)", fontSize: 13,
          border: "1px dashed rgba(255,255,255,0.1)", borderRadius: 14,
        }}>
          No jobs in the queue yet.
          <br />
          Go to the{" "}
          <span style={{ color: "rgba(253,72,37,0.8)" }}>Jobs</span> view and click{" "}
          <strong style={{ color: "rgba(255,255,255,0.6)" }}>Apply</strong> on any job to add it here.
        </div>
      )}

      {/* Draft cards */}
      {queue.length > 0 && (
        <div style={{
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 16, overflow: "hidden",
          background: "rgba(255,255,255,0.03)",
        }}>
          {queue.map((draft) => (
            <DraftCard
              key={draft.jobId}
              draft={draft}
              profile={profile}
              onScrape={() => onScrape(draft.jobId)}
              onFill={() => onFill(draft.jobId)}
              onRemove={() => onRemove(draft.jobId)}
              onScrapedFieldChange={(idx, val) => onScrapedFieldChange(draft.jobId, idx, val)}
              onApply={() => onApply(draft.jobId)}
              onSaveCoverLetter={() => onSaveCoverLetter(draft.jobId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}