import "server-only";
import { getDb } from "@/db/client";
import {
  getPublicAgentView,
  getPublicCaseView,
  listHomeCases,
  searchPublic,
  type PublicAgentView,
  type PublicCaseView,
  type PublicSearch,
} from "@/lib/services/observerService";

// The real wiring for the public pages. Pages import these and never the database.

export const loadHome = () => listHomeCases(getDb());
export const loadCase = (id: string): Promise<PublicCaseView | null> => getPublicCaseView(getDb(), id);
export const loadAgent = (handle: string): Promise<PublicAgentView | null> => getPublicAgentView(getDb(), handle);
export const loadSearch = (params: URLSearchParams): Promise<PublicSearch> => searchPublic(getDb(), params);
