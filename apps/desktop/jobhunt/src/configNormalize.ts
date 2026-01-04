import type { EngineConfig, Rule, Penalty } from "./api";

function asStringArray(v: any): string[] {
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string");
  return [];
}

function asInt(v: any, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeRule(r: any): Rule {
  return {
    tag: typeof r?.tag === "string" ? r.tag : "",
    weight: asInt(r?.weight, 0),
    any: asStringArray(r?.any).length ? asStringArray(r?.any) : [""],
  };
}

function normalizePenalty(p: any): Penalty {
  return {
    reason: typeof p?.reason === "string" ? p.reason : "",
    weight: asInt(p?.weight, 0),
    any: asStringArray(p?.any).length ? asStringArray(p?.any) : [""],
  };
}

export function normalizeConfig(raw: any): EngineConfig {
  // Start from a safe default shape
  const cfg: EngineConfig = {
    app: { port: 38471, data_dir: "." },
    polling: { email_seconds: 60, fast_lane_seconds: 60, normal_lane_seconds: 300 },
    filters: { remote_ok: true, locations_allow: [], locations_block: [] },
    scoring: { notify_min_score: 0, title_rules: [], keyword_rules: [], penalties: [] },
  };

  cfg.app.port = asInt(raw?.app?.port, cfg.app.port);
  cfg.app.data_dir = typeof raw?.app?.data_dir === "string" ? raw.app.data_dir : cfg.app.data_dir;

  cfg.polling.email_seconds = asInt(raw?.polling?.email_seconds, cfg.polling.email_seconds);
  cfg.polling.fast_lane_seconds = asInt(raw?.polling?.fast_lane_seconds, cfg.polling.fast_lane_seconds);
  cfg.polling.normal_lane_seconds = asInt(raw?.polling?.normal_lane_seconds, cfg.polling.normal_lane_seconds);

  cfg.filters.remote_ok = !!raw?.filters?.remote_ok;
  cfg.filters.locations_allow = asStringArray(raw?.filters?.locations_allow);
  cfg.filters.locations_block = asStringArray(raw?.filters?.locations_block);

  cfg.scoring.notify_min_score = asInt(raw?.scoring?.notify_min_score, 0);

  const tr = Array.isArray(raw?.scoring?.title_rules) ? raw.scoring.title_rules : [];
  const kr = Array.isArray(raw?.scoring?.keyword_rules) ? raw.scoring.keyword_rules : [];
  const pe = Array.isArray(raw?.scoring?.penalties) ? raw.scoring.penalties : [];

  cfg.scoring.title_rules = tr.map(normalizeRule);
  cfg.scoring.keyword_rules = kr.map(normalizeRule);
  cfg.scoring.penalties = pe.map(normalizePenalty);

  return cfg;
}
