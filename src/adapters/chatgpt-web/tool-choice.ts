import type { CodexParsedRequest } from "../../types";
import { ChatGptWebAdapterError } from "./adapter-error";

export function chatGptWebToolChoiceError(parsed: CodexParsedRequest): ChatGptWebAdapterError | undefined {
  const body = parsed._rawBody;
  const rawChoice = body && typeof body === "object" && !Array.isArray(body)
    ? (body as { tool_choice?: unknown }).tool_choice
    : undefined;
  const choices = [parsed.options.toolChoice, rawChoice];
  if (choices.every(choice => choice === undefined || choice === null || choice === "auto")) return undefined;

  // The exec gateway can discover tools outside the advertised registry, and retained rounds
  // can replay previously issued calls. Until both support a restriction, reject the entire
  // request before any browser or broker work. Check the raw choice too: the parser normalizes
  // unsupported hosted-tool choices to auto.
  return new ChatGptWebAdapterError(
    "ChatGPT Web does not support restrictive or forced tool_choice values. "
      + "This request was rejected before starting or replaying a browser turn.",
    {
      status: 400,
      errorType: "invalid_request_error",
      code: "unsupported_tool_choice",
      retryable: false,
    },
  );
}
