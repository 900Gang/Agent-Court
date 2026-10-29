import "server-only";
import { cache } from "react";
import { getDb } from "@/db/client";
import { getOperator } from "@/lib/auth/session";
import { logger } from "@/lib/config/logger";
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

/**
 * Whether the visitor is signed in, and whether they may report. Nothing else about them leaves this function, so
 * no page can show an operator id, a name or an email. Cached per request: the layout and the page share one lookup.
 * A failed lookup is treated as signed out, so a broken session never breaks a public page.
 */
export const loadViewer = cache(async (): Promise<{ signedIn: boolean; canReport: boolean }> => {
  try {
    const operator = await getOperator();
    return { signedIn: operator !== null, canReport: operator !== null && operator.status === "active" };
  } catch (error) {
    logger.warn("viewer lookup failed", { errorClass: error instanceof Error ? error.constructor.name : "NonError" });
    return { signedIn: false, canReport: false };
  }
});
