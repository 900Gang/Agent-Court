import { getApiDeps } from "@/lib/http/apiPipeline";
import { handleSearchCases } from "@/lib/http/handlers/cases";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleSearchCases(request, getApiDeps());
}
