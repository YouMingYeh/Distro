"use client";

import { useState } from "react";
import { Check, Copy } from "@phosphor-icons/react";

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-xs text-muted transition hover:text-fg active:scale-[0.98]"
    >
      {copied ? <Check size={14} className="text-accent" /> : <Copy size={14} />}
      <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

export function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto font-mono text-[13px] leading-6">
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
      <div className="relative p-5 md:p-6">
        <div className="mb-3 flex justify-end md:absolute md:right-5 md:top-5 md:mb-0">
          <CopyButton text={code} />
        </div>
        <div role="tabpanel" className="min-h-[17rem]">
          <Code>{code}</Code>
        </div>
      </div>
    </div>
  );
}
