"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ArrowUpRight, ChatCircle, CheckCircle, Eye, Globe, Heart, Plus, WarningCircle } from "@phosphor-icons/react";
import { CopyButton } from "./code-tabs";
import { ROWS } from "./connect-panel";
import { demoPosts, demoVideo, demoWorkspace } from "./dashboard/demo-data";
import { SiteHeader, siteShell } from "./site-header";
import { VideoPreview } from "./video-preview";

const API = process.env.NEXT_PUBLIC_DISTRO_URL?.replace(/\/$/, "") || "https://mcp.trydistro.app";
const DASHBOARD_DEMO =
  process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_DISTRO_DASHBOARD_DEMO === "1";

type Account = { account_id: string; platform: string; username?: string; active?: boolean };
type Me = {
  sign_in: boolean; // false when the server runs without sign-in
  signed_in?: boolean;
  email?: string;
  profiles?: { id: string; name: string; default: boolean; accounts: Account[] | null }[];
  api_keys?: { id: string; name: string; ends_with: string; scopes: string[]; created: string }[];
};

/** Who is signed in, from the backend's session cookie. `undefined` while loading, `null` if it cannot be reached. */
function useMe(enabled = true) {
  const [me, setMe] = useState<Me | null>();
  useEffect(() => {
    if (!enabled) return;
    fetch(`${API}/me`, { credentials: "include" })
      .then((r) => r.json())
      .then(setMe, () => setMe(null));
  }, [enabled]);
  return me;
}

const pill = "inline-flex items-center rounded-full border border-line px-4 py-2 text-sm font-medium transition hover:border-fg active:scale-[0.98]";

/** Header button: Sign in, or Dashboard once signed in. Renders nothing when the server has no sign-in. */
export function SignInButton() {
  const me = useMe(!DASHBOARD_DEMO);
  if (DASHBOARD_DEMO) return <a href="/dashboard" className={pill}>Dashboard</a>;
  if (!me?.sign_in) return null;
  return me.signed_in ? (
    <a href="/dashboard" className={pill}>
      Dashboard
    </a>
  ) : (
    <a href={`${API}/signin`} className={pill}>
      Sign in
    </a>
  );
}

const panel = "min-w-0 rounded-2xl border border-line bg-surface p-2";
const row = "flex min-h-14 items-center gap-3 rounded-lg px-4 py-2 transition hover:bg-bg";
const small = "inline-flex shrink-0 items-center gap-1 rounded-full border border-line px-3.5 py-1.5 text-sm transition hover:border-fg active:scale-[0.98]";
const MCP_INSTALL = `claude mcp add --transport http distro ${API}/mcp`;
const sectionHeading = "mb-3 text-xl font-semibold tracking-tight sm:text-2xl";
const dateFormat = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : dateFormat.format(date);
}

type Profile = NonNullable<Me["profiles"]>[number];

function ProfileControls({ profiles, current, onPick, onAdd }: {
  profiles: Profile[];
  current?: Profile;
  onPick: (id: string) => void;
  onAdd: (profile: Profile) => void;
}) {
  const [naming, setNaming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    if (!name || pending) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch(`${API}/me/profiles?name=${encodeURIComponent(name)}`, {
        method: "POST",
        credentials: "include",
      });
      const data = await response.json();
      if (!response.ok || typeof data?.id !== "string" || typeof data.name !== "string") {
        setError(typeof data?.error === "string" ? data.error : "Could not create the profile. Try again.");
        return;
      }
      onAdd({ id: data.id, name: data.name, default: data.default === true, accounts: [] });
      setNaming(false);
    } catch {
      setError("Could not create the profile. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {profiles.length > 1 && (
        <select
          aria-label="Profile"
          value={current?.id ?? ""}
          onChange={(event) => onPick(event.currentTarget.value)}
          className="max-w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm"
        >
          {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </select>
      )}
      {naming ? (
        <form onSubmit={create} className="flex max-w-full flex-wrap items-center gap-2">
          <input
            name="name"
            autoFocus
            required
            maxLength={60}
            disabled={pending}
            aria-label="Profile name"
            placeholder="Profile name"
            className="w-40 max-w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm"
          />
          <button type="submit" disabled={pending} className={`${small} disabled:opacity-60`}>
            {pending ? "Creating…" : "Create"}
          </button>
          <button type="button" disabled={pending} onClick={() => {
            setNaming(false);
            setError("");
          }} className="px-2 py-1 text-sm text-muted hover:text-fg">
            Cancel
          </button>
        </form>
      ) : (
        <button type="button" onClick={() => setNaming(true)} className={`${small} text-muted`}>
          <Plus size={14} aria-hidden />
          New profile
        </button>
      )}
      {error && <p role="alert" className="w-full text-sm text-muted">{error}</p>}
    </div>
  );
}

