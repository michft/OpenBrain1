import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, copyFile, cp, lstat, mkdir, readFile, readlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

// macOS standalone installation. Secrets travel through stdin/files, never argv/output.
const integration = fileURLToPath(new URL("../", import.meta.url));
const values = parseEnv(await readFile(resolve(integration, ".env.local"), "utf8"));
assert(values.MCP_ACCESS_KEY && values.MCP_ACCESS_KEY !== values.MCP_ADMIN_KEY, "Distinct agent/admin keys required.");
assert(values.OPENROUTER_API_KEY, "Existing OpenRouter upstream key required.");
assert(values.CONVEX_SITE_URL, "Convex development site required.");
const site = new URL(values.CONVEX_SITE_URL);
const upstream = new URL(values.OPENROUTER_BASE || "https://openrouter.ai/api/v1");
for (const url of [site, upstream]) assert(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash, "Clean HTTPS URL required.");
const endpoint = new URL("/mcp", site).href;
const proxyRoot = process.env.OB1_CLIPROXY_ROOT || resolve(homedir(), "src/cliproxyapi");
const proxyDir = resolve(proxyRoot, "bin/local");
const proxyConfig = resolve(proxyDir, "config.yaml");
const binary = resolve(proxyDir, "cli-proxy-api");
const target = resolve(homedir(), ".config/ob1");
const skillSource = resolve(integration, "../../skills/ob1-agent-memory");
const skillTarget = resolve(target, "skills/ob1-agent-memory");
const globalSkill = resolve(homedir(), ".agents/skills/ob1-agent-memory");
const codexHome = process.env.CODEX_HOME || resolve(homedir(), ".codex");
const plist = resolve(homedir(), "Library/LaunchAgents/com.ob1.cliproxyapi.plist");
const envPath = resolve(target, "standalone.env");
const mcpPath = resolve(target, "mcp.json");
const backup = `${proxyConfig}.ob1-backup`;

function run(command: string, args: string[], input?: string, env = process.env): string {
  try { return execFileSync(command, args, { encoding: "utf8", input, env, stdio: ["pipe", "pipe", "pipe"] }); }
  catch { throw new Error(`${command} failed; inspect locally without sharing credential-bearing output.`); }
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
}
assert(process.platform === "darwin", "This service installer targets macOS.");
assert((await lstat(binary)).isFile(), "Build/install CLIProxyAPI separately before setup.");
const config: { server?: { host?: string; port?: number }; management?: { "secret-key"?: string; "disable-control-panel"?: boolean }; "api-keys"?: { "openai-compatibility"?: Array<{ name?: string }> } } = JSON.parse(run("ruby", ["-r", "yaml", "-r", "json", "-e", "puts JSON.generate(YAML.safe_load(File.read(ARGV[0])))", proxyConfig]));
assert(config.server?.host === "127.0.0.1" && config.server.port === 8317, "Preserve the dedicated loopback proxy profile; unexpected host/port.");
assert(!config.management?.["secret-key"] && config.management?.["disable-control-panel"] === true, "Management must be disabled before HTTPS exposure.");
assert(!config["api-keys"]?.["openai-compatibility"]?.some((provider) => provider.name === "ob1-openrouter"), "OB1 provider already exists; preserve and inspect it.");
for (const path of [plist, envPath, mcpPath, skillTarget, backup]) assert(!(await exists(path)), `Destination already exists; preserve ${path}.`);
const servers: Array<{ name?: string; transport?: { url?: string } }> = JSON.parse(run("codex", ["mcp", "list", "--json"], undefined, { ...process.env, CODEX_HOME: codexHome }));
const installed = servers.find((server) => server.name === "ob1-brain");
assert(!installed || installed.transport?.url === endpoint, "Existing OB1 Codex entry differs; preserve and inspect it.");
if (await exists(globalSkill)) assert((await lstat(globalSkill)).isSymbolicLink() && await readlink(globalSkill) === skillSource, "Global skill differs; preserve and inspect it.");
if (process.argv.includes("--check")) {
  console.log(JSON.stringify({ ready: true, endpoint, binary, standalone: target, removeSharedCodexEntry: Boolean(installed) }));
  process.exit(0);
}

