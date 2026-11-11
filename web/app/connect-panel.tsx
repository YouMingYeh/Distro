import { ArrowUpRight, CheckCircle } from "@phosphor-icons/react/dist/ssr";
import { siInstagram, siThreads, siTiktok, siX, siYoutube } from "simple-icons";
import type { Platform } from "./platforms";

const ROWS: { id: Platform; name: string; path: string }[] = [
  { id: "tiktok", name: "TikTok", path: siTiktok.path },
  { id: "instagram", name: "Instagram", path: siInstagram.path },
  { id: "youtube", name: "YouTube", path: siYoutube.path },
  { id: "twitter", name: "X", path: siX.path },
  { id: "threads", name: "Threads", path: siThreads.path },
];

/**
 * Live account linking. Each button is a plain link to the backend, which sets
 * the workspace cookie, asks Zernio for the platform consent URL and redirects.
 */
export function ConnectPanel({
  api,
  connected,
  failed,
}: {
  api: string;
  connected?: { platform: Platform; username?: string };
  failed?: boolean;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface p-2 shadow-[0_24px_60px_-30px_color-mix(in_srgb,var(--fg)_35%,transparent)]">
      <div className="flex items-baseline justify-between px-4 pb-2 pt-3">
        <h2 className="text-sm font-medium">Accounts</h2>
        <p className="font-mono text-xs text-muted">connect_account</p>
      </div>
      <ul>
        {ROWS.map((row) => {
          const done = connected?.platform === row.id;
          return (
            <li key={row.id} className="flex h-14 items-center gap-3 rounded-lg px-4 transition hover:bg-bg">
              <svg viewBox="0 0 24 24" aria-hidden className="size-5 shrink-0 fill-current">
                <path d={row.path} />
              </svg>
              <span className="flex-1 text-sm">{row.name}</span>
              {done ? (
                <span className="inline-flex items-center gap-1.5 text-sm text-accent">
                  <CheckCircle size={16} weight="fill" />
                  {connected.username ? `@${connected.username}` : "Connected"}
                </span>
              ) : (
                <a
                  href={`${api}/connect/${row.id}`}
                  className="inline-flex items-center gap-1 rounded-full border border-line px-3.5 py-1.5 text-sm transition hover:border-fg active:scale-[0.98]"
                >
                  Connect
                  <ArrowUpRight size={14} />
                </a>
              )}
            </li>
          );
        })}
      </ul>
      <p className="px-4 pb-3 pt-2 text-xs leading-5 text-muted">
        {failed
          ? "That connection did not go through. Nothing was linked, so it is safe to try again."
          : "You approve on the platform's own consent screen. Tokens stay on the server."}
      </p>
    </div>
  );
}