function Mark({ path }: { path?: string }) {
  if (!path) return <Globe size={20} className="shrink-0" aria-hidden />;
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-5 shrink-0 fill-current">
      <path d={path} />
    </svg>
  );
}

function AccountRow({ account: a, name, path, href }: { account: Account; name: string; path?: string; href?: string }) {
  const stale = a.active === false;
  return (
    <li className={row}>
      <Mark path={path} />
      <span className="min-w-0 flex-1 text-sm">
        <span className="block truncate">{a.username ? `@${a.username}` : name}</span>
        {a.username && <span className="block text-xs text-muted">{name}</span>}
      </span>
      {stale ? (
        <>
          <span className="hidden items-center gap-1.5 text-sm text-muted sm:inline-flex">
            <WarningCircle size={16} />
            Needs reconnecting
          </span>
          <a href={href} aria-disabled={!href || undefined} className={small}>
            Reconnect
          </a>
        </>
      ) : (
        <span className="inline-flex items-center gap-1.5 text-sm text-accent">
          <CheckCircle size={16} weight="fill" />
          Connected
        </span>
      )}
    </li>
  );
}

function ProfilePanel({ profile: p, demo }: { profile: Profile; demo: boolean }) {
  const connect = (platform: string) => demo ? undefined : `${API}/connect/${platform}?profile=${encodeURIComponent(p.id)}&from=dashboard`;
  const accounts = p.accounts ?? [];
  const known = new Set<string>(ROWS.map((r) => r.id));
  return (
    <section className={panel}>
      <div className="flex items-baseline justify-between gap-3 px-4 pb-2 pt-3">
        <h3 className="text-sm font-medium">
          {p.name}
          {p.default && <span className="ml-2 font-normal text-muted">Default</span>}
        </h3>
        <p className="truncate font-mono text-xs text-muted">{p.id}</p>
      </div>
      {p.accounts === null && (
        <p className="mx-2 mb-1 rounded-lg bg-bg px-3 py-2 text-sm text-muted">
          Connected accounts could not be loaded right now. Reload to try again.
        </p>
      )}
      <ul>
        {ROWS.map((r) => {
          const mine = accounts.filter((a) => a.platform === r.id);
          if (mine.length) {
            return mine.map((a) => <AccountRow key={a.account_id} account={a} name={r.name} path={r.path} href={connect(r.id)} />);
          }
          return (
            <li key={r.id} className={row}>
              <Mark path={r.path} />
              <span className="flex-1 text-sm text-muted">{r.name}</span>
              <a href={connect(r.id)} aria-disabled={demo || undefined} className={small}>
                Connect
                <ArrowUpRight size={14} />
              </a>
            </li>
          );
        })}
        {accounts
          .filter((a) => !known.has(a.platform))
          .map((a) => (
            <AccountRow
              key={a.account_id}
              account={a}
              name={a.platform.charAt(0).toUpperCase() + a.platform.slice(1)}
              href={connect(a.platform)}
            />
          ))}
      </ul>
    </section>
  );
}

type Post = {
  id: string;
  platform?: string;
  username?: string;
  caption?: string;
  published?: string;
  url?: string;
  thumbnail?: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
};

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const SHOWN = 12;
const postColumns = "grid grid-cols-[minmax(0,1fr)] items-center gap-x-3 px-3 sm:grid-cols-[minmax(0,1fr)_repeat(3,5rem)] sm:px-4";
const postMetrics = [
  { key: "views", label: "Views", icon: Eye },
  { key: "likes", label: "Likes", icon: Heart },
  { key: "comments", label: "Comments", icon: ChatCircle },
] as const;

