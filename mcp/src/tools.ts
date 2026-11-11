import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { env, PLATFORMS, type Props, type Scope } from "./env";
import { generateVideo, getJob, MODELS } from "./inference";
import { connectUrl, createPost, listAccounts } from "./zernio";

type Tool<S extends z.ZodRawShape = z.ZodRawShape> = {
  scope: Scope;
  description: string;
  input: S;
  run: (workspaceId: string, args: z.infer<z.ZodObject<S>>) => Promise<unknown>;
};
const tool = <S extends z.ZodRawShape>(t: Tool<S>) => t as unknown as Tool;

const platform = z.enum(PLATFORMS);

/** Every tool, once. MCP and REST are two doors onto this table. */
export const TOOLS: Record<string, Tool> = {
  connect_account: tool({
    scope: "accounts",
    description: "Get a link the user opens to connect a social account. Give the link to the user; the account is linked once they approve.",
    input: { platform },
    run: async (ws, a) => ({ platform: a.platform, auth_url: await connectUrl(ws, a.platform, env.ORIGIN) }),
  }),
  list_accounts: tool({
    scope: "accounts",
    description: "List connected social accounts and whether each is still active.",
    input: { platform: platform.optional() },
    run: async (ws, a) => {
      const accounts = await listAccounts(ws);
      return { accounts: a.platform ? accounts.filter((x) => x.platform === a.platform) : accounts };
    },
  }),
  list_models: tool({
    scope: "video",
    description: "List the generation models this server can call.",
    input: { kind: z.enum(["video", "audio"]).optional() },
    run: async (_ws, a) => ({ models: MODELS.filter((m) => !a.kind || m.kind === a.kind) }),
  }),
  generate_video: tool({
    scope: "video",
    description: "Start a video generation job. Returns a job_id right away; poll get_job for the result.",
    input: {
      model: z.enum(MODELS.map((m) => m.id) as [string, ...string[]]).default(MODELS[0].id),
      prompt: z.string().min(1).max(2000),
    },
    run: (ws, a) => generateVideo(ws, a),
  }),
  get_job: tool({
    scope: "video",
    description: "Status of a generation job, and the video URL once it is ready.",
    input: { job_id: z.string().regex(/^job_[0-9a-f-]+$/) },
    run: (ws, a) => getJob(ws, a.job_id),
  }),
  publish: tool({
    scope: "publish",
    description:
      "Post a video to connected accounts. dry_run defaults to true and only returns what would be sent; set dry_run false only when the user has clearly asked to post.",
    input: {
      video_url: z.string().url(),
      caption: z.string().max(2200),
      platforms: z.array(platform).min(1),
      schedule_at: z.string().datetime({ offset: true }).optional(),
      dry_run: z.boolean().default(true),
    },
    run: async (ws, a) => {
      const accounts = await listAccounts(ws);
      const targets = a.platforms.map((p) => {
        const account = accounts.find((x) => x.platform === p && x.active !== false);
        if (!account) throw new Error(`No connected ${p} account. Call connect_account first.`);
        return { platform: p, accountId: account.account_id };
      });
      const payload = {
        content: a.caption,
        mediaItems: [{ type: "video", url: a.video_url }],
        platforms: targets,
        ...(a.schedule_at ? { scheduledFor: a.schedule_at, timezone: "UTC" } : { publishNow: true }),
      };
      if (a.dry_run) return { dry_run: true, message: "Dry-run only; nothing was posted.", payload };
      const { post } = await createPost(payload);
      return { dry_run: false, post_id: post?._id, status: post?.status };
    },
  }),
};

async function runTool(name: string, props: Props | undefined, args: unknown): Promise<unknown> {
  const t = TOOLS[name];
  if (!t) throw new Error(`Unknown tool: ${name}`);
  if (!props?.workspaceId) throw new Error("Not authorized.");
  if (!props.scopes.includes(t.scope)) throw new Error(`This token lacks the "${t.scope}" scope. Re-authorize and grant it.`);
  return t.run(props.workspaceId, z.object(t.input).parse(args ?? {}));
}

function createServer() {
  const server = new McpServer({ name: "Distro", version: "0.1.0" });
  for (const [name, t] of Object.entries(TOOLS)) {
    server.registerTool(name, { description: t.description, inputSchema: z.object(t.input) }, async (args: unknown) => {
      try {
        const result = await runTool(name, getMcpAuthContext()?.props as Props | undefined, args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text" as const, text: e instanceof Error ? e.message : "Tool failed." }] };
      }
    });
  }
  return server;
}

const handler = createMcpHandler(createServer);

export const mcpHandler = {
  fetch: (req: Request, e: unknown, ctx: ExecutionContext) => handler(req, e as never, ctx),
};

/** REST: POST /api/tools/<name> with a JSON body of the tool's arguments. Same token, same scopes. */
export const apiHandler = {
  async fetch(req: Request, _e: unknown, ctx: ExecutionContext): Promise<Response> {
    const name = new URL(req.url).pathname.match(/^\/api\/tools\/([a-z_]+)$/)?.[1];
    if (!name || !TOOLS[name]) return Response.json({ error: "not_found", tools: Object.keys(TOOLS) }, { status: 404 });
    if (req.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "POST" } });
    try {
      const args = await req.json().catch(() => ({}));
      return Response.json(await runTool(name, ctx.props as Props | undefined, args));
    } catch (e) {
      const bad = e instanceof z.ZodError;
      return Response.json(
        { error: bad ? "invalid_arguments" : "tool_failed", message: bad ? z.prettifyError(e) : (e as Error).message },
        { status: bad ? 400 : 422 },
      );
    }
  },
};
