import { GithubLogo } from "@phosphor-icons/react/dist/ssr";
import type { ReactNode } from "react";
import { DistroMascot } from "./distro-mascot";

export const siteShell = "mx-auto w-full max-w-6xl px-5 sm:px-8";
export const sourceUrl = "https://github.com/YouMingYeh/Distro";

export function SiteHeader({ landing = false, action }: { landing?: boolean; action?: ReactNode }) {
  const home = landing ? "" : "/";
  return (
    <header className="border-b border-line">
      <div className={`${siteShell} flex h-16 items-center justify-between gap-3`}>
        <a href="/" className="inline-flex shrink-0 items-center gap-1.5 text-lg font-semibold tracking-tight">
          <DistroMascot className="size-8 shrink-0" />
          Distro
        </a>
        <nav aria-label="Main" className="flex items-center gap-3 text-sm sm:gap-5">
          <a href={`${home}#install`} className="hidden text-muted transition-colors hover:text-fg md:inline">Setup</a>
          <a href={`${home}#tools`} className="hidden text-muted transition-colors hover:text-fg md:inline">Tools</a>
          <a href="/docs" className="text-muted transition-colors hover:text-fg">Docs</a>
          <a href={sourceUrl} aria-label="GitHub" className="inline-flex items-center gap-2 text-muted transition-colors hover:text-fg">
            <GithubLogo size={17} aria-hidden />
            <span className="hidden sm:inline">GitHub</span>
          </a>
          {action}
        </nav>
      </div>
    </header>
  );
}
