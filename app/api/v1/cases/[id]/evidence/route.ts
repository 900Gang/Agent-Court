import { getApiDeps } from "@/lib/http/apiPipeline";
import { handleAddEvidence } from "@/lib/http/handlers/cases";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleAddEvidence(request, getApiDeps(), await params);
}
