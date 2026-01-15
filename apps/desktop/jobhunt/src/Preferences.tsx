// src/Preferences.tsx
import { useEffect, useState } from "react";
import { EngineConfig, getConfig, putConfig, Rule, Penalty } from "./api";
import { normalizeConfig } from "./configNormalize";

function cloneCfg(cfg: EngineConfig): EngineConfig {
  return normalizeConfig(JSON.parse(JSON.stringify(cfg)));
}

export default function Preferences({ onBack }: { onBack: () => void }) {
  const [cfg, setCfg] = useState<EngineConfig | null>(null);
  const [err, setErr] = useState<string>("");
  const [saving, setSaving] = useState(false);

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

  function updateRule(list: "title_rules" | "keyword_rules", idx: number, next: Rule) {
    if (!cfg) return;
    const c = cloneCfg(cfg);
    c.scoring[list][idx] = next;
    setCfg(c);
  }

  function addRule(list: "title_rules" | "keyword_rules") {
    if (!cfg) return;
    const c = cloneCfg(cfg);
    c.scoring[list].push({ tag: "", weight: 0, any: [""] });
    setCfg(c);
  }

  function removeRule(list: "title_rules" | "keyword_rules", idx: number) {
    if (!cfg) return;
    const c = cloneCfg(cfg);
    c.scoring[list].splice(idx, 1);
    setCfg(c);
  }

  function updatePenalty(idx: number, next: Penalty) {
    if (!cfg) return;
    const c = cloneCfg(cfg);
    c.scoring.penalties[idx] = next;
    setCfg(c);
  }

  function addPenalty() {
    if (!cfg) return;
    const c = cloneCfg(cfg);
    c.scoring.penalties.push({ reason: "", weight: 0, any: [""] });
    setCfg(c);
  }

  function removePenalty(idx: number) {
    if (!cfg) return;
    const c = cloneCfg(cfg);
    c.scoring.penalties.splice(idx, 1);
    setCfg(c);
  }

  // Loading view
  if (!cfg) {
    return (
      <div className="app">
        <div className="pageTop">
          <button className="btn" onClick={onBack}>
            Back
          </button>
          <h2>Preferences</h2>
        </div>

        {err ? <div className="error">{err}</div> : <div className="small">Loading…</div>}
      </div>
    );
  }

  return (
    <div className="app">
      <div className="pageTop">
        <button className="btn" onClick={onBack}>
          Back
        </button>
        <h2>Preferences</h2>
        <div className="spacer" />
        <button className="btn btnPrimary" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {err && (
        <pre className="error" style={{ whiteSpace: "pre-wrap" }}>
          {err}
        </pre>
      )}

      <div className="settingsPanel">
        <Section title="Title Rules">
          <RulesEditor
            rules={cfg.scoring?.title_rules ?? []}
            onAdd={() => addRule("title_rules")}
            onRemove={(i) => removeRule("title_rules", i)}
            onChange={(i, r) => updateRule("title_rules", i, r)}
          />
        </Section>

        <Section title="Keyword Rules">
          <RulesEditor
            rules={cfg.scoring?.keyword_rules ?? []}
            onAdd={() => addRule("keyword_rules")}
            onRemove={(i) => removeRule("keyword_rules", i)}
            onChange={(i, r) => updateRule("keyword_rules", i, r)}
          />
        </Section>

        <Section title="Penalties">
          <PenaltiesEditor
            penalties={cfg.scoring?.penalties ?? []}
            onAdd={addPenalty}
            onRemove={removePenalty}
            onChange={updatePenalty}
          />
        </Section>

        <Section title="Filters">
          <div className="checkRow">
            <input
              className="checkbox"
              type="checkbox"
              checked={cfg.filters.remote_ok}
              onChange={(e) => {
                const c = cloneCfg(cfg);
                c.filters.remote_ok = e.target.checked;
                setCfg(c);
              }}
            />
            <div>Remote OK</div>
          </div>

          <div className="rowLine" />

          <TextList
            title="Allowed Locations"
            values={cfg.filters.locations_allow ?? []}
            onChange={(vals) => {
              const c = cloneCfg(cfg);
              c.filters.locations_allow = vals;
              setCfg(c);
            }}
          />

          <div className="rowLine" />

          <TextList
            title="Blocked Locations"
            values={cfg.filters.locations_block ?? []}
            onChange={(vals) => {
              const c = cloneCfg(cfg);
              c.filters.locations_block = vals;
              setCfg(c);
            }}
          />
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <div className="sectionHead">{title}</div>
      <div>{children}</div>
    </>
  );
}

