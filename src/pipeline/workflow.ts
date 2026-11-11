import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { CostMeter, isDone, isFailed, outcomeUrl, queueGet, queueSubmit } from "../adapters/gmi";
import { getHook, getJob, mergeJobParams, resolveAssets, updateJob } from "../db/client";
import { safeJson, usd, type Env } from "../env";
import { fileUrl } from "../files/proxy";
import { commit, release } from "../guardrails/spend";
import { MODELS, TTS_VOICE_DEFAULT, ttsCostCents, wanCostCents } from "../models";
import { WAN_NEGATIVE, wanHookPrompt } from "../prompts";
import { getBrand } from "./brand";
import { edit, estimateSpeechMs, probe, timedCaptions, type Caption, type EditMeta, type EditRequest } from "./edit";
import type { JobParams } from "./generate";
import { failedIds, FIXABLE, isHardFail, runSanity, type SanityAction } from "./sanity";

type Params = { job_id: string };

const RETRY = { retries: { limit: 2, delay: "5 seconds" as const, backoff: "linear" as const }, timeout: "2 minutes" as const };
const NO_RETRY = { retries: { limit: 0, delay: "1 second" as const }, timeout: "5 minutes" as const };

async function copyToR2(env: Env, url: string, key: string, contentType: string): Promise<number> {
  const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const length = Number(res.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > 0) {
    const put = await env.BUCKET.put(key, res.body, { httpMetadata: { contentType } });
    return put.size;
  }
  const buf = await res.arrayBuffer();
  await env.BUCKET.put(key, buf, { httpMetadata: { contentType } });
  return buf.byteLength;
}

/**
 * tts -> wan (sleep-polled) -> edit -> sanity -> commit.
 * Every paid call sits under the reservation make_video took on the Durable
 * Object (key = job id). Step results are small JSON; media goes to R2.
 */