function PostRow({ post: p }: { post: Post }) {
  const [broken, setBroken] = useState(false);
  const r = ROWS.find((x) => x.id === p.platform);
  const published = p.published && formatDate(p.published);
  return (
    <li className="min-w-0 border-t border-line">
      <a href={p.url} target="_blank" rel="noreferrer" className={`${postColumns} rounded-lg py-2.5 ${p.url ? "transition-colors hover:bg-bg" : ""}`}>
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-12 w-9 shrink-0 place-items-center overflow-hidden rounded-md bg-bg text-muted">
            {p.thumbnail && !broken ? (
              // Platform CDN links can expire.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={p.thumbnail}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                onError={() => setBroken(true)}
                className="size-full object-cover"
              />
            ) : (
              <Mark path={r?.path} />
            )}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{p.caption || "No caption"}</p>
            <p className="mt-0.5 truncate text-xs text-muted">
              {p.username ? `@${p.username}` : (r?.name ?? p.platform)}
              {published && <> · {published}</>}
            </p>
          </div>
        </div>
        <div className="mt-2 ml-12 flex flex-wrap gap-3 text-xs text-muted tabular-nums sm:contents">
          {postMetrics.map(({ key, label, icon: Icon }) => (
            <span key={key} className="inline-flex items-center gap-1 sm:justify-end sm:text-sm sm:text-fg">
              <Icon size={14} className="sm:hidden" aria-hidden />
              <span className="sr-only">{label} </span>
              {compact.format(p[key])}
            </span>
          ))}
        </div>
      </a>
    </li>
  );
}

