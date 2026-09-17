import { createHmac } from "node:crypto";
import type { AppConfig } from "./config";

/** Keep Codex's native Authorization header available for the official upstream. */
export function localApiPath(config: Pick<AppConfig, "controlToken">): string {
  const capability = createHmac("sha256", config.controlToken)
    .update("codex-chatgpt-web/local-responses/v1")
    .digest("base64url");
  return `/bridge/${capability}/v1`;
}

export function redactLocalApiUrl(value: string): string {
  return value.replace(/\/bridge\/[A-Za-z0-9_-]+(?=\/v1)/g, "/bridge/[redacted]");
}
