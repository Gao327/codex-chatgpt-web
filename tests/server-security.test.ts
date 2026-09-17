import { expect, test } from "bun:test";
import { createConnection } from "node:net";
import { defaultConfig } from "../src/config";
import { localApiPath } from "../src/local-api";
import { startServer } from "../src/server";

async function rawRequestStatus(port: number, target: string, hosts: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    let response = "";
    const socket = createConnection({ host: "127.0.0.1", port }, () => {
      socket.end([
        `POST ${target} HTTP/1.1`, ...hosts.map(host => `Host: ${host}`),
        "Authorization: Bearer codex-session", "Content-Type: application/json",
        "Content-Length: 2", "Connection: close", "", "{}",
      ].join("\r\n"));
    });
    socket.setTimeout(2_000, () => socket.destroy(new Error("HTTP security check timed out")));
    socket.on("data", chunk => { response += chunk.toString(); });
    socket.once("error", reject);
    socket.once("end", () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(response)?.[1])));
  });
}

test("every local model endpoint rejects missing or incorrect bridge authentication before executing", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  let executions = 0;
  const server = startServer(config, {
    fetchUpstream: async () => { executions += 1; return Response.json({}); },
    adapterFactory: () => { executions += 1; throw new Error("must not execute"); },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    for (const base of ["/v1", localApiPath(defaultConfig()), `/bridge/${config.controlToken}/v1`]) {
      for (const [method, endpoint] of [
        ["GET", "/models"], ["GET", "/responses"], ["POST", "/responses"],
        ["POST", "/responses/compact"], ["POST", "/alpha/search"],
      ]) {
        const response = await fetch(`${origin}${base}${endpoint}`, {
          method,
          headers: { authorization: "Bearer arbitrary-local-process", "content-type": "application/json" },
          ...(method === "POST" ? { body: "{not even valid json" } : {}),
        });
        expect(response.status).toBe(401);
        expect(await response.text()).not.toContain(config.controlToken);
      }
    }
    expect(executions).toBe(0);
  } finally {
    await server.stop(true);
  }
});

test("authenticated native routing keeps the Codex bearer and query without exposing the local capability", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  let upstream: Request | undefined;
  const server = startServer(config, {
    fetchUpstream: async request => { upstream = request; return Response.json({ results: [] }); },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    const response = await fetch(`${origin}${localApiPath(config)}/alpha/search?client_version=1.2.3`, {
      method: "POST",
      headers: { authorization: "Bearer codex-session", "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ query: "test" }),
    });
    expect(response.status).toBe(200);
    expect(upstream!.url).toBe("https://chatgpt.com/backend-api/codex/alpha/search?client_version=1.2.3");
    expect(upstream!.headers.get("authorization")).toBe("Bearer codex-session");
    expect(JSON.stringify([...upstream!.headers])).not.toContain(localApiPath(config).split("/")[2]!);
    expect(await upstream!.json()).toEqual({ query: "test" });

    const admin = await fetch(`${origin}/admin/drain`, {
      method: "POST",
      headers: { authorization: `Bearer ${localApiPath(config).split("/")[2]}` },
    });
    expect(admin.status).toBe(401);
  } finally {
    await server.stop(true);
  }
});

test("browser origins, browser fetch metadata, and rebound hosts cannot access local routes", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  let executions = 0;
  const server = startServer(config, {
    fetchUpstream: async () => { executions += 1; return Response.json({}); },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    const untrustedHeaders: Record<string, string>[] = [
      { origin: "https://attacker.example" }, { origin: "null" }, { origin },
      { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-origin" },
      { host: `attacker.example:${server.port}` }, { host: `localhost:${server.port}` },
      { host: "127.0.0.1:1" },
    ];
    for (const headers of untrustedHeaders) {
      for (const path of ["/healthz", "/admin/drain", `${localApiPath(config)}/alpha/search`]) {
        const response = await fetch(`${origin}${path}`, {
          method: path === "/healthz" ? "GET" : "POST",
          headers: { authorization: `Bearer ${config.controlToken}`, "content-type": "application/json", ...headers },
          ...(path === "/healthz" ? {} : { body: "{}" }),
        });
        expect(response.status).toBe(403);
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
      }
    }
    expect(executions).toBe(0);
    expect((await fetch(`${origin}/healthz`)).status).toBe(200);
  } finally {
    await server.stop(true);
  }
});

test("local model POSTs require JSON rather than browser form or text content types", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  let executions = 0;
  const server = startServer(config, {
    fetchUpstream: async () => { executions += 1; return Response.json({}); },
  });
  try {
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "application/jsonp"]) {
      const response = await fetch(`http://127.0.0.1:${server.port}${localApiPath(config)}/alpha/search`, {
        method: "POST",
        headers: { authorization: "Bearer codex-session", "content-type": contentType },
        body: "{}",
      });
      expect(response.status).toBe(415);
    }
    expect(executions).toBe(0);
  } finally {
    await server.stop(true);
  }
});

test("restrictive tool choices return a terminal HTTP 400 before constructing a Web adapter", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  let executions = 0;
  const server = startServer(config, {
    adapterFactory: () => { executions += 1; throw new Error("must not execute"); },
  });
  try {
    for (const stream of [false, true]) {
      for (const toolChoice of ["none", "required", { type: "function", name: "allowed_tool" }, { type: "web_search_preview" }]) {
        const response = await fetch(`http://127.0.0.1:${server.port}${localApiPath(config)}/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "chatgpt-web/high", input: "test", stream, tool_choice: toolChoice }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: { type: "invalid_request_error", code: "unsupported_tool_choice" },
        });
      }
    }
    expect(executions).toBe(0);
  } finally {
    await server.stop(true);
  }
});

test("raw HTTP path normalization and ambiguous hosts cannot bypass local API authentication", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  let executions = 0;
  const server = startServer(config, {
    fetchUpstream: async () => { executions += 1; return Response.json({}); },
  });
  const port = server.port!;
  const host = `127.0.0.1:${port}`;
  try {
    for (const target of [
      "/v1/alpha/search", "/%76%31/alpha/search", "/v1%2falpha%2fsearch", "//v1/alpha/search",
      "/bridge/incorrect/../../v1/alpha/search", "/bridge/incorrect/v1/../../../v1/alpha/search",
      `http://${host}/v1/alpha/search`, `http://attacker.example:${port}/v1/alpha/search`,
    ]) {
      expect([400, 401, 403, 404]).toContain(await rawRequestStatus(port, target, [host]));
    }
    for (const hosts of [[host, "attacker.example"], ["attacker.example", host], []]) {
      expect([400, 403]).toContain(await rawRequestStatus(port, `${localApiPath(config)}/alpha/search`, hosts));
    }
    expect(executions).toBe(0);
  } finally {
    await server.stop(true);
  }
});
