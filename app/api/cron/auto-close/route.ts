import { getCronDeps, handleCronAutoClose } from "@/lib/http/handlers/cron";

export const dynamic = "force-dynamic";

// Vercel cron sends GET with `Authorization: Bearer <CRON_SECRET>`. POST is accepted for manual runs.
export function GET(request: Request): Promise<Response> {
  return handleCronAutoClose(request, getCronDeps());
}

export function POST(request: Request): Promise<Response> {
  return handleCronAutoClose(request, getCronDeps());
}
