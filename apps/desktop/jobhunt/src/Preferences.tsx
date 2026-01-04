import { useEffect, useState } from "react";
import { EngineConfig, getConfig, putConfig, Rule, Penalty } from "./api";
import { normalizeConfig } from "./configNormalize"

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
                setCfg(await getConfig());
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
            setCfg(saved);
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

    if (!cfg) {
        return (
            <div style={{ fontFamily: "system-ui", padding: 16 }}>
        <button onClick={onBack}>Back</button>
        <h2 style={{ marginTop: 12 }}>Preferences</h2>
        {err ? <div style={{ color: "crimson" }}>{err}</div> : <div>Loading…</div>}
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "system-ui", padding: 16, maxWidth: 1100 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button onClick={onBack}>Back</button>
        <h2 style={{ margin: 0 }}>Preferences</h2>
        <div style={{ flex: 1 }} />
        <button onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {err && (
        <pre style={{ marginTop: 12, color: "crimson", whiteSpace: "pre-wrap" }}>
          {err}
        </pre>
      )}

      <Section title="Title Rules">
        <RulesEditor
          rules={cfg.scoring?.title_rules ?? []}
          onAdd={() => addRule("title_rules")}
          onRemove={(i) => removeRule("title_rules", i)}
          onChange={(i, r) => updateRule("title_rules", i, r)}
          labelTag="Tag"
        />
      </Section>

      <Section title="Keyword Rules">
        <RulesEditor
          rules={cfg.scoring?.keyword_rules ?? []}
          onAdd={() => addRule("keyword_rules")}
          onRemove={(i) => removeRule("keyword_rules", i)}
          onChange={(i, r) => updateRule("keyword_rules", i, r)}
          labelTag="Tag"
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
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={cfg.filters.remote_ok}
            onChange={(e) => {
              const c = cloneCfg(cfg);
              c.filters.remote_ok = e.target.checked;
              setCfg(c);
            }}
          />
          Remote OK
        </label>

        <TextList
          title="Allowed Locations"
          values={cfg.filters.locations_allow}
          onChange={(vals) => {
            const c = cloneCfg(cfg);
            c.filters.locations_allow = vals;
            setCfg(c);
          }}
        />
        <TextList
          title="Blocked Locations"
          values={cfg.filters.locations_block}
          onChange={(vals) => {
            const c = cloneCfg(cfg);
            c.filters.locations_block = vals;
            setCfg(c);
          }}
        />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid #eee" }}>
      <h3 style={{ margin: "0 0 10px 0" }}>{title}</h3>
      {children}
    </div>
  );
}

function RulesEditor(props: {
  rules: Rule[];
  onAdd: () => void;
  onRemove: (idx: number) => void;
  onChange: (idx: number, next: Rule) => void;
  labelTag: string;
}) {
  const { rules, onAdd, onRemove, onChange } = props;

  return (
    <div>
      <button onClick={onAdd}>Add rule</button>
      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
        {(rules ?? []).map((r, idx) => (
          <div key={idx} style={{ border: "1px solid #ddd", borderRadius: 10, padding: 12 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <label>
                Tag{" "}
                <input
                  value={r.tag}
                  onChange={(e) => onChange(idx, { ...r, tag: e.target.value })}
                />
              </label>

              <label>
                Weight{" "}
                <input
                  type="number"
                  value={r.weight}
                  onChange={(e) => onChange(idx, { ...r, weight: Number(e.target.value) })}
                  style={{ width: 90 }}
                />
              </label>

              <button onClick={() => onRemove(idx)} style={{ marginLeft: "auto" }}>
                Remove
              </button>
            </div>

            <TermList
              title="Any of these terms (substring match)"
              terms={r.any}
              onChange={(terms) => onChange(idx, { ...r, any: terms })}
            />
          </div>
        ))}
        {rules.length === 0 && <div style={{ opacity: 0.7 }}>No rules yet.</div>}
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
    <div>
      <button onClick={onAdd}>Add penalty</button>
      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
        {penalties.map((p, idx) => (
          <div key={idx} style={{ border: "1px solid #ddd", borderRadius: 10, padding: 12 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <label>
                Reason{" "}
                <input
                  value={p.reason}
                  onChange={(e) => onChange(idx, { ...p, reason: e.target.value })}
                />
              </label>

              <label>
                Weight{" "}
                <input
                  type="number"
                  value={p.weight}
                  onChange={(e) => onChange(idx, { ...p, weight: Number(e.target.value) })}
                  style={{ width: 90 }}
                />
              </label>

              <button onClick={() => onRemove(idx)} style={{ marginLeft: "auto" }}>
                Remove
              </button>
            </div>

            <TermList
              title="Any of these terms (substring match)"
              terms={p.any}
              onChange={(terms) => onChange(idx, { ...p, any: terms })}
            />
          </div>
        ))}
        {penalties.length === 0 && <div style={{ opacity: 0.7 }}>No penalties yet.</div>}
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
    const next = terms.slice();
    next[i] = v;
    onChange(next);
  }
  function add() {
    onChange([...terms, ""]);
  }
  function remove(i: number) {
    const next = terms.slice();
    next.splice(i, 1);
    onChange(next.length ? next : [""]);
  }

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 12, opacity: 0.8 }}>{title}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
        {(terms ?? []).map((t, i) => (
          <div key={i} style={{ display: "flex", gap: 8 }}>
            <input value={t} onChange={(e) => setTerm(i, e.target.value)} style={{ flex: 1 }} />
            <button onClick={() => remove(i)}>Remove</button>
          </div>
        ))}
      </div>
      <button onClick={add} style={{ marginTop: 6 }}>
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
    const next = values.slice();
    next[i] = v;
    onChange(next);
  }
  function add() {
    onChange([...values, ""]);
  }
  function remove(i: number) {
    const next = values.slice();
    next.splice(i, 1);
    onChange(next);
  }

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontWeight: 600 }}>{title}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
        {values.map((v, i) => (
          <div key={i} style={{ display: "flex", gap: 8 }}>
            <input value={v} onChange={(e) => setVal(i, e.target.value)} style={{ flex: 1 }} />
            <button onClick={() => remove(i)}>Remove</button>
          </div>
        ))}
      </div>
      <button onClick={add} style={{ marginTop: 6 }}>
        Add
      </button>
    </div>
  );
}