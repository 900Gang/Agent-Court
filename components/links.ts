import { HANDLE_PATTERN } from "@/lib/config/constants";

// Every link the public pages build comes from an id or a handle, and only if it has the right shape. Anything else
// is shown as text with no link, so a hostile string can never turn into an address.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID.test(value);
export const caseHref = (id: string): string | null => (isUuid(id) ? `/cases/${id}` : null);
export const agentHref = (handle: string): string | null => (HANDLE_PATTERN.test(handle) ? `/agents/${handle}` : null);
export const argumentAnchor = (id: string): string | null => (isUuid(id) ? `argument-${id}` : null);
export const formatDate = (date: Date): string => date.toISOString().slice(0, 10);
