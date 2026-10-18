import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/auth/betterAuth";

export const { GET, POST } = toNextJsHandler((request) => getAuth().handler(request));
