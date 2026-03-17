// src/ProfileTab.tsx — applicant profile form

import React from "react";
import type { ApplicantProfile } from "./types";

// ─── Reusable form primitives ─────────────────────────────────────────────────

function TwoCol({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
      {children}
    </div>
  );
}

function Field({
  label,
  fieldKey,
  type = "text",
  placeholder = "",
  profile,
  onChange,
}: {
  label: string;
  fieldKey: keyof ApplicantProfile;
  type?: string;
  placeholder?: string;
  profile: ApplicantProfile;
  onChange: (key: keyof ApplicantProfile, value: any) => void;
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
        onChange={(e) => onChange(fieldKey, e.target.value)}
      />
    </label>
  );
}

function SelectField({
  label,
  fieldKey,
  options,
  profile,
  onChange,
}: {
  label: string;
  fieldKey: keyof ApplicantProfile;
  options: { value: string; label: string }[];
  profile: ApplicantProfile;
  onChange: (key: keyof ApplicantProfile, value: any) => void;
}) {
  return (
    <label className="formLabel" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
      <span style={{ fontSize: 12, color: "rgba(255,255,255,0.55)" }}>{label}</span>
      <select
        style={{ width: "100%", borderRadius: 10, padding: "8px 12px" }}
        value={profile[fieldKey] as string}
        onChange={(e) => onChange(fieldKey, e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

// ─── ProfileTab ───────────────────────────────────────────────────────────────

export function ProfileTab({
  profile,
  updateProfile,
  resumeInputRef,
  coverInputRef,
  onFileUpload,
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
  onFileUpload: (
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
      <div style={{ padding: "14px", display: "flex", flexDirection: "column", gap: 12 }}>
        <TwoCol>
          <Field label="First name *" fieldKey="firstName" placeholder="Jane" profile={profile} onChange={updateProfile} />
          <Field label="Last name *"  fieldKey="lastName"  placeholder="Smith" profile={profile} onChange={updateProfile} />
        </TwoCol>
        <TwoCol>
          <Field label="Email *" fieldKey="email" type="email" placeholder="jane@example.com" profile={profile} onChange={updateProfile} />
          <Field label="Phone *" fieldKey="phone" placeholder="+1 (555) 000-0000" profile={profile} onChange={updateProfile} />
        </TwoCol>
        <p className="help" style={{ margin: "4px 0 0" }}>
          Fill city, state, and country separately — Groq uses these to answer location dropdowns precisely.
        </p>
        <TwoCol>
          <Field label="City *" fieldKey="city" placeholder="Dallas" profile={profile} onChange={updateProfile} />
          <Field label="State *" fieldKey="state" placeholder="TX" profile={profile} onChange={updateProfile} />
        </TwoCol>
        <TwoCol>
          <Field label="Country *" fieldKey="country" placeholder="United States" profile={profile} onChange={updateProfile} />
          <Field label="Display location (City, State)" fieldKey="location" placeholder="Dallas, TX" profile={profile} onChange={updateProfile} />
        </TwoCol>
        <TwoCol>
          <Field label="LinkedIn URL"       fieldKey="linkedinURL"  placeholder="https://linkedin.com/in/jane" profile={profile} onChange={updateProfile} />
          <Field label="Portfolio / website" fieldKey="portfolioURL" placeholder="https://jane.dev" profile={profile} onChange={updateProfile} />
        </TwoCol>
        <Field label="GitHub URL" fieldKey="githubURL" placeholder="https://github.com/janesmith" profile={profile} onChange={updateProfile} />
      </div>

      {/* ── Work ── */}
      <div className="sectionHead">Work</div>
      <div style={{ padding: "14px", display: "flex", flexDirection: "column", gap: 12 }}>
        <TwoCol>
          <Field label="Current / most recent title" fieldKey="currentTitle"    placeholder="Senior Software Engineer" profile={profile} onChange={updateProfile} />
          <Field label="Years of experience"          fieldKey="yearsExperience" placeholder="5"                        profile={profile} onChange={updateProfile} />
        </TwoCol>
        <TwoCol>
          <SelectField
            label="Work authorization (US)"
            fieldKey="workAuth"
            options={[
              { value: "us_citizen",  label: "US Citizen" },
              { value: "green_card",  label: "Permanent Resident (Green Card)" },
              { value: "h1b",         label: "H-1B / Work Visa" },
              { value: "other",       label: "Other" },
            ]}
            profile={profile}
            onChange={updateProfile}
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
        <TwoCol>
          <Field label="Desired salary" fieldKey="desiredSalary" placeholder="e.g. $130,000 or Open to discussion" profile={profile} onChange={updateProfile} />
          <Field label="Notice period / availability" fieldKey="noticePeriod" placeholder="e.g. 2 weeks, Immediately" profile={profile} onChange={updateProfile} />
        </TwoCol>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "rgba(255,255,255,0.55)" }}>Authorized to work in your current country?</span>
          <div className="checkRow" style={{ padding: "8px 0" }}>
            <input
              className="checkbox"
              type="checkbox"
              checked={profile.authorizedToWork}
              onChange={(e) => updateProfile("authorizedToWork", e.target.checked)}
            />
            <span style={{ fontSize: 13 }}>Yes, authorized to work here</span>
          </div>
        </div>
      </div>

      {/* ── Common custom questions ── */}
      <div className="sectionHead">Common Questions</div>
      <div style={{ padding: "14px", display: "flex", flexDirection: "column", gap: 12 }}>
        <p className="help" style={{ marginTop: 0 }}>
          These appear on most applications. Filling them here means Groq can answer them automatically.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "rgba(255,255,255,0.55)" }}>Previously worked at or consulted for this company?</span>
          <div className="checkRow" style={{ padding: "8px 0" }}>
            <input
              className="checkbox"
              type="checkbox"
              checked={profile.previouslyEmployed}
              onChange={(e) => updateProfile("previouslyEmployed", e.target.checked)}
            />
            <span style={{ fontSize: 13 }}>Yes (Groq will answer "Yes" to these questions)</span>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "rgba(255,255,255,0.55)" }}>
            Employment agreements or post-employment restrictions?
          </span>
          <span className="help">Leave blank if none. If yes, describe briefly — Groq will use this to answer the question.</span>
          <input
            className="input"
            value={profile.employmentRestrictions}
            placeholder="e.g. Non-compete with Acme Corp expires June 2025"
            onChange={(e) => updateProfile("employmentRestrictions", e.target.value)}
          />
        </div>
      </div>

      {/* ── EEO ── */}
      <div className="sectionHead">EEO / Demographic (optional)</div>
      <div style={{ padding: "14px", display: "flex", flexDirection: "column", gap: 12 }}>
        <p className="help" style={{ marginTop: 0 }}>
          Auto-filled on voluntary EEO questions. All default to "prefer not to say".
        </p>
        <TwoCol>
          <SelectField label="Gender" fieldKey="gender"
            options={[
              { value: "male",       label: "Male" },
              { value: "female",     label: "Female" },
              { value: "non_binary", label: "Non-binary" },
              { value: "prefer_not", label: "Prefer not to say" },
            ]}
            profile={profile} onChange={updateProfile}
          />
          <SelectField label="Race / ethnicity" fieldKey="race"
            options={[
              { value: "white",       label: "White" },
              { value: "black",       label: "Black or African American" },
              { value: "hispanic",    label: "Hispanic or Latino" },
              { value: "asian",       label: "Asian" },
              { value: "native",      label: "American Indian / Alaska Native" },
              { value: "pacific",     label: "Native Hawaiian / Pacific Islander" },
              { value: "two_or_more", label: "Two or more races" },
              { value: "prefer_not",  label: "Prefer not to say" },
            ]}
            profile={profile} onChange={updateProfile}
          />
        </TwoCol>
        <TwoCol>
          <SelectField label="Veteran status" fieldKey="veteranStatus"
            options={[
              { value: "yes",        label: "Protected veteran" },
              { value: "no",         label: "Not a protected veteran" },
              { value: "prefer_not", label: "Prefer not to disclose" },
            ]}
            profile={profile} onChange={updateProfile}
          />
          <SelectField label="Disability status" fieldKey="disabilityStatus"
            options={[
              { value: "yes",        label: "Yes, I have a disability" },
              { value: "no",         label: "No, I don't have a disability" },
              { value: "prefer_not", label: "Prefer not to disclose" },
            ]}
            profile={profile} onChange={updateProfile}
          />
        </TwoCol>
      </div>

      {/* ── Documents ── */}
      <div className="sectionHead">Documents</div>
      <div style={{ padding: "14px", display: "flex", flexDirection: "column", gap: 16 }}>
        <p className="help" style={{ marginTop: 0 }}>
          Paste your resume as plain text — Groq uses it to fill fields and write cover letters.
          Upload your PDF directly on each job form.
        </p>

        <DocumentField
          label="Resume"
          fileName={profile.resumeFileName}
          value={profile.resumeText}
          placeholder="Paste your resume as plain text — Groq reads this to fill out fields and write cover letters."
          inputRef={resumeInputRef}
          onUpload={(f) => onFileUpload(f, "resumeText", "resumeFileName")}
          onChange={(v) => updateProfile("resumeText", v)}
          minHeight={140}
        />

        <DocumentField
          label="Default cover letter"
          fileName={profile.coverLetterFileName}
          value={profile.coverLetterText}
          placeholder="Paste a cover letter template. Groq will customise it for each job using the job description."
          inputRef={coverInputRef}
          onUpload={(f) => onFileUpload(f, "coverLetterText", "coverLetterFileName")}
          onChange={(v) => updateProfile("coverLetterText", v)}
          minHeight={120}
        />
      </div>

      {/* ── Groq API Key ── */}
      <div className="sectionHead">Groq API Key</div>
      <div style={{ padding: "14px", display: "flex", flexDirection: "column", gap: 10 }}>
        <p className="help" style={{ marginTop: 0 }}>
          Required for AI field filling. Stored securely in the OS keyring.
          Get a free key at{" "}
          <a href="https://console.groq.com" target="_blank" rel="noreferrer" style={{ color: "rgba(10,132,255,0.9)" }}>
            console.groq.com
          </a>.
        </p>

        {apiKeySet && (
          <div style={{
            display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 10,
            background: "rgba(30,215,96,0.08)", border: "1px solid rgba(30,215,96,0.25)",
            fontSize: 12, color: "rgba(30,215,96,0.9)",
          }}>
            <span>✓</span>
            <span>API key stored. Enter a new key below to replace it.</span>
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
            disabled={apiKeySaving || !apiKeyInput.trim()}
          >
            {apiKeySaving ? "Saving…" : "Save key"}
          </button>
        </div>

        {apiKeyError && (
          <div style={{ fontSize: 12, color: "rgba(255,69,58,0.9)" }}>{apiKeyError}</div>
        )}
      </div>
    </div>
  );
}

// ─── Document field (resume / cover letter) ───────────────────────────────────

function DocumentField({
  label,
  fileName,
  value,
  placeholder,
  inputRef,
  onUpload,
  onChange,
  minHeight,
}: {
  label: string;
  fileName: string;
  value: string;
  placeholder: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onUpload: (file: File) => void;
  onChange: (val: string) => void;
  minHeight: number;
}) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
        {fileName && (
          <span style={{
            fontSize: 11, color: "rgba(30,215,96,0.8)", padding: "2px 8px",
            borderRadius: 999, border: "1px solid rgba(30,215,96,0.3)",
          }}>
            {fileName}
          </span>
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".txt,.md"
          style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); }}
        />
        <button
          className="btn miniBtn"
          style={{ marginLeft: "auto" }}
          onClick={() => inputRef.current?.click()}
        >
          Upload .txt
        </button>
      </div>
      <textarea
        className="atsTextarea"
        style={{ minHeight }}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}