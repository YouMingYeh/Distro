"use client";

import { Play } from "@phosphor-icons/react";
import { type FormEvent, useRef, useState } from "react";

export function VideoPreview({ sample }: { sample?: { src: string; poster: string } }) {
  const [source, setSource] = useState<string | null>(sample?.src ?? null);
  const [error, setError] = useState("");
  const [sampleStarted, setSampleStarted] = useState(false);
  const player = useRef<HTMLVideoElement>(null);
  const showingSample = Boolean(sample && source === sample.src);

  function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("video-url") as HTMLInputElement;
    const value = input.value.trim();
    let url: URL | undefined;
    try {
      url = new URL(value);
    } catch {}

    if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
      setError("Enter an HTTP or HTTPS video URL.");
      input.focus();
      return;
    }

    setError("");
    setSource(value);
  }

  return (
    <section id="video-preview" aria-labelledby="video-preview-title" className="grid min-w-0 scroll-mt-6 items-center gap-5 rounded-2xl border border-line bg-surface p-4 md:grid-cols-2 md:gap-8 md:p-6">
      <div className="min-w-0">
        <h2 id="video-preview-title" className="text-xl font-semibold tracking-tight sm:text-2xl">Video preview</h2>
        <p className="mt-1 text-sm text-muted">
          {showingSample ? "Sample video" : "Play a generated video before publishing."}
        </p>

        <form onSubmit={preview} noValidate className="mt-5">
          <label htmlFor="video-url" className="block text-sm font-medium">Video URL</label>
          <div className="mt-2 flex gap-2">
            <input
              id="video-url"
              name="video-url"
              type="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://…"
              aria-describedby="video-preview-hint"
              onChange={() => setError("")}
              className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 py-2 text-base placeholder:text-muted md:text-sm"
            />
            <button type="submit" className="shrink-0 cursor-pointer rounded-lg bg-fg px-4 py-2 text-sm font-medium text-bg transition hover:opacity-85">
              Preview
            </button>
          </div>
          <p id="video-preview-hint" aria-live="polite" className="mt-2 text-xs leading-relaxed text-muted">
            {error || <>Paste the <code className="font-mono">video_url</code> returned by Distro.</>}
          </p>
        </form>
      </div>

      <div className="relative grid aspect-video min-w-0 place-items-center overflow-hidden rounded-lg bg-zinc-950 text-zinc-400">
        {source ? (
          <video
            key={source}
            ref={player}
            src={source}
            poster={showingSample ? sample?.poster : undefined}
            controls
            playsInline
            preload="metadata"
            aria-label={showingSample ? "Sample video" : "Generated video preview"}
            onPlay={() => {
              if (showingSample) setSampleStarted(true);
            }}
            onError={() => {
              setSource(null);
              setError("Could not load this video. Check the link and try again.");
            }}
            className="size-full min-h-0 min-w-0 object-contain"
          />
        ) : (
          <div className="grid justify-items-center gap-2.5 text-xs">
            <span className="grid size-10 place-items-center rounded-full border border-zinc-700">
              <Play size={18} weight="fill" aria-hidden />
            </span>
            <p>No video loaded</p>
          </div>
        )}
        {showingSample && !sampleStarted && (
          <button
            type="button"
            aria-label="Play sample video"
            onClick={() => {
              player.current?.play().catch(() => setError("Could not start playback. Try again."));
            }}
            className="absolute inset-0 m-auto grid size-12 cursor-pointer place-items-center rounded-full border border-white/30 bg-zinc-950/85 text-white transition hover:bg-zinc-950"
          >
            <Play size={20} weight="fill" aria-hidden />
          </button>
        )}
      </div>
    </section>
  );
}
