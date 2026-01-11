import { useEffect, useMemo, useRef, useState } from "react";

export type SelectOption<T extends string> = { value: T; label: string };

export default function Select<T extends string>(props: {
  value: T;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
  ariaLabel?: string;
  width?: number;
}) {
  const { value, options, onChange, ariaLabel, width } = props;

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const current = useMemo(
    () => options.find((o) => o.value === value) ?? options[0],
    [options, value]
  );

  useEffect(() => {
    function onDocDown(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div ref={rootRef} className="select" style={{ width: width ?? 220 }}>
      <button
        type="button"
        className="selectBtn"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{current?.label ?? value}</span>
        <span className="selectChevron">▾</span>
      </button>

      {open && (
        <div className="selectMenu" role="listbox">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`selectItem ${o.value === value ? "active" : ""}`}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
