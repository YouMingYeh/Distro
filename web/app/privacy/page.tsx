import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy: Distro" };

const REPO = "https://github.com/YouMingYeh/Distro";

export default function Privacy() {
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-16 md:py-24">
      <h1 className="text-3xl font-semibold tracking-tight">Privacy</h1>
      <div className="mt-8 space-y-5 leading-relaxed text-muted">
        <p>
          Distro gives AI agents tools to connect social accounts, run video models and publish short-form video. This
          page says what it stores to do that.
        </p>
        <p>
          <strong className="text-fg">Sign-in.</strong> You sign in through Clerk, with Google if you choose. From
          Google we receive your name, email address and profile picture. We use them only to recognise your account.
        </p>
        <p>
          <strong className="text-fg">Connected social accounts.</strong> When you link a platform, you approve it on
          that platform&apos;s own consent screen. The resulting access tokens are held by our publishing provider,
          Zernio, and are never given to your agent. Distro stores which accounts belong to you.
        </p>
        <p>
          <strong className="text-fg">Agent access.</strong> Each agent you authorize gets a token limited to the
          scopes you approved. Distro stores those grants so you can use and revoke them.
        </p>
        <p>
          <strong className="text-fg">What we do not do.</strong> We do not sell your data, use it for advertising, or
          post to your accounts unless you or your agent ask for a post.
        </p>
        <p>
          <strong className="text-fg">Removal.</strong> To disconnect an account or delete your data, open an issue at{" "}
          <a href={REPO} className="underline transition hover:text-fg">
            the project repository
          </a>
          .
        </p>
      </div>
      <p className="mt-10 text-sm text-muted">
        <a href="/" className="transition hover:text-fg">
          Back to Distro
        </a>
      </p>
    </main>
  );
}
