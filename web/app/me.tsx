"use client";

import { Fragment, useEffect, useState } from "react";
import { ArrowUpRight, ChatCircle, CheckCircle, Eye, Globe, Heart, Plus, WarningCircle } from "@phosphor-icons/react";
import { CopyButton } from "./code-tabs";
import { ROWS } from "./connect-panel";

const API = process.env.NEXT_PUBLIC_DISTRO_URL?.replace(/\/$/, "") || "https://mcp.trydistro.app";

type Account = { account_id: string; platform: string; username?: string; active?: boolean };
type Me = {
  sign_in: boolean; // false when the server runs without sign-in
  signed_in?: boolean;
  email?: string;
  profiles?: { id: string; name: string; default: boolean; accounts: Account[] | null }[];
  api_keys?: { id: string; name: string; ends_with: string; scopes: string[]; created: string }[];
};

/** Who is signed in, from the backend's session cookie. `undefined` while loading, `null` if it cannot be reached. */
function useMe() {
  const [me, setMe] = useState<Me | null>();
  useEffect(() => {
    fetch(`${API}/me`, { credentials: "include" })
      .then((r) => r.json())
      .then(setMe, () => setMe(null));
  }, []);
  return me;
}

const pill = "inline-flex items-center rounded-full border border-line px-4 py-2 text-sm font-medium transition hover:border-fg active:scale-[0.98]";

/** Header button: Sign in, or Dashboard once signed in. Renders nothing when the server has no sign-in. */
export function SignInButton() {
  const me = useMe();
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

const shell = "mx-auto w-full max-w-5xl px-4 md:px-8";
const panel = "min-w-0 rounded-xl border border-line bg-surface p-2";
const row = "flex min-h-14 items-center gap-3 rounded-lg px-4 py-2 transition hover:bg-bg";
const small = "inline-flex shrink-0 items-center gap-1 rounded-full border border-line px-3.5 py-1.5 text-sm transition hover:border-fg active:scale-[0.98]";
const MCP_INSTALL = `claude mcp add --transport http distro ${API}/mcp`;

type Profile = NonNullable<Me["profiles"]>[number];

function Mark({ path }: { path?: string }) {
  if (!path) return <Globe size={20} className="shrink-0" aria-hidden />;
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-5 shrink-0 fill-current">
      <path d={path} />
    </svg>
  );
}

function AccountRow({ account: a, name, path, href }: { account: Account; name: string; path?: string; href: string }) {
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
          <a href={href} className={small}>
            Reconnect
          </a>
        </>
      ) : (
        <>
          <span className="inline-flex items-center gap-1.5 text-sm text-accent">
            <CheckCircle size={16} weight="fill" />
            Connected
          </span>
          <a
            href={href}
            aria-label={`Connect another ${name} account`}
            title={`Connect another ${name} account`}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-line text-muted transition hover:border-fg hover:text-fg active:scale-[0.98]"
          >
            <Plus size={14} />
          </a>
        </>
      )}
    </li>
  );
}

