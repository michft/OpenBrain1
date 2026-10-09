import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, chmod, lstat, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

// Run from the integration directory. Never print or install the admin key.
const integration = fileURLToPath(new URL("../", import.meta.url));
const values = parseEnv(await readFile(resolve(integration, ".env.local"), "utf8"));
const key = values.MCP_ACCESS_KEY;
assert(key && key !== values.MCP_ADMIN_KEY, "Configure distinct agent/admin credentials first.");
assert(values.CONVEX_SITE_URL, "Configure CONVEX_SITE_URL first.");
const site = new URL(values.CONVEX_SITE_URL);
assert(site.protocol === "https:" && !site.search && !site.hash && !site.username && !site.password, "Use an HTTPS Convex site URL without credentials.");
const endpoint = new URL("/mcp", site).href;
const codexHome = process.env.CODEX_HOME || resolve(homedir(), ".codex");
const configPath = resolve(codexHome, "config.toml");
let config = "";
try { config = await readFile(configPath, "utf8"); }
catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
// Use Codex's TOML parser, including quoted/spaced keys and inline tables.
let servers: unknown;
try {
  servers = JSON.parse(execFileSync("codex", ["mcp", "list", "--json"], {
    encoding: "utf8", env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ["ignore", "pipe", "pipe"],
  }));
} catch {
  throw new Error("Codex MCP config inspection failed; preserve config and inspect locally.");
}
assert(Array.isArray(servers), "Unexpected Codex MCP config output; preserve config.");
assert(!servers.some((server: unknown) => typeof server === "object" && server !== null && "name" in server && server.name === "ob1-brain"), "ob1-brain already configured; preserve it and inspect before replacing.");
const credentialDir = resolve(homedir(), ".config", "ob1");
const headersPath = resolve(credentialDir, "mcp-headers.json");
const skillSource = resolve(integration, "../../skills/ob1-agent-memory");
const skillTarget = resolve(homedir(), ".agents/skills/ob1-agent-memory");
try {
  await lstat(skillTarget);
  throw new Error("Skill destination already exists; preserve it and inspect before replacing.");
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}
await mkdir(credentialDir, { recursive: true, mode: 0o700 });
await chmod(credentialDir, 0o700);
await writeFile(headersPath, JSON.stringify({ "x-brain-key": key }), { mode: 0o600, flag: "wx" });
await mkdir(codexHome, { recursive: true });
// Native header helper works for desktop/service launches without shell env exports.
// Shell-quote the path independently of TOML string quoting.
const helper = `/bin/cat '${headersPath.replaceAll("'", "'\\''")}'`;
const entry = `\n[mcp_servers.ob1-brain]\nurl = ${JSON.stringify(endpoint)}\nhttp_headers_helper = ${JSON.stringify(helper)}\ntool_timeout_sec = 60\n`;
await writeFile(configPath, config + entry, { mode: 0o600 });
await chmod(configPath, 0o600);
await mkdir(dirname(skillTarget), { recursive: true });
await symlink(skillSource, skillTarget);
console.log(JSON.stringify({ endpoint, config: configPath, credential: headersPath, skill: skillTarget, restart_required: true }, null, 2));
