import { Suspense } from "react";
import { CaretDown, GithubLogo } from "@phosphor-icons/react/dist/ssr";
import { AgentDemo } from "./agent-demo";
import { Code, CodeTabs, CopyableLine } from "./code-tabs";
import { ConnectPanel } from "./connect-panel";
import { DistroMascot } from "./distro-mascot";
import { SignInButton } from "./me";
import { isPlatform } from "./platforms";
import { SetupTabs } from "./setup-tabs";
import { GROUPS } from "./tools";
import "./distro-brand.css";

const BASE = process.env.NEXT_PUBLIC_DISTRO_URL?.replace(/\/$/, "") || "https://mcp.trydistro.app";
const MCP_URL = `${BASE}/mcp`;
const REPO = "https://github.com/YouMingYeh/Distro";

const CAPABILITIES = [
  ["Connect your accounts", "Link the social accounts your agent can publish to."],
  ["Generate a video", "Give your agent a prompt and render a short clip."],
  ["Publish on your schedule", "Preview the post, then publish now or schedule it for later."],
];

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

const shell = "mx-auto w-full max-w-6xl px-5 sm:px-8";
const sectionHeading = "text-2xl font-semibold tracking-tight sm:text-3xl";

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
      <header className="border-b border-line">
        <div className={`${shell} flex h-16 items-center justify-between`}>
          <a href="/" className="inline-flex items-center gap-1.5 text-lg font-semibold tracking-tight">
            <DistroMascot className="size-8 shrink-0" />
            Distro
          </a>
          <nav aria-label="Main" className="flex items-center gap-3 text-sm sm:gap-5">
            <a href="#install" className="hidden text-muted transition-colors hover:text-fg md:inline">Setup</a>
            <a href="#tools" className="hidden text-muted transition-colors hover:text-fg md:inline">Tools</a>
            <a href="/docs" className="text-muted transition-colors hover:text-fg">Docs</a>
            <a href={REPO} aria-label="GitHub" className="inline-flex items-center gap-2 text-muted transition-colors hover:text-fg">
              <GithubLogo size={17} aria-hidden />
              <span className="hidden sm:inline">GitHub</span>
            </a>
            <SignInButton />
          </nav>
        </div>
      </header>

      <main className={shell}>
        <section aria-labelledby="hero-title" className="distro-hero">
          <div className="w-full min-w-0 text-center">
            <h1 id="hero-title" className="distro-hero-title">
              <span>MEET</span>{" "}
              <DistroMascot className="distro-hero-mascot" expression="greet" />{" "}
              <span>DISTRO</span>
            </h1>
            <p className="mx-auto mt-5 max-w-[52ch] text-pretty leading-relaxed text-muted sm:mt-6 sm:text-lg">
              Turn a prompt into a short-form video. Preview, schedule, and publish to your connected social accounts, all from your AI agent.
            </p>
            <div className="mx-auto mt-7 w-full max-w-md text-left">
              <p className="mb-2 text-sm font-medium">MCP server URL</p>
              <CopyableLine text={MCP_URL} label="Copy MCP server URL" primary />
            </div>
          </div>
          <AgentDemo mcpUrl={MCP_URL} />
        </section>

        <section id="install" aria-labelledby="install-title" className="scroll-mt-8 pb-12 md:pb-20">
          <h2 id="install-title" className={`${sectionHeading} mb-5`}>Connect your agent</h2>
          <SetupTabs mcpUrl={MCP_URL} />
        </section>

        <section id="tools" aria-labelledby="tools-title" className="scroll-mt-8 border-t border-line pb-14 pt-9 md:pb-20 md:pt-12">
          <div className="distro-capabilities-card">
            <div className="distro-capabilities-copy">
              <h2 id="tools-title" className="distro-capabilities-title">What you can do</h2>
              <dl className="mt-6 grid gap-4">
                {CAPABILITIES.map(([name, description]) => (
                  <div key={name}>
                    <dt className="font-semibold">{name}</dt>
                    <dd className="mt-0.5 text-pretty text-sm leading-relaxed text-muted sm:text-base">{description}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <div className="distro-capabilities-art">
              <DistroMascot className="distro-capabilities-mascot" expression="happy" lazy />
            </div>
          </div>

          <div id="accounts" className="mt-9 scroll-mt-8">
            <h3 className="mb-4 text-lg font-semibold tracking-tight">Social accounts</h3>
            <Suspense fallback={<ConnectPanel api={BASE} />}>
              <Accounts searchParams={searchParams} />
            </Suspense>
          </div>

          <details className="group mt-8 border-y border-line">
            <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-muted hover:text-fg [&::-webkit-details-marker]:hidden">
              Developer details
              <CaretDown size={16} aria-hidden className="group-open:rotate-180" />
            </summary>
            <div className="space-y-9 border-t border-line py-6">
              <div>
                <h3 className="font-semibold">Tools</h3>
                <p className="mb-4 mt-1 text-sm text-muted">
                  Find arguments and results in the <a href="/docs#tools" className="text-fg underline underline-offset-4">tool reference</a>.
                </p>
                <div className="grid gap-5 md:grid-cols-3">
                  {GROUPS.map(({ group, tools }) => (
                    <div key={group}>
                      <h4 className="mb-2 text-sm font-medium">{group}</h4>
                      <dl className="space-y-3">
                        {tools.map(({ name, summary }) => (
                          <div key={name}>
                            <dt className="font-mono text-[13px]">
                              <a href={`/docs#${name}`} className="underline-offset-4 hover:underline">{name}</a>
                            </dt>
                            <dd className="mt-0.5 text-sm leading-relaxed text-muted">{summary}</dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  ))}
                </div>
              </div>
              {FLOWS.map(({ title, lead, steps }) => (
                <div key={title}>
                  <h3 className="font-semibold">{title}</h3>
                  <p className="mb-3 mt-1 max-w-[65ch] text-sm leading-relaxed text-muted">{lead}</p>
                  <dl className="grid gap-4 text-sm md:grid-cols-3">
                    {steps.map(([name, description]) => (
                      <div key={name}>
                        <dt className="font-medium">{name}</dt>
                        <dd className="mt-0.5 leading-relaxed text-muted">{description}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
              <div id="interfaces">
                <h3 className="mb-3 font-semibold">MCP, REST, and Skill examples</h3>
                <CodeTabs samples={SAMPLES} />
              </div>
              <div id="auth">
                <h3 className="mb-3 font-semibold">OAuth 2.0</h3>
                <p className="mb-4 max-w-[65ch] text-sm leading-relaxed text-muted">
                  Agents authorize with Distro using PKCE. Social accounts are linked on each platform&apos;s consent
                  screen through Zernio. Platform tokens stay on the server.
                </p>
                <div className="rounded-lg border border-line bg-surface p-4">
                  <Code>{OAUTH_FLOW}</Code>
                </div>
              </div>
            </div>
          </details>
        </section>
      </main>
      <footer className={`${shell} flex flex-wrap gap-x-5 gap-y-2 border-t border-line py-6 text-sm text-muted`}>
        <p className="mr-auto">Distro. Publishing runs on Zernio.</p>
        <a href="/privacy" className="transition-colors hover:text-fg">Privacy</a>
        <a href={REPO} className="transition-colors hover:text-fg">Source on GitHub</a>
      </footer>
    </>
  );
}
