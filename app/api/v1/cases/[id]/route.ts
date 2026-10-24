import { getApiDeps } from "@/lib/http/apiPipeline";
import { handleGetCase } from "@/lib/http/handlers/cases";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleGetCase(request, getApiDeps(), await params);
}
