"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "@phosphor-icons/react";

export function CopyButton({
  text,
  label = "Copy",
  primary = false,
}: {
  text: string;
  label?: string;
  primary?: boolean;
}) {
  const [feedback, setFeedback] = useState("");
  const reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(reset.current), []);

  async function copy() {
    clearTimeout(reset.current);
    try {
      await navigator.clipboard.writeText(text);
      setFeedback("Copied");
    } catch {
      setFeedback("Copy failed");
    }
    reset.current = setTimeout(() => setFeedback(""), 2000);
  }

  return (
    <span className="inline-flex shrink-0">
      <button
        type="button"
        aria-label={label}
        onClick={copy}
        className={`inline-flex min-h-9 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors ${
          primary ? "bg-fg text-bg hover:opacity-85" : "border border-line text-muted hover:bg-bg hover:text-fg"
        }`}
      >
        {feedback === "Copied" ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
        <span>{feedback || "Copy"}</span>
      </button>
      <span role="status" className="sr-only">{feedback}</span>
    </span>
  );
}

export function CopyableLine({ text, label, primary }: { text: string; label: string; primary?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-lg border border-line bg-surface p-2 pl-3.5">
      <code tabIndex={0} className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[13px]">
        {text}
      </code>
      <CopyButton key={text} text={text} label={label} primary={primary} />
    </div>
  );
}

export function Code({ children }: { children: string }) {
  return (
    <pre tabIndex={0} className="overflow-x-auto font-mono text-[13px] leading-6">
      {children.split("\n").map((line, i) => (
        <span key={i} className={/^\s*(#|\/\/)/.test(line) ? "block text-muted" : "block"}>
          {line || " "}
        </span>
      ))}
    </pre>
  );
}

type Samples = Record<string, Record<string, string>>;

function Tabs({ label, items, value, onChange }: { label: string; items: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-1">
      {items.map((item) => (
        <button
          key={item}
          role="tab"
          type="button"
          aria-selected={item === value}
          onClick={() => onChange(item)}
          className={`rounded-full px-4 py-1.5 text-sm transition active:scale-[0.98] ${
            item === value ? "bg-fg text-bg" : "text-muted hover:text-fg"
          }`}
        >
          {item}
        </button>
      ))}
    </div>
  );
}

/** One action shown through each interface: samples[action][interface]. */
export function CodeTabs({ samples }: { samples: Samples }) {
  const actions = Object.keys(samples);
  const [action, setAction] = useState(actions[0]);
  const interfaces = Object.keys(samples[action]);
  const [iface, setIface] = useState(interfaces[0]);
  const code = samples[action][iface];

  return (
    <div className="min-w-0 rounded-xl border border-line bg-surface">
      <div className="flex flex-col gap-3 border-b border-line p-3 md:flex-row md:items-center md:justify-between">
        <Tabs label="Action" items={actions} value={action} onChange={setAction} />
        <Tabs label="Interface" items={interfaces} value={iface} onChange={setIface} />
      </div>
      <div className="p-4 sm:p-6">
        <div className="mb-2 flex justify-end">
          <CopyButton key={code} text={code} label="Copy example" />
        </div>
        <div role="tabpanel" className="min-h-[17rem]">
          <Code>{code}</Code>
        </div>
      </div>
    </div>
  );
}
