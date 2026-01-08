import { useEffect, useMemo, useState } from "react";
import { events, getJobs, seedJob, deleteJob } from "./api";
import Preferences from "./Preferences";
import Scraping from "./Scraping";
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
  const [sort, setSort] = useState<SortKey>("score");
  const [windowKey, setWindowKey] = useState<WindowKey>("7d");

  const [view, setView] = useState<"jobs" | "prefs" | "scrape">("jobs");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [err, setErr] = useState<string>("");

  async function refresh() {
    try {
      setErr("");
      const data = await getJobs(params);

      // HARD GUARANTEE jobs is always an array
      setJobs(Array.isArray(data) ? data : []);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      setJobs([]); // also ensure array on error
    }
  }

  useEffect(() => {
    startEngineDebug().catch(console.error);
  }, []);

  const params = useMemo(() => {
    const p = new URLSearchParams({
      sort,
      window: windowKey,
    });
    return p.toString();
  }, [sort, windowKey]);


  useEffect(() => {

    refresh();
    const stop = events((msg) => {
      if (msg?.type === "job_created" || msg?.type === "job_deleted") refresh();
    });
    return stop;
  }, [params]);

  if (view === "prefs") {
    return <Preferences onBack={() => setView("jobs")} />;
  }
  if (view === "scrape") {
    return <Scraping onBack={() => setView("jobs")} />;
  }

  return (
    <div style={{ fontFamily: "system-ui", padding: 16 }}>
      <h2 style={{ margin: 0 }}>JobHunt</h2>
      <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
        <button onClick={() => refresh()}>Refresh</button>
        <button onClick={() => seedJob().then(refresh).catch((e) => setErr(String(e)))}>
          Seed fake job
        </button>
        <button onClick={() => setView("prefs")}>Preferences</button>
        <button onClick={() => setView("scrape")}>Scraping</button>
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 12 }}>
        <label>
          Sort{" "}
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            <option value="score">Score</option>
            <option value="date">Date</option>
            <option value="company">Company</option>
            <option value="title">Title</option>
          </select>
        </label>

        <label>
          Time{" "}
          <select value={windowKey} onChange={(e) => setWindowKey(e.target.value as WindowKey)}>
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last week</option>
            <option value="all">All</option>
          </select>
        </label>
      </div>

      {err && (
        <div style={{ marginTop: 12, color: "crimson" }}>
          Engine not reachable yet? ({err})
          <div style={{ fontSize: 12 }}>
            The engine should be at http://127.0.0.1:38471/health
          </div>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        {jobs.length === 0 && <div>No jobs yet.</div>}
        {jobs.map((j) => {
          const logoSrc =
            j.companyLogoURL && j.companyLogoURL.startsWith("/")
              ? `http://127.0.0.1:38471${j.companyLogoURL}`
              : j.companyLogoURL;
          return (
            <div
              key={j.id}
              style={{
                padding: 12,
                border: "1px solid #ddd",
                borderRadius: 10,
                marginBottom: 10,
              }}
            >
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                {/* logo column */}
                <div style={{ width: 84, height: 84, flex: "0 0 48px", display: "flex", alignItems: "center", justifyContent: "center", }}>
                  {j.companyLogoURL ? (
                    <img
                      src={logoSrc}
                      alt={j.company}
                      style={{
                        width: 64,
                        height: 64,
                        borderRadius: 8,
                        objectFit: "contain",
                        background: "#eee",
                        display: "block",
                      }}
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      crossOrigin="anonymous"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = "none";
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        width: 64,
                        height: 64,
                        borderRadius: 8,
                        background: "#f3f3f3",
                      }}
                    />
                  )}
                </div>

                {/* existing content column */}
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                    <div style={{ fontWeight: 700 }}>{j.title}</div>

                    <button
                      onClick={() => {
                        if (!confirm(`Remove "${j.title}"?`)) return;
                        deleteJob(j.id).then(refresh).catch((e) => setErr(String(e)));
                      }}
                      aria-label={`Remove ${j.title}`}
                      title="Remove"
                      style={{
                        border: "none",
                        background: "transparent",
                        cursor: "pointer",
                        fontSize: 24,         // “large cross”
                        lineHeight: 1,
                        padding: 4,
                        opacity: 0.65,
                      }}
                    >
                      ×
                    </button>
                  </div>


                  <div style={{ opacity: 0.75 }}>
                    {j.company} · {j.location} · {j.workMode} · score {j.score}
                  </div>

                  <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {j.tags?.map((t) => (
                      <span
                        key={t}
                        style={{
                          fontSize: 12,
                          padding: "2px 8px",
                          border: "1px solid #ccc",
                          borderRadius: 999,
                        }}
                      >
                        {t}
                      </span>
                    ))}
                  </div>

                  <div style={{ marginTop: 8 }}>
                    <a href={j.url} target="_blank" rel="noreferrer">
                      Apply
                    </a>
                    <span style={{ marginLeft: 12, fontSize: 12, opacity: 0.75 }}>
                      Date: {j.date}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