function ProfilePanel({ profile: p }: { profile: Profile }) {
  const connect = (platform: string) => `${API}/connect/${platform}?profile=${p.id}&from=dashboard`;
  const accounts = p.accounts ?? [];
  const known = new Set<string>(ROWS.map((r) => r.id));
  return (
    <section className={panel}>
      <div className="flex items-baseline justify-between gap-3 px-4 pb-2 pt-3">
        <h2 className="text-sm font-medium">
          {p.name}
          {p.default && <span className="ml-2 font-normal text-muted">Default</span>}
        </h2>
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
              <a href={connect(r.id)} className={small}>
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

function PostCard({ post: p }: { post: Post }) {
  const [broken, setBroken] = useState(false);
  const r = ROWS.find((x) => x.id === p.platform);
  return (
    <li className="min-w-0">
      <a href={p.url} target="_blank" rel="noreferrer" className="group block">
        <div className="relative aspect-[9/16] overflow-hidden rounded-lg bg-bg">
          {p.thumbnail && !broken ? (
            // Platform CDN links are signed and expire, so a dead one falls back to the platform mark.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={p.thumbnail}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setBroken(true)}
              className="size-full object-cover transition group-hover:scale-[1.02]"
            />
          ) : (
            <div className="grid size-full place-items-center text-muted">
              <Mark path={r?.path} />
            </div>
          )}
          <div className="absolute inset-x-0 bottom-0 flex items-center gap-3 bg-gradient-to-t from-black/75 to-transparent px-2.5 pb-2 pt-8 text-xs font-medium text-white">
            <span className="inline-flex items-center gap-1">
              <Eye size={14} aria-label="Views" />
              {compact.format(p.views)}
            </span>
            <span className="inline-flex items-center gap-1">
              <Heart size={14} aria-label="Likes" />
              {compact.format(p.likes)}
            </span>
            <span className="inline-flex items-center gap-1">
              <ChatCircle size={14} aria-label="Comments" />
              {compact.format(p.comments)}
            </span>
          </div>
        </div>
        <p className="mt-2 line-clamp-2 text-sm leading-snug">{p.caption || "No caption"}</p>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
          <span className="truncate">{p.username ? `@${p.username}` : (r?.name ?? p.platform)}</span>
          {p.published && <span className="shrink-0">· {new Date(p.published).toLocaleDateString()}</span>}
        </p>
      </a>
    </li>
  );
}

/** Published posts for one profile with their numbers. Loads after the accounts, from its own request. */
function Posts({ profileId }: { profileId: string }) {
  const [posts, setPosts] = useState<Post[] | null>();
  useEffect(() => {
    fetch(`${API}/me/posts?profile=${profileId}`, { credentials: "include" })
      .then((r) => r.json())
      .then((d: { posts?: Post[] | null }) => setPosts(d.posts ?? null), () => setPosts(null));
  }, [profileId]);

  const sum = (k: "views" | "likes" | "comments" | "shares") => (posts ?? []).reduce((n, p) => n + p[k], 0);
  const stats: [string, number][] = [
    ["Posts", posts?.length ?? 0],
    ["Views", sum("views")],
    ["Likes", sum("likes")],
    ["Comments", sum("comments")],
  ];
  return (
    <section className={panel}>
      <div className="flex items-baseline justify-between gap-3 px-4 pb-2 pt-3">
        <h2 className="text-sm font-medium">Posts</h2>
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
          <dl className="grid grid-cols-2 gap-2 p-2 sm:grid-cols-4">
            {stats.map(([label, value]) => (
              <div key={label} className="rounded-lg bg-bg px-3 py-2.5">
                <dt className="text-xs text-muted">{label}</dt>
                <dd className="mt-0.5 text-2xl font-semibold tracking-tight tabular-nums">{compact.format(value)}</dd>
              </div>
            ))}
          </dl>
          <ul className="grid grid-cols-2 gap-x-3 gap-y-5 p-2 sm:grid-cols-3">
            {posts.slice(0, SHOWN).map((p) => (
              <PostCard key={p.id} post={p} />
            ))}
          </ul>
          {posts.length > SHOWN && (
            <p className="px-4 pb-3 pt-1 text-xs text-muted">
              Showing the {SHOWN} newest of {posts.length}. The totals count all of them.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function ApiKeys({ keys }: { keys: NonNullable<Me["api_keys"]> }) {
  return (
    <section className={panel}>
      <div className="flex items-baseline justify-between gap-3 px-4 pb-2 pt-3">
        <h2 className="text-sm font-medium">API keys</h2>
        <p className="font-mono text-xs text-muted">{keys.length}</p>
      </div>
      {keys.length ? (
        <ul>
          {keys.map((k) => (
            <li key={k.id} className={`${row} flex-wrap justify-between gap-y-0`}>
              <span className="min-w-0 text-sm">
                <span className="block truncate">{k.name}</span>
                <span className="block text-xs text-muted">
                  {k.scopes.join(", ")}, created {new Date(k.created).toLocaleDateString()}
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
  const me = useMe();
  const signedIn = me?.sign_in && me.signed_in;
  const profiles = (signedIn && me.profiles) || [];
  const count = profiles.reduce((n, p) => n + (p.accounts?.length ?? 0), 0);

  return (
    <>
      <header className={`${shell} flex h-16 items-center justify-between gap-4`}>
        <a href="/" className="text-lg font-semibold tracking-tight">
          Distro
        </a>
        {signedIn && (
          <nav className="flex min-w-0 items-center gap-4 text-sm">
            <span className="hidden truncate text-muted sm:block">{me.email}</span>
            <a href={`${API}/signout`} className={pill}>
              Sign out
            </a>
          </nav>
        )}
      </header>

      <main className={`${shell} pb-24 pt-10 md:pt-16`}>
        <h1 className="text-4xl font-semibold tracking-tighter md:text-5xl">Dashboard</h1>
        <p className="mb-10 mt-3 text-muted">
          {signedIn
            ? count
              ? `${count} ${count === 1 ? "account" : "accounts"} your agent can publish to.`
              : "Connect an account so your agent has somewhere to publish."
            : "Accounts and API keys for your Distro workspace."}
        </p>

        {me === undefined ? (
          <Skeleton />
        ) : me === null ? (
          <Notice title="The server could not be reached">Nothing was changed. Reload the page to try again.</Notice>
        ) : !me.sign_in ? (
          <Notice title="No dashboard on this server">This server runs without sign-in, so there are no accounts to show here.</Notice>
        ) : !me.signed_in ? (
          <Notice title="Sign in to see your accounts" action={{ href: `${API}/signin`, label: "Sign in" }}>
            Your connected accounts and API keys live in your workspace.
          </Notice>
        ) : (
          <div className="grid items-start gap-4 md:grid-cols-[1.5fr_1fr]">
            <div className="grid min-w-0 grid-cols-1 gap-4">
              {profiles.map((p) => (
                <Fragment key={p.id}>
                  <ProfilePanel profile={p} />
                  {!!p.accounts?.length && <Posts profileId={p.id} />}
                </Fragment>
              ))}
            </div>
            <div className="grid min-w-0 grid-cols-1 gap-4">
              <ApiKeys keys={me.api_keys ?? []} />
              <section className={panel}>
                <h2 className="px-4 pb-1 pt-3 text-sm font-medium">Add Distro to your agent</h2>
                <p className="px-4 pb-1 text-sm leading-relaxed text-muted">
                  Run this once in Claude Code. Other clients are on the{" "}
                  <a href="/#install" className="text-fg underline underline-offset-4">
                    home page
                  </a>
                  .
                </p>
                <Command text={MCP_INSTALL} />
              </section>
            </div>
          </div>
        )}
      </main>
    </>
  );
}
