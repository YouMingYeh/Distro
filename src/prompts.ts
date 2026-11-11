/**
 * All prompts are generic. Product truth comes only from the stored brand
 * profile (set_brand) or a brief the user passed in; nothing here names a
 * product.
 */

export const SAFETY_RULES = `Rules you must follow:
- The brand profile below is the ONLY source of product truth. Do not invent features, numbers, awards, prices, or user counts it does not state.
- No medical or health-outcome claims. No "saves your relationship" claims. No surveillance, spying, tracking-someone, or "always watching you" angles. No invented personal biographies presented as fact.
- Do not mention any city, country, or real person.
- Respect every item under "Claims to avoid".
- Hooks will be shown with an "AI-generated" label; never pretend the speaker is a real customer giving a real testimonial.
- Write like a person talking to a phone camera: plain words, specific images, no corporate ad voice, no hashtags, no emoji.`;

export function researchDistillPrompt(brandBrief: string, platform: string, assetsBlock: string): string {
  return `You are a short-form video strategist. You are given structured research summaries about what is performing on ${platform} right now (hook types, formats, rounded view counts, brands), and a brand profile.

Produce ORIGINAL work only:
- "patterns": 5 to 8 reusable hook patterns you can see in the research. For each: "hook_type" (e.g. question, bold claim, pov, problem, curiosity gap, before-after, list, story, demo, reaction), "format_family" (e.g. "talking head then screen"), "why" (one or two sentences in your own words on why it works; NEVER quote or closely paraphrase any source line), "brand_angle" (how this brand could use it without overclaiming), "evidence": {"view_band": "high"|"mid"|"low", "recency": string, "n_examples": integer}.
- "seed_hooks": 6 to 10 brand-new hook lines for THIS brand, each {"text": string (max 16 words), "pattern_index": integer index into patterns, "footage_hints": array of asset ids from the footage list that could prove the line, or []}.
- "notes": one sentence on anything you ignored. Ignore patterns from categories that do not fit this brand (for example follower-spy or dating-spy styles) and say so.

${SAFETY_RULES}

Brand profile:
${brandBrief}

Available footage (asset ids):
${assetsBlock || "(none uploaded yet)"}

Reply with a single JSON object: {"patterns": [...], "seed_hooks": [...], "notes": "..."}.`;
}

export function seedAdaptPrompt(brandBrief: string, platform: string, patternsBlock: string, assetsBlock: string): string {
  return `You are a short-form video strategist. Live research is unavailable, so you are given a list of GENERIC hook pattern types and a brand profile for ${platform}.

For each pattern you think fits this brand (pick 5 to 8), write a "brand_angle": one sentence on how this brand could use it without overclaiming. Then write 6 to 10 brand-new hook lines.

${SAFETY_RULES}

Brand profile:
${brandBrief}

Generic patterns:
${patternsBlock}

Available footage (asset ids):
${assetsBlock || "(none uploaded yet)"}

Reply with a single JSON object:
{"patterns": [{"seed_id": string, "brand_angle": string}], "seed_hooks": [{"text": string (max 16 words), "seed_id": string, "footage_hints": [asset ids or empty]}]}`;
}

export function hookGenPrompt(brandBrief: string, platform: string, n: number, patternsBlock: string, seedBlock: string, assetsBlock: string, defaultCta: string): string {
  return `You write short-form ${platform} video scripts. Propose ${n} DISTINCT candidates for the brand below. Spread them across different hook types and patterns; do not write ${n} variations of one idea.

Each candidate is a tiny script:
- "hook": the first line, spoken to camera, 5 to 16 words. It must make a stranger keep watching past 3 seconds.
- "body": 1 to 2 short spoken sentences (max 32 words total) that the uploaded product footage can prove on screen.
- "cta": a short closing line. Use this unless you have a clearly better short variant: "${defaultCta}"
- "pattern_id": the id of the pattern you used, or null.
- "want_talking_head": true if the hook works best said by a person to camera, false if it works better as bold on-screen text.
- "footage_hints": asset ids from the footage list that prove the body, or [].

${SAFETY_RULES}

Brand profile:
${brandBrief}

Patterns to draw from:
${patternsBlock || "(none; use your own judgment)"}

Seed ideas you may refine (optional):
${seedBlock || "(none)"}

Available footage (asset ids). Never reference anything not in this list:
${assetsBlock || "(none uploaded yet)"}

Reply with a single JSON object: {"candidates": [{"hook": "...", "body": "...", "cta": "...", "pattern_id": "...", "want_talking_head": true, "footage_hints": []}]}`;
}

