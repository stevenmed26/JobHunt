import { useEffect, useState } from "react";
import { events, getJobs, seedJob } from "./api";
import { Command } from "@tauri-apps/plugin-shell";

async function startEngine() {
  try {
    const cmd = Command.sidecar("bin/engine");
    await cmd.spawn();
    console.log("Engine sidecar started");
  } catch (e) {
    console.error("Failed to start engine", e);
  }
}

function isTauri() {
  return "__TAURI_INTERNALS__" in window;
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
    if (isTauri()) {
      startEngine();
    }

    refresh();
    const stop = events((msg) => {
      if (msg?.type === "job_created") refresh();
    });
    return stop;
  }, []);

  return (
    <div style={{ fontFamily: "system-ui", padding: 16 }}>
      <h2 style={{ margin: 0 }}>JobHunt</h2>
      <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
        <button onClick={() => refresh()}>Refresh</button>
        <button onClick={() => seedJob().then(refresh).catch((e) => setErr(String(e)))}>
          Seed fake job
        </button>
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
