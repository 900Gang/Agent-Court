import { handleMeRequest } from "@/lib/http/meHandler";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handleMeRequest(request);
}
