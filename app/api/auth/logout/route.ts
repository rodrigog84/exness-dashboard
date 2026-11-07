import { logoutResponse } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST() {
  return logoutResponse();
}
