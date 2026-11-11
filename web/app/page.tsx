import { Suspense } from "react";
import { ArrowRight, GithubLogo } from "@phosphor-icons/react/dist/ssr";
import { Code, CodeTabs, CopyButton } from "./code-tabs";
import { ConnectPanel } from "./connect-panel";
import { SignInButton } from "./me";
import { isPlatform } from "./platforms";
import { GROUPS } from "./tools";

const BASE = process.env.NEXT_PUBLIC_DISTRO_URL?.replace(/\/$/, "") || "https://mcp.trydistro.app";
const REPO = "https://github.com/YouMingYeh/Distro";
const INSTALL = `claude mcp add --transport http distro ${BASE}/mcp`;

const FLOWS = [
  {
    title: "Video models as jobs.",
    lead: "Renders take minutes. Agents should not wait on them, so every model runs behind the same three calls.",
    steps: [
      ["Pick a model", "list_models returns what the server can call, so the agent never guesses an id."],
      ["Start a job", "generate_video answers at once with a job id. A render never blocks a tool call."],
      ["Collect the file", "get_job reports progress, then a video URL you can hand straight to publish."],
    ],
  },
  {
    title: "Paid ads, dry-run first.",
    lead: "Meta, TikTok, Google, LinkedIn, X, Pinterest, Reddit and Microsoft ad accounts behind one set of tools. Nothing is spent until you say so.",
    steps: [
      ["Connect an ad account", "connect_ads returns a consent link. list_ad_accounts shows what each connection can spend from, with currency and billing state."],
      ["Boost or create", "boost_post promotes a post you already published. create_ad builds a new ad from a video or image. Both only preview the request until dry_run is turned off."],
      ["Watch and pause", "list_ads and get_ad_analytics report spend, impressions and clicks day by day. set_ad_status pauses an ad in one call."],
    ],
  },
];

// Example payloads. Shapes follow the tool contracts; values are illustrative.
const SAMPLES = {
  "Connect an account": {
    MCP: `// tools/call
{
  "name": "connect_account",
  "arguments": { "platform": "tiktok" }
}

// result
{
  "platform": "tiktok",
  "auth_url": "https://www.tiktok.com/v2/auth/authorize?client_key=..."
}`,
    REST: `curl ${BASE}/api/tools/connect_account \\
  -H "Authorization: Bearer $DISTRO_API_KEY" \\
  -d '{ "platform": "tiktok" }'

# 200
{
  "platform": "tiktok",
  "auth_url": "https://www.tiktok.com/v2/auth/authorize?client_key=..."
}`,
    Skill: `You     Connect my TikTok.

Agent   Open this link to approve access:
        https://www.tiktok.com/v2/auth/authorize?client_key=...
        I will confirm once the account is linked.`,
  },
  "Generate a video": {
    MCP: `// tools/call
{
  "name": "generate_video",
  "arguments": { "model": "<model id>", "prompt": "..." }
}

// result
{
  "job_id": "job_...",
  "status": "queued",
  "poll": "get_job"
}`,
    REST: `curl ${BASE}/api/tools/generate_video \\
  -H "Authorization: Bearer $DISTRO_API_KEY" \\
  -d '{ "model": "<model id>", "prompt": "..." }'

# then poll
curl ${BASE}/api/tools/get_job \\
  -H "Authorization: Bearer $DISTRO_API_KEY" \\
  -d '{ "job_id": "job_..." }'`,
    Skill: `You     Make a short video for the launch.

Agent   Rendering now.
        I will check back when the video is ready.`,
  },
  "Publish": {
    MCP: `// tools/call
{
  "name": "publish",
  "arguments": {
    "video_url": "https://...",
    "caption": "...",
    "platforms": ["tiktok"],
    "dry_run": true
  }
}

// result
{
  "dry_run": true,
  "message": "Dry-run only; nothing was posted."
}`,
    REST: `curl ${BASE}/api/tools/publish \\
  -H "Authorization: Bearer $DISTRO_API_KEY" \\
  -d '{
    "video_url": "https://...",
    "caption": "...",
    "platforms": ["tiktok"],
    "dry_run": true
  }'`,
    Skill: `You     Queue it for TikTok tomorrow at 9.

Agent   Here is the dry run. Nothing was posted.
        Say "post it" when you want it to go live.`,
  },
  "Run an ad": {
    MCP: `// tools/call
{
  "name": "boost_post",
  "arguments": {
    "post_id": "<post_id from publish>",
    "account_id": "<from list_ad_accounts>",
    "ad_account_id": "<from list_ad_accounts>",
    "name": "Launch boost",
    "goal": "video_views",
    "budget_amount": 20,
    "budget_type": "daily",
    "countries": ["US"],
    "dry_run": true
  }
}

// result
{
  "dry_run": true,
  "message": "Dry-run only; no ad was created and nothing will be spent."
}`,
    REST: `curl ${BASE}/api/tools/boost_post \\
  -H "Authorization: Bearer $DISTRO_API_KEY" \\
  -d '{
    "post_id": "<post_id from publish>",
    "account_id": "<from list_ad_accounts>",
    "ad_account_id": "<from list_ad_accounts>",
    "name": "Launch boost",
    "goal": "video_views",
    "budget_amount": 20,
    "budget_type": "daily",
    "countries": ["US"],
    "dry_run": true
  }'`,
    Skill: `You     Put $20 a day behind yesterday's TikTok, US only.

Agent   Here is the dry run: $20 daily, video views, US.
        Nothing is spent yet. Confirm and I will start it.`,
  },
};

