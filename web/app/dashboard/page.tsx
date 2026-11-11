import type { Metadata } from "next";
import { Dashboard } from "../me";

export const metadata: Metadata = { title: "Dashboard: Distro" };

export default function DashboardPage() {
  return <Dashboard />;
}
