// src/AutoApply.tsx

import { useEffect, useRef, useState } from "react";
import { setGroqAPIKey, getGroqKeyStatus } from "./api";
import { loadProfile, saveProfile, readFileAsText } from "./applyStorage";
import { useApplyQueue } from "./useApplyQueue";
import { ProfileTab } from "./ProfileTab";
import { QueueTab } from "./QueueTab";
import type { ApplicantProfile } from "./types";

// Re-export for App.tsx badge
export { useAutoApplyQueue } from "./useApplyQueue";

export default function AutoApply({ onBack }: { onBack: () => void }) {
  const [tab,           setTab]           = useState<"profile" | "queue">("profile");
  const [profile,       setProfile]       = useState<ApplicantProfile>(loadProfile);
  const [saved,         setSaved]         = useState(false);
  const [apiKeySet,     setApiKeySet]     = useState(false);
  const [apiKeySaving,  setApiKeySaving]  = useState(false);
  const [apiKeyInput,   setApiKeyInput]   = useState("");
  const [apiKeyError,   setApiKeyError]   = useState("");

  const resumeInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef  = useRef<HTMLInputElement>(null);

  const queue = useApplyQueue(profile);

  useEffect(() => {
    getGroqKeyStatus().then(setApiKeySet).catch(() => setApiKeySet(false));
  }, []);

  useEffect(() => {
    saveProfile(profile);
  }, [profile]);

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

  async function handleSaveApiKey() {
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
  }

  const pendingBadge = queue.queue.filter((d) => d.scrapedFields.length === 0).length;

  return (
    <div className="app">
      {/* Header */}
      <div className="pageTop">
        <button className="btn" onClick={onBack}>Back</button>
        <h2 style={{ margin: 0 }}>Auto Apply</h2>
        <div className="spacer" />
        {tab === "profile" && (
          <button
            className="btn btnPrimary"
            onClick={() => { saveProfile(profile); setSaved(true); setTimeout(() => setSaved(false), 2000); }}
          >
            {saved ? "Saved ✓" : "Save profile"}
          </button>
        )}
      </div>

      {/* Tab bar */}
      <div style={{
        display: "flex", gap: 4, marginBottom: 20, width: "fit-content",
        background: "rgba(255,255,255,0.04)", borderRadius: 999,
        padding: 4, border: "1px solid rgba(255,255,255,0.08)",
      }}>
        {(["profile", "queue"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: "7px 18px", borderRadius: 999, border: "none", cursor: "pointer",
              background: tab === t ? "rgba(255,255,255,0.10)" : "transparent",
              color:      tab === t ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.45)",
              fontSize: 13, fontWeight: tab === t ? 600 : 400,
              transition: "all 120ms ease",
              display: "flex", alignItems: "center", gap: 6,
            }}
          >
            {t === "profile" ? "Profile" : "Review Queue"}
            {t === "queue" && pendingBadge > 0 && (
              <span style={{
                fontSize: 10, background: "rgba(253,72,37,0.85)", color: "white",
                borderRadius: 999, padding: "1px 6px", fontWeight: 700,
              }}>
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
          onFileUpload={handleFileUpload}
          apiKeySet={apiKeySet}
          apiKeySaving={apiKeySaving}
          apiKeyInput={apiKeyInput}
          apiKeyError={apiKeyError}
          onApiKeyChange={setApiKeyInput}
          onApiKeySave={handleSaveApiKey}
        />
      ) : (
        <QueueTab
          queue={queue.queue}
          profile={profile}
          onScrape={queue.scrapeDraft}
          onFill={queue.fillDraft}
          onRemove={queue.removeDraft}
          onScrapedFieldChange={queue.updateScrapedField}
          onFieldChange={queue.updateField}
          onApply={queue.applyDraft}
          onSaveCoverLetter={async (jobId) => {
            try {
              await queue.saveGeneratedCoverLetter(jobId);
            } catch (e) {
              console.warn("[AutoApply] Save cover letter failed:", e);
            }
          }}
          onScrapeAll={async () => {
            const toScrape = queue.queue
              .filter((d) => d.scrapedFields.length === 0 && d.status !== "scraping")
              .map((d) => d.jobId);
            for (const id of toScrape) await queue.scrapeDraft(id);
          }}
        />
      )}
    </div>
  );
}