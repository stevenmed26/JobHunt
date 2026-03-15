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

// ─── LLM proxy (Groq — goes through engine to avoid Tauri CSP + keep key secure) ─

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LLMRequest {
  system?: string;
  max_tokens?: number;
  messages: LLMMessage[];
}

// Calls the engine's /api/llm proxy which forwards to Groq.
// Returns the raw text content from the model.
export async function callLLM(req: LLMRequest): Promise<string> {
  const res = await fetch(`${ENGINE_BASE}/api/llm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `LLM proxy error: ${res.status}`);
  }
  const data = await res.json();
  // Engine normalizes Groq response to { text: "..." }
  return data.text ?? "";
}

export async function setGroqAPIKey(apiKey: string): Promise<void> {
  const res = await fetch(`${ENGINE_BASE}/api/secrets/groq`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey }),
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function getGroqKeyStatus(): Promise<boolean> {
  const res = await fetch(`${ENGINE_BASE}/api/secrets/groq/status`);
  if (!res.ok) return false;
  const data = await res.json();
  return data.has_key === true;
}

// ─── Apply — two-phase scrape + fill ─────────────────────────────────────────

// A field scraped from the real ATS form by filler.js --scrape
export interface ScrapedField {
  selector: string;       // exact CSS selector from the live DOM
  label: string;          // human-readable label text
  type: string;           // text|email|tel|select|textarea|file|react-select
  required: boolean;
  options: { value: string; label: string }[];  // for select/react-select
  value: string;          // filled in by Groq, editable by user
  isFile?: boolean;
  isReactSelect?: boolean;
}

// Phase 1: scrape the form fields from the live URL
export async function scrapeForm(jobId: number, url: string, atsType: string): Promise<ScrapedField[]> {
  const res = await fetch(`${ENGINE_BASE}/api/apply/scrape`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId, url, atsType }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Scrape error: ${res.status}`);
  }
  const data = await res.json();
  return data.fields as ScrapedField[];
}

// Phase 2: fill the form using exact selectors + reviewed values
export interface FillRequest {
  jobId: number;
  url: string;
  resumePdfPath?: string;
  resumeText?: string;
  fields: ScrapedField[];
}

export async function fillForm(req: FillRequest): Promise<{ ok: boolean; pid?: number }> {
  const res = await fetch(`${ENGINE_BASE}/api/apply/fill`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Fill error: ${res.status}`);
  }
  return res.json();
}