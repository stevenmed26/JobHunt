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

export default function Scraping({ onBack }: { onBack: () => void }) {
  const [cfg, setCfg] = useState<EngineConfig | null>(null);
  const [st, setSt] = useState<ScrapeStatus | null>(null);

  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [pw, setPw] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [runningNow, setRunningNow] = useState(false);

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
      // Don’t clobber main error if user is editing config;
      // but do show status failures if nothing else is happening.
      if (!err) setErr(String(e?.message ?? e));
    }
  }

  useEffect(() => {
    (async () => {
      try {
        setErr("");
        setCfg(normalizeConfig(await getConfig()));
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
      const saved = await putConfig(cfg);
      setCfg(normalizeConfig(saved));
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

                {status === "saving" && <div>Saving…</div>}
                {status === "saved" && <div>Saved to OS keychain.</div>}
                {status === "error" && <div style={{ whiteSpace: "pre-wrap" }}>Error: {err}</div>}
                
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
    </div>
  );
}


