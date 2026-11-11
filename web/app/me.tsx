"use client";

import { useEffect, useState } from "react";
import { PLATFORMS } from "./platforms";

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

const card = "rounded-xl border border-line bg-surface p-5";

export function Dashboard() {
  const me = useMe();
  if (me === undefined) return <p className="text-muted">Loading.</p>;
  if (me === null) return <p className="text-muted">The server could not be reached. Reload to try again.</p>;
  if (!me.sign_in) return <p className="text-muted">This server runs without sign-in, so there is no dashboard.</p>;
  if (!me.signed_in) {
    return (
      <a href={`${API}/signin`} className={pill}>
        Sign in to see your accounts
      </a>
    );
  }
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted">
          Signed in as <span className="text-fg">{me.email ?? "your account"}</span>
        </p>
        <a href={`${API}/signout`} className={pill}>
          Sign out
        </a>
      </div>

      {me.profiles?.map((p) => (
        <section key={p.id} className={card}>
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="font-medium">
              {p.name}
              {p.default && <span className="ml-2 text-xs text-muted">default profile</span>}
            </h2>
            <p className="font-mono text-xs text-muted">{p.id}</p>
          </div>
          {p.accounts === null ? (
            <p className="mt-3 text-sm text-muted">Connected accounts could not be loaded right now.</p>
          ) : p.accounts.length === 0 ? (
            <p className="mt-3 text-sm text-muted">No accounts connected yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-line text-sm">
              {p.accounts.map((a) => (
                <li key={a.account_id} className="flex items-center justify-between gap-3 py-2">
                  <span>
                    <span className="capitalize">{a.platform}</span>
                    {a.username && <span className="text-muted"> @{a.username}</span>}
                  </span>
                  <span className={a.active === false ? "text-muted" : "text-accent"}>
                    {a.active === false ? "Needs reconnecting" : "Connected"}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
            Connect:
            {PLATFORMS.map((id) => (
              <a key={id} href={`${API}/connect/${id}?profile=${p.id}`} className="capitalize underline-offset-4 transition hover:text-fg hover:underline">
                {id}
              </a>
            ))}
          </p>
        </section>
      ))}

      <section className={card}>
        <h2 className="font-medium">API keys</h2>
        {me.api_keys?.length ? (
          <ul className="mt-3 divide-y divide-line text-sm">
            {me.api_keys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center justify-between gap-x-3 py-2">
                <span>
                  {k.name} <span className="font-mono text-xs text-muted">dk_…{k.ends_with}</span>
                </span>
                <span className="text-muted">
                  {k.scopes.join(", ")} · {new Date(k.created).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted">No API keys yet.</p>
        )}
        <p className="mt-4 text-sm text-muted">
          Create or revoke keys from the CLI: <code className="font-mono text-fg">distro apikey create</code>
        </p>
      </section>
    </div>
  );
}
