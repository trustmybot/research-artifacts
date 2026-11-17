import { appendFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import type { Duplex } from "node:stream";

export const ALLOWED_TARGET = "api.anthropic.com:443";
export const PROXY_PORT = 3128;
export const PROXY_READY_LINE = "cr allowlist proxy ready";

const MAX_LOGGED_TARGET_CHARS = 300;

export interface ProxyOptions {
  host: string;
  port?: number;
  logPath: string;
  scrub?: (text: string) => string;
  dial?: (host: string, port: number) => Socket;
}

export interface AllowlistProxy {
  url: string;
  close(): Promise<void>;
}

export function isAllowedTarget(target: string | undefined): boolean {
  return target?.toLowerCase() === ALLOWED_TARGET;
}

function refuse(socket: Duplex, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function listen(server: Server, host: string, port: number): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server.address() as AddressInfo);
    });
  });
}

export async function startAllowlistProxy(options: ProxyOptions): Promise<AllowlistProxy> {
  const scrub = options.scrub ?? ((text: string): string => text);
  const dial = options.dial ?? ((host: string, port: number): Socket => connect(port, host));
  const tunnels = new Set<Duplex>();

  const log = (request: IncomingMessage, decision: string, status: number): void => {
    const attempt = {
      at: new Date().toISOString(),
      client: request.socket.remoteAddress,
      method: request.method,
      target: request.url?.slice(0, MAX_LOGGED_TARGET_CHARS),
      decision,
      status,
    };
    appendFileSync(options.logPath, `${scrub(JSON.stringify(attempt))}\n`);
  };

  const server = createServer((request, response) => {
    log(request, "refused_not_connect", 405);
    response.writeHead(405, { Connection: "close", "Content-Length": "0" });
    response.end();
  });

  server.on("connect", (request: IncomingMessage, client: Duplex, head: Buffer) => {
    client.on("error", () => client.destroy());
    if (!isAllowedTarget(request.url)) {
      log(request, "refused_not_allowlisted", 403);
      refuse(client, "403 Forbidden");
      return;
    }

    const [host, port] = ALLOWED_TARGET.split(":");
    const upstream = dial(host, Number(port));
    tunnels.add(client);
    tunnels.add(upstream);
    let established = false;
    client.once("close", () => {
      tunnels.delete(client);
      upstream.destroy();
    });
    upstream.once("close", () => {
      tunnels.delete(upstream);
      if (established) client.destroy();
    });
    upstream.on("error", () => {
      if (established) return;
      log(request, "upstream_failed", 502);
      refuse(client, "502 Bad Gateway");
    });
    upstream.once("connect", () => {
      established = true;
      log(request, "admitted", 200);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
  });

  const { address, port } = await listen(server, options.host, options.port ?? 0);
  return {
    url: `http://${address}:${port}`,
    close: () =>
      new Promise((resolve) => {
        for (const tunnel of tunnels) tunnel.destroy();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
