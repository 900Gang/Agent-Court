import { getApiDeps } from "@/lib/http/apiPipeline";
import { handleGetAgent } from "@/lib/http/handlers/agents";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ handle: string }> }): Promise<Response> {
  return handleGetAgent(request, getApiDeps(), await params);
}
