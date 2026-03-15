import { normalizeConfig } from "./configNormalize";

export const ENGINE_BASE = "http://127.0.0.1:38471";

export async function getJobs(qs?: string) {
  const r = await fetch(qs ? `${ENGINE_BASE}/jobs?${qs}` : "/jobs");
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function seedJob() {
  const res = await fetch(`${ENGINE_BASE}/seed`, { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export function events(onMessage: (data: any) => void) {
  const es = new EventSource(`${ENGINE_BASE}/events`);
  es.addEventListener("message", (ev) => {
    try {
      onMessage(JSON.parse((ev as MessageEvent).data));
    } catch {
      // ignore
    }
  });
  return () => es.close();
}

export type Rule = {
  tag: string;
  weight: number;
  any: string[];
};

export type Penalty = {
  reason: string;
  weight: number;
  any: string[];
};

export type EngineConfig = {
  app: { port: number; data_dir: string };
  polling: {
    email_seconds: number;
    fast_lane_seconds: number;
    normal_lane_seconds: number;
  };
  filters: {
    remote_ok: boolean;
    locations_allow: string[];
    locations_block: string[];
  };
  scoring: {
    notify_min_score: number;
    title_rules: Rule[];
    keyword_rules: Rule[];
    penalties: Penalty[];
  };
  email: EngineEmailConfig;
  sources: EngineSourcesConfig;
};

export async function getConfig(): Promise<EngineConfig> {
  const res = await fetch(`${ENGINE_BASE}/config`);
  if (!res.ok) throw new Error(await res.text());
  const raw = await res.json();
  return normalizeConfig(raw);
}

export async function putConfig(cfg: EngineConfig): Promise<EngineConfig> {
  const res = await fetch(`${ENGINE_BASE}/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cfg),
  });
  if (!res.ok) throw new Error(await res.text());
  const raw = await res.json();
  return normalizeConfig(raw);
}

export async function deleteJob(id: number) {
  const res = await fetch(`${ENGINE_BASE}/jobs/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// Returns the scraped job description HTML/text stored in the engine DB.
// Returns an empty string if the job has no description yet.
export async function getJobDescription(id: number): Promise<string> {
  const res = await fetch(`${ENGINE_BASE}/jobs/${id}/description`);
  if (!res.ok) return "";
  const data = await res.json();
  return data.description ?? "";
}

export type ScrapeStatus = {
  last_run_at: string;
  last_ok_at: string;
  last_error: string;
  last_added: number;
  running: boolean;
};

export async function getScrapeStatus(): Promise<ScrapeStatus> {
  const res = await fetch(`${ENGINE_BASE}/scrape/status`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function runScrape(): Promise<{ ok: boolean; msg?: string }> {
  const res = await fetch(`${ENGINE_BASE}/scrape/run`, { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export type EngineEmailConfig = {
  enabled: boolean;
  imap_host: string;
  imap_port: number;
  username: string;
  mailbox: string;
  search_subject_any: string[];
};

export type SourceCompany = {
  slug: string;
  name?: string;
};

export type EngineSourcesConfig = {
  greenhouse: { enabled: boolean; companies: SourceCompany[] };
  lever: { enabled: boolean; companies: SourceCompany[] };
  workday: { enabled: boolean; companies: SourceCompany[] };
  smartrecruiters: { enabled: boolean; companies: SourceCompany[] };
};

export async function setImapPassword(password: string) {
  const res = await fetch(`${ENGINE_BASE}/api/secrets/imap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new Error(await res.text());
}

// ─── Claude proxy (goes through engine to avoid Tauri CSP + keep key secure) ─

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ClaudeRequest {
  model?: string;
  max_tokens?: number;
  system?: string;
  messages: ClaudeMessage[];
}

export async function callClaude(req: ClaudeRequest): Promise<string> {
  const res = await fetch(`${ENGINE_BASE}/api/claude`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Claude proxy error: ${res.status}`);
  }
  const data = await res.json();
  return (data.content ?? [])
    .map((b: any) => b.text ?? "")
    .join("");
}

export async function setClaudeAPIKey(apiKey: string): Promise<void> {
  const res = await fetch(`${ENGINE_BASE}/api/secrets/claude`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey }),
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function getClaudeKeyStatus(): Promise<boolean> {
  const res = await fetch(`${ENGINE_BASE}/api/secrets/claude/status`);
  if (!res.ok) return false;
  const data = await res.json();
  return data.has_key === true;
}