const OAUTH_FLOW = `POST /mcp
401  WWW-Authenticate: Bearer resource_metadata=
     "${BASE}/.well-known/oauth-protected-resource"

// discovery
GET  /.well-known/oauth-protected-resource
GET  /.well-known/oauth-authorization-server

// client id metadata document, or dynamic registration
POST /oauth/register

// authorization code with PKCE
GET  /authorize?response_type=code
       &code_challenge=...&code_challenge_method=S256
       &resource=${BASE}
       &scope=accounts video research publish ads managed
POST /oauth/token

POST /mcp
     Authorization: Bearer <access_token>`;

const primary =
  "inline-flex items-center gap-2 rounded-full bg-fg px-5 py-2.5 text-sm font-medium text-bg transition hover:opacity-90 active:scale-[0.98]";
const secondary =
  "inline-flex items-center gap-2 rounded-full border border-line px-5 py-2.5 text-sm font-medium transition hover:border-fg active:scale-[0.98]";
const h2 = "text-3xl font-semibold tracking-tight md:text-4xl";
const shell = "mx-auto w-full max-w-7xl px-4 md:px-8";

// Reads the callback params after a platform redirect; streamed so the page itself stays static.
async function Accounts({ searchParams }: Pick<PageProps<"/">, "searchParams">) {
  const sp = await searchParams;
  const connected =
    sp.connected && isPlatform(sp.platform)
      ? { platform: sp.platform, username: typeof sp.username === "string" ? sp.username : undefined }
      : undefined;
  return <ConnectPanel api={BASE} connected={connected} failed={typeof sp.error === "string"} />;
}

