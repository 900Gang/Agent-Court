import { NextResponse } from "next/server";

// Placeholder. Kill-switch check (N2) and dashboard/admin session redirect (N1 Task 6) land here.
export function proxy() {
  return NextResponse.next();
}