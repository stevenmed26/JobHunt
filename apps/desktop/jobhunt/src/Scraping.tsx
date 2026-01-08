import { useEffect, useMemo, useState } from "react";
import { EngineConfig, getConfig, putConfig, getScrapeStatus, runScrape, ScrapeStatus } from "./api";
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
  const [showPw, setShowPw] = useState(false);
  const [runningNow, setRunningNow] = useState(false);

  // local textareas for ATS company lists (keeps typing smooth)
  const [ghText, setGhText] = useState("");
  const [leverText, setLeverText] = useState("");

  async function refreshStatus() {
    try {
      const s = await getScrapeStatus();
      setSt(s);
    } catch (e: any) {
      // Don’t clobber main error if user is editing config;
      // but do show status failures if nothing else is happening.
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
      if (!res.ok) {
        setErr(res.msg || "Scrape did not start");
      }
      // status will update via polling, but refresh immediately too:
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
    <div style={{ fontFamily: "system-ui", padding: 16, maxWidth: 1000 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button onClick={onBack}>Back</button>
        <h2 style={{ margin: 0 }}>Scraping</h2>
        <div style={{ flex: 1 }} />

        <button onClick={runOnce} disabled={runningNow || st?.running}>
          {(st?.running || runningNow) ? "Running…" : "Run now"}
        </button>

        <button onClick={save} disabled={saving || !cfg}>
          {saving ? "Saving…" : "Save email settings"}
        </button>
      </div>

      {err && (
        <pre style={{ marginTop: 12, color: "crimson", whiteSpace: "pre-wrap" }}>
          {err}
        </pre>
      )}

      {/* Status */}
      <div style={{ marginTop: 16, border: "1px solid #ddd", borderRadius: 10, padding: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontWeight: 700 }}>Status</div>
          <div style={{ opacity: 0.75, fontSize: 12 }}>
            auto-refreshing
          </div>
          <div style={{ flex: 1 }} />
          <button onClick={refreshStatus}>Refresh</button>
        </div>

        <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "140px 1fr", gap: 8 }}>
          <div>Running</div>
          <div>{String(st?.running ?? false)}</div>

          <div>Last run</div>
          <div>{fmt(st?.last_run_at)}</div>

          <div>Last success</div>
          <div>{fmt(st?.last_ok_at)}</div>

          <div>Last added</div>
          <div>{String(st?.last_added ?? 0)}</div>

          <div>Last error</div>
          <div style={{ color: st?.last_error ? "crimson" : "inherit" }}>
            {st?.last_error || "-"}
          </div>
        </div>
      </div>

      {/* Email settings */}
      <div style={{ marginTop: 16, border: "1px solid #ddd", borderRadius: 10, padding: 12 }}>
        <div style={{ fontWeight: 700 }}>Email (IMAP)</div>

        {!cfg || !email ? (
          <div style={{ marginTop: 8, opacity: 0.7 }}>Loading config…</div>
        ) : (
          <>
            <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
              <input
                type="checkbox"
                checked={email.enabled}
                onChange={(e) => {
                  const c = cloneCfg(cfg);
                  c.email.enabled = e.target.checked;
                  setCfg(c);
                }}
              />
              Enabled
            </label>

            <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "140px 1fr", gap: 10 }}>
              <div>IMAP Host</div>
              <input
                value={email.imap_host}
                onChange={(e) => {
                  const c = cloneCfg(cfg);
                  c.email.imap_host = e.target.value;
                  setCfg(c);
                }}
              />

              <div>IMAP Port</div>
              <input
                type="number"
                value={email.imap_port}
                onChange={(e) => {
                  const c = cloneCfg(cfg);
                  c.email.imap_port = Number(e.target.value);
                  setCfg(c);
                }}
              />

              <div>Mailbox</div>
              <input
                value={email.mailbox}
                onChange={(e) => {
                  const c = cloneCfg(cfg);
                  c.email.mailbox = e.target.value;
                  setCfg(c);
                }}
              />

              <div>Username</div>
              <input
                value={email.username}
                onChange={(e) => {
                  const c = cloneCfg(cfg);
                  c.email.username = e.target.value;
                  setCfg(c);
                }}
              />

              <div>App Password</div>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  type={showPw ? "text" : "password"}
                  value={email.app_password}
                  onChange={(e) => {
                    const c = cloneCfg(cfg);
                    c.email.app_password = e.target.value;
                    setCfg(c);
                  }}
                  style={{ flex: 1 }}
                />
                <button onClick={() => setShowPw((v) => !v)}>{showPw ? "Hide" : "Show"}</button>
              </div>
            </div>

            <div style={{ marginTop: 14 }}>
              <div style={{ fontWeight: 600 }}>Subject contains any of</div>
              <div style={{ opacity: 0.75, fontSize: 12 }}>
                Leave empty to scan broadly; start narrow for MVP.
              </div>

              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                {(email.search_subject_any ?? []).map((v, i) => (
                  <div key={i} style={{ display: "flex", gap: 8 }}>
                    <input
                      value={v}
                      onChange={(e) => {
                        const c = cloneCfg(cfg);
                        c.email.search_subject_any[i] = e.target.value;
                        setCfg(c);
                      }}
                      style={{ flex: 1 }}
                    />
                    <button
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
                onClick={() => {
                  const c = cloneCfg(cfg);
                  c.email.search_subject_any = c.email.search_subject_any ?? [];
                  c.email.search_subject_any.push("");
                  setCfg(c);
                }}
                style={{ marginTop: 6 }}
              >
                Add filter
              </button>
            </div>
          </>
        )}
      </div>

      {/* ATS Sources (Greenhouse / Lever) */}
      <div style={{ marginTop: 16, border: "1px solid #ddd", borderRadius: 10, padding: 12 }}>
        <div style={{ fontWeight: 700 }}>ATS Sources</div>
        <div style={{ marginTop: 6, opacity: 0.75, fontSize: 12 }}>
          One per line: <code>slug</code> or <code>slug | Display Name</code>
        </div>

        {!cfg ? (
          <div style={{ marginTop: 8, opacity: 0.7 }}>Loading config…</div>
        ) : (
          <>
            {/* Greenhouse */}
            <div style={{ marginTop: 12 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <div style={{ fontWeight: 600 }}>Greenhouse</div>
                <div style={{ flex: 1 }} />
                <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
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

              <div style={{ marginTop: 6, opacity: 0.75, fontSize: 12 }}>
                Example: <code>boards.greenhouse.io/stripe</code> → slug <code>stripe</code>
              </div>

              <textarea
                value={ghText}
                onChange={(e) => setGhText(e.target.value)}
                placeholder={"stripe | Stripe\ncoinbase | Coinbase"}
                style={{
                  width: "100%",
                  marginTop: 8,
                  minHeight: 88,
                  border: "1px solid #ccc",
                  borderRadius: 10,
                  padding: 10,
                  fontSize: 12,
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                }}
              />
            </div>

            {/* Lever */}
            <div style={{ marginTop: 14 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <div style={{ fontWeight: 600 }}>Lever</div>
                <div style={{ flex: 1 }} />
                <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
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

              <div style={{ marginTop: 6, opacity: 0.75, fontSize: 12 }}>
                Example: <code>jobs.lever.co/airtable</code> → slug <code>airtable</code>
              </div>

              <textarea
                value={leverText}
                onChange={(e) => setLeverText(e.target.value)}
                placeholder={"airtable | Airtable\nzapier | Zapier"}
                style={{
                  width: "100%",
                  marginTop: 8,
                  minHeight: 88,
                  border: "1px solid #ccc",
                  borderRadius: 10,
                  padding: 10,
                  fontSize: 12,
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                }}
              />
            </div>

            <div style={{ marginTop: 10, opacity: 0.75, fontSize: 12 }}>
              Note: company lists are saved when you click <b>Save email settings</b> (we’ll rename this later).
            </div>
          </>
        )}
      </div>
    </div>
  );
}
