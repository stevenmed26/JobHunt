import { useEffect, useState } from "react";
import { events, getJobs, seedJob, deleteJob } from "./api";
import Preferences from "./Preferences";
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
  firstSeen: string;
};

export default function App() {
  const [view, setView] = useState<"jobs" | "prefs">("jobs");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [err, setErr] = useState<string>("");

  async function refresh() {
    try {
      setErr("");
      const data = await getJobs();

      // HARD GUARANTEE jobs is always an array
      setJobs(Array.isArray(data) ? data : []);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      setJobs([]); // also ensure array on error
    }
  }


  useEffect(() => {
    startEngineDebug()

    refresh();
    const stop = events((msg) => {
      if (msg?.type === "job_created" || msg?.type === "job_deleted") refresh();
    });
    return stop;
  }, []);

  if (view === "prefs") {
    return <Preferences onBack={() => setView("jobs")} />;
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
        {jobs.map((j) => (
          <div
            key={j.id}
            style={{
              padding: 12,
              border: "1px solid #ddd",
              borderRadius: 10,
              marginBottom: 10,
            }}
          >
            <button
              onClick={() => {
                if (!confirm(`Remove "${j.title}"?`)) return;
                deleteJob(j.id).then(refresh).catch((e) => setErr(String(e)))
              }}
            >Remove</button>
            <div style={{ fontWeight: 700 }}>{j.title}</div>
            <div style={{ opacity: 0.85 }}>
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
                first seen: {j.firstSeen}
              </span>
            </div>
          </div>
        ))}
        {jobs.length === 0 && (
          <div style={{ opacity: 0.7 }}>
            No jobs yet. Click “Seed fake job”.
          </div>
        )}
      </div>
    </div>
  );
}
