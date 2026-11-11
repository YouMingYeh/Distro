/**
 * Build a GMI request-queue payload for ANY catalog video model from one normalized request.
 * TypeScript port of model_server/gmi_video.py. Reads src/data/gmi-video-models.json
 * (made by scripts/sync_gmi_catalog.py): each entry's `map` says which real parameter
 * plays each normalized role, so there is no per-model code here.
 */
import catalogJson from "../../src/data/gmi-video-models.json";

export type Param = {
  name: string;
  type?: string;
  required?: boolean;
  default_value?: unknown;
  min_value?: number;
  max_value?: number;
  options?: unknown[];
};

export type CatalogEntry = {
  id: string;
  provider: string | null;
  featured: string | null;
  description: string;
  text_to_video: boolean;
  image_to_video: boolean;
  supports_9_16: boolean;
  selectable: boolean;
  unmapped_required: string[];
  map: Record<string, Param>;
  price: {
    unit?: string | null;
    base_usd?: number;
    chart?: { dimensions?: { name: string; default?: unknown }[]; rates?: Record<string, unknown> };
    by_resolution_usd_per_s?: Record<string, number>;
    details?: string;
  };
  params: Param[];
};

export type Catalog = { generated_at: string; featured: Record<string, string[]>; models: CatalogEntry[] };
export const CATALOG = catalogJson as unknown as Catalog;

export type VideoRequest = {
  prompt: string;
  duration: number;
  aspect: string;
  resolution: string;
  negative_prompt?: string | null;
  first_frame?: string | null;
  last_frame?: string | null;
  audio_url?: string | null;
  audio: boolean;
  seed?: number | null;
};

export type Built = {
  model: string;
  payload: Record<string, unknown>;
  duration: number;
  est_usd: number;
  price_source: string;
  warnings: string[];
};

export class BuildError extends Error {}

