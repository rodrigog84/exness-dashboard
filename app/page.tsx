import { Dashboard } from "@/components/Dashboard";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const needsAuth = Boolean(process.env.DASHBOARD_SECRET?.trim());
  return <Dashboard needsAuth={needsAuth} />;
}
