import { getCronDeps, handleCronReembed } from "@/lib/http/handlers/cron";

export const dynamic = "force-dynamic";

// Vercel cron sends GET with `Authorization: Bearer <CRON_SECRET>`. POST is accepted for manual runs.
export function GET(request: Request): Promise<Response> {
  return handleCronReembed(request, getCronDeps());
}

export function POST(request: Request): Promise<Response> {
  return handleCronReembed(request, getCronDeps());
}
