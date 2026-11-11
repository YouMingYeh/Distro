import { ArrowUpRight, CheckCircle } from "@phosphor-icons/react/dist/ssr";
import { siInstagram, siThreads, siTiktok, siX, siYoutube } from "simple-icons";
import { ConnectionReturn } from "./connection-return";
import type { Platform } from "./platforms";

export const ROWS: { id: Platform; name: string; path: string }[] = [
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
    <div className="rounded-xl border border-line bg-surface">
      {failed && (
        <p
          id="account-connection-result"
          role="alert"
          tabIndex={-1}
          className="border-b border-line px-4 py-3 text-sm sm:px-5"
        >
          Connection failed. Try connecting again.
        </p>
      )}
      <ul className="divide-y divide-line">
        {ROWS.map((row) => {
          const done = connected?.platform === row.id;
          return (
            <li key={row.id} className="flex min-h-14 items-center gap-3 px-4 py-2 sm:px-5">
              <svg viewBox="0 0 24 24" aria-hidden className="size-5 shrink-0 fill-current">
                <path d={row.path} />
              </svg>
              <span className="shrink-0 text-sm">{row.name}</span>
              {done ? (
                <span
                  id={failed ? undefined : "account-connection-result"}
                  role="status"
                  tabIndex={-1}
                  className="ml-auto flex min-w-0 items-center gap-1.5 rounded-sm text-sm text-accent"
                >
                  <CheckCircle size={16} weight="fill" aria-hidden className="shrink-0" />
                  <span className="[overflow-wrap:anywhere]">
                    <span className="sr-only">{row.name} connected. </span>
                    {connected.username ? `@${connected.username}` : "Connected"}
                  </span>
                </span>
              ) : (
                <a
                  href={`${api}/connect/${row.id}`}
                  aria-label={`Connect ${row.name}`}
                  className="ml-auto inline-flex min-h-9 items-center gap-1 rounded-md border border-line px-3 text-sm transition-colors hover:bg-bg"
                >
                  Connect
                  <ArrowUpRight size={14} aria-hidden />
                </a>
              )}
            </li>
          );
        })}
      </ul>
      {(failed || connected) && <ConnectionReturn />}
    </div>
  );
}
