import { useRef, useEffect, useMemo, useState } from "react";
import { EngineConfig, getConfig, putConfig, getScrapeStatus, runScrape, ScrapeStatus, setImapPassword, searchCompanies, discoverCompanies, extractCompaniesFromText, CompanyResult } from "./api";
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

// Shared results list used by all three discovery tabs
function ResultsList({ results, addedSlugs, onAdd }: {
  results: CompanyResult[];
  addedSlugs: Set<string>;
  onAdd: (r: CompanyResult) => void;
}) {
  if (results.length === 0) return null;
  return (
    <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6, maxHeight: 400, overflowY: "auto" }}>
      {results.map((r) => {
        const key = r.ats + ":" + r.slug;
        const added = addedSlugs.has(key);
        return (
          <div key={key} style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "8px 12px", borderRadius: 10,
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
          }}>
            <span style={{
              fontSize: 10, padding: "2px 7px", borderRadius: 999, flexShrink: 0,
              background: r.ats === "greenhouse" ? "#1D9E75" : "#0A84FF",
              color: "white", fontWeight: 600,
            }}>
              {r.ats}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.name}
              </div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", fontFamily: "monospace" }}>
                {r.slug}
              </div>
            </div>
            <a href={r.jobUrl} target="_blank" rel="noreferrer"
              style={{ fontSize: 12, color: "rgba(10,132,255,0.9)", textDecoration: "none", flexShrink: 0 }}>
              View ↗
            </a>
            <button className="btn miniBtn" style={{
              flexShrink: 0,
              background: added ? "rgba(30,215,96,0.12)" : undefined,
              color: added ? "rgba(30,215,96,0.8)" : undefined,
              border: added ? "1px solid rgba(30,215,96,0.3)" : undefined,
            }} onClick={() => !added && onAdd(r)} disabled={added}>
              {added ? "✓ Added" : "Add"}
            </button>
          </div>
        );
      })}
    </div>
  );
}