export const POINTWISE_CRITERIA: { key: string; text: string }[] = [
  { key: "hook_strength", text: "Hook strength: would a stranger keep watching past 3 seconds?" },
  { key: "brand_fit", text: "Brand fit: true to the brand profile, with no overclaim." },
  { key: "specificity", text: 'Specificity: a concrete ritual or image, not a generic "best app ever".' },
  { key: "footage_fit", text: "Footage fit: can be proven with the available uploaded clips." },
  { key: "platform_fit", text: "Platform fit: spoken plus on-screen text would feel like UGC, not a TV ad." },
  { key: "safety", text: "Safety: no banned claim classes, nothing private or sensitive." },
];

export function pointwisePrompt(brandBrief: string, platform: string, criteria: { key: string; text: string }[], candidatesBlock: string, assetsBlock: string): string {
  return `You are a strict judge of short-form ${platform} hooks. Score every candidate below.

For each candidate, FIRST write one short sentence of reasoning, THEN give integer scores from 1 (bad) to 5 (excellent) on each criterion:
${criteria.map((c, i) => `${i + 1}. ${c.key} — ${c.text}`).join("\n")}

Be discriminating: most candidates should not get 5s. A hook that makes a claim the brand profile does not support gets brand_fit 1 and safety at most 2.

Brand profile:
${brandBrief}

Available footage:
${assetsBlock || "(none uploaded yet)"}

Candidates:
${candidatesBlock}

Reply with a single JSON object: {"scores": [{"i": <candidate number>, "reason": "...", ${criteria.map((c) => `"${c.key}": n`).join(", ")}}]}`;
}

export function pairwisePrompt(brandBrief: string, platform: string, a: string, b: string): string {
  return `You are judging two short-form ${platform} scripts for the same brand. Pick the one more likely to stop a stranger from scrolling AND stay true to the brand profile.

Brand profile:
${brandBrief}

Script A:
${a}

Script B:
${b}

Think briefly, then reply with a single JSON object: {"reason": "<one short sentence>", "winner": "A" or "B"}`;
}

export function sanityTextPrompt(brandBrief: string, script: string): string {
  return `You are a brand-safety reviewer for a short-form video ad. Check the script against the brand profile.

Fail "off_brand" if the script: makes a claim the profile does not support; makes a medical/health-outcome claim; promises to fix or save a relationship; uses a surveillance/spying/tracking angle; presents an invented biography as fact; names a city, country, or real person; or violates anything under "Claims to avoid". Otherwise pass.

Brand profile:
${brandBrief}

Script:
${script}

Reply with a single JSON object: {"off_brand_ok": true|false, "detail": "<one short sentence>"}`;
}

export const VISION_FRAMES_PROMPT = `You are screening frames from a video before it is posted publicly as a product ad. Look at ALL frames together and answer:
- "real_face": does any frame show a clearly identifiable real human face (a photo or video of a real person, not a cartoon, avatar, emoji, or illustration)?
- "personal_photo": does any frame look like a private personal photo (family, friends, selfies in a camera roll or chat) rather than product UI or stock-style content?
- "location_cue": is there a readable street sign, address, map pin with a place name, landmark, or other cue that reveals a specific real-world location?
- "confidence": "high", "medium", or "low" for your most serious finding.
- "detail": one short sentence. Do not describe or identify any person.

Reply with a single JSON object: {"real_face": bool, "personal_photo": bool, "location_cue": bool, "confidence": "...", "detail": "..."}`;

export function wanHookPrompt(hookLine: string, tone: string | null, audience: string | null): string {
  const who = audience ? `someone who looks like they belong to this audience: ${audience}` : "a friendly person in their twenties";
  return `Vertical selfie-style UGC video, handheld phone camera, natural indoor light, casual home setting. ${who} looks straight into the camera and says, with natural lip movement and ${tone || "a casual, upbeat"} energy: "${hookLine}" Authentic creator vibe, slight handheld movement, eye contact, no on-screen text, no captions, no logos, no phone screen or app UI visible.`;
}

export const WAN_NEGATIVE = "text, captions, subtitles, watermark, logo, user interface, distorted face, extra fingers, low quality, blurry";
