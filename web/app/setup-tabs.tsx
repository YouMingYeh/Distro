"use client";

import { useState } from "react";
import { CopyableLine } from "./code-tabs";

const clients = ["Claude Code", "Codex"] as const;

export function SetupTabs({ mcpUrl }: { mcpUrl: string }) {
  const [client, setClient] = useState<(typeof clients)[number]>("Claude Code");
  const isClaude = client === "Claude Code";

  return (
    <div className="overflow-hidden rounded-xl border border-line">
      <fieldset className="flex gap-1 border-b border-line bg-surface px-2.5 py-2">
        <legend className="sr-only">Choose an MCP client</legend>
        {clients.map((name) => (
          <label key={name} className="cursor-pointer">
            <input
              className="peer sr-only"
              type="radio"
              name="mcp-client"
              checked={client === name}
              onChange={() => setClient(name)}
            />
            <span className="flex min-h-10 items-center rounded-md px-3.5 text-sm font-medium text-muted transition-colors hover:text-fg peer-checked:bg-bg peer-checked:text-fg peer-focus-visible:outline-2 peer-focus-visible:-outline-offset-2 peer-focus-visible:outline-accent">
              {name}
            </span>
          </label>
        ))}
      </fieldset>
      <div className="min-w-0 space-y-3 p-4 text-sm sm:p-6">
        <p className="text-muted">Add Distro from your terminal.</p>
        <CopyableLine
          text={isClaude ? `claude mcp add --transport http distro ${mcpUrl}` : `codex mcp add distro --url ${mcpUrl}`}
          label={`Copy ${client} setup command`}
        />
        {isClaude ? (
          <p className="text-muted">
            In Claude Code, open <code className="font-mono text-fg">/mcp</code> and select Distro to authorize it.
          </p>
        ) : (
          <>
            <p className="text-muted">If Codex asks you to sign in, run this command.</p>
            <CopyableLine text="codex mcp login distro" label="Copy Codex sign-in command" />
          </>
        )}
      </div>
    </div>
  );
}