function RulesEditor(props: {
  rules: Rule[];
  onAdd: () => void;
  onRemove: (idx: number) => void;
  onChange: (idx: number, next: Rule) => void;
}) {
  const { rules, onAdd, onRemove, onChange } = props;

  return (
    <div className="listBox">
      <button className="btn miniBtn" onClick={onAdd}>
        Add rule
      </button>

      <div className="listStack">
        {(rules ?? []).map((r, idx) => (
          <div key={idx} className="ruleBox">
            <div className="ruleTop">
              <label className="formLabel">
                Tag
                <input
                  className="input"
                  value={r.tag}
                  onChange={(e) => onChange(idx, { ...r, tag: e.target.value })}
                />
              </label>

              <label className="formLabel">
                Weight
                <input
                  className="input"
                  type="number"
                  value={r.weight}
                  onChange={(e) => onChange(idx, { ...r, weight: Number(e.target.value) })}
                  style={{ width: 120 }}
                />
              </label>

              <div className="right">
                <button className="btn miniBtn" onClick={() => onRemove(idx)}>
                  Remove
                </button>
              </div>
            </div>

            <TermList
              title="Any of these terms (substring match)"
              terms={r.any ?? [""]}
              onChange={(terms) => onChange(idx, { ...r, any: terms })}
            />
          </div>
        ))}

        {rules.length === 0 && <div className="small">No rules yet.</div>}
      </div>
    </div>
  );
}

function PenaltiesEditor(props: {
  penalties: Penalty[];
  onAdd: () => void;
  onRemove: (idx: number) => void;
  onChange: (idx: number, next: Penalty) => void;
}) {
  const { penalties, onAdd, onRemove, onChange } = props;

  return (
    <div className="listBox">
      <button className="btn miniBtn" onClick={onAdd}>
        Add penalty
      </button>

      <div className="listStack">
        {(penalties ?? []).map((p, idx) => (
          <div key={idx} className="ruleBox">
            <div className="ruleTop">
              <label className="formLabel">
                Reason
                <input
                  className="input"
                  value={p.reason}
                  onChange={(e) => onChange(idx, { ...p, reason: e.target.value })}
                />
              </label>

              <label className="formLabel">
                Weight
                <input
                  className="input"
                  type="number"
                  value={p.weight}
                  onChange={(e) => onChange(idx, { ...p, weight: Number(e.target.value) })}
                  style={{ width: 120 }}
                />
              </label>

              <div className="right">
                <button className="btn miniBtn" onClick={() => onRemove(idx)}>
                  Remove
                </button>
              </div>
            </div>

            <TermList
              title="Any of these terms (substring match)"
              terms={p.any ?? [""]}
              onChange={(terms) => onChange(idx, { ...p, any: terms })}
            />
          </div>
        ))}

        {penalties.length === 0 && <div className="small">No penalties yet.</div>}
      </div>
    </div>
  );
}

function TermList(props: {
  title: string;
  terms: string[];
  onChange: (terms: string[]) => void;
}) {
  const { title, terms, onChange } = props;

  function setTerm(i: number, v: string) {
    const next = (terms ?? [""]).slice();
    next[i] = v;
    onChange(next);
  }
  function add() {
    onChange([...(terms ?? [""]), ""]);
  }
  function remove(i: number) {
    const next = (terms ?? [""]).slice();
    next.splice(i, 1);
    onChange(next.length ? next : [""]);
  }

  return (
    <div style={{ marginTop: 10 }}>
      <div className="help">{title}</div>

      <div className="listStack">
        {(terms ?? []).map((t, i) => (
          <div key={i} className="listItem">
            <input className="input" value={t} onChange={(e) => setTerm(i, e.target.value)} />
            <button className="btn miniBtn" onClick={() => remove(i)}>
              Remove
            </button>
          </div>
        ))}
      </div>

      <button className="btn miniBtn" style={{ marginTop: 10 }} onClick={add}>
        Add term
      </button>
    </div>
  );
}

function TextList(props: {
  title: string;
  values: string[];
  onChange: (vals: string[]) => void;
}) {
  const { title, values, onChange } = props;

  function setVal(i: number, v: string) {
    const next = (values ?? []).slice();
    next[i] = v;
    onChange(next);
  }
  function add() {
    onChange([...(values ?? []), ""]);
  }
  function remove(i: number) {
    const next = (values ?? []).slice();
    next.splice(i, 1);
    onChange(next);
  }

  return (
    <div className="listBox">
      <div style={{ fontWeight: 680, fontSize: 13, letterSpacing: -0.01 }}>{title}</div>

      <div className="listStack">
        {(values ?? []).map((v, i) => (
          <div key={i} className="listItem">
            <input className="input" value={v} onChange={(e) => setVal(i, e.target.value)} />
            <button className="btn miniBtn" onClick={() => remove(i)}>
              Remove
            </button>
          </div>
        ))}
      </div>

      <button className="btn miniBtn" style={{ marginTop: 10 }} onClick={add}>
        Add
      </button>
    </div>
  );
}
