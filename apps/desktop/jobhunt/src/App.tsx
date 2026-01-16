// App.tsx
import { useEffect, useMemo, useState } from "react";
import { events, getJobs, seedJob, deleteJob } from "./api";
import Preferences from "./Preferences";
import Scraping from "./Scraping";
import Select from "./ui/Select";
import { Command } from "@tauri-apps/plugin-shell";

async function startEngineDebug() {
  const cmd = Command.sidecar("engine");
  cmd.stdout.on("data", (line) => console.log("[engine stdout]", line));
  cmd.stderr.on("data", (line) => console.error("[engine stderr]", line));
  cmd.on("close", (e) => console.error("[engine closed]", e));
  await cmd.spawn();
}

type Job = {
  id: number;
  company: string;
  title: string;
  location: string;
  workMode: string;
  url: string;
  score: number;
  tags: string[];
  date: string;
  companyLogoURL?: string;
};

type SortKey = "score" | "date" | "company" | "title";
type WindowKey = "24h" | "7d" | "all";

export default function App() {
  const DEV_TOOLS = import.meta.env.DEV;

  const [sort, setSort] = useState<SortKey>("score");
  const [windowKey, setWindowKey] = useState<WindowKey>("7d");

  const [view, setView] = useState<"jobs" | "prefs" | "scrape">("jobs");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [err, setErr] = useState<string>("");

  const params = useMemo(() => {
    const p = new URLSearchParams({ sort, window: windowKey });
    return p.toString();
  }, [sort, windowKey]);

  async function refresh() {
    try {
      setErr("");
      const data = await getJobs(params);
      setJobs(Array.isArray(data) ? data : []);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      setJobs([]);
    }
  }

  useEffect(() => {
    startEngineDebug().catch(console.error);
  }, []);

  useEffect(() => {
    refresh();
    const stop = events((msg) => {
      if (msg?.type === "job_created" || msg?.type === "job_deleted") refresh();
    });
    return stop;
  }, [params]);

  if (view === "prefs") return <Preferences onBack={() => setView("jobs")} />;
  if (view === "scrape") return <Scraping onBack={() => setView("jobs")} />;

  return (
  <div className="app">
    <div className="topbar">
      <div className="brand">
        <h1>JobHunt</h1>
      </div>

      <div className="toolbar">
        <button className="btn btnPrimary" onClick={() => refresh()}>Refresh</button>
        {DEV_TOOLS && (<button className="btn" onClick={() => seedJob().then(refresh).catch((e) => setErr(String(e)))}>
          Seed
        </button>
        )}
        <button className="btn" onClick={() => setView("prefs")}>Preferences</button>
        <button className="btn" onClick={() => setView("scrape")}>Scraping</button>
      </div>
    </div>

    <div className="toolbarRow">
      <div className="tool">
        <div className="toolLabel">Sort</div>
        <Select
          value={sort}
          onChange={setSort}
          options={[
            { value: "score", label: "Score" },
            { value: "date", label: "Date" },
            { value: "company", label: "Company" },
            { value: "title", label: "Title" },
          ]}
          width={200}
        />
      </div>

      <div className="tool">
        <div className="toolLabel">Time</div>
        <Select
          value={windowKey}
          onChange={setWindowKey}
          options={[
            { value: "24h", label: "Last 24 hours" },
            { value: "7d", label: "Last week" },
            { value: "all", label: "All time" },
          ]}
          width={200}
        />
      </div>
    </div>

    {err && (
      <div className="error">
        Engine not reachable yet? ({err})
        <div className="small">Expected: http://127.0.0.1:38471/health</div>
      </div>
    )}

    <div className="panel">
      {jobs.length === 0 && <div style={{ padding: 14 }} className="small">No jobs yet.</div>}

      {jobs.map((j) => {
        const logoSrc =
          j.companyLogoURL && j.companyLogoURL.startsWith("/")
            ? `http://127.0.0.1:38471${j.companyLogoURL}`
            : j.companyLogoURL;

        return (
          <div key={j.id} className="listRow">
            <div className="logo">
              {logoSrc ? (
                <img
                  src={logoSrc}
                  alt={j.company}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  crossOrigin="anonymous"
                  onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
                />
              ) : null}
            </div>

            <div className="jobMain">
              <p className="jobTitle" title={j.title}>{j.title}</p>
              <div className="jobMeta">
                <span>{j.company}</span><span className="dot">·</span>
                <span>{j.location}</span><span className="dot">·</span>
                <span>{j.workMode}</span><span className="dot">·</span>
                <span>score {j.score}</span>
              </div>

              {!!j.tags?.length && (
                <div className="tags">
                  {j.tags.slice(0, 6).map((t) => (
                    <span key={t} className="tag">{t}</span>
                  ))}
                </div>
              )}
            </div>

            <div className="actions">
              <a className="link" href={j.url} target="_blank" rel="noreferrer">Apply</a>
              <button
                className="iconBtn"
                onClick={() => {
                  if (!confirm(`Remove "${j.title}"?`)) return;
                  deleteJob(j.id).then(refresh).catch((e) => setErr(String(e)));
                }}
                title="Remove"
                aria-label={`Remove ${j.title}`}
              >
                ×
              </button>
            </div>
          </div>
        );
      })}
    </div>
  </div>
);
}