export default function Page({ searchParams }: PageProps<"/">) {
  return (
    <>
      <header className={`${shell} flex h-16 items-center justify-between`}>
        <a href="#" className="text-lg font-semibold tracking-tight">
          Distro
        </a>
        <nav className="flex items-center gap-6 text-sm">
          <a href="#tools" className="hidden text-muted transition hover:text-fg md:block">
            Tools
          </a>
          <a href="#interfaces" className="hidden text-muted transition hover:text-fg md:block">
            Interfaces
          </a>
          <a href="#auth" className="hidden text-muted transition hover:text-fg md:block">
            Auth
          </a>
          <a href="/docs" className="text-muted transition hover:text-fg">
            Docs
          </a>
          <span className="hidden sm:block">
            <a href="#install" className={primary}>
              Add to your agent
            </a>
          </span>
          <SignInButton />
        </nav>
      </header>

      <main>
        <section className={`${shell} grid items-center gap-12 py-14 md:grid-cols-[1.15fr_1fr] md:gap-16 md:py-20`}>
          <div>
            <h1 className="rise text-5xl font-semibold leading-[1.02] tracking-tighter md:text-7xl">
              Social ads infra for agents.
            </h1>
            <p className="rise mt-6 max-w-[46ch] text-lg leading-relaxed text-muted" style={{ "--i": 1 } as React.CSSProperties}>
              Give any agent the tools to connect social accounts, call video models, publish short-form video and run paid ads on it.
            </p>
            <div className="rise mt-8 flex flex-wrap gap-3" style={{ "--i": 2 } as React.CSSProperties}>
              <a href="#install" className={primary}>
                Add to your agent
                <ArrowRight size={16} />
              </a>
              <a href={REPO} className={secondary}>
                <GithubLogo size={16} />
                GitHub
              </a>
            </div>
          </div>
          <div className="rise" style={{ "--i": 3 } as React.CSSProperties}>
            <Suspense fallback={<ConnectPanel api={BASE} />}>
              <Accounts searchParams={searchParams} />
            </Suspense>
          </div>
        </section>

        <section id="tools" className={`${shell} scroll-mt-8 py-16 md:py-24`}>
          <h2 className={h2}>Tools your agent can call.</h2>
          <p className="mt-4 max-w-[60ch] text-muted">
            Each tool does one job and returns structured JSON. Every call is scoped to the workspace that authorized it.{" "}
            <a href="/docs#tools" className="text-fg underline underline-offset-4">
              Arguments and results are in the docs.
            </a>
          </p>
          <div className="mt-12 grid gap-4 md:grid-cols-2">
            {GROUPS.map(({ group, tools }, i) => (
              <div key={group} className={`rounded-xl p-6 ${i === 1 ? "bg-fg text-bg" : "border border-line bg-surface"}`}>
                <h3 className="text-sm font-medium">{group}</h3>
                <dl className={`mt-6 grid gap-6 ${i === 1 ? "sm:grid-cols-2" : ""}`}>
                  {tools.map(({ name, summary }) => (
                    <div key={name}>
                      <dt className="font-mono text-sm">
                        <a href={`/docs#${name}`} className="underline-offset-4 hover:underline">
                          {name}
                        </a>
                      </dt>
                      <dd className={`mt-1.5 text-sm leading-relaxed ${i === 1 ? "opacity-70" : "text-muted"}`}>{summary}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        </section>

        {FLOWS.map(({ title, lead, steps }, i) => (
          <section key={title} className={`border-line ${i ? "border-b" : "border-y"}`}>
            <div className={`${shell} py-16 md:py-20`}>
              <h2 className={h2}>{title}</h2>
              <p className="mt-4 max-w-[60ch] text-muted">{lead}</p>
              <dl className="mt-12 grid gap-8 md:grid-cols-3">
                {steps.map(([name, desc]) => (
                  <div key={name} className="border-l-2 border-accent pl-4">
                    <dt className="text-lg font-medium">{name}</dt>
                    <dd className="mt-1.5 max-w-[40ch] text-sm leading-relaxed text-muted">{desc}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </section>
        ))}

        <section id="interfaces" className={`${shell} scroll-mt-8 py-16 md:py-24`}>
          <h2 className={h2}>Three ways in. Same tools.</h2>
          <p className="mb-10 mt-4 max-w-[60ch] text-muted">
            MCP for agents, REST for your own backend, and a Skill that teaches an agent the whole loop in plain language.
          </p>
          <CodeTabs samples={SAMPLES} />
        </section>

        <section id="auth" className={`${shell} grid scroll-mt-8 items-start gap-10 py-16 md:grid-cols-2 md:gap-16 md:py-24`}>
          <div>
            <h2 className={h2}>OAuth 2.0 on both sides.</h2>
            <h3 className="mt-8 font-medium">Agent to Distro</h3>
            <p className="mt-2 max-w-[52ch] leading-relaxed text-muted">
              MCP clients discover the authorization server, identify themselves and get a scoped token with PKCE.
              Nobody pastes an API key into a chat.
            </p>
            <h3 className="mt-6 font-medium">Distro to social platforms</h3>
            <p className="mt-2 max-w-[52ch] leading-relaxed text-muted">
              Accounts are linked on each platform&apos;s own consent screen, through Zernio. Platform tokens stay on
              the server and never reach the agent.
            </p>
          </div>
          <div className="min-w-0 rounded-xl border border-line bg-surface p-5 md:p-6">
            <Code>{OAUTH_FLOW}</Code>
          </div>
        </section>

        <section id="install" className="scroll-mt-8 border-t border-line">
          <div className={`${shell} py-20 md:py-28`}>
            <h2 className="text-4xl font-semibold tracking-tighter md:text-6xl">Add one URL.</h2>
            <p className="mt-4 max-w-[52ch] text-muted">
              Works with any client that speaks MCP over Streamable HTTP. On first use your agent opens a page where you sign in, with Google if you like, and approve.
            </p>
            <div className="mt-10 flex max-w-3xl items-center justify-between gap-4 rounded-xl border border-line bg-surface p-4 pl-5">
              <code className="min-w-0 overflow-x-auto whitespace-nowrap font-mono text-sm">{INSTALL}</code>
              <CopyButton text={INSTALL} />
            </div>
          </div>
        </section>
      </main>

      <footer className={`${shell} flex flex-col gap-2 py-8 text-sm text-muted md:flex-row md:justify-between`}>
        <p>Distro. Publishing runs on Zernio.</p>
        <span className="flex gap-5">
          <a href="/docs" className="transition hover:text-fg">
            Docs
          </a>
          <a href="/privacy" className="transition hover:text-fg">
            Privacy
          </a>
          <a href={REPO} className="transition hover:text-fg">
            Source on GitHub
          </a>
        </span>
      </footer>
    </>
  );
}
