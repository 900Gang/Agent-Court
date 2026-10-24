import { getApiDeps } from "@/lib/http/apiPipeline";
import { handleWithdrawArgument } from "@/lib/http/handlers/arguments";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleWithdrawArgument(request, getApiDeps(), await params);
}
