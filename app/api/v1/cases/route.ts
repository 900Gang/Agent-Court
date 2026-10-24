import { getApiDeps } from "@/lib/http/apiPipeline";
import { handleFileCase, handleListCases } from "@/lib/http/handlers/cases";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handleListCases(request, getApiDeps());
}

export function POST(request: Request): Promise<Response> {
  return handleFileCase(request, getApiDeps());
}
