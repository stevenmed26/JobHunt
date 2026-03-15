// src/FieldRows.tsx — editable field rows for the application review UI

import type { ApplicationField } from "./types";
import type { ScrapedField } from "./api";

// ─── Profile-seeded field row ─────────────────────────────────────────────────

const SOURCE_COLOR: Record<ApplicationField["source"], string> = {
  profile: "rgba(30,215,96,0.85)",
  ai:      "rgba(253,72,37,0.85)",
  manual:  "rgba(255,199,0,0.85)",
};
const SOURCE_LABEL: Record<ApplicationField["source"], string> = {
  profile: "profile",
  ai:      "groq",
  manual:  "edited",
};

export function FieldRow({
  field,
  onChange,
}: {
  field: ApplicationField;
  onChange: (val: string) => void;
}) {
  const isLong =
    field.value.length > 80 ||
    field.key.includes("cover") ||
    field.key.includes("letter") ||
    field.key.includes("why");

  return (
    <div style={{ padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", flex: 1 }}>
          {field.label}
          {field.required && <span style={{ color: "rgba(253,72,37,0.8)", marginLeft: 3 }}>*</span>}
        </span>
        <span style={{
          fontSize: 10, padding: "2px 7px", borderRadius: 999, letterSpacing: "0.03em",
          border: `1px solid ${SOURCE_COLOR[field.source]}`,
          color: SOURCE_COLOR[field.source],
        }}>
          {SOURCE_LABEL[field.source]}
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

// ─── Scraped field row ────────────────────────────────────────────────────────

function Pill({ color, label }: { color: string; label: string }) {
  return (
    <span style={{
      fontSize: 10, padding: "2px 7px", borderRadius: 999, letterSpacing: "0.03em", flexShrink: 0,
      border: `1px solid ${color}`, color,
    }}>
      {label}
    </span>
  );
}

export function ScrapedFieldRow({
  field,
  idx,
  onChange,
}: {
  field: ScrapedField;
  idx: number;
  onChange: (idx: number, val: string) => void;
}) {
  const isLong =
    field.type === "textarea" ||
    field.label.toLowerCase().includes("cover") ||
    field.label.toLowerCase().includes("why") ||
    (field.value?.length ?? 0) > 80;

  return (
    <div style={{ padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", flex: 1, minWidth: 0 }}>
          {field.label}
          {field.required && <span style={{ color: "rgba(253,72,37,0.8)", marginLeft: 3 }}>*</span>}
        </span>
        <Pill color="rgba(255,255,255,0.25)" label={field.type} />
        {field.value
          ? <Pill color="rgba(30,215,96,0.8)" label="groq" />
          : <Pill color="rgba(255,255,255,0.2)" label="empty" />
        }
      </div>

      {field.type === "file" ? (
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", fontStyle: "italic" }}>
          Resume file — injected automatically
        </div>
      ) : field.type === "select" || field.type === "react-select" ? (
        <select
          style={{
            width: "100%", borderRadius: 10, padding: "8px 12px", fontSize: 13,
            background: "#1c1c1e", border: "1px solid rgba(255,255,255,0.12)",
            color: "rgba(255,255,255,0.92)", colorScheme: "dark",
          }}
          value={field.value}
          onChange={(e) => onChange(idx, e.target.value)}
        >
          <option value="">— select —</option>
          {field.options.map((o) => (
            <option key={o.value} value={o.label}>{o.label}</option>
          ))}
          {/* Keep Groq's answer visible even if it's not in the scraped option list */}
          {field.value && !field.options.find((o) => o.label === field.value) && (
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