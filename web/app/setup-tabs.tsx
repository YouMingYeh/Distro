"use client";

import { useState } from "react";
import { siClaude, siCursor, siGithubcopilot, siGooglegemini, siWindsurf } from "simple-icons";
import { CopyableLine } from "./code-tabs";

// simple-icons has no Codex or Grok mark; these two paths come from @lobehub/icons-static-svg.
const CODEX_PATH = "M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z";
const GROK_PATH = "M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815";

type Client = {
  name: string;
  icon: string;
  intro: string;
  command: (mcpUrl: string) => string;
  note?: string;
  followUp?: { intro: string; command: string };
};

const json = (key: string) => (mcpUrl: string) => JSON.stringify({ mcpServers: { distro: { [key]: mcpUrl } } });

const clients: Client[] = [
  {
    name: "Claude Code",
    icon: siClaude.path,
    intro: "Add Distro from your terminal.",
    command: (mcpUrl) => `claude mcp add --transport http distro ${mcpUrl}`,
    note: "In Claude Code, open /mcp and select Distro to authorize it.",
  },
  {
    name: "Codex",
    icon: CODEX_PATH,
    intro: "Add Distro from your terminal.",
    command: (mcpUrl) => `codex mcp add distro --url ${mcpUrl}`,
    followUp: { intro: "If Codex asks you to sign in, run this command.", command: "codex mcp login distro" },
  },
  {
    name: "Cursor",
    icon: siCursor.path,
    intro: "Add this to ~/.cursor/mcp.json.",
    command: json("url"),
    note: "Then open Cursor Settings, go to MCP, and sign in to Distro.",
  },
  {
    name: "VS Code",
    icon: siGithubcopilot.path,
    intro: "Add Distro to GitHub Copilot from your terminal.",
    command: (mcpUrl) => `code --add-mcp '${JSON.stringify({ name: "distro", type: "http", url: mcpUrl })}'`,
    note: "Start the server from the MCP: List Servers command to sign in.",
  },
  {
    name: "Gemini CLI",
    icon: siGooglegemini.path,
    intro: "Add Distro from your terminal.",
    command: (mcpUrl) => `gemini mcp add --transport http distro ${mcpUrl}`,
    note: "In Gemini CLI, run /mcp auth distro to authorize it.",
  },
  {
    name: "Windsurf",
    icon: siWindsurf.path,
    intro: "Add this to ~/.codeium/windsurf/mcp_config.json.",
    command: json("serverUrl"),
    note: "Then refresh the MCP servers in Cascade and sign in to Distro.",
  },
  {
    name: "Grok",
    icon: GROK_PATH,
    intro: "Paste the Distro MCP link to your Grok bot. That is the whole setup.",
    command: (mcpUrl) => mcpUrl,
  },
];

export function SetupTabs({ mcpUrl }: { mcpUrl: string }) {
  const [client, setClient] = useState(clients[0]);

  return (
    <div className="overflow-hidden rounded-xl border border-line">
      <fieldset className="flex min-w-0 gap-1 overflow-x-auto border-b border-line bg-surface px-2.5 py-2">
        <legend className="sr-only">Choose an MCP client</legend>
        {clients.map((item) => (
          <label key={item.name} className="shrink-0 cursor-pointer">
            <input
              className="peer sr-only"
              type="radio"
              name="mcp-client"
              checked={client === item}
              onChange={() => setClient(item)}
            />
            <span className="flex min-h-10 items-center gap-2 rounded-md px-3.5 text-sm font-medium text-muted transition-colors hover:text-fg peer-checked:bg-bg peer-checked:text-fg peer-focus-visible:outline-2 peer-focus-visible:-outline-offset-2 peer-focus-visible:outline-accent">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" fillRule="evenodd" aria-hidden>
                <path d={item.icon} />
              </svg>
              {item.name}
            </span>
          </label>
        ))}
      </fieldset>
      <div className="min-w-0 space-y-3 p-4 text-sm sm:p-6">
        <p className="text-muted">{client.intro}</p>
        <CopyableLine text={client.command(mcpUrl)} label={`Copy ${client.name} setup`} />
        {client.note && <p className="text-muted">{client.note}</p>}
        {client.followUp && (
          <>
            <p className="text-muted">{client.followUp.intro}</p>
            <CopyableLine text={client.followUp.command} label={`Copy ${client.name} sign-in command`} />
          </>
        )}
      </div>
    </div>
  );
}
