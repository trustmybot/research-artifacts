import { PROXY_PORT, PROXY_READY_LINE, startAllowlistProxy } from "./allowlist-proxy.ts";

await startAllowlistProxy({ host: "0.0.0.0", port: PROXY_PORT, logPath: "/dev/stdout" });
process.stderr.write(`${PROXY_READY_LINE}\n`);