/** Published posts for one profile with their numbers. Loads after the accounts, from its own request. */
function Posts({ profileId, demo }: { profileId: string; demo: boolean }) {
  const [livePosts, setPosts] = useState<Post[] | null>();
  const posts = demo ? demoPosts : livePosts;
  useEffect(() => {
    if (demo) return;
    fetch(`${API}/me/posts?profile=${profileId}`, { credentials: "include" })
      .then((r) => r.json())
      .then((d: { posts?: Post[] | null }) => setPosts(d.posts ?? null), () => setPosts(null));
  }, [demo, profileId]);

  return (
    <div className={panel}>
      <div className="flex items-baseline justify-between gap-3 px-4 pb-2 pt-3">
        <h3 className="text-sm font-medium">Published posts</h3>
        <p className="text-xs text-muted">Last 90 days</p>
      </div>
      {posts === undefined ? (
        <div aria-busy aria-label="Loading posts" className="m-2 h-24 rounded-lg bg-line motion-safe:animate-pulse" />
      ) : posts === null ? (
        <p className="mx-2 mb-2 rounded-lg bg-bg px-3 py-2 text-sm text-muted">Posts could not be loaded right now. Reload to try again.</p>
      ) : posts.length === 0 ? (
        <p className="px-4 pb-3 text-sm text-muted">Nothing published in the last 90 days. New posts can take a while to show up.</p>
      ) : (
        <>
          <dl className="m-2 grid grid-cols-2 rounded-xl border border-line bg-bg sm:grid-cols-4">
            <div className="px-3 py-2.5 sm:px-4">
              <dt className="text-xs text-muted">Posts</dt>
              <dd className="mt-0.5 text-2xl font-semibold tracking-tight tabular-nums">{compact.format(posts.length)}</dd>
            </div>
            {postMetrics.map(({ key, label }) => (
              <div key={key} className="px-3 py-2.5 sm:px-4">
                <dt className="text-xs text-muted">{label}</dt>
                <dd className="mt-0.5 text-2xl font-semibold tracking-tight tabular-nums">
                  {compact.format(posts.reduce((total, post) => total + post[key], 0))}
                </dd>
              </div>
            ))}
          </dl>
          <div className={`${postColumns} mt-3 hidden py-2 text-xs text-muted sm:grid`} aria-hidden>
            <span>Post</span>
            {postMetrics.map(({ label }) => <span key={label} className="text-right">{label}</span>)}
          </div>
          <ul>
            {posts.slice(0, SHOWN).map((p) => (
              <PostRow key={p.id} post={p} />
            ))}
          </ul>
          {posts.length > SHOWN && (
            <p className="px-4 pb-3 pt-1 text-xs text-muted">
              Showing the {SHOWN} newest of {posts.length}. The totals count all of them.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function ApiKeys({ keys }: { keys: NonNullable<Me["api_keys"]> }) {
  return (
    <section className={panel}>
      <div className="flex items-baseline justify-between gap-3 px-4 pb-2 pt-3">
        <h3 className="text-sm font-medium">API keys</h3>
        <p className="font-mono text-xs text-muted">{keys.length}</p>
      </div>
      {keys.length ? (
        <ul>
          {keys.map((k) => (
            <li key={k.id} className={`${row} flex-wrap justify-between gap-y-0`}>
              <span className="min-w-0 text-sm">
                <span className="block truncate">{k.name}</span>
                <span className="block text-xs text-muted">
                  {k.scopes.join(", ")}{k.created && `, created ${formatDate(k.created)}`}
                </span>
              </span>
              <span className="font-mono text-xs text-muted">dk_…{k.ends_with}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 pb-2 text-sm text-muted">No API keys yet. Create one from the CLI to call the REST API.</p>
      )}
      <Command text="distro apikey create" />
    </section>
  );
}

function Command({ text }: { text: string }) {
  return (
    <div className="m-2 flex items-center justify-between gap-3 rounded-lg bg-bg py-2 pl-3 pr-2">
      <code className="min-w-0 overflow-x-auto whitespace-nowrap font-mono text-[13px]">{text}</code>
      <CopyButton text={text} />
    </div>
  );
}

/** Loading placeholder shaped like the loaded page: a profile panel beside the keys panel. */
function Skeleton() {
  const bar = "rounded-full bg-line motion-safe:animate-pulse";
  return (
    <div aria-busy aria-label="Loading your dashboard" className="grid items-start gap-4 md:grid-cols-[1.5fr_1fr]">
      <div className={panel}>
        {ROWS.map((r) => (
          <div key={r.id} className="flex h-14 items-center gap-3 px-4">
            <div className={`size-5 ${bar}`} />
            <div className={`h-3 w-32 ${bar}`} />
            <div className={`ml-auto h-7 w-24 ${bar}`} />
          </div>
        ))}
      </div>
      <div className={panel}>
        <div className="flex h-14 items-center px-4">
          <div className={`h-3 w-40 ${bar}`} />
        </div>
        <div className={`m-2 h-10 ${bar} rounded-lg`} />
      </div>
    </div>
  );
}

/** A full-width message for the states with nothing to show. */
function Notice({ title, children, action }: { title: string; children: string; action?: { href: string; label: string } }) {
  return (
    <div className="max-w-[52ch]">
      <h2 className="text-xl font-medium tracking-tight">{title}</h2>
      <p className="mt-2 leading-relaxed text-muted">{children}</p>
      {action && (
        <a
          href={action.href}
          className="mt-6 inline-flex items-center gap-2 rounded-full bg-fg px-5 py-2.5 text-sm font-medium text-bg transition hover:opacity-90 active:scale-[0.98]"
        >
          {action.label}
        </a>
      )}
    </div>
  );
}

export function Dashboard() {
  const liveMe = useMe(!DASHBOARD_DEMO);
  const me: Me | null | undefined = DASHBOARD_DEMO ? demoWorkspace : liveMe;
  const signedIn = Boolean(me?.sign_in && me.signed_in);
  const [added, setAdded] = useState<Profile[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const profiles = [...((signedIn && me?.profiles) || []), ...added];
  const current = profiles.find((profile) => profile.id === picked) ?? profiles[0];
  const count = profiles.reduce((n, p) => n + (p.accounts?.length ?? 0), 0);
  // Return to the same profile after a platform's consent screen.
  useEffect(() => {
    if (DASHBOARD_DEMO) return;
    try {
      setPicked(sessionStorage.getItem("distro-profile"));
    } catch {}
  }, []);

  function pick(id: string) {
    setPicked(id);
    try {
      sessionStorage.setItem("distro-profile", id);
    } catch {}
  }

  function addProfile(profile: Profile) {
    setAdded((previous) => [...previous, profile]);
    pick(profile.id);
  }

  // Signed out: go straight to sign-in. The backend sends the browser back to /dashboard afterwards.
  const signedOut = !!me?.sign_in && !me.signed_in;
  useEffect(() => {
    if (signedOut) window.location.replace(`${API}/signin`);
  }, [signedOut]);

  return (
    <>
      <SiteHeader action={DASHBOARD_DEMO ? (
        <span className="whitespace-nowrap text-xs text-muted">Demo data</span>
      ) : signedIn && (
        <div className="flex min-w-0 items-center gap-3">
          <span className="hidden max-w-40 truncate text-muted xl:block">{me?.email}</span>
          <a href={`${API}/signout`} className={`${pill} whitespace-nowrap`}>Sign out</a>
        </div>
      )} />

      <main id="overview" className={`${siteShell} grid scroll-mt-6 gap-6 pt-8 pb-16 sm:gap-7 sm:pt-12 lg:pb-24`}>
        <div className="mb-1">
          <h1 className="text-[clamp(2.125rem,4.8vw,3.75rem)] leading-none font-semibold tracking-[-0.065em]">Dashboard</h1>
          <p className="mt-3 max-w-[46ch] text-pretty text-sm leading-relaxed text-muted sm:text-base">
            {DASHBOARD_DEMO
              ? "Preview videos and track your social posts."
              : signedIn
                ? count
                  ? `${count} ${count === 1 ? "account" : "accounts"} your agent can publish to.`
                  : "Connect an account so your agent has somewhere to publish."
                : "Accounts and API keys for your Distro workspace."}
          </p>
        </div>

        <VideoPreview sample={DASHBOARD_DEMO ? demoVideo : undefined} />

        {me === undefined || signedOut ? (
          <Skeleton />
        ) : me === null ? (
          <Notice title="The server could not be reached">Reload to try again.</Notice>
        ) : !me.sign_in ? (
          <Notice title="No dashboard on this server">This server runs without sign-in, so there are no accounts to show here.</Notice>
        ) : (
          <>
            {!DASHBOARD_DEMO && (
              <ProfileControls profiles={profiles} current={current} onPick={pick} onAdd={addProfile} />
            )}
            <section id="posts" aria-labelledby="posts-heading" className="min-w-0 scroll-mt-6">
              <h2 id="posts-heading" className={sectionHeading}>Posts</h2>
              {current?.accounts?.length ? (
                <Posts key={current.id} profileId={current.id} demo={DASHBOARD_DEMO} />
              ) : (
                <p className={`${panel} px-4 py-4 text-sm text-muted`}>Connect a social account to see its published posts.</p>
              )}
            </section>

            <div className="grid min-w-0 items-start gap-6 md:grid-cols-[1.2fr_minmax(0,1fr)]">
              <section id="social-accounts" aria-labelledby="social-accounts-heading" className="min-w-0 scroll-mt-6">
                <h2 id="social-accounts-heading" className={sectionHeading}>Social accounts</h2>
                {current && <ProfilePanel key={current.id} profile={current} demo={DASHBOARD_DEMO} />}
              </section>
              <section id="agent-setup" aria-labelledby="agent-setup-heading" className="min-w-0 scroll-mt-6">
                <h2 id="agent-setup-heading" className={sectionHeading}>Agent setup</h2>
                <div className="grid gap-4">
                  <div className={panel}>
                    <h3 className="px-4 pb-1 pt-3 text-sm font-medium">Add Distro to your agent</h3>
                    <p className="px-4 pb-1 text-sm leading-relaxed text-muted">
                      Run this once in Claude Code. See{" "}
                      <a href="/#install" className="text-fg underline underline-offset-4">Setup</a>
                      {" "}for other clients.
                    </p>
                    <Command text={MCP_INSTALL} />
                  </div>
                  <ApiKeys keys={me.api_keys ?? []} />
                </div>
              </section>
            </div>
          </>
        )}
      </main>
    </>
  );
}
