import { useRef, useEffect, useMemo, useState } from "react";
import { EngineConfig, getConfig, putConfig, getScrapeStatus, runScrape, ScrapeStatus, setImapPassword } from "./api";
import { normalizeConfig } from "./configNormalize";

function cloneCfg(cfg: EngineConfig): EngineConfig {
  return normalizeConfig(JSON.parse(JSON.stringify(cfg)));
}

function fmt(ts?: string) {
  if (!ts) return "-";
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return ts;
    return d.toLocaleString();
  } catch {
    return ts ?? "-";
  }
}

// --- ATS helpers: textarea <-> companies list (minimal, inline-style friendly)
type SourceCompany = { slug: string; name?: string };

function companiesToText(list: SourceCompany[] | undefined): string {
  return (list ?? [])
    .map((c) => (c?.name ? `${c.slug} | ${c.name}` : c.slug))
    .join("\n");
}

function textToCompanies(text: string): SourceCompany[] {
  return (text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("|").map((p) => p.trim()).filter(Boolean);
      if (parts.length === 0) return null;
      if (parts.length === 1) return { slug: parts[0] };
      return { slug: parts[0], name: parts.slice(1).join(" | ") };
    })
    .filter((x): x is SourceCompany => !!x && !!x.slug);
}

export default function Scraping({ onBack }: { onBack: () => void }) {
  const [cfg, setCfg] = useState<EngineConfig | null>(null);
  const [st, setSt] = useState<ScrapeStatus | null>(null);

  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [pw, setPw] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [runningNow, setRunningNow] = useState(false);

  // local textareas for ATS company lists (keeps typing smooth)
  const [ghText, setGhText] = useState("");
  const [leverText, setLeverText] = useState("");
  const lastSavedRef = useRef<string>("");

  async function saveIfNeeded(next: string) {
    const trimmed = next.trim();

    if (!trimmed) return;

    if (trimmed === lastSavedRef.current) return;

    try {
      setStatus("saving");
      setErr("");
      await setImapPassword(trimmed);
      lastSavedRef.current = trimmed;

      setPw("");
      setStatus("saved");

      window.setTimeout(() => setStatus("idle"), 1500);
    } catch (e: any) {
      setStatus("error");
      setErr(typeof e?.message === "string" ? e.message : String(e));
    }
  }

  async function refreshStatus() {
    try {
      const s = await getScrapeStatus();
      setSt(s);
    } catch (e: any) {
      if (!err) setErr(String(e?.message ?? e));
    }
  }

  useEffect(() => {
    (async () => {
      try {
        setErr("");
        const c = normalizeConfig(await getConfig());
        setCfg(c);

        // initialize textarea content from config once loaded
        const s = (c as any).sources;
        setGhText(companiesToText(s?.greenhouse?.companies));
        setLeverText(companiesToText(s?.lever?.companies));
      } catch (e: any) {
        setErr(String(e?.message ?? e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // poll status
  useEffect(() => {
    refreshStatus();
    const t = setInterval(refreshStatus, 1200);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    if (!cfg) return;
    try {
      setSaving(true);
      setErr("");

      // Before save: sync textarea -> cfg.sources (minimal mutation)
      const c = cloneCfg(cfg) as any;
      c.sources = c.sources ?? {};
      c.sources.greenhouse = c.sources.greenhouse ?? { enabled: false, companies: [] };
      c.sources.lever = c.sources.lever ?? { enabled: false, companies: [] };
      c.sources.greenhouse.companies = textToCompanies(ghText);
      c.sources.lever.companies = textToCompanies(leverText);

      const saved = await putConfig(c);
      const norm = normalizeConfig(saved);
      setCfg(norm);

      // re-sync textareas from saved config (so formatting stays canonical)
      const s = (norm as any).sources;
      setGhText(companiesToText(s?.greenhouse?.companies));
      setLeverText(companiesToText(s?.lever?.companies));
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  async function runOnce() {
    try {
      setRunningNow(true);
      setErr("");
      const res = await runScrape();
      if (!res.ok) setErr(res.msg || "Scrape did not start");
      await refreshStatus();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setRunningNow(false);
    }
  }

  const email = useMemo(() => cfg?.email, [cfg]);
  const sources = useMemo(() => (cfg as any)?.sources, [cfg]);

  return (
    <div className="app">
      <div className="pageTop">
        <button className="btn" onClick={onBack}>
          Back
        </button>
        <h2>Scraping</h2>
        <div className="spacer" />

        <button className="btn btnPrimary" onClick={runOnce} disabled={runningNow || st?.running}>
          {(st?.running || runningNow) ? "Running…" : "Run now"}
        </button>

        <button className="btn" onClick={save} disabled={saving || !cfg}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {err && (
        <pre className="error" style={{ whiteSpace: "pre-wrap" }}>
          {err}
        </pre>
      )}

      <div className="settingsPanel">
        {/* Status */}
        <div className="sectionHead">Status</div>
        <div className="kv">
          <div className="k">Running</div>
          <div className="v">{String(st?.running ?? false)}</div>

          <div className="k">Last run</div>
          <div className="v">{fmt(st?.last_run_at)}</div>

          <div className="k">Last success</div>
          <div className="v">{fmt(st?.last_ok_at)}</div>

          <div className="k">Last added</div>
          <div className="v">{String(st?.last_added ?? 0)}</div>

          <div className="k">Last error</div>
          <div className={`v ${st?.last_error ? "bad" : ""}`}>{st?.last_error || "-"}</div>
        </div>

        <div className="rowLine" />

        {/* Email settings */}
        <div className="sectionHead">Email (IMAP)</div>

        {!cfg || !email ? (
          <div className="listBox">
            <div className="small">Loading config…</div>
          </div>
        ) : (
          <>
            <div className="checkRow">
              <input
                className="checkbox"
                type="checkbox"
                checked={email.enabled}
                onChange={(e) => {
                  const c = cloneCfg(cfg);
                  c.email.enabled = e.target.checked;
                  setCfg(c);
                }}
              />
              <div>Enabled</div>
            </div>

            <div className="rowLine" />

            <div className="formGrid">
              <div className="formLabel">IMAP Host</div>
              <input
                className="input"
                value={email.imap_host}
                onChange={(e) => {
                  const c = cloneCfg(cfg);
                  c.email.imap_host = e.target.value;
                  setCfg(c);
                }}
              />

              <div className="formLabel">IMAP Port</div>
              <input
                className="input"
                type="number"
                value={email.imap_port}
                onChange={(e) => {
                  const c = cloneCfg(cfg);
                  c.email.imap_port = Number(e.target.value);
                  setCfg(c);
                }}
              />

              <div className="formLabel">Mailbox</div>
              <input
                className="input"
                value={email.mailbox}
                onChange={(e) => {
                  const c = cloneCfg(cfg);
                  c.email.mailbox = e.target.value;
                  setCfg(c);
                }}
              />

              <div className="formLabel">Username</div>
              <input
                className="input"
                value={email.username}
                onChange={(e) => {
                  const c = cloneCfg(cfg);
                  c.email.username = e.target.value;
                  setCfg(c);
                }}
              />

              <div className="formLabel">App Password</div>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  className="input"
                  type="password"
                  value={pw}
                  placeholder="Enter app password"
                  onChange={(e) => setPw(e.target.value)}
                  onBlur={(e) => saveIfNeeded(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      // Use current state value (or e.currentTarget.value)
                      void saveIfNeeded(pw);
                    }
                  }}
                />

                {status === "saving" && <div className="small">Saving…</div>}
                {status === "saved" && <div className="small">Saved to OS keychain.</div>}
                {status === "error" && <div className="small" style={{ whiteSpace: "pre-wrap" }}>Error: {err}</div>}
                
              </div>
            </div>

            <div className="rowLine" />

            <div className="listBox">
              <div className="formLabel">Subject contains any of</div>
              <div className="help">Leave empty to scan broadly; start narrow for MVP.</div>

              <div className="listStack">
                {(email.search_subject_any ?? []).map((v, i) => (
                  <div key={i} className="listItem">
                    <input
                      className="input"
                      value={v}
                      onChange={(e) => {
                        const c = cloneCfg(cfg);
                        c.email.search_subject_any[i] = e.target.value;
                        setCfg(c);
                      }}
                    />
                    <button
                      className="btn miniBtn"
                      onClick={() => {
                        const c = cloneCfg(cfg);
                        c.email.search_subject_any.splice(i, 1);
                        setCfg(c);
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>

              <button
                className="btn miniBtn"
                style={{ marginTop: 10 }}
                onClick={() => {
                  const c = cloneCfg(cfg);
                  c.email.search_subject_any = c.email.search_subject_any ?? [];
                  c.email.search_subject_any.push("");
                  setCfg(c);
                }}
              >
                Add filter
              </button>
            </div>
          </>
        )}
      </div>

      {/* ATS Sources (Greenhouse / Lever) */}
      <div className="atsPanel">
        <div className="atsHead">
          <div className="atsTitle">ATS Sources</div>
          <div className="atsHint">
            One per line: <code>slug</code> or <code>slug | Display Name</code>
          </div>
        </div>

        {!cfg ? (
          <div className="listBox">
            <div className="small">Loading config…</div>
          </div>
        ) : (
          <>
            {/* Greenhouse */}
            <div className="atsSection">
              <div className="atsRowTop">
                <div className="atsName">Greenhouse</div>
                <div className="spacer" />
                <label className="checkInline">
                  <input
                    className="checkbox"
                    type="checkbox"
                    checked={!!sources?.greenhouse?.enabled}
                    onChange={(e) => {
                      const c = cloneCfg(cfg) as any;
                      c.sources = c.sources ?? {};
                      c.sources.greenhouse = c.sources.greenhouse ?? { enabled: false, companies: [] };
                      c.sources.greenhouse.enabled = e.target.checked;
                      setCfg(c);
                    }}
                  />
                  Enabled
                </label>
              </div>

              <div className="help">
                Example: <code>boards.greenhouse.io/stripe</code> → slug <code>stripe</code>
              </div>

              <textarea
                className="atsTextarea"
                value={ghText}
                onChange={(e) => setGhText(e.target.value)}
                placeholder={"stripe | Stripe\ncoinbase | Coinbase"}
              />
            </div>

            {/* Lever */}
            <div className="atsSection">
              <div className="atsRowTop">
                <div className="atsName">Lever</div>
                <div className="spacer" />
                <label className="checkInline">
                  <input
                    className="checkbox"
                    type="checkbox"
                    checked={!!sources?.lever?.enabled}
                    onChange={(e) => {
                      const c = cloneCfg(cfg) as any;
                      c.sources = c.sources ?? {};
                      c.sources.lever = c.sources.lever ?? { enabled: false, companies: [] };
                      c.sources.lever.enabled = e.target.checked;
                      setCfg(c);
                    }}
                  />
                  Enabled
                </label>
              </div>

              <div className="help">
                Example: <code>jobs.lever.co/airtable</code> → slug <code>airtable</code>
              </div>

              <textarea
                className="atsTextarea"
                value={leverText}
                onChange={(e) => setLeverText(e.target.value)}
                placeholder={"airtable | Airtable\nzapier | Zapier"}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
