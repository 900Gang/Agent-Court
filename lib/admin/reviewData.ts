import "server-only";
import { getDb } from "@/db/client";
import { listAppeals, listReports } from "@/lib/services/reviewService";

/** The open reports from the real database. Pages go through here instead of importing the database. */
export const loadReports = () => listReports(getDb());

/** The verdicts under appeal or review from the real database. */
export const loadAppeals = () => listAppeals(getDb());
