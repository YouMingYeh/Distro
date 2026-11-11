import type { Metadata } from "next";
import { Dashboard } from "../me";

export const metadata: Metadata = { title: "Dashboard: Distro" };

export default function DashboardPage() {
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-16 md:py-24">
      <a href="/" className="text-sm text-muted transition hover:text-fg">
        Distro
      </a>
      <h1 className="mb-8 mt-2 text-3xl font-semibold tracking-tight">Dashboard</h1>
      <Dashboard />
    </main>
  );
}