/** Short side in pixels for '720p', '768P', '2K', '1280*720', 'std', 'pro'... */
export function px(v: unknown): number | null {
  const s = String(v).trim().toLowerCase();
  const named: Record<string, number> = { std: 720, fast: 720, pro: 1080, "4k": 2160, "2k": 1440, "8k": 4320 };
  if (s in named) return named[s];
  let m = s.match(/^(\d+)\s*[*x×]\s*(\d+)$/);
  if (m) return Math.min(Number(m[1]), Number(m[2]));
  m = s.match(/^(\d+)\s*p$/);
  if (m) return Number(m[1]);
  m = s.match(/^(\d)\s*k$/);
  if (m) return ({ 2: 1440, 4: 2160 } as Record<number, number>)[Number(m[1])] ?? null;
  return null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function nearest<T>(options: T[], target: number, key: (o: T) => number | null): T | null {
  let best: T | null = null;
  let bestScore = Infinity;
  for (const o of options) {
    const k = key(o);
    if (k === null) continue;
    const score = Math.abs(k - target);
    if (score < bestScore) {
      best = o;
      bestScore = score;
    }
  }
  return best;
}

function aspectOf(s: string): number | null {
  const [w, h] = s.split(":").map(num);
  return w && h ? w / h : null;
}

export function build(entry: CatalogEntry, req: VideoRequest): Built {
  const m = entry.map;
  const p: Record<string, unknown> = {};
  const warn: string[] = [];
  const wantPx = px(req.resolution) ?? 720;
  let duration = req.duration;

  if (!m.prompt) throw new BuildError(`${entry.id}: no prompt parameter`);
  p[m.prompt.name] = req.prompt;
  if (req.negative_prompt && m.negative_prompt) p[m.negative_prompt.name] = req.negative_prompt;

  // duration
  if (m.duration) {
    const d = m.duration;
    if (d.options?.length) {
      const opt = nearest(d.options, req.duration, num);
      if (opt !== null) {
        p[d.name] = opt;
        duration = num(opt) ?? req.duration;
      }
    } else {
      const lo = d.min_value ?? 1;
      const hi = d.max_value ?? 60;
      duration = Math.max(lo, Math.min(hi, req.duration));
      p[d.name] = d.type === "integer" ? Math.trunc(duration) : duration;
    }
  } else if (m.num_frames) {
    const fps = num(m.fps?.default_value) ?? 24;
    const nf = m.num_frames;
    let frames = Math.round(req.duration * fps) + 1;
    frames = Math.max(Math.trunc(nf.min_value ?? 1), Math.min(Math.trunc(nf.max_value ?? frames), frames));
    p[nf.name] = frames;
    if (m.fps) p[m.fps.name] = m.fps.type === "integer" ? Math.trunc(fps) : fps;
    duration = (frames - 1) / fps;
  }
  if (Math.abs(duration - req.duration) > 0.01) warn.push(`duration ${req.duration}s -> ${duration}s`);

  // aspect ratio / size / raw pixels
  const targetAr = aspectOf(req.aspect) ?? 9 / 16;
  if (m.aspect) {
    const opts = (m.aspect.options ?? []).map(String);
    if (opts.includes(req.aspect)) p[m.aspect.name] = req.aspect;
    else if (req.first_frame && opts.includes("adaptive")) p[m.aspect.name] = "adaptive";
    else warn.push(`aspect ${req.aspect} not offered (${opts.join(", ")}); output may need crop`);
  }
  if (m.size) {
    const opt = nearest(m.size.options ?? [], 0, (o) => {
      const [w, h] = String(o).split("*").map(num);
      if (!w || !h) return null;
      return Math.abs(w / h - targetAr) * 10_000 + Math.abs(Math.min(w, h) - wantPx); // aspect first
    });
    if (opt !== null) p[m.size.name] = opt;
  } else if (m.width && m.height) {
    const short = wantPx;
    const long = Math.round(short / Math.min(targetAr, 1 / targetAr) / 16) * 16;
    let [w, h] = targetAr < 1 ? [short, long] : [long, short];
    w = Math.min(w, m.width.max_value ?? w);
    h = Math.min(h, m.height.max_value ?? h);
    p[m.width.name] = w;
    p[m.height.name] = h;
  } else if (!m.aspect) {
    warn.push("model has no aspect control; output is likely 16:9");
  }

  // resolution (or Kling-style quality tier)
  if (m.resolution?.options?.length) {
    const opt = nearest(m.resolution.options, wantPx, px);
    if (opt !== null) {
      p[m.resolution.name] = opt;
      if (px(opt) !== wantPx) warn.push(`resolution ${req.resolution} -> ${String(opt)}`);
    }
  } else if (m.tier?.options?.length) {
    const opt = nearest(m.tier.options, wantPx, px);
    if (opt !== null) p[m.tier.name] = opt;
  }

  // media inputs
  const media: [string, string | null | undefined][] = [
    ["first_frame", req.first_frame],
    ["last_frame", req.last_frame],
    ["audio_drive", req.audio_url],
  ];
  for (const [slot, val] of media) {
    if (!val) continue;
    if (m[slot]) p[m[slot].name] = val;
    else if (slot === "first_frame" && m.reference_images) p[m.reference_images.name] = [val];
    else warn.push(`${slot} not supported by this model; ignored`);
  }
  if (m.task) {
    const opts = (m.task.options ?? []).map(String);
    const want = req.first_frame ? "image_to_video" : "text_to_video";
    if (opts.includes(want)) p[m.task.name] = want;
  }

  // switches
  if (m.audio_gen) {
    const opts = (m.audio_gen.options ?? []).map(String);
    p[m.audio_gen.name] = opts.includes("on") ? (req.audio ? "on" : "off") : req.audio;
  }
  if (m.watermark) p[m.watermark.name] = false;
  if (req.seed !== null && req.seed !== undefined && m.seed) p[m.seed.name] = req.seed;

  const missing = entry.params
    .filter((q) => q.required && !(q.name in p) && (q.default_value === null || q.default_value === undefined || q.default_value === ""))
    .map((q) => q.name);
  if (missing.length) throw new BuildError(`${entry.id}: required params not covered: ${missing.join(", ")}`);

  const [est, src] = estimate(entry, p, duration, req.audio);
  return { model: entry.id, payload: p, duration, est_usd: est, price_source: src, warnings: warn };
}

/** List-price estimate in USD. Conservative where the catalog is ambiguous. */
export function estimate(entry: CatalogEntry, payload: Record<string, unknown>, duration: number, audio: boolean): [number, string] {
  const price = entry.price;
  const unit = (price.unit ?? "second").toLowerCase();
  const mult = ["request", "video", "clip"].includes(unit) ? 1 : Math.ceil(duration);
  const resVals = ["resolution", "tier", "size"]
    .map((k) => entry.map[k])
    .filter((s): s is Param => !!s && s.name in payload)
    .map((s) => String(payload[s.name]));
  const resPx = resVals.length ? px(resVals[0]) : null;
  const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

  const chart = price.chart;
  if (chart?.rates) {
    let node: unknown = chart.rates;
    for (const dim of chart.dimensions ?? []) {
      if (!node || typeof node !== "object") break;
      const obj = node as Record<string, unknown>;
      let key: unknown;
      if (dim.name === "resolution") key = Object.keys(obj).find((k) => resPx !== null && px(k) === resPx) ?? dim.default;
      else if (dim.name === "audio") key = audio ? "true" : "false";
      else key = dim.default;
      node = obj[String(key).toLowerCase()] ?? obj[String(key)];
    }
    if (typeof node === "number") return [r4((node / 1_000_000) * mult), "price_chart"];
  }

  const byRes = price.by_resolution_usd_per_s ?? {};
  let rate: number | undefined = Object.entries(byRes).find(([k]) => resPx !== null && px(k) === resPx)?.[1];
  let src = "pricing_details";
  if (rate === undefined) {
    rate = price.base_usd ?? 0;
    src = "base_price";
  }
  // "$0.252 if audio is on", "$0.14 if 1080p"
  for (const mm of (price.details ?? "").matchAll(/\$\s*(\d+(?:\.\d+)?)\s+if\s+([\w.]+)/g)) {
    const c = mm[2].toLowerCase();
    if ((["audio", "sound"].includes(c) && audio) || (px(c) !== null && px(c) === resPx)) {
      rate = Math.max(rate, Number(mm[1]));
      src = `pricing_details (${mm[2]})`;
    }
  }
  return [r4(rate * mult), src];
}

/** A model id (case-insensitive) or a featured tier name (fast / default / quality). */
export function resolveModel(sel: string): CatalogEntry {
  const byId = new Map(CATALOG.models.map((e) => [e.id.toLowerCase(), e]));
  const tier = CATALOG.featured[sel];
  if (tier) {
    for (const id of tier) {
      const e = byId.get(id.toLowerCase());
      if (e && e.selectable && e.text_to_video && e.supports_9_16) return e;
    }
    throw new HttpError(400, `no usable model in tier '${sel}'`);
  }
  const e = byId.get(sel.toLowerCase());
  if (!e) throw new HttpError(404, `unknown model '${sel}'; see GET /models`);
  if (!e.selectable) throw new HttpError(400, `model '${e.id}' needs inputs this server does not map: ${e.unmapped_required.join(", ")}`);
  return e;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
