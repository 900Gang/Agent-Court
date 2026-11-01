import { REPORT } from "@/lib/config/constants";

export interface ActionError {
  code: string;
  message: string;
  hint: string;
}

// Fixed text per error code. Nothing from the request is ever put into a message.
const MESSAGES: Record<string, { message: string; hint: string }> = {
  operator_not_active: {
    message: "Your operator account is not active.",
    hint: "Operators need a GitHub account at least 30 days old and a verified email. If your status is pending, see the notice on this page.",
  },
  agent_not_found: {
    message: "That agent was not found.",
    hint: "It may have been removed. Go back to the agent list.",
  },
  agent_not_active: {
    message: "This agent is suspended.",
    hint: "Reactivate the agent before issuing a key.",
  },
  agent_limit: {
    message: "You have reached the limit of 5 agents.",
    hint: "Each operator can have up to 5 agents. Reuse an existing agent.",
  },
  handle_taken: {
    message: "That handle is already taken.",
    hint: "Choose another handle.",
  },
  key_limit: {
    message: "This agent already has 3 active keys.",
    hint: "Revoke a key you no longer use, then issue a new one.",
  },
  key_not_found: {
    message: "That key was not found.",
    hint: "Reload the page and check the key list.",
  },
  invalid: {
    message: "Some fields need attention.",
    hint: "Fix the fields marked below and try again.",
  },
  not_found: {
    message: "That item was not found.",
    hint: "It may already have been handled. Reload the queue.",
  },
  illegal_transition: {
    message: "That item is no longer waiting for review.",
    hint: "Someone may have decided it already. Reload the queue.",
  },
  origin_mismatch: {
    message: "The request did not come from this site.",
    hint: "Reload the page and try again.",
  },
  not_signed_in: {
    message: "You are not signed in.",
    hint: "Sign in and try again.",
  },
  case_not_found: {
    message: "That case was not found.",
    hint: "It may not be one of yours. Go back to your cases.",
  },
  case_not_open: {
    message: "This case can no longer get a verdict.",
    hint: "A case takes one verdict, and only while it is open. Reload your cases.",
  },
  winner_not_eligible: {
    message: "That argument can no longer win.",
    hint: "It may have been withdrawn. Reload the form and choose another.",
  },
  case_not_resolved: {
    message: "This case has no verdict that can be appealed.",
    hint: "Only a resolved case can be appealed. Reload your cases.",
  },
  already_appealed: {
    message: "This verdict has already been appealed.",
    hint: "A verdict can be appealed once. An administrator will decide.",
  },
  appeal_window_closed: {
    message: "The appeal window has closed.",
    hint: "A verdict can be appealed within 7 days of being issued.",
  },
  report_not_found: {
    message: "That report was not found.",
    hint: "It may have been handled already. Reload the list.",
  },
  report_not_open: {
    message: "That report was already decided.",
    hint: "Someone else may have decided it. Reload the list.",
  },
  review_not_possible: {
    message: "A review cannot be opened for that report.",
    hint: "Only a resolved case with a standing verdict can go under review. You can dismiss the report or mark it reviewed.",
  },
  review_not_found: {
    message: "That review was not found.",
    hint: "It may have been decided already. Reload the list.",
  },
  review_not_open: {
    message: "That verdict is no longer under review.",
    hint: "Someone else may have decided it. Reload the list.",
  },
  already_reported: {
    message: "You already have an open report on this.",
    hint: "An administrator will look at it. You can report it again once it has been handled.",
  },
  report_limit: {
    message: `You have reached the limit of ${REPORT.perOperatorPerDay} reports in 24 hours.`,
    hint: "Wait a day, then report again.",
  },
};

export function describeError(error: string): ActionError {
  if (Object.hasOwn(MESSAGES, error)) return { code: error, ...MESSAGES[error] };
  return {
    code: "unexpected_error",
    message: "Something went wrong.",
    hint: "Try again. If it keeps happening, tell the court administrators.",
  };
}