export class MakeVideoWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const env = this.env;
    const jobId = event.payload.job_id;
    let spentCents = 0;
    const notes: string[] = [];

    try {
      const ctx = await step.do("load", RETRY, async () => {
        const job = await getJob(env, jobId);
        if (!job) throw new Error("job row missing");
        const params = safeJson<JobParams>(job.params_json, {} as JobParams);
        const hook = await getHook(env, params.hook_id);
        if (!hook) throw new Error("hook missing");
        const brand = await getBrand(env);
        await updateJob(env, jobId, { status: "running", step: "tts" });
        return {
          params,
          hook: { id: hook.id, hook: hook.hook, body: hook.body ?? "", cta: hook.cta ?? brand?.cta ?? "" },
          tone: brand?.tone ?? null,
          audience: brand?.audience ?? null,
        };
      });
      const { params, hook } = ctx;
      const base = params.base_url;
      const hookKey = `videos/${jobId}/hook.mp4`;
      const ttsHookKey = `videos/${jobId}/tts_hook.mp3`;
      const ttsBodyKey = `videos/${jobId}/tts.mp3`;
      const finalKey = `videos/${jobId}/final.mp4`;
      const bodyText = `${hook.body} ${hook.cta}`.trim();

      // ---------- TTS: hook line and body narration as two clips.
      const ttsIds = await step.do("tts-submit", RETRY, async () => {
        const submit = async (text: string) => (text ? (await queueSubmit(env, MODELS.tts, { text, voice_id: TTS_VOICE_DEFAULT, format: "mp3", speed: 1.05 })).request_id : null);
        return { hook: await submit(hook.hook), body: await submit(bodyText) };
      });

      let tts: { hook: boolean; body: boolean; pending: boolean; failed?: string } = { hook: false, body: false, pending: true };
      for (let i = 0; i < 30 && tts.pending; i++) {
        await step.sleep(`tts-wait-${i}`, i === 0 ? "3 seconds" : "5 seconds");
        tts = await step.do(`tts-poll-${i}`, RETRY, async () => {
          const out = { hook: tts.hook, body: tts.body, pending: false, failed: tts.failed };
          for (const [which, id, key] of [["hook", ttsIds.hook, ttsHookKey], ["body", ttsIds.body, ttsBodyKey]] as const) {
            if (!id || out[which]) continue;
            const r = await queueGet(env, id);
            if (isDone(r.status)) {
              const url = outcomeUrl(r);
              if (!url) throw new Error("TTS finished without a media URL");
              await copyToR2(env, url, key, "audio/mpeg");
              out[which] = true;
            } else if (isFailed(r.status)) {
              out.failed = `${which}: ${r.error ?? r.status}`;
            } else {
              out.pending = true;
            }
          }
          return out;
        });
        if (tts.failed) break;
      }
      const ttsChars = (tts.hook ? hook.hook.length : 0) + (tts.body ? bodyText.length : 0);
      if (ttsChars) spentCents += ttsCostCents(ttsChars);
      if (!tts.hook || (bodyText && !tts.body)) notes.push(`Voiceover was incomplete (${tts.failed ?? "timed out"}); the cut uses captions and a quiet bed where the voice is missing.`);

      const voice = await step.do("tts-probe", RETRY, async () => {
        const dur = async (ok: boolean, key: string, text: string) => {
          if (!ok) return 0;
          try {
            return (await probe(env, await fileUrl(env, base, key))).duration_ms;
          } catch {
            return estimateSpeechMs(text);
          }
        };
        return { hook_ms: await dur(tts.hook, ttsHookKey, hook.hook), body_ms: await dur(tts.body, ttsBodyKey, bodyText) };
      });

      // ---------- Talking-head hook (Wan). Tries the TTS as audio_url once, then without.
      let haveHookVideo = false;
      if (params.want_talking_head) {
        await step.do("mark-wan", RETRY, () => updateJob(env, jobId, { status: "waiting_render", step: "wan" }));
        const attempts: boolean[] = tts.hook ? [true, false] : [false];
        for (let a = 0; a < attempts.length && !haveHookVideo; a++) {
          const audioDriven = attempts[a];
          const submitted = await step.do(`wan-submit-${a}`, NO_RETRY, async () => {
            const payload: Record<string, unknown> = {
              prompt: wanHookPrompt(hook.hook, ctx.tone, ctx.audience),
              negative_prompt: WAN_NEGATIVE,
              resolution: params.resolution,
              ratio: "9:16",
              duration: params.hook_duration_s,
              watermark: false,
              prompt_extend: true,
            };
            if (audioDriven) payload.audio_url = await fileUrl(env, base, ttsHookKey, 3600);
            try {
              const r = await queueSubmit(env, MODELS.video, payload);
              await updateJob(env, jobId, { gmi_request_id: r.request_id });
              return { id: r.request_id, error: null as string | null };
            } catch (e) {
              return { id: null as string | null, error: String(e instanceof Error ? e.message : e).slice(0, 240) };
            }
          });
          if (!submitted.id) {
            notes.push(`Render submit ${audioDriven ? "with voice-driven lips " : ""}failed: ${submitted.error}`);
            continue;
          }
          let state: { status: string; error: string | null; saved: boolean } = { status: "queued", error: null, saved: false };
          for (let i = 0; i < 26; i++) {
            await step.sleep(`wan-wait-${a}-${i}`, i === 0 ? "20 seconds" : "30 seconds");
            state = await step.do(`wan-poll-${a}-${i}`, RETRY, async () => {
              const r = await queueGet(env, submitted.id!);
              if (isDone(r.status)) {
                const url = outcomeUrl(r);
                if (!url) return { status: "failed", error: "render finished without a video URL", saved: false };
                await copyToR2(env, url, hookKey, "video/mp4");
                return { status: "success", error: null, saved: true };
              }
              return { status: isFailed(r.status) ? "failed" : r.status, error: r.error ?? null, saved: false };
            });
            if (state.saved || state.status === "failed") break;
          }
          if (state.saved) {
            haveHookVideo = true;
            spentCents += wanCostCents(params.resolution, params.hook_duration_s);
            if (!audioDriven && tts.hook) notes.push("Hook was rendered without voice-driven lip sync; the voiceover is mixed over it.");
          } else if (state.status === "failed") {
            notes.push(`Render ${audioDriven ? "with voice-driven lips " : ""}failed and was not billed: ${state.error ?? "no reason given"}`);
          } else {
            notes.push("Render did not finish within 13 minutes; it may still be billed upstream.");
            spentCents += wanCostCents(params.resolution, params.hook_duration_s);
            break;
          }
        }
        if (!haveHookVideo) notes.push("Talking-head render was unavailable, so the hook is an on-screen text card.");
      }

      // ---------- Edit.
      await step.do("mark-edit", RETRY, () => updateJob(env, jobId, { status: "editing", step: "edit" }));
      const buildEdit = async (): Promise<EditRequest> => {
        const assets = (await resolveAssets(env, params.body_assets)).filter((a) => a.banned === 0);
        if (!assets.length) throw new Error("No usable body footage is left for this job (all sources are flagged or missing).");
        let hookMs: number;
        if (haveHookVideo) {
          try {
            hookMs = (await probe(env, await fileUrl(env, base, hookKey))).duration_ms;
          } catch {
            hookMs = params.hook_duration_s * 1000;
          }
        } else {
          hookMs = Math.min(8000, Math.max(2500, voice.hook_ms + 500));
        }
        const bodyStart = Math.max(hookMs, voice.hook_ms + 150);
        const target = Math.min(20_000, Math.max(5000, voice.body_ms + 700));
        const perClip = Math.ceil(target / assets.length);
        const available = assets.reduce((s, a) => s + Math.min(a.duration_ms ?? perClip, perClip), 0);
        const bodyLen = Math.min(target, available);
        const speechMs = voice.body_ms || estimateSpeechMs(bodyText);

        const captions: Caption[] = [
          ...timedCaptions(hook.hook, 0, Math.min(voice.hook_ms || estimateSpeechMs(hook.hook), hookMs)),
          ...timedCaptions(bodyText, bodyStart, speechMs),
        ].filter((c) => c.start_ms < hookMs + bodyLen - 300);

        const audio: { url: string; start_ms: number }[] = [];
        if (tts.hook) audio.push({ url: await fileUrl(env, base, ttsHookKey), start_ms: 0 });
        if (tts.body) audio.push({ url: await fileUrl(env, base, ttsBodyKey), start_ms: bodyStart });
        const icon = await env.BUCKET.head("brand/icon.png");

        return {
          job_id: jobId,
          output_key: finalKey,
          width: 1080,
          height: 1920,
          ...(haveHookVideo ? { hook: { url: await fileUrl(env, base, hookKey), r2_key: hookKey } } : { hook_text: hook.hook, hook_duration_ms: hookMs }),
          body: await Promise.all(assets.map(async (a) => ({ url: await fileUrl(env, base, a.r2_key), r2_key: a.r2_key, max_ms: perClip }))),
          body_max_ms: target,
          ...(audio.length ? { audio } : {}),
          captions,
          ai_label: true,
          cta: hook.cta || undefined,
          ...(icon ? { end_card_icon_url: await fileUrl(env, base, "brand/icon.png") } : {}),
        };
      };

      let editMeta: EditMeta = await step.do("edit", { retries: { limit: 1, delay: "10 seconds" }, timeout: "6 minutes" }, async () => edit(env, await buildEdit()));
      await step.do("save-edit", RETRY, async () => {
        await mergeJobParams(env, jobId, { edit_meta: editMeta, hook_mode: haveHookVideo ? "talking_head" : "text_card" });
        await updateJob(env, jobId, { status: "checking", step: "sanity", final_r2_key: finalKey });
      });

      // ---------- Sanity, with one forced re-edit for fixable failures.
      const script = `Hook: ${hook.hook}\nBody: ${hook.body}\nCTA: ${hook.cta}`;
      const check = (actions: SanityAction[], n: number) =>
        step.do(`sanity-${n}`, { retries: { limit: 1, delay: "5 seconds" }, timeout: "3 minutes" }, async () => {
          const meter = new CostMeter();
          const report = await runSanity(env, base, { jobId, finalKey, hookId: hook.id, editMeta, sourceAssetIds: params.body_assets, script, actions }, meter);
          return { report, llm_cents_x100: Math.round(meter.usd * 10_000) };
        });
      let llmUsd = 0;
      let sanity = await check([], 0);
      llmUsd += sanity.llm_cents_x100 / 10_000;
      const failed = failedIds(sanity.report);
      if (failed.length && !isHardFail(failed) && failed.every((id) => FIXABLE.has(id) || id === "length")) {
        const fixable = failed.filter((id) => FIXABLE.has(id));
        if (fixable.length) {
          editMeta = await step.do("re-edit", { retries: { limit: 1, delay: "10 seconds" }, timeout: "6 minutes" }, async () => edit(env, await buildEdit()));
          const actions: SanityAction[] = fixable.map((id) => ({ id, did: "re-edit with crop, captions, voice bed and AI label forced on", ok: true }));
          await step.do("save-re-edit", RETRY, () => mergeJobParams(env, jobId, { edit_meta: editMeta, sanity_actions: actions }).then(() => undefined));
          sanity = await check(actions, 1);
          llmUsd += sanity.llm_cents_x100 / 10_000;
        }
      }
      spentCents += Math.ceil(llmUsd * 100);

      // ---------- Commit real cost.
      const verdict = sanity.report.verdict;
      await step.do("commit", RETRY, async () => {
        await commit(env, jobId, spentCents, { job_id: jobId, model: MODELS.video, note: `final ${verdict}` });
        await mergeJobParams(env, jobId, {
          notes,
          cost_breakdown: {
            render_usd: haveHookVideo ? usd(wanCostCents(params.resolution, params.hook_duration_s)) : 0,
            voice_usd: usd(ttsChars ? ttsCostCents(ttsChars) : 0),
            checks_usd: Math.round(llmUsd * 10_000) / 10_000,
          },
        });
        await updateJob(env, jobId, {
          status: verdict === "discard" ? "discarded" : "ready",
          step: null,
          actual_cents: spentCents,
          error: verdict === "discard" ? `Sanity check failed: ${failedIds(sanity.report).join(", ")}. See sanity.items; fix the cause (different footage, shorter line) and call make_video again.` : null,
        });
      });
      return { job_id: jobId, verdict, actual_cents: spentCents };
    } catch (e) {
      const message = String(e instanceof Error ? e.message : e).slice(0, 400);
      await step.do("fail", RETRY, async () => {
        // Money already spent upstream is recorded honestly; an untouched reserve is released.
        if (spentCents > 0) await commit(env, jobId, spentCents, { job_id: jobId, model: MODELS.video, note: "job failed after paid steps" });
        else await release(env, jobId, { job_id: jobId, note: "job failed before any paid step" });
        await mergeJobParams(env, jobId, { notes });
        await updateJob(env, jobId, { status: "failed", actual_cents: spentCents, error: `${message}${spentCents ? ` ($${usd(spentCents).toFixed(2)} was already spent on voice/render.)` : " Nothing was charged."}` });
      });
      return { job_id: jobId, verdict: "failed", actual_cents: spentCents };
    }
  }
}
