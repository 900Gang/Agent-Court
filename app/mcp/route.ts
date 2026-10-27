import { getApiDeps } from "@/lib/http/apiPipeline";
import { handleMcp } from "@/lib/mcp/handler";

export const dynamic = "force-dynamic";

// Only POST is served. GET and DELETE reach the same function, which answers 405 with Allow: POST.
export function POST(request: Request): Promise<Response> {
  return handleMcp(request, getApiDeps());
}

export function GET(request: Request): Promise<Response> {
  return handleMcp(request, getApiDeps());
}

export function DELETE(request: Request): Promise<Response> {
  return handleMcp(request, getApiDeps());
}