export default function Scraping({ onBack }: { onBack: () => void }) {
  const [cfg, setCfg] = useState<EngineConfig | null>(null);
  const [st, setSt] = useState<ScrapeStatus | null>(null);

  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [pw, setPw] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [runningNow, setRunningNow] = useState(false);

  // company search / discover / extract
  const [companyTab, setCompanyTab] = useState<"search" | "discover" | "extract">("search");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchAts, setSearchAts] = useState<"greenhouse" | "lever" | "">("");
  const [searchResults, setSearchResults] = useState<CompanyResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchErr, setSearchErr] = useState("");
  const [addedSlugs, setAddedSlugs] = useState<Set<string>>(new Set());
  // discover
  const [discoverSource, setDiscoverSource] = useState<"greenhouse" | "lever">("lever");
  const [discoverKeyword, setDiscoverKeyword] = useState("");
  const [discoverResults, setDiscoverResults] = useState<CompanyResult[]>([]);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [discoverTotal, setDiscoverTotal] = useState(0);
  const [discoverErr, setDiscoverErr] = useState("");
  // extract
  const [extractText, setExtractText] = useState("");
  const [extractResults, setExtractResults] = useState<CompanyResult[]>([]);
  const [extractLoading, setExtractLoading] = useState(false);
  const [extractErr, setExtractErr] = useState("");

  // local textareas for ATS company lists (keeps typing smooth)
  const [ghText, setGhText] = useState("");
  const [leverText, setLeverText] = useState("");
  const [wdText, setWdText] = useState("");
  const [sRText, setSRText] = useState("");
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

  async function doDiscover() {
    setDiscoverLoading(true);
    setDiscoverErr("");
    setDiscoverResults([]);
    try {
      const res = await discoverCompanies(discoverSource, discoverKeyword || undefined);
      setDiscoverResults(res.results);
      setDiscoverTotal(res.total);
      if (res.results.length === 0) setDiscoverErr("No boards found. Try a different keyword or source.");
    } catch (e: any) {
      setDiscoverErr(String(e?.message ?? e));
    } finally {
      setDiscoverLoading(false);
    }
  }

  async function doExtract() {
    if (!extractText.trim()) return;
    setExtractLoading(true);
    setExtractErr("");
    setExtractResults([]);
    try {
      const results = await extractCompaniesFromText(extractText);
      setExtractResults(results);
      if (results.length === 0) setExtractErr("No Greenhouse or Lever URLs found in the text.");
    } catch (e: any) {
      setExtractErr(String(e?.message ?? e));
    } finally {
      setExtractLoading(false);
    }
  }

  async function doSearch() {
    if (searchQuery.trim().length < 2) return;
    setSearchLoading(true);
    setSearchErr("");
    setSearchResults([]);
    try {
      const results = await searchCompanies(searchQuery.trim(), searchAts || undefined);
      setSearchResults(results);
      if (results.length === 0) setSearchErr("No boards found. Try a shorter name or different spelling.");
    } catch (e: any) {
      setSearchErr(String(e?.message ?? e));
    } finally {
      setSearchLoading(false);
    }
  }

  function addCompany(result: CompanyResult) {
    const line = `${result.slug} | ${result.name}`;
    if (result.ats === "greenhouse") {
      setGhText(t => t ? t + "" + line : line);
    } else {
      setLeverText(t => t ? t + "" + line : line);
    }
    setAddedSlugs(s => { const next = new Set(s); next.add(result.ats + ":" + result.slug); return next; });
  }

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

      {/* Company Discovery Panel */}
      <div className="atsPanel" style={{ marginTop: 16 }}>
        <div className="atsHead">
          <div className="atsTitle">Discover Companies</div>
          <div className="atsHint">Find Greenhouse &amp; Lever boards you can add to your sources.</div>
        </div>

        {/* Tab bar */}
        <div style={{ display: "flex", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
          {(["search", "discover", "extract"] as const).map((t) => (
            <button key={t} onClick={() => setCompanyTab(t)} style={{
              padding: "9px 16px", fontSize: 12, border: "none", cursor: "pointer",
              background: companyTab === t ? "rgba(255,255,255,0.06)" : "transparent",
              color: companyTab === t ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.4)",
              borderBottom: companyTab === t ? "2px solid rgba(10,132,255,0.8)" : "2px solid transparent",
              fontWeight: companyTab === t ? 600 : 400,
            }}>
              {t === "search" ? "🔍 Search by name" : t === "discover" ? "🌐 Browse all" : "📋 Paste URLs"}
            </button>
          ))}
        </div>

        {/* ── Search tab ── */}
        {companyTab === "search" && (
          <div className="atsSection">
            <div className="help" style={{ marginBottom: 10 }}>
              Know a company name? Search to find their exact ATS slug.
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input
                className="input"
                style={{ flex: 1, minWidth: 180 }}
                placeholder="e.g. Stripe, Scale AI, Notion..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") doSearch(); }}
              />
              <select style={{ borderRadius: 10, padding: "8px 12px", background: "#1c1c1e",
                border: "1px solid rgba(255,255,255,0.12)", color: "rgba(255,255,255,0.92)",
                fontSize: 13, colorScheme: "dark" as any }}
                value={searchAts} onChange={(e) => setSearchAts(e.target.value as any)}>
                <option value="">Both</option>
                <option value="greenhouse">Greenhouse</option>
                <option value="lever">Lever</option>
              </select>
              <button className="btn btnPrimary" style={{ fontSize: 12, padding: "8px 16px" }}
                onClick={doSearch} disabled={searchLoading || searchQuery.trim().length < 2}>
                {searchLoading ? "Searching…" : "Search"}
              </button>
            </div>
            {searchErr && <div style={{ marginTop: 8, fontSize: 12, color: "rgba(255,69,58,0.9)" }}>{searchErr}</div>}
            <ResultsList results={searchResults} addedSlugs={addedSlugs} onAdd={addCompany} />
          </div>
        )}

        {/* ── Discover tab ── */}
        {companyTab === "discover" && (
          <div className="atsSection">
            <div className="help" style={{ marginBottom: 10 }}>
              <strong style={{ color: "rgba(255,255,255,0.7)" }}>Lever:</strong> Fetches the full Lever sitemap — every company currently posting jobs.{" "}
              <strong style={{ color: "rgba(255,255,255,0.7)" }}>Greenhouse:</strong> Probes ~300 known tech companies in parallel.
              Filter by keyword to narrow results.
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <select style={{ borderRadius: 10, padding: "8px 12px", background: "#1c1c1e",
                border: "1px solid rgba(255,255,255,0.12)", color: "rgba(255,255,255,0.92)",
                fontSize: 13, colorScheme: "dark" as any }}
                value={discoverSource} onChange={(e) => setDiscoverSource(e.target.value as any)}>
                <option value="lever">Lever (sitemap)</option>
                <option value="greenhouse">Greenhouse (probe)</option>
              </select>
              <input
                className="input"
                style={{ flex: 1, minWidth: 140 }}
                placeholder="Filter by keyword (optional)"
                value={discoverKeyword}
                onChange={(e) => setDiscoverKeyword(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") doDiscover(); }}
              />
              <button className="btn btnPrimary" style={{ fontSize: 12, padding: "8px 16px" }}
                onClick={doDiscover} disabled={discoverLoading}>
                {discoverLoading ? "Loading…" : "Discover"}
              </button>
            </div>
            {discoverErr && <div style={{ marginTop: 8, fontSize: 12, color: "rgba(255,69,58,0.9)" }}>{discoverErr}</div>}
            {discoverResults.length > 0 && (
              <div style={{ marginTop: 8, fontSize: 11, color: "rgba(255,255,255,0.35)" }}>
                Showing {discoverResults.length} of {discoverTotal} probed
              </div>
            )}
            <ResultsList results={discoverResults} addedSlugs={addedSlugs} onAdd={addCompany} />
          </div>
        )}

        {/* ── Extract tab ── */}
        {companyTab === "extract" && (
          <div className="atsSection">
            <div className="help" style={{ marginBottom: 10 }}>
              Paste anything — a job alert email, a webpage, a list of URLs. JobHunt will extract
              every Greenhouse and Lever company it finds.
            </div>
            <textarea
              className="atsTextarea"
              style={{ minHeight: 120 }}
              placeholder={"Paste emails, job board pages, or URLs here...\nhttps://boards.greenhouse.io/stripe\nhttps://jobs.lever.co/openai/abc-123"}
              value={extractText}
              onChange={(e) => setExtractText(e.target.value)}
            />
            <button className="btn btnPrimary" style={{ fontSize: 12, padding: "8px 16px", marginTop: 8 }}
              onClick={doExtract} disabled={extractLoading || !extractText.trim()}>
              {extractLoading ? "Extracting…" : "Extract companies"}
            </button>
            {extractErr && <div style={{ marginTop: 8, fontSize: 12, color: "rgba(255,69,58,0.9)" }}>{extractErr}</div>}
            <ResultsList results={extractResults} addedSlugs={addedSlugs} onAdd={addCompany} />
          </div>
        )}

        {(searchResults.length > 0 || discoverResults.length > 0 || extractResults.length > 0) && (
          <div style={{ padding: "6px 14px 10px", fontSize: 11, color: "rgba(255,255,255,0.3)" }}>
            Click Add to insert into the source lists below, then Save.
          </div>
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