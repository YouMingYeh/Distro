import type { Env } from "../../env";
import { AdapterNotConfigured, type PublishInput, type PublishResult, type SchedulerAdapter } from "./types";

const ENDPOINT = "https://api.buffer.com";

/**
 * Buffer (GraphQL). A dry run only builds the payload; it never calls
 * createPost. The live path is best-effort and unverified against a real
 * account: check the mutation shape against Buffer's current API docs, and set
 * BUFFER_CHANNEL_ID-style routing in the caption/variables before relying on it.
 */
export function bufferAdapter(env: Env): SchedulerAdapter {
  return {
    id: "buffer",
    async publish(input: PublishInput): Promise<PublishResult> {
      const variables = {
        input: {
          text: input.caption,
          assets: { videos: [{ url: input.videoUrl }] },
          mode: input.scheduleAt ? "customScheduled" : "addToQueue",
          dueAt: input.scheduleAt ?? null,
          metadata: { tiktok: { isAiGenerated: true } },
        },
      };
      const query = "mutation CreatePost($input: CreatePostInput!) { createPost(input: $input) { ... on PostActionSuccess { post { id } } ... on MutationError { message } } }";
      const payload = { endpoint: ENDPOINT, query, variables };
      if (input.dryRun) {
        return { adapter: "buffer", dryRun: true, accepted: true, payload, message: "Dry-run only; this is the request that would be sent to Buffer. Nothing was posted." };
      }
      if (!env.BUFFER_ACCESS_TOKEN) throw new AdapterNotConfigured("Buffer adapter not configured: set BUFFER_ACCESS_TOKEN on the server.");
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.BUFFER_ACCESS_TOKEN}` },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      });
      const data = (await res.json().catch(() => ({}))) as { data?: { createPost?: { post?: { id?: string }; message?: string } }; errors?: { message: string }[] };
      const id = data.data?.createPost?.post?.id;
      const err = data.errors?.[0]?.message ?? data.data?.createPost?.message;
      return {
        adapter: "buffer",
        dryRun: false,
        accepted: res.ok && Boolean(id),
        externalId: id,
        payload,
        message: id ? "Sent to Buffer." : `Buffer did not accept the post: ${err ?? `HTTP ${res.status}`}`,
      };
    },
  };
}
