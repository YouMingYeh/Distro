import type { CSSProperties } from "react";
import { Check } from "@phosphor-icons/react/dist/ssr";
import { siModelcontextprotocol } from "simple-icons";
import { TypedTask } from "./typed-task";
import { DistroMascot } from "./distro-mascot";
import "./agent-demo.css";

const orbit = [
  { file: "claude.jpg" },
  { file: "tiktok.jpg" },
  { file: "instagram.jpg" },
  { file: "codex-dark.png", className: "agent-demo-satellite-codex" },
  { file: "youtube-white.png", className: "agent-demo-satellite-youtube" },
  { file: "threads.jpg" },
];

const steps = [
  ["generate_video", "Render queued"],
  ["get_job", "Video ready"],
  ["publish", "TikTok dry run"],
];

export function AgentDemo({ mcpUrl }: { mcpUrl: string }) {
  return (
    <figure className="agent-demo-scene">
      <figcaption className="sr-only">Example of an agent preparing a TikTok preview with Distro</figcaption>
      <div className="agent-demo-connection" aria-hidden="true">
        <span className="agent-demo-tile agent-demo-distro">
          <DistroMascot className="size-8" />
        </span>
        <span className="agent-demo-link"><i /><i /><i /></span>
        <span className="agent-demo-tile agent-demo-mcp">
          <svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor">
            <path d={siModelcontextprotocol.path} />
          </svg>
        </span>
      </div>
      <div className="agent-demo-stage">
        {orbit.map((icon, index) => (
          <span
            key={icon.file}
            className={`agent-demo-satellite ${icon.className ?? ""}`}
            style={{
              "--phase": index / orbit.length,
              "--resting-depth": index < orbit.length / 2 ? 3 : 1,
            } as CSSProperties}
            aria-hidden="true"
          >
            <img className="agent-demo-app-icon" src={`/brand/${icon.file}`} alt="" width="56" height="56" />
          </span>
        ))}

        <div className="agent-demo-window">
          <div className="agent-demo-bar">
            <span className="agent-demo-dots" aria-hidden="true"><i /><i /><i /></span>
            <code className="agent-demo-endpoint">{mcpUrl.replace(/^https?:\/\//, "")}</code>
          </div>
          <div className="agent-demo-body">
            <p className="agent-demo-task">
              <span className="agent-demo-task-label">Task</span>
              <TypedTask text="Make a launch video and preview it for TikTok." />
            </p>
            <ol className="agent-demo-steps">
              {steps.map(([tool, result], index) => (
                <li key={tool}>
                  <div className="agent-demo-step-text">
                    <code>{tool}</code>
                    <span>{result}</span>
                  </div>
                  <Check className="agent-demo-check" style={{ "--step": index } as CSSProperties} aria-hidden="true" />
                </li>
              ))}
            </ol>
            <p className="agent-demo-result">Preview ready to review.</p>
          </div>
        </div>
      </div>
    </figure>
  );
}