const key = randomBytes(32).toString("hex");
const model = values.OPEN_BRAIN_CLASSIFICATION_MODEL || "openai/gpt-4o-mini";
const nextConfig = run("ruby", ["-r", "yaml", "-r", "json", "-e", `
v=YAML.safe_load(File.read(ARGV[0])); p=JSON.parse(STDIN.read)
v['access'] ||= {}; v['access']['api-keys'] ||= []; v['access']['api-keys'] << p['client_key']
v['api-keys'] ||= {}; v['api-keys']['openai-compatibility'] ||= []
v['api-keys']['openai-compatibility'] << {'name'=>'ob1-openrouter','base-url'=>p['base'],'keys'=>[{'api-key'=>p['upstream_key']}],'models'=>[{'name'=>p['model'],'alias'=>'ob1-classifier','input-modalities'=>['text'],'output-modalities'=>['text']}]}
puts YAML.dump(v)
`, proxyConfig], JSON.stringify({ client_key: key, upstream_key: values.OPENROUTER_API_KEY, base: upstream.href.replace(/\/+$/, ""), model }));
await mkdir(target, { recursive: true, mode: 0o700 });
await chmod(target, 0o700);
await copyFile(proxyConfig, backup);
await chmod(backup, 0o600);
await writeFile(envPath, `OB1_MCP_URL=${endpoint}\nOB1_PROXY_LOCAL_URL=http://127.0.0.1:8317/v1\nOB1_PROXY_API_KEY=${key}\nOB1_PROXY_MODEL=ob1-classifier\n`, { mode: 0o600, flag: "wx" });
await writeFile(mcpPath, JSON.stringify({ mcpServers: { "ob1-brain": { url: endpoint, headers: { "x-brain-key": values.MCP_ACCESS_KEY } } } }, null, 2), { mode: 0o600, flag: "wx" });
await mkdir(resolve(target, "skills"), { recursive: true });
await cp(skillSource, skillTarget, { recursive: true, errorOnExist: true, force: false });
await writeFile(proxyConfig, nextConfig, { mode: 0o600 });
await chmod(proxyConfig, 0o600);
const logs = resolve(target, "logs");
await mkdir(logs, { recursive: true, mode: 0o700 });
for (const name of ["proxy.stdout.log", "proxy.stderr.log"]) await writeFile(resolve(logs, name), "", { mode: 0o600, flag: "a" });
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
await mkdir(resolve(homedir(), "Library/LaunchAgents"), { recursive: true });
await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.ob1.cliproxyapi</string>
<key>ProgramArguments</key><array><string>${xml(binary)}</string><string>--local-model</string><string>--config</string><string>${xml(proxyConfig)}</string></array>
<key>WorkingDirectory</key><string>${xml(proxyDir)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>${xml(resolve(logs, "proxy.stdout.log"))}</string>
<key>StandardErrorPath</key><string>${xml(resolve(logs, "proxy.stderr.log"))}</string>
</dict></plist>
`, { mode: 0o600, flag: "wx" });
if (installed) run("codex", ["mcp", "remove", "ob1-brain"], undefined, { ...process.env, CODEX_HOME: codexHome });
if (await exists(globalSkill)) await unlink(globalSkill);
run("plutil", ["-lint", plist]);
run("launchctl", ["bootstrap", `gui/${process.getuid?.()}`, plist]);
console.log(JSON.stringify({ installed: true, endpoint, service: "com.ob1.cliproxyapi", localProxy: "http://127.0.0.1:8317/v1", upstreamModel: model, mcp: mcpPath, skill: skillTarget, sharedCodexEntryRemoved: Boolean(installed), httpsPending: true }, null, 2));
