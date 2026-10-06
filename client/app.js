import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { VERSION } from "../shared/version.js";
import {
  applyUpdateAndRestart,
  clearUpdateMarker,
  readUpdateMarker,
  recoverInterruptedUpdate,
} from "../shared/updater.js";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_COPYRIGHT_TEXT,
  escapeToml,
  FIXED_CLIENT_API_PORT,
  isExpired,
  isPortAllowed,
  LoginRateLimiter,
  normalizeDeviceId,
  normalizeDomains,
  randomSecret,
  requestIp,
  sanitizeProxyName,
  sanitizeUpdateInfo,
  setupServiceRuntime,
  signToken,
  verifyToken,
  versionNewer,
} from "../shared/core.js";
import { frpReleaseTarget, resolveFrpBinary, frpBinaryName } from "../shared/platform.js";
import { renderHtmlWithIncludes } from "../shared/partials.js";
import {
  migratePlaintextJson,
  readEncryptedJson,
  writeEncryptedJson,
} from "../shared/secrets.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(process.env.CLIENT_DATA_DIR || join(ROOT, "data", "client"));
const RUNTIME_DIR = resolve(
  process.env.CLIENT_RUNTIME_DIR || join(ROOT, "runtime", "client"),
);

// 客户端启动参数解析：支持命令行 --port / --host，环境变量，以及配置文件。
// 优先级：命令行参数 > 环境变量 > 配置文件 > 默认值。
const CLIENT_CONFIG_FILE = join(DATA_DIR, "config.json");

function readClientConfigFile() {
  try {
    if (!existsSync(CLIENT_CONFIG_FILE)) return {};
    const parsed = JSON.parse(readFileSync(CLIENT_CONFIG_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function parseCliArgs(argv) {
  const args = { port: null, host: null };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--port" || token === "-p") {
      args.port = argv[++i];
    } else if (token.startsWith("--port=")) {
      args.port = token.slice("--port=".length);
    } else if (token === "--host" || token === "-H") {
      args.host = argv[++i];
    } else if (token.startsWith("--host=")) {
      args.host = token.slice("--host=".length);
    } else if (token === "--help" || token === "-h") {
      args.help = true;
    }
  }
  return args;
}

function showHelpAndExit() {
  console.log(`XFCloud Tunnel 客户端 v${VERSION}

用法: node --experimental-sqlite client/app.js [选项]

启动选项:
  --port=<端口>     Web 控制台监听端口（1-65535），默认 7400
  --host=<地址>     Web 控制台监听地址，默认 0.0.0.0
  -p, --port <端口>  与 --port=<端口> 等价
  -H, --host <地址>  与 --host=<地址> 等价
  -h, --help         显示此帮助信息并退出

环境变量（优先级低于命令行参数，高于配置文件）:
  CLIENT_PORT        与 --port 等价
  CLIENT_HOST        与 --host 等价

配置文件（位于 data/client/config.json，仅当上述来源未指定时生效）:
  { "port": 7400, "host": "0.0.0.0" }

示例:
  node --experimental-sqlite client/app.js --port=8400
  node --experimental-sqlite client/app.js -p 8400 --host 127.0.0.1
`);
  process.exit(0);
}

const CLI_ARGS = parseCliArgs(process.argv);
if (CLI_ARGS.help) showHelpAndExit();

function resolvePortOption() {
  if (CLI_ARGS.port) {
    const value = Number(CLI_ARGS.port);
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new Error(`--port 须为 1-65535 的整数，收到：${CLI_ARGS.port}`);
    }
    return value;
  }
  if (process.env.CLIENT_PORT) {
    const value = Number(process.env.CLIENT_PORT);
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new Error(`CLIENT_PORT 须为 1-65535 的整数，收到：${process.env.CLIENT_PORT}`);
    }
    return value;
  }
  const fileConfig = readClientConfigFile();
  if (fileConfig.port != null) {
    const value = Number(fileConfig.port);
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new Error(`配置文件 port 须为 1-65535 的整数，收到：${fileConfig.port}`);
    }
    return value;
  }
  return 7400;
}

function resolveHostOption() {
  if (CLI_ARGS.host) return String(CLI_ARGS.host);
  if (process.env.CLIENT_HOST) return String(process.env.CLIENT_HOST);
  const fileConfig = readClientConfigFile();
  if (fileConfig.host) return String(fileConfig.host);
  return "0.0.0.0";
}

const HOST = resolveHostOption();
const PORT = resolvePortOption();
// 与服务端的固定通信端口：服务端始终在 FIXED_CLIENT_API_PORT 上提供客户端 API，
// 与可在网页修改的 Web 管理端口分离，因此服务端改管理端口不影响客户端连接。
// SERVER_API_PORT/SERVER_API_SCHEME 环境变量仅供自动化测试覆盖，生产部署无需设置。
const SERVER_API_SCHEME = String(process.env.SERVER_API_SCHEME || "http").toLowerCase();
const SERVER_API_PORT = Number(process.env.SERVER_API_PORT || FIXED_CLIENT_API_PORT);
// 未连接服务端时，"检测版本更新"直接向授权中心查询；可用环境变量覆盖默认地址。
const LICENSE_CENTER_URL = String(
  process.env.LICENSE_SERVER_URL || "https://key.xfhub.top",
).replace(/\/+$/, "");
// 0.10.0.1：恢复未登录 frpc 本机锁（0.8.9.2 引入、0.8.9.9 移除）。
// 部署时可用 CLIENT_FRPC_PASSWORD 自定义锁密码（6-128 位），未设置时用默认密码。
const FRPC_LOCK_PASSWORD = (() => {
  const raw = process.env.CLIENT_FRPC_PASSWORD;
  if (raw == null || raw === "") return "xfcloud@123";
  if (raw.length < 6 || raw.length > 128) {
    throw new Error("CLIENT_FRPC_PASSWORD 须为 6-128 位字符");
  }
  return raw;
})();
// 0.9.5：登录页服务端列表缓存（5 分钟），降低授权中心压力。
let serverDirectoryCache = null;
let FRPC_BIN = resolveFrpBinary(ROOT, "frpc", process.env.FRPC_BIN);
const FRPC_BIN_LOCKED = Boolean(process.env.FRPC_BIN); // 显式配置的路径不可被覆盖
const BIN_DIR = join(ROOT, "bin");
let frpcVersion = detectFrpcVersion();

function detectFrpcVersion() {
  if (!existsSync(FRPC_BIN)) return "";
  try {
    const result = spawnSync(FRPC_BIN, ["-v"], { encoding: "utf8", timeout: 3_000 });
    const text = (result.stdout || result.stderr || "").trim();
    const match = /v?(\d+\.\d+\.\d+)/.exec(text);
    return match ? match[1] : text.slice(0, 32);
  } catch {
    return "";
  }
}

// 安装 frpc 二进制到 bin/frpc，并刷新 supervisor 状态。
function installFrpcBinary(buffer, version = "") {
  mkdirSync(BIN_DIR, { recursive: true });
  if (frpc.process) frpc.stop();
  rmSync(FRPC_BIN, { force: true });
  writeFileSync(FRPC_BIN, buffer);
  if (process.platform !== "win32") chmodSync(FRPC_BIN, 0o755);
  frpcVersion = version || detectFrpcVersion();
  frpc.refreshState();
}
// 0.9.3：本地状态加密落盘（state.enc + 0600 独立密钥 state.key），旧明文 state.json 自动迁移后删除。
const STATE_FILE = join(DATA_DIR, "state.enc");
const STATE_KEY_FILE = join(DATA_DIR, "state.key");
const LEGACY_STATE_FILE = join(DATA_DIR, "state.json");
const BRANDING_LOGO_FILE = join(DATA_DIR, "branding-logo");
const CONFIGURED_DEVICE_ID = process.env.CLIENT_DEVICE_ID
  ? normalizeDeviceId(process.env.CLIENT_DEVICE_ID)
  : null;

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(RUNTIME_DIR, { recursive: true });

// 模块加载即完成运行时引导，并恢复中断的在线更新。
setupServiceRuntime(ROOT);
recoverInterruptedUpdate(DATA_DIR, (msg) => console.log(`[updater] ${msg}`));

if (!["http", "https"].includes(SERVER_API_SCHEME)) {
  throw new Error("SERVER_API_SCHEME 仅支持 http 或 https");
}
if (!Number.isInteger(SERVER_API_PORT) || SERVER_API_PORT < 1 || SERVER_API_PORT > 65535) {
  throw new Error("SERVER_API_PORT 须为 1-65535");
}

function serverAddressFromUrl(value) {
  try {
    return new URL(String(value)).hostname;
  } catch {
    return "";
  }
}

function deviceIdOrNew(value) {
  if (CONFIGURED_DEVICE_ID) return CONFIGURED_DEVICE_ID;
  try {
    return normalizeDeviceId(value);
  } catch {
    return randomUUID();
  }
}

function defaultState() {
  return {
    deviceId: deviceIdOrNew(),
    session: null,
    proxies: [],
    ownerUsername: null,
    customFrpcConfig: "",
    customFrpcDesired: false,
    // 0.10.2.8：信息中心——服务端公告缓存、公告已读 id、本地消息已读时间（随加密状态持久化）。
    notices: [],
    noticeReadIds: [],
    messagesReadAt: "",
  };
}

function loadState() {
  let parsed = null;
  try {
    parsed = readEncryptedJson(STATE_FILE, STATE_KEY_FILE);
  } catch {
    return { ...defaultState(), sessionError: "本地状态文件无法解密" };
  }
  let legacyPlaintextLeftover = false;
  if (parsed === null) {
    // 0.9.3：首次启动或从 0.9.2 明文 state.json 迁移（迁移成功后明文立即删除）。
    try {
      const migrated = migratePlaintextJson(LEGACY_STATE_FILE, STATE_FILE, STATE_KEY_FILE);
      parsed = migrated ? migrated.value : null;
      if (migrated && migrated.plaintextRemoved === false) legacyPlaintextLeftover = true;
    } catch {
      parsed = null;
    }
  } else if (existsSync(LEGACY_STATE_FILE)) {
    // 0.9.3：密文已存在但旧明文残留（上次迁移时删除失败），每次启动都重试删除，避免凭据明文永久残留。
    try {
      rmSync(LEGACY_STATE_FILE, { force: true });
      legacyPlaintextLeftover = existsSync(LEGACY_STATE_FILE);
    } catch {
      legacyPlaintextLeftover = true;
    }
  }
  if (!parsed || typeof parsed !== "object") {
    return defaultState();
  }
  try {
    const session = parsed.session || null;
    if (session) {
      session.serverAddress =
        session.serverAddress || serverAddressFromUrl(session.serverUrl);
      session.renewalUrl = typeof session.renewalUrl === "string" ? session.renewalUrl : "";
      session.updateInfo = sanitizeUpdateInfo(session.updateInfo, VERSION);
      session.traffic = session.traffic || {
        available: false,
        sampledAt: null,
        error: null,
        proxies: {},
      };
      delete session.serverUrl;
    }
    return {
      deviceId: deviceIdOrNew(parsed.deviceId),
      session,
      // 0.10.1.1：多节点并发映射——每条映射补充归属节点（旧数据默认选中节点/主节点）。
      proxies: Array.isArray(parsed.proxies)
        ? parsed.proxies.map((proxy) => ({
            ...proxy,
            node:
              typeof proxy?.node === "string" && proxy.node
                ? proxy.node
                : parsed.session?.selectedNode || "master",
          }))
        : [],
      sessionError: parsed.sessionError || null,
      // 0.9.3：旧明文 state.json 迁移后仍残留（删除失败）时界面告警。
      plaintextStateLeftover: legacyPlaintextLeftover,
      ownerUsername:
        parsed.ownerUsername || session?.user?.username || null,
      // 未登录时由用户自行填写的 frpc 配置文件（TOML 原文），及期望运行状态。
      customFrpcConfig: typeof parsed.customFrpcConfig === "string" ? parsed.customFrpcConfig : "",
      customFrpcDesired: Boolean(parsed.customFrpcDesired),
      // 0.10.0.1：frpc 锁密钥随加密状态持久化（缺失时启动兜底生成）。
      frpcLockSecret:
        typeof parsed.frpcLockSecret === "string" && parsed.frpcLockSecret
          ? parsed.frpcLockSecret
          : null,
      // 0.10.2.8：信息中心——最近一次收到的公告缓存（离线时信息中心仍有内容）。
      notices: Array.isArray(parsed.notices) ? parsed.notices.slice(0, 50) : [],
      // 已读状态持久化（公告按 id、本地消息按时间戳）。
      noticeReadIds: Array.isArray(parsed.noticeReadIds)
        ? parsed.noticeReadIds.map(String).slice(-500)
        : [],
      messagesReadAt: typeof parsed.messagesReadAt === "string" ? parsed.messagesReadAt : "",
    };
  } catch {
    return { ...defaultState(), sessionError: "本地状态文件无法读取" };
  }
}

const state = loadState();

// 0.10.0.1：frpc 锁密钥缺失时兜底生成（0.8.9.8 教训：secret 为空会让 signToken 直接崩溃）；
// 紧随其后的 saveState() 会将其写回加密状态，保证重启后解锁会话仍有效。
if (!state.frpcLockSecret) state.frpcLockSecret = randomSecret();

function saveState() {
  writeEncryptedJson(STATE_FILE, state, STATE_KEY_FILE);
}

// 0.9.3：frpc 启动成功后立即删除明文配置文件（frpc 启动时已读入内存）；
// Windows 下偶发占用，最多重试 3 次（每次间隔 200ms）。返回 true=已删除/不存在，false=仍被占用。
function removeRuntimeConfig(configPath) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      rmSync(configPath, { force: true });
      return true;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
  return !existsSync(configPath);
}

saveState();

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

// 读取并解析 JSON 请求体。
async function readJson(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("JSON 格式无效");
  }
}

// ===== 0.10.0.1：未登录 frpc 本机锁（恢复 0.8.9.2 行为，0.8.9.9 曾移除）=====
// 未登录时修改 frpc 配置 / 启停 / 更换二进制须先解锁；登录会话直接旁路。
const frpcLockRateLimiter = new LoginRateLimiter({ maxAttempts: 5, windowMs: 10 * 60_000 });
const FRPC_LOCK_COOKIE = "xft_frpc_lock";
const FRPC_LOCK_TTL_MS = 12 * 60 * 60 * 1000;
const FRPC_LOCK_MUTATIONS = new Set([
  "/api/frpc/config",
  "/api/frpc/start",
  "/api/frpc/stop",
  "/api/frpc/restart",
  "/api/frpc/node",
  "/api/frpc/install",
]);

function frpcLockPasswordMatches(input) {
  const expected = Buffer.from(FRPC_LOCK_PASSWORD);
  const given = Buffer.from(String(input ?? ""));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function isFrpcUnlocked(req) {
  if (!req) return false;
  const cookie = String(req.headers.cookie || "")
    .split(/;\s*/)
    .find((item) => item.startsWith(`${FRPC_LOCK_COOKIE}=`));
  if (!cookie) return false;
  try {
    verifyToken(cookie.slice(FRPC_LOCK_COOKIE.length + 1), state.frpcLockSecret, "frpc-lock");
    return true;
  } catch {
    return false;
  }
}

function isFrpcLockedRequest(pathname, method) {
  if (state.session || !FRPC_LOCK_MUTATIONS.has(pathname)) return false;
  if (pathname === "/api/frpc/config") return method === "GET" || method === "POST";
  return method === "POST";
}

function normalizeServerAddress(value) {
  const text = String(value || "").trim();
  if (!text) throw new Error("请输入服务器 IP 或域名");
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(text)) {
    throw new Error("只需填写服务器 IP 或域名，无需协议");
  }
  if (/[/?#@]/.test(text)) {
    throw new Error("服务器地址不能包含端口、路径或登录信息");
  }
  const unwrapped = text.startsWith("[") && text.endsWith("]")
    ? text.slice(1, -1)
    : text;
  if (isIP(unwrapped)) return unwrapped;
  if (unwrapped.includes(":")) {
    throw new Error("只需填写服务器 IP 或域名，无需端口");
  }
  const hostname = unwrapped.replace(/\.$/, "").toLowerCase();
  const validHostname =
    hostname === "localhost" ||
    (hostname.length <= 253 &&
      hostname.split(".").every((label) =>
        /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label),
      ));
  if (!validHostname) throw new Error("服务器 IP 或域名格式无效");
  return hostname;
}

function managerBaseUrl(serverAddress) {
  const host = isIP(serverAddress) === 6 ? `[${serverAddress}]` : serverAddress;
  const defaultPort =
    (SERVER_API_SCHEME === "http" && SERVER_API_PORT === 80) ||
    (SERVER_API_SCHEME === "https" && SERVER_API_PORT === 443);
  return `${SERVER_API_SCHEME}://${host}${defaultPort ? "" : `:${SERVER_API_PORT}`}`;
}

// ===== 0.10.2.0 集群 id 登录 =====
// 集群 id：6 位无歧义字符（与授权中心一致，去掉 0/o/1/i/l）。
// 输入命中 id 字形时先向授权中心解析当前主节点地址；未知 id 或解析失败（含网络异常）
// 返回 null，按原输入走 IP/域名直连——单标签主机名与 id 字形重合时不受影响。
const CLUSTER_ID_PATTERN = /^[23456789a-hj-km-np-z]{6}$/i;
async function resolveClusterIdInput(value) {
  const text = String(value || "").trim();
  if (!CLUSTER_ID_PATTERN.test(text) || text.toLowerCase() === "localhost") return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const resp = await fetch(
      `${LICENSE_CENTER_URL}/api/v1/servers/cluster-master?clusterId=${encodeURIComponent(
        text.toLowerCase(),
      )}`,
      { signal: controller.signal },
    );
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => ({}));
    if (!data.masterAddress) return null;
    return {
      clusterId: String(data.clusterId || text.toLowerCase()),
      masterAddress: String(data.masterAddress),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function integerPort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label}须为 1-65535`);
  }
  return port;
}

function normalizeProxy(input, existingId = null) {
  const user = state.session?.user;
  if (!user) throw new Error("请先登录");
  const type = String(input.type || "").toLowerCase();
  if (!["tcp", "udp", "http", "https"].includes(type)) {
    throw new Error("仅支持 TCP / UDP / HTTP / HTTPS 映射");
  }
  // 0.9.3：HTTP/HTTPS 域名隧道改为授权制，默认用户不可创建（服务端插件同样强制拦截）。
  if ((type === "http" || type === "https") && !user.httpAllowed) {
    throw new Error("当前账号未开通 HTTP/HTTPS 隧道权限，请联系管理员授权");
  }
  // 0.10.1.1：多节点并发映射——每条映射归属一个节点（入参 node，默认当前选中节点/主节点）。
  const nodes = Array.isArray(state.session.nodes) ? state.session.nodes : [];
  const nodeName = String(input.node || "").trim() || state.session.selectedNode || "master";
  const nodeEntry = nodes.find((node) => node.name === nodeName) || null;
  if (nodes.length && !nodeEntry) throw new Error("节点不存在或未授权该节点");
  // 0.10.0.2：节点+端口二维授权——HTTP/HTTPS 仅主节点；远程端口按归属节点的授权段校验。
  if ((type === "http" || type === "https") && nodeEntry && !nodeEntry.isMaster) {
    throw new Error("HTTP/HTTPS 域名隧道仅主节点支持，请切换到主节点后创建");
  }
  const ranges = sessionRangesFor(nodeEntry);
  const rangesText = nodeEntry ? nodeEntry.rangesText : user.portRangesText;
  const localIP = String(input.localIP || "").trim();
  if (!localIP || /[\r\n"']/u.test(localIP)) throw new Error("本地地址无效");
  const name = sanitizeProxyName(input.name);
  const duplicate = state.proxies.find(
    (proxy) => proxy.id !== existingId && proxy.name.toLowerCase() === name.toLowerCase(),
  );
  if (duplicate) throw new Error("代理名称已存在");
  const proxy = {
    id: existingId || randomUUID(),
    name,
    type,
    localIP,
    localPort: integerPort(input.localPort, "本地端口"),
    enabled: input.enabled !== false,
    // 0.10.1.1：归属节点（旧服务端无节点列表时视为主节点）。
    node: nodeEntry ? nodeName : "master",
  };
  if (type === "http" || type === "https") {
    // HTTP/HTTPS 走 vhost 路由：不使用远程端口，必须配置自定义域名。
    const domains = normalizeDomains(input.domains);
    if (domains.length === 0) throw new Error(`${type.toUpperCase()} 映射必须配置至少一个自定义域名`);
    if (domains.length > 5) throw new Error("每条映射最多配置 5 个域名");
    const domainOwner = state.proxies.find(
      (item) =>
        item.id !== existingId &&
        Array.isArray(item.domains) &&
        item.domains.some((domain) => domains.includes(domain)),
    );
    if (domainOwner) throw new Error("域名已被本账号的其他映射使用");
    proxy.domains = domains;
    proxy.remotePort = null;
  } else {
    const remotePort = integerPort(input.remotePort, "远程端口");
    if (!isPortAllowed(remotePort, ranges)) {
      throw new Error(`远程端口不在当前节点授权范围 ${rangesText} 内`);
    }
    // 0.10.1.1：同一端口可在不同节点分别使用——占用查重限定在同一节点内。
    const ownNode = nodeEntry ? nodeName : "master";
    const portTaken = state.proxies.find(
      (item) =>
        item.id !== existingId &&
        item.remotePort === remotePort &&
        (item.node || "master") === ownNode,
    );
    if (portTaken) throw new Error(`远程端口 ${remotePort} 已被本节点的其他映射占用`);
    proxy.remotePort = remotePort;
    proxy.domains = [];
  }
  return proxy;
}

// 0.9.2：入参为比特/秒（Mbps 全链路）；frp 带宽后缀按字节计（无 Mb 后缀），写入前 ÷8。
function formatBandwidthLimit(bitsPerSec) {
  const bits = Number(bitsPerSec) || 0;
  if (bits <= 0) return null;
  const bytesPerSec = Math.floor(bits / 8);
  if (bytesPerSec <= 0) return null;
  if (bytesPerSec % (1024 * 1024) === 0) {
    return `${Math.floor(bytesPerSec / (1024 * 1024))}MB`;
  }
  const kb = Math.max(1, Math.floor(bytesPerSec / 1024));
  return `${kb}KB`;
}

// 选中节点的授权端口段：有节点列表时按节点取，否则回退用户全量段（兼容旧服务端）。
function sessionRangesFor(nodeEntry) {
  if (!nodeEntry) return state.session?.user?.portRanges || [];
  return nodeEntry.ranges || [];
}

function configText(key = null) {
  // 未登录（或 session 异常缺失 user）：直接使用用户自行填写的 frpc 配置文件（TOML 原文）。
  if (!state.session?.user) {
    const custom = String(state.customFrpcConfig || "").trim();
    if (!custom) {
      throw new Error("未连接服务端：请先在“设置 - frpc 配置文件”中填写配置内容");
    }
    return state.customFrpcConfig;
  }
  const { user, token, frp } = state.session;
  // 0.10.1.1：多节点并发映射——key 指定承载节点（默认当前选中节点/主节点），
  // 每个节点一份 frpc 配置、一个独立 frpc 进程。
  const nodes = Array.isArray(state.session.nodes) ? state.session.nodes : [];
  const nodeName = key || state.session.selectedNode || "master";
  const nodeEntry = nodes.find((node) => node.name === nodeName) || null;
  // 0.10.0.2：登录走集群主节点，隧道经归属节点承载——非主节点改写 serverAddr/serverPort。
  const isMasterSession = !nodeEntry || nodeEntry.isMaster;
  const ranges = sessionRangesFor(nodeEntry);
  // 0.9.2：frp 身份与全限定代理名前缀统一使用 6 位用户 ID（用户名可改、可重名）。
  const userKey = user.uid || user.username;
  // 0.9.3：用户级限速由服务端下达（rateLimitBps，bps）；frp 仅支持代理块级 transport.bandwidthLimit，
  // 不支持全局段，因此用户级限速需写入每个代理块。
  // 0.9.4：端口级限速优先于用户级——端口级已设置（>0）时直接生效，未设置时回退用户级。
  // 限速模式 server 表示由 frps 服务端侧执行限速。服务端存 bps，frp 按字节计（÷8）。
  const userLimitBps = Number(frp.rateLimitBps) || 0;
  const lines = [
    `serverAddr = ${escapeToml(isMasterSession ? frp.host : nodeEntry.host || frp.host)}`,
    `serverPort = ${isMasterSession ? Number(frp.port) : Number(nodeEntry.bindPort) || Number(frp.port)}`,
    `user = ${escapeToml(userKey)}`,
    `loginFailExit = false`,
    `auth.method = "token"`,
    // 0.10.1.0：从节点使用其自报的 frp token（主节点经登录响应下发），与该节点 frps 一致。
    `auth.token = ${escapeToml(isMasterSession ? frp.authToken : nodeEntry.frpToken || frp.authToken)}`,
    `transport.tcpMux = false`,
    `transport.heartbeatInterval = ${Number(frp.heartbeatInterval || 5)}`,
    // 0.10.2.7：抗工作连接池假死。线上现象：frpc 运行一段时间后隧道不可用，
    // 日志刷 "work connection pool is full, discarding"，重启 frpc 恢复——
    // NAT/防火墙静默丢弃长连接后池内全是死连接，frps 的 StartWorkConn 持续被丢弃。
    // 心跳超时收紧（默认 90s，interval 5s 下 15s 即 3 次无响应）、预建 5 条工作连接
    // （默认 1，高并发下 frps 排队重试加剧积压）、OS 层 TCP keepalive 5 分钟（默认 2 小时）。
    // 0.10.2.8：0.10.2.7 误写了 transport.tcpKeepalive（frpc 无此字段，直接启动失败），
    // 正确字段为 transport.dialServerKeepalive——frpc 源码 connector.go 中 realConnect()
    // 是控制连接与工作连接（tcpMux=false 下每次 Connect）的统一拨号路径，
    // WithKeepAlive(DialServerKeepAlive) 同时覆盖两者，经 frpc verify 实测通过。
    `transport.heartbeatTimeout = 15`,
    `transport.poolCount = 5`,
    `transport.dialServerKeepalive = 300`,
    `metadatas.fm_token = ${escapeToml(token)}`,
    `log.to = "console"`,
    `log.level = "info"`,
    "",
  ];
  // 0.9.3：隧道级限速仅写在各代理块；未获 HTTP/HTTPS 授权的用户不生成域名隧道配置。
  const proxyLimits =
    frp.proxyRateLimits && typeof frp.proxyRateLimits === "object" ? frp.proxyRateLimits : {};
  // 0.10.0.2：按节点过滤代理——HTTP/HTTPS 走 vhost 仅主节点承载；
  // TCP/UDP 仅写入远程端口落在该节点授权段内的映射（旧服务端回退全量段）。
  // 0.10.1.1：多节点并发映射——本配置只承载归属该节点的映射（旧服务端无节点列表时承载全部）。
  const proxiesToWrite = state.proxies.filter((item) => {
    if (nodes.length && (item.node || "master") !== nodeName) return false;
    if (!item.enabled) return false;
    if (item.type === "http" || item.type === "https") {
      return isMasterSession && user.httpAllowed;
    }
    return isPortAllowed(item.remotePort, ranges);
  });
  for (const proxy of proxiesToWrite) {
    const qualifiedName = `${userKey}-${proxy.name}`;
    const proxyLimitBps = Number(proxyLimits[qualifiedName]) || 0;
    // 0.9.4：端口级优先——已设置端口级限速则覆盖用户级，否则继承用户级。
    const finalBps = proxyLimitBps > 0 ? proxyLimitBps : userLimitBps;
    lines.push(
      "[[proxies]]",
      `name = ${escapeToml(qualifiedName)}`,
      `type = ${escapeToml(proxy.type)}`,
      `localIP = ${escapeToml(proxy.localIP)}`,
      `localPort = ${proxy.localPort}`,
    );
    if (proxy.type === "http" || proxy.type === "https") {
      // HTTP/HTTPS 通过自定义域名经 vhost 端口路由，不占用远程端口。
      const domains = Array.isArray(proxy.domains) ? proxy.domains : [];
      lines.push(`customDomains = [${domains.map((domain) => escapeToml(domain)).join(", ")}]`);
    } else {
      lines.push(`remotePort = ${proxy.remotePort}`);
    }
    const bandwidthLimit = formatBandwidthLimit(finalBps);
    if (bandwidthLimit) {
      lines.push(
        `transport.bandwidthLimit = ${escapeToml(bandwidthLimit)}`,
        `transport.bandwidthLimitMode = "server"`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ===== 0.10.2.8 客户端信息中心：本地运行消息 =====
// 监听 frpc 运行（日志报错/意外退出/启动失败/连接池自愈），透出为信息中心消息；
// 内存保留最近 50 条，同内容 10 分钟内去重（仅累加次数），不落盘（重启视为已感知）。
const RUNTIME_MESSAGE_LIMIT = 50;
const RUNTIME_MESSAGE_DEDUP_MS = 10 * 60_000;
const runtimeMessages = [];
let runtimeMessageSeq = 0;

function pushRuntimeMessage(level, text, source = "frpc") {
  const clean = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  if (!clean) return;
  const now = Date.now();
  const key = clean.slice(0, 100);
  const dup = runtimeMessages.find(
    (item) => item.key === key && now - item.firstSeenAt < RUNTIME_MESSAGE_DEDUP_MS,
  );
  if (dup) {
    dup.count += 1;
    return;
  }
  runtimeMessageSeq += 1;
  runtimeMessages.push({
    id: `m-${now.toString(36)}-${runtimeMessageSeq}`,
    key,
    level: level === "warn" ? "warn" : "error",
    text: clean,
    source: String(source || "frpc"),
    createdAt: new Date().toISOString(),
    firstSeenAt: now,
    count: 1,
  });
  if (runtimeMessages.length > RUNTIME_MESSAGE_LIMIT) {
    runtimeMessages.splice(0, runtimeMessages.length - RUNTIME_MESSAGE_LIMIT);
  }
}

// 信息中心快照：最新在前，剥离内部去重字段。
function runtimeMessagesSnapshot() {
  return runtimeMessages
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map(({ key, ...rest }) => rest);
}

class FrpcSupervisor {
  constructor(key = "custom") {
    // 0.10.1.1：每个承载节点一个 supervisor（key=节点名，未登录自定义配置为 custom）。
    this.key = String(key || "custom");
    const safeKey = this.key.replace(/[^a-z0-9_-]/gi, "_") || "default";
    this.configPath = join(RUNTIME_DIR, `frpc-${safeKey}.toml`);
    this.process = null;
    this.desired = false;
    this.authorizationPaused = false;
    this.state = existsSync(FRPC_BIN) ? "stopped" : "missing";
    this.logs = [];
    this.startedAt = null;
    this.restartTimer = null;
    // restart() 触发的重启在旧进程退出后立即启动；崩溃自愈仍走 2s 延时。
    this.immediateRestart = false;
    // 0.9.3：配置代际——每次写入新 frpc 配置递增，防止旧进程的延迟删除误删新配置。
    this.configGeneration = 0;
    // 0.10.2.7：连接池假死自愈检测状态（60s 窗口计数 + 重启冷却时间戳）。
    this.poolFullTimes = [];
    this.poolFullRestartAt = 0;
  }

  appendLog(text) {
    const rawLines = String(text)
      .split(/\r?\n/)
      .filter(Boolean);
    // 0.10.2.8：监听 frpc 运行日志，[E] 级错误透出为信息中心消息（pushRuntimeMessage 内去重）。
    for (const line of rawLines) {
      if (/\s\[E\]\s/.test(line)) {
        pushRuntimeMessage(
          "error",
          `[${this.key}] ${line.replace(/^[^\[]*\[E\]\s*/, "").trim()}`,
        );
      }
    }
    const lines = rawLines.map((line) => `${new Date().toISOString()} ${line}`);
    this.logs.push(...lines);
    this.logs = this.logs.slice(-200);
    this.detectPoolFull(lines);
  }

  // 0.10.2.7：frpc 日志自愈——60 秒内累计 ≥10 条 "work connection pool is full"
  // 视为工作连接池已被死连接占满（隧道实际不可用，用户需重启 frpc 才能恢复），
  // 自动重启一次重建连接池；重启后 10 分钟冷却，防止异常场景反复重启。
  detectPoolFull(lines) {
    if (!lines.some((line) => line.includes("work connection pool is full"))) return;
    const now = Date.now();
    // 冷却期内（自愈重启后 10 分钟）不再重复触发，防止异常场景循环重启。
    if (now - this.poolFullRestartAt < 10 * 60_000) return;
    this.poolFullTimes = this.poolFullTimes.filter((time) => now - time < 60_000);
    this.poolFullTimes.push(now);
    if (this.poolFullTimes.length >= 10) {
      this.poolFullTimes = [];
      this.poolFullRestartAt = now;
      this.appendLog(
        `[${this.key}] 检测到 frpc 工作连接池持续占满（隧道已不可用），自动重启 frpc 重建连接池`,
      );
      pushRuntimeMessage(
        "warn",
        `[${this.key}] 隧道连接池持续占满，已自动重启 frpc 重建连接池`,
      );
      this.restart();
    }
  }

  // 0.10.1.3 规格4：启动失败（配置生成/写入/进程创建异常）不再卡死在 error 态——
  // 原实现只在进程 exit 回调里安排重试，这类失败没有进程可退，supervisor 永久停在
  // error 直到人工干预（如同步版本窗口期配置临时异常就会导致映射长时间不可用）。
  scheduleStartRetry(delay = 2_000) {
    if (!this.desired || this.authorizationPaused) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => this.start(), delay);
  }

  start() {
    this.desired = true;
    this.authorizationPaused = false;
    clearTimeout(this.restartTimer);
    if (this.process) return;
    if (!existsSync(FRPC_BIN)) {
      this.state = "missing";
      this.appendLog(`[${this.key}] frpc binary not found: ${FRPC_BIN}`);
      pushRuntimeMessage(
        "error",
        "frpc 内核缺失，隧道无法启动，请在设置中重新安装 frpc 内核",
      );
      return;
    }
    if (state.session) {
      // session 可能存在但缺 user（异常状态文件/旧版本数据），必须判空避免启动崩溃。
      const u = state.session?.user;
      // 0.9.3：未激活（activated===false / mustChangePassword / expiresAt 为空）或过期/停用账户禁止启动 frpc。
      if (
        u &&
        (u.mustChangePassword ||
          u.activated === false ||
          !u.enabled ||
          (u.expiresAt == null && u.activated !== true) ||
          isExpired(u.expiresAt))) {
        // 待激活（首次登录未改密）账户禁止启动 frpc，必须先完成激活。
        this.state = "unauthorized";
        this.authorizationPaused = true;
        pushRuntimeMessage(
          "warn",
          "账号待激活、已停用或已过期，frpc 暂停运行，请在激活/续期后重试",
        );
        return;
      }
    } else if (!String(state.customFrpcConfig || "").trim()) {
      // 未登录且未填写自定义配置：保持停止，等待用户在设置中填写配置文件。
      this.state = "stopped";
      return;
    }

    const configPath = this.configPath;
    let config;
    try {
      config = configText(this.key);
    } catch (error) {
      this.appendLog(`[${this.key}] ${error.message}`);
      pushRuntimeMessage("error", `[${this.key}] frpc 配置生成失败：${error.message}`);
      this.state = "error";
      this.scheduleStartRetry();
      return;
    }
    // 0.9.3：HTTP/HTTPS 授权被收回后，域名隧道不写入配置并给出明确提示（仅主节点承载）。
    if (state.session?.user && state.session.user.httpAllowed === false) {
      const skipped = state.proxies.filter(
        (item) =>
          item.enabled &&
          (item.type === "http" || item.type === "https") &&
          (item.node || "master") === this.key,
      );
      if (skipped.length) {
        this.appendLog(
          `[${this.key}] 当前账号未开通 HTTP/HTTPS 隧道权限，${skipped.length} 条域名隧道未写入配置，请联系管理员授权`,
        );
      }
    }
    const generation = ++this.configGeneration;
    try {
      writeFileSync(configPath, config, { mode: 0o600 });
    } catch (error) {
      this.appendLog(`[${this.key}] ${error.message}`);
      pushRuntimeMessage("error", `[${this.key}] frpc 配置写入失败：${error.message}`);
      this.state = "error";
      this.scheduleStartRetry();
      return;
    }
    try {
      this.process = spawn(FRPC_BIN, ["-c", configPath], {
        cwd: RUNTIME_DIR,
        windowsHide: true,
      });
    } catch (error) {
      this.appendLog(`[${this.key}] ${error.message}`);
      pushRuntimeMessage("error", `[${this.key}] frpc 进程创建失败：${error.message}`);
      this.state = "error";
      this.process = null;
      this.scheduleStartRetry();
      return;
    }
    this.state = "starting";
    this.startedAt = new Date().toISOString();
    this.process.stdout.on("data", (chunk) => this.appendLog(chunk));
    this.process.stderr.on("data", (chunk) => this.appendLog(chunk));
    this.process.once("spawn", () => {
      this.state = "running";
      // 0.9.3：frpc 启动时已将配置读入内存，延迟 1s 删除明文配置文件，规避读取竞态；
      // 代际校验避免重启窗口内旧定时器误删新配置；删除失败保留 0600 文件并告警。
      setTimeout(() => {
        if (generation !== this.configGeneration) return;
        if (!removeRuntimeConfig(configPath)) {
          this.appendLog(
            `[${this.key}] 警告：明文配置 ${configPath} 暂无法删除（文件被占用），已保留为 0600 仅本机可读文件，客户端重启后将再次清理`,
          );
        }
      }, 1_000);
    });
    this.process.once("error", (error) => {
      this.appendLog(`[${this.key}] ${error.message}`);
      pushRuntimeMessage("error", `[${this.key}] frpc 进程异常：${error.message}`);
      this.state = "error";
    });
    this.process.once("exit", (code, signal) => {
      this.appendLog(`[${this.key}] frpc exited code=${code} signal=${signal}`);
      this.process = null;
      if (this.authorizationPaused) {
        this.state = "unauthorized";
        return;
      }
      this.state = "stopped";
      if (this.desired) {
        // 配置变更主动重启：旧进程已退出，立即以新配置 spawn；崩溃自愈保留 2s 延时。
        const planned = this.immediateRestart;
        const delay = planned ? 0 : 2_000;
        this.immediateRestart = false;
        // 0.10.2.8：非主动重启的退出视为异常崩溃，透出信息中心消息。
        if (!planned) {
          pushRuntimeMessage(
            "error",
            `[${this.key}] frpc 进程意外退出（code=${code} signal=${signal}），正在自动重启`,
          );
        }
        this.restartTimer = setTimeout(() => this.start(), delay);
      }
    });
  }

  stop() {
    this.desired = false;
    this.authorizationPaused = false;
    clearTimeout(this.restartTimer);
    if (this.process) this.process.kill();
    else this.state = existsSync(FRPC_BIN) ? "stopped" : "missing";
    // 0.9.3：停止时清理残留明文配置。
    removeRuntimeConfig(this.configPath);
  }

  suspendForAuthorization() {
    const shouldResume =
      this.authorizationPaused ||
      this.desired ||
      Boolean(this.process) ||
      this.state === "running" ||
      this.state === "starting";
    this.desired = false;
    this.authorizationPaused = shouldResume;
    clearTimeout(this.restartTimer);
    if (this.process) this.process.kill();
    this.state = "unauthorized";
  }

  resumeAfterAuthorization() {
    if (!this.authorizationPaused) {
      if (this.state === "unauthorized") {
        this.state = existsSync(FRPC_BIN) ? "stopped" : "missing";
      }
      return;
    }
    this.authorizationPaused = false;
    this.start();
  }

  restart() {
    this.desired = true;
    this.authorizationPaused = false;
    clearTimeout(this.restartTimer);
    if (this.process) {
      // 标记为「退出后立即重启」，由 exit 回调以 0ms 延时 spawn 新进程，消除 2s 断窗。
      this.immediateRestart = true;
      this.process.kill();
    } else {
      this.start();
    }
  }

  refreshState() {
    if (this.process) return;
    this.state = existsSync(FRPC_BIN) ? "stopped" : "missing";
  }

  status() {
    return {
      key: this.key,
      state: this.state,
      desired: this.desired,
      pid: this.process?.pid || null,
      startedAt: this.startedAt,
      binary: FRPC_BIN,
      version: frpcVersion,
      logs: this.logs.slice(-100),
    };
  }
}

// 0.10.1.1：多节点并发映射管理器——每个「有启用映射」的节点一个独立 frpc 进程，
// 未登录自定义配置固定为 custom 单进程；对外保持与旧 FrpcSupervisor 一致的方法面。
class FrpcManager {
  constructor() {
    this.supervisors = new Map();
  }

  // 当前应存在的 supervisor key 列表：未登录 → custom；登录 → 每个有启用映射的节点
  //（HTTP/HTTPS 域名隧道仅主节点承载，固定归 master；无启用映射时回退当前选中节点）。
  activeKeys() {
    if (!state.session?.user) return ["custom"];
    const nodes = state.session.nodes;
    const keys = new Set();
    for (const proxy of state.proxies) {
      if (!proxy.enabled) continue;
      if (proxy.type === "http" || proxy.type === "https") {
        if (state.session.user.httpAllowed) keys.add("master");
        continue;
      }
      keys.add(proxy.node || "master");
    }
    // 无启用映射时保留基线进程（当前选中节点，默认主节点），保证「连接」语义不变。
    if (!keys.size) keys.add(state.session.selectedNode || "master");
    // 0.10.1.5：nodes 非数组（旧服务端不下发节点列表）不过滤；空数组 = 授权节点已被
    // 服务端全部收回（端口收回/取消关联）——过滤所有 key，ensureSupervisors 停掉全部进程。
    // master 例外：已授权 HTTP/HTTPS 且存在启用中的域名隧道时保留（域名隧道走 vhost 共享端口，
    // 不占用用户端口授权）；节点全部收回时该例外同样失效。
    if (!Array.isArray(nodes)) return [...keys];
    return [...keys].filter(
      (key) =>
        nodes.some((node) => node.name === key) ||
        (key === "master" &&
          nodes.length > 0 &&
          state.session.user.httpAllowed &&
          state.proxies.some(
            (proxy) => proxy.enabled && (proxy.type === "http" || proxy.type === "https"),
          )),
    );
  }

  // 0.10.1.2 规格6：按 key 取单个 supervisor（不存在返回 null），节点级启停用。
  supervisorOf(key) {
    return this.supervisors.get(String(key || "")) || null;
  }

  // 使 supervisors 与 activeKeys 对齐：多出的停止并移除，缺的新建。
  ensureSupervisors() {
    const wanted = new Set(this.activeKeys());
    for (const [key, supervisor] of this.supervisors) {
      if (!wanted.has(key)) {
        supervisor.stop();
        this.supervisors.delete(key);
      }
    }
    for (const key of wanted) {
      if (!this.supervisors.has(key)) {
        this.supervisors.set(key, new FrpcSupervisor(key));
      }
    }
  }

  start() {
    this.ensureSupervisors();
    for (const supervisor of this.supervisors.values()) supervisor.start();
  }

  stop() {
    for (const supervisor of this.supervisors.values()) supervisor.stop();
  }

  restart() {
    this.ensureSupervisors();
    for (const supervisor of this.supervisors.values()) supervisor.restart();
  }

  // 0.10.1.3 规格4：仅重启指定节点的 frpc 进程（节点连接参数变化时精准应用新配置，
  // 不打断其他节点正常连接）。
  restartKeys(keys) {
    for (const key of Array.isArray(keys) ? keys : []) {
      const supervisor = this.supervisors.get(String(key));
      if (supervisor && (supervisor.desired || supervisor.process)) supervisor.restart();
    }
  }

  suspendForAuthorization() {
    for (const supervisor of this.supervisors.values()) supervisor.suspendForAuthorization();
  }

  resumeAfterAuthorization() {
    this.ensureSupervisors();
    for (const supervisor of this.supervisors.values()) supervisor.resumeAfterAuthorization();
  }

  refreshState() {
    for (const supervisor of this.supervisors.values()) supervisor.refreshState();
  }

  // 提示性日志写入所有 supervisor 的日志（界面任意节点页可见）。
  appendLog(text) {
    for (const supervisor of this.supervisors.values()) supervisor.appendLog(text);
  }

  get process() {
    for (const supervisor of this.supervisors.values()) {
      if (supervisor.process) return supervisor.process;
    }
    return null;
  }

  get desired() {
    for (const supervisor of this.supervisors.values()) {
      if (supervisor.desired) return true;
    }
    return false;
  }

  get state() {
    return this.status().state;
  }

  aggregateState(list) {
    if (!list.length) return existsSync(FRPC_BIN) ? "stopped" : "missing";
    if (list.some((item) => item.state === "error")) return "error";
    if (list.some((item) => item.state === "unauthorized")) return "unauthorized";
    if (list.some((item) => item.state === "starting")) return "starting";
    if (list.every((item) => item.state === "running")) return "running";
    if (list.some((item) => item.state === "running")) return "partial";
    return "stopped";
  }

  status() {
    this.ensureSupervisors();
    const list = [...this.supervisors.values()];
    const running = list.filter((item) => item.process);
    return {
      // 聚合状态：旧界面字段保持语义（多节点时 partial 表示部分运行）。
      state: this.aggregateState(list),
      desired: list.some((item) => item.desired),
      pid: running[0]?.process?.pid || null,
      startedAt: running[0]?.startedAt || null,
      binary: FRPC_BIN,
      version: frpcVersion,
      logs: list[0]?.logs.slice(-100) || [],
      // 0.10.1.1：每个 frpc 进程一个节点条目（运行日志多页展示用）。
      nodes: list.map((item) => item.status()),
    };
  }
}

const frpc = new FrpcManager();

// 未登录时手动"检测版本更新"得到的结果（运行时内存，不持久化）；
// 登录后以服务端心跳下发的 session.updateInfo 为准。
let pendingUpdate = null;

// 旧版服务端不下发 ports 时，用授权范围 + 本机映射端口本地估算。
function fallbackPorts() {
  const user = state.session?.user;
  const ranges = Array.isArray(user?.portRanges) ? user.portRanges : [];
  if (ranges.length === 0) return null;
  const occupied = new Set(
    state.proxies.map((proxy) => proxy.remotePort).filter((port) => Number.isInteger(port)),
  );
  const totalPorts = ranges.reduce(
    (sum, range) => sum + (range.end - range.start + 1),
    0,
  );
  const availablePorts = [];
  for (const range of ranges) {
    for (let port = range.start; port <= range.end; port += 1) {
      if (!occupied.has(port)) availablePorts.push(port);
      if (availablePorts.length >= 50) break;
    }
    if (availablePorts.length >= 50) break;
  }
  return {
    ranges,
    totalPorts,
    usedCount: state.proxies.length,
    occupiedCount: occupied.size,
    availablePorts,
    estimated: true,
  };
}

function browserState(req = null) {
  const traffic = state.session?.traffic;
  return {
    connected: Boolean(state.session),
    serverAddress: state.session?.serverAddress || "",
    user: state.session?.user || null,
    sessionError: state.sessionError || null,
    // 0.9.3：旧明文 state.json 删除失败等本地安全告警（非阻断，顶部横幅提示）。
    securityNotice: state.plaintextStateLeftover
      ? "检测到旧版明文状态文件 state.json 仍残留在数据目录且暂无法删除（可能被占用），重启客户端后将自动重试；为保护账号安全请手动删除该文件。"
      : null,
    ports: state.session?.ports || fallbackPorts(),
    // 0.10.0.2：节点选择器数据——用户被授权的节点列表与当前选中节点。
    nodes: Array.isArray(state.session?.nodes) ? state.session.nodes : [],
    selectedNode: state.session?.selectedNode || null,
    branding: state.session ? browserBranding() : offlineBranding(),
    renewalUrl: state.session?.renewalUrl || "",
    currentVersion: VERSION,
    update: state.session?.updateInfo || pendingUpdate || null,
    proxies: state.proxies.map((proxy) => {
      // 0.10.1.1：标注归属节点与其 host（访问方式展示用）。
      const nodes = Array.isArray(state.session?.nodes) ? state.session.nodes : [];
      const nodeEntry =
        nodes.find((node) => node.name === (proxy.node || "master")) || null;
      return {
        ...proxy,
        node: proxy.node || "master",
        nodeHost: nodeEntry?.host || state.session?.serverAddress || "",
        traffic: traffic?.proxies?.[proxy.name] || {
          available: Boolean(traffic?.available),
          sampledAt: traffic?.sampledAt || null,
          error: traffic?.error || null,
          hasMetrics: false,
          incomingBytes: 0,
          outgoingBytes: 0,
          totalIncomingBytes: 0,
          totalOutgoingBytes: 0,
          incomingBytesPerSecond: 0,
          outgoingBytesPerSecond: 0,
        },
      };
    }),
    frpc: frpc.status(),
    serverFrpc: state.session?.serverFrpc || null,
    // 0.10.0.1：frpc 本机锁状态（登录会话旁路，界面据此显示解锁面板/禁用操作）。
    frpcLock: {
      enabled: true,
      unlocked: Boolean(state.session) || isFrpcUnlocked(req),
    },
    // 0.10.2.8：信息中心——服务端公告 + 本地运行消息 + 未读计数（徽标与弹窗依据）。
    notices: Array.isArray(state.notices) ? state.notices : [],
    messages: runtimeMessagesSnapshot(),
    unread: (() => {
      const notices = Array.isArray(state.notices) ? state.notices : [];
      const readIds = new Set((state.noticeReadIds || []).map(String));
      const unreadNoticeIds = notices
        .filter((item) => !readIds.has(String(item?.id)))
        .map((item) => String(item?.id));
      const readAt = state.messagesReadAt || "";
      const messageUnread = runtimeMessages.filter((item) => item.createdAt > readAt).length;
      return {
        notices: unreadNoticeIds.length,
        messages: messageUnread,
        total: unreadNoticeIds.length + messageUnread,
        noticeIds: unreadNoticeIds,
      };
    })(),
  };
}

async function remoteFetch(path, options = {}) {
  if (!state.session) throw new Error("请先登录");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${managerBaseUrl(state.session.serverAddress)}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.session.token}`,
        "X-FRP-Device-ID": state.deviceId,
        "X-Client-Version": VERSION,
        ...(options.headers || {}),
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `服务器返回 ${response.status}`);
      error.status = response.status;
      error.code = data.code;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

// 服务端下发的品牌 Logo 下载到本地缓存；URL 变化时才重新拉取。
let lastSyncedLogoUrl = null;
let logoRetryAt = 0;
async function syncBrandingLogo() {
  if (!state.session) return false;
  const branding = state.session.branding || {};
  const logoUrl = branding.clientLogoUrl || null;
  if (logoUrl === lastSyncedLogoUrl) return false;
  if (!logoUrl) {
    const hadLogo = Boolean(state.session.brandingLogo);
    state.session.brandingLogo = null;
    if (existsSync(BRANDING_LOGO_FILE)) {
      try {
        unlinkSync(BRANDING_LOGO_FILE);
      } catch {
        // 删除失败不影响使用。
      }
    }
    lastSyncedLogoUrl = null;
    logoRetryAt = 0;
    return hadLogo;
  }
  if (Date.now() < logoRetryAt) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(
      `${managerBaseUrl(state.session.serverAddress)}${logoUrl}`,
      { signal: controller.signal },
    );
    if (!response.ok) throw new Error(`logo fetch ${response.status}`);
    const mime = response.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) throw new Error("logo empty");
    writeFileSync(BRANDING_LOGO_FILE, buffer, { mode: 0o600 });
    state.session.brandingLogo = { mime, version: Date.now() };
    lastSyncedLogoUrl = logoUrl;
    return true;
  } catch {
    // 拉取失败时保留已有缓存，60 秒后重试。
    logoRetryAt = Date.now() + 60_000;
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function browserBranding() {
  const logo = state.session?.brandingLogo;
  const cp = state.session?.branding?.copyright;
  return {
    name: state.session?.branding?.clientName || "",
    logoUrl: logo ? `/branding/logo?v=${logo.version}` : null,
    icp: state.session?.branding?.icp || "",
    police: state.session?.branding?.police || "",
    // 连接服务端后展示该服务端（源自授权中心）的版权；未连接时展示内置默认版权。
    copyright: {
      text: cp?.text || DEFAULT_COPYRIGHT_TEXT,
      url: cp?.url || "",
    },
  };
}

// 未连接任何服务端时的品牌/版权信息（全新部署：展示授权中心统一的默认声明）。
function offlineBranding() {
  return {
    name: "",
    logoUrl: null,
    icp: "",
    police: "",
    copyright: { text: DEFAULT_COPYRIGHT_TEXT, url: "" },
  };
}

async function connect(input) {
  // 0.10.2.0：集群 id 输入先解析为当前主节点地址（未知 id/解析失败按 IP/域名直连）。
  const resolvedCluster = await resolveClusterIdInput(input.serverAddress);
  const serverAddress = normalizeServerAddress(
    resolvedCluster?.masterAddress || input.serverAddress,
  );
  const serverUrl = managerBaseUrl(serverAddress);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${serverUrl}/api/client/login`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", "X-Client-Version": VERSION },
      body: JSON.stringify({
        // 0.9.2：登录框输入的是用户 ID；同时带 username 字段兼容 0.9.1 旧服务端。
        uid: input.username,
        username: input.username,
        password: input.password,
        deviceId: state.deviceId,
        clientVersion: VERSION,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `登录失败 (${response.status})`);
      error.code = data.code;
      throw error;
    }
    frpc.stop();
    // 0.9.2：账号归属以稳定的 uid 判定（用户名可改、可重名）。
    const ownerKey = data.user.uid || data.user.username;
    if (state.ownerKey && state.ownerKey !== ownerKey) {
      state.proxies = [];
    }
    state.ownerKey = ownerKey;
    // 0.10.0.2：登录统一走集群主节点；nodes 为用户被授权的节点列表（含各节点端口段），
    // 默认选中主节点（无主节点段时取首个），空列表兼容旧服务端（null = 等价主节点）。
    const nodes = Array.isArray(data.nodes) ? data.nodes : [];
    const defaultNode = nodes.some((node) => node.name === "master")
      ? "master"
      : nodes[0]?.name || null;
    state.session = {
      serverAddress,
      // 0.10.2.0：用集群 id 登录时记录 id——主节点切换后 refreshProfile 据此自动跟随新主。
      clusterId: resolvedCluster?.clusterId || "",
      token: data.token,
      user: data.user,
      nodes,
      selectedNode: defaultNode,
      traffic: data.traffic || {
        available: false,
        sampledAt: null,
        error: null,
        proxies: {},
      },
      ports: data.ports || null,
      branding: data.branding || { clientName: "", clientLogoUrl: null, icp: "", police: "", copyright: { text: DEFAULT_COPYRIGHT_TEXT, url: "" } },
      brandingLogo: null,
      renewalUrl: data.renewalUrl || "",
      updateInfo: sanitizeUpdateInfo(data.update, VERSION),
      serverFrpc: data.frpc || { available: false, version: "" },
      frp: data.frp,
    };
    lastSyncedLogoUrl = null;
    logoRetryAt = 0;
    // 0.10.2.8：登录响应同样携带公告，登录即缓存。
    state.notices = Array.isArray(data.notices) ? data.notices : [];
    state.sessionError = null;
    saveState();
    // 0.9.0：首次登录待激活（mustChangePassword）时不启动 frpc，强制先走激活流程。
    if (!data.user.mustChangePassword) frpc.start();
    void syncBrandingLogo().then(() => {
      if (state.session) saveState();
    });
  } finally {
    clearTimeout(timeout);
  }
}

// 0.10.2.0：主节点跟随重解析节流（30 秒内不重复向授权中心解析）。
let masterFollowAt = 0;

async function refreshProfile() {
  if (!state.session) return;
  try {
    const data = await remoteFetch("/api/client/me");
    const tokenChanged = Boolean(data.token && data.token !== state.session.token);
    // 0.9.3：HTTP/HTTPS 授权变化也需要重启 frpc 以增删域名隧道配置。
    const oldHttpAllowed = state.session.user?.httpAllowed;
    // 记录 frp 连接参数（host/port/authToken/heartbeat），服务端迁移或轮换 token 后需重连生效。
    const oldFrpConn = JSON.stringify(
      (() => {
        const f = state.session.frp || {};
        return { host: f.host, port: f.port, authToken: f.authToken, heartbeatInterval: f.heartbeatInterval };
      })(),
    );
    if (data.token) state.session.token = data.token;
    state.session.user = data.user;
    if (!state.session.frp) state.session.frp = {};
    // frp 连接参数 / vhost 端口随心跳下发，合并后按变化重启 frpc 应用新配置。
    if (data.frp) {
      if (data.frp.host != null) state.session.frp.host = data.frp.host;
      if (data.frp.port != null) state.session.frp.port = data.frp.port;
      if (data.frp.authToken != null) state.session.frp.authToken = data.frp.authToken;
      if (data.frp.heartbeatInterval != null) {
        state.session.frp.heartbeatInterval = data.frp.heartbeatInterval;
      }
      state.session.frp.vhostHttpPort = data.frp.vhostHttpPort;
      state.session.frp.vhostHttpsPort = data.frp.vhostHttpsPort;
    }
    // 0.10.0.2：节点列表随心跳刷新；选中节点被回收时回退主节点/首节点。
    // 0.10.1.5：服务端收回端口/取消关联后 nodes 可能为空数组或缺少个别节点——
    // 必须同步停掉对应 frpc 进程，否则旧连接仍存活（取消关联形同虚设）。
    if (Array.isArray(data.nodes)) {
      const previousNodes = Array.isArray(state.session.nodes) ? state.session.nodes : [];
      if (!data.nodes.length) {
        const hadNodes = previousNodes.length > 0;
        state.session.nodes = [];
        if (hadNodes) {
          frpc.appendLog("授权节点已被服务端全部收回，停止全部 frpc 连接");
        }
        frpc.stop();
      } else {
        // 0.10.1.3 规格4：检测已有节点的连接参数变化（host/bindPort/frpToken）。
        // 节点重新部署、改监听端口或令牌轮换后，若不重启对应 frpc 进程，客户端会一直
        // 按旧地址/旧令牌连接（表现为「同步版本后连接其他节点一段时间不可用」）。
        const changedNodeKeys = data.nodes
          .filter((next) => {
            const prev = previousNodes.find((node) => node.name === next.name);
            if (!prev) return false;
            return (
              String(prev.host || "") !== String(next.host || "") ||
              Number(prev.bindPort) !== Number(next.bindPort) ||
              String(prev.frpToken || "") !== String(next.frpToken || "")
            );
          })
          .map((node) => node.name);
        // 0.10.1.5：检测被取消关联（从列表移除）的节点，立即对账停掉对应进程。
        const removedNodes = previousNodes.filter(
          (prev) => !data.nodes.some((next) => next.name === prev.name),
        );
        state.session.nodes = data.nodes;
        const stillAllowed = state.session.nodes.some(
          (node) => node.name === state.session.selectedNode,
        );
        if (!stillAllowed) {
          state.session.selectedNode = state.session.nodes.some((node) => node.name === "master")
            ? "master"
            : state.session.nodes[0].name;
          frpc.restart();
        } else if (changedNodeKeys.length) {
          frpc.appendLog(
            `节点连接参数已变更，重启对应 frpc 进程：${changedNodeKeys.join("、")}`,
          );
          frpc.restartKeys(changedNodeKeys);
        }
        if (removedNodes.length) {
          frpc.appendLog(
            `节点已取消关联，停止对应 frpc 进程：${removedNodes.map((node) => node.name).join("、")}`,
          );
          frpc.ensureSupervisors();
        }
      }
    }
    const newFrpConn = JSON.stringify(
      (() => {
        const f = state.session.frp || {};
        return { host: f.host, port: f.port, authToken: f.authToken, heartbeatInterval: f.heartbeatInterval };
      })(),
    );
    const frpConnChanged = oldFrpConn !== newFrpConn;
    state.session.traffic = data.traffic || {
      available: false,
      sampledAt: null,
      error: null,
      proxies: {},
    };
    state.session.ports = data.ports || null;
    state.session.branding = data.branding || { clientName: "", clientLogoUrl: null, icp: "", police: "", copyright: { text: DEFAULT_COPYRIGHT_TEXT, url: "" } };
    state.session.renewalUrl = data.renewalUrl || "";
    state.session.updateInfo = sanitizeUpdateInfo(data.update, VERSION);
    state.session.serverFrpc = data.frpc || { available: false, version: "" };
    // 0.10.2.8：服务端公告随心跳下发，缓存到本地；已读标记修剪为仍存在的公告 id。
    state.notices = Array.isArray(data.notices) ? data.notices : [];
    {
      const aliveIds = new Set(state.notices.map((item) => String(item?.id)));
      state.noticeReadIds = state.noticeReadIds.filter((id) => aliveIds.has(id));
    }
    state.sessionError = null;
    saveState();
    void syncBrandingLogo().then((synced) => {
      if (synced && state.session) saveState();
    });
    if (
      data.user.expired ||
      !data.user.enabled ||
      data.user.mustChangePassword ||
      data.user.activated === false
    ) {
      // 待激活（管理员重置密码/首次登录）同样挂起 frpc，激活或恢复后由 resume 拉回。
      frpc.suspendForAuthorization();
    } else {
      const httpAllowedChanged = oldHttpAllowed !== Boolean(data.user?.httpAllowed);
      // 0.9.3.2：限速变更通过 commands 队列推送，心跳不再下发限速数据。
      // 收到限速命令时立即更新本地状态并重启 frpc。
      let rateLimitChanged = false;
      if (Array.isArray(data.commands) && data.commands.length > 0) {
        for (const cmd of data.commands) {
          if (cmd.type === "rateLimitUpdate") {
            state.session.frp.rateLimitBps = cmd.rateLimitBps ?? 0;
            state.session.frp.proxyRateLimits = cmd.proxyRateLimits || {};
            rateLimitChanged = true;
          }
        }
        saveState();
      }
      const shouldRestart =
        (tokenChanged ||
          rateLimitChanged ||
          httpAllowedChanged ||
          frpConnChanged) &&
        (frpc.desired || Boolean(frpc.process));
      if (httpAllowedChanged && data.user?.httpAllowed === false) {
        // 授权被收回：运行中的 http/https 隧道将随重启从配置中移除（服务端 NewProxy 亦强制拦截）。
        frpc.appendLog("HTTP/HTTPS 隧道权限已被管理员收回，域名隧道将停止并从配置中移除");
      }
      frpc.resumeAfterAuthorization();
      if (shouldRestart && frpc.process) frpc.restart();
    }
  } catch (error) {
    // 0.10.2.0：集群 id 登录的主节点跟随——当前服务端不可达/报错时重新解析集群 id，
    // 主节点已切换则自动改连新主（集群统一签名密钥，旧会话 token 在新主上仍有效）；
    // 地址未变化（或未用 id 登录）时按原有错误处理走。
    if (state.session?.clusterId && Date.now() - masterFollowAt >= 30_000) {
      masterFollowAt = Date.now();
      const resolved = await resolveClusterIdInput(state.session.clusterId);
      if (state.session && resolved?.masterAddress) {
        const nextAddress = normalizeServerAddress(resolved.masterAddress);
        if (nextAddress !== state.session.serverAddress) {
          state.session.serverAddress = nextAddress;
          state.sessionError = null;
          saveState();
          frpc.appendLog(`检测到集群主节点切换，改连新主节点 ${nextAddress}`);
          // 立即按新主地址重建 frpc 进程（旧主不可达时进程可能已退出，
          // 依赖下一轮 /me 的 frpConnChanged 会漏启）。
          frpc.restart();
          return;
        }
      }
    }
    state.sessionError = error.name === "AbortError" ? "无法连接管理服务器" : error.message;
    if (
      [
        "SESSION_REVOKED",
        "IDENTITY_MISMATCH",
        "TOKEN_INVALID",
        "DEVICE_REPLACED",
        "DEVICE_REQUIRED",
      ].includes(error.code)
    ) {
      const username = state.session?.user?.username;
      frpc.stop();
      state.ownerUsername = username || state.ownerUsername;
      state.session = null;
      if (error.code === "DEVICE_REPLACED") {
        state.sessionError = "账号已在另一台设备登录，本机已退出";
      } else if (error.code === "DEVICE_REQUIRED") {
        state.sessionError = "客户端已升级，请重新登录";
      } else {
        state.sessionError =
          error.code === "SESSION_REVOKED"
            ? "账号已被管理员强制下线，请重新登录"
            : "登录已失效，请重新登录";
      }
    } else if (
      [
        "ACCOUNT_EXPIRED",
        "ACCOUNT_DISABLED",
        "SERVER_LICENSE_REQUIRED",
      ].includes(error.code) ||
      /(到期|停用|许可)/.test(state.sessionError)
    ) {
      frpc.suspendForAuthorization();
    }
    saveState();
    // 会话被服务端吊销/踢下线后同样回到免登录状态：若此前自定义 frpc 期望运行则恢复。
    if (
      !state.session &&
      state.customFrpcDesired &&
      String(state.customFrpcConfig || "").trim()
    ) {
      frpc.start();
    }
  }
}

const staticFiles = new Map([
  ["/", join(ROOT, "client", "public", "index.html")],
  ["/app.js", join(ROOT, "client", "public", "app.js")],
  ["/assets/style.css", join(ROOT, "shared", "style.css")],
  ["/favicon.svg", join(ROOT, "shared", "favicon.svg")],
]);

function serveStatic(res, pathname) {
  const file = staticFiles.get(pathname);
  if (!file || !existsSync(file)) return false;
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
  };
  const body =
    extname(file) === ".html"
      ? Buffer.from(renderHtmlWithIncludes(file), "utf8")
      : readFileSync(file);
  res.writeHead(200, {
    "Content-Type": types[extname(file)] || "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": pathname === "/" ? "no-store" : "public, max-age=300",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self' https://unpkg.com; style-src 'self'; img-src 'self' data:; connect-src 'self'",
  });
  res.end(body);
  return true;
}

async function handleApi(req, res, url) {
  const { pathname } = url;
  if (pathname === "/healthz") {
    sendJson(res, 200, { ok: true, frpc: frpc.state });
    return true;
  }

  // CSRF 防护：所有状态变更请求必须携带自定义头（跨站请求无法通过预检）。
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    req.headers["x-console-request"] !== "1"
  ) {
    sendJson(res, 403, { error: "非法请求来源", code: "CSRF_BLOCKED" });
    return true;
  }

  // 0.10.0.1：未登录且未解锁时，frpc 变更操作（改配置/启停/换二进制）一律拦截。
  if (isFrpcLockedRequest(pathname, req.method) && !isFrpcUnlocked(req)) {
    sendJson(res, 403, { error: "frpc 已锁定，请先在设置中用锁密码解锁", code: "FRPC_LOCKED" });
    return true;
  }

  if (pathname === "/api/state" && req.method === "GET") {
    sendJson(res, 200, browserState(req));
    return true;
  }
  if (pathname === "/branding/logo" && req.method === "GET") {
    const logo = state.session?.brandingLogo;
    if (!logo || !existsSync(BRANDING_LOGO_FILE)) {
      sendJson(res, 404, { error: "未设置品牌 Logo" });
      return true;
    }
    const body = readFileSync(BRANDING_LOGO_FILE);
    res.writeHead(200, {
      "Content-Type": logo.mime || "image/png",
      "Content-Length": body.length,
      "Cache-Control": "public, max-age=60",
    });
    res.end(body);
    return true;
  }
  if (pathname === "/api/connect" && req.method === "POST") {
    await connect(await readJson(req));
    sendJson(res, 200, browserState(req));
    return true;
  }
  if (pathname === "/api/disconnect" && req.method === "POST") {
    frpc.stop();
    if (state.session) {
      try {
        await remoteFetch("/api/client/logout", { method: "POST" });
      } catch {
        // Local logout must still complete when the server is unreachable.
      }
    }
    state.session = null;
    state.sessionError = null;
    // 0.10.2.8：登出清空公告缓存（公告属于服务端/账号，换账号登录后重新拉取）。
    state.notices = [];
    saveState();
    // 退出登录后回到免登录状态：若此前自定义 frpc 处于期望运行状态，则用自定义配置重新拉起，
    // 否则登出后 frpc 被停止且配置来源消失，用户将无法继续使用自己的 frpc 隧道。
    if (state.customFrpcDesired && String(state.customFrpcConfig || "").trim()) {
      frpc.start();
    }
    sendJson(res, 200, browserState(req));
    return true;
  }
  if (pathname === "/api/refresh" && req.method === "POST") {
    await refreshProfile();
    sendJson(res, 200, browserState(req));
    return true;
  }
  // 0.10.2.8：信息中心已读——scope=notices 仅标记公告已读；scope=all 连同本地运行消息。
  if (pathname === "/api/messages/read" && req.method === "POST") {
    const body = await readJson(req);
    if (body?.scope === "all") {
      state.messagesReadAt = new Date().toISOString();
    }
    const ids = (Array.isArray(state.notices) ? state.notices : []).map((item) =>
      String(item?.id),
    );
    const readSet = new Set((state.noticeReadIds || []).map(String));
    for (const id of ids) readSet.add(id);
    state.noticeReadIds = [...readSet].slice(-500);
    saveState();
    sendJson(res, 200, browserState(req));
    return true;
  }
  // 0.10.0.2：切换承载节点（节点+端口二维授权）——更新选中节点并重启 frpc 应用新 serverAddr。
  if (pathname === "/api/session/node" && req.method === "POST") {
    if (!state.session) throw new Error("请先连接服务端");
    const input = await readJson(req);
    const nodes = Array.isArray(state.session.nodes) ? state.session.nodes : [];
    const target = nodes.find((node) => node.name === String(input.name || ""));
    if (!target) throw new Error("节点不存在或未授权该节点");
    if (state.session.selectedNode !== target.name) {
      state.session.selectedNode = target.name;
      saveState();
      frpc.restart();
    }
    sendJson(res, 200, browserState(req));
    return true;
  }

  // 0.9.0：首次登录强制激活——修改初始密码（可选同时改用户名），成功后更新 token 并启动 frpc。
  if (pathname === "/api/account/activate" && req.method === "POST") {
    if (!state.session) {
      sendJson(res, 401, { error: "请先登录" });
      return true;
    }
    try {
      const input = await readJson(req);
      const newUsername = String(input.newUsername || "").trim();
      // 先改名（旧密码校验），再改密：两步都用当前密码鉴权。
      if (newUsername) {
        const renamed = await remoteFetch("/api/client/account/username", {
          method: "POST",
          body: JSON.stringify({ currentPassword: input.currentPassword, newUsername }),
        });
        state.session.token = renamed.token;
        state.session.user = renamed.user;
        state.ownerKey = renamed.user.uid || renamed.user.username;
      }
      const changed = await remoteFetch("/api/client/account/password", {
        method: "POST",
        body: JSON.stringify({
          currentPassword: input.currentPassword,
          newPassword: input.newPassword,
        }),
      });
      state.session.token = changed.token;
      state.session.user = changed.user;
      saveState();
      frpc.resumeAfterAuthorization();
      frpc.start();
      sendJson(res, 200, browserState(req));
    } catch (error) {
      sendJson(res, Number(error.status) || 400, { error: error.message });
    }
    return true;
  }

  // 已激活用户自助修改密码：token 轮换后重启 frpc 应用新 fm_token。
  if (pathname === "/api/account/password" && req.method === "POST") {
    if (!state.session) {
      sendJson(res, 401, { error: "请先登录" });
      return true;
    }
    try {
      const input = await readJson(req);
      const data = await remoteFetch("/api/client/account/password", {
        method: "POST",
        body: JSON.stringify({
          currentPassword: input.currentPassword,
          newPassword: input.newPassword,
        }),
      });
      state.session.token = data.token;
      state.session.user = data.user;
      saveState();
      if (frpc.desired || Boolean(frpc.process)) frpc.restart();
      sendJson(res, 200, browserState(req));
    } catch (error) {
      sendJson(res, Number(error.status) || 400, { error: error.message });
    }
    return true;
  }

  // 已激活用户自助修改用户名：全限定代理名随之变化，重启 frpc 重建映射。
  if (pathname === "/api/account/username" && req.method === "POST") {
    if (!state.session) {
      sendJson(res, 401, { error: "请先登录" });
      return true;
    }
    try {
      const input = await readJson(req);
      const data = await remoteFetch("/api/client/account/username", {
        method: "POST",
        body: JSON.stringify({
          currentPassword: input.currentPassword,
          newUsername: input.newUsername,
        }),
      });
      state.session.token = data.token;
      state.session.user = data.user;
      state.ownerKey = data.user.uid || data.user.username;
      saveState();
      if (frpc.desired || Boolean(frpc.process)) frpc.restart();
      sendJson(res, 200, browserState(req));
    } catch (error) {
      sendJson(res, Number(error.status) || 400, { error: error.message });
    }
    return true;
  }

  // 0.9.2：自助修改用户 ID：旧 token 失效、frp 身份与限速键前缀随 uid 变化，重启 frpc 重建。
  if (pathname === "/api/account/uid" && req.method === "POST") {
    if (!state.session) {
      sendJson(res, 401, { error: "请先登录" });
      return true;
    }
    try {
      const input = await readJson(req);
      const data = await remoteFetch("/api/client/account/uid", {
        method: "POST",
        body: JSON.stringify({
          currentPassword: input.currentPassword,
          newUid: input.newUid,
        }),
      });
      state.session.token = data.token;
      state.session.user = data.user;
      state.ownerKey = data.user.uid || data.user.username;
      saveState();
      if (frpc.desired || Boolean(frpc.process)) frpc.restart();
      sendJson(res, 200, browserState(req));
    } catch (error) {
      sendJson(res, Number(error.status) || 400, { error: error.message });
    }
    return true;
  }
  // 0.9.5：服务端公开目录（登录页「服务器列表」）——由客户端代理授权中心，避免浏览器跨域。
  if (pathname === "/api/servers/directory" && req.method === "GET") {
    const cached = serverDirectoryCache;
    if (cached && Date.now() - cached.at < 5 * 60_000) {
      sendJson(res, 200, cached.data);
      return true;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const resp = await fetch(`${LICENSE_CENTER_URL}/api/v1/servers/directory`, {
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`授权中心返回 ${resp.status}`);
      const data = await resp.json().catch(() => ({}));
      const payload = {
        total: Number(data.total) || 0,
        servers: Array.isArray(data.servers) ? data.servers.slice(0, 500) : [],
        source: "license-center",
      };
      serverDirectoryCache = { at: Date.now(), data: payload };
      sendJson(res, 200, payload);
    } catch (error) {
      // 失败时短暂回退到过期缓存，避免登录页列表频繁闪烁。
      if (cached) {
        sendJson(res, 200, { ...cached.data, stale: true });
      } else {
        sendJson(res, 502, { error: `服务端列表获取失败：${error.message}`, total: 0, servers: [] });
      }
    } finally {
      clearTimeout(timeout);
    }
    return true;
  }
  // 0.10.0：注册/忘记密码支持探测——查询目标服务端（或集群主节点）的注册开关与入口。
  if (pathname === "/api/auth-config" && req.method === "POST") {
    const input = await readJson(req);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      // 0.10.2.0：集群 id 输入先解析为主节点地址再探测。
      const resolvedCluster = await resolveClusterIdInput(input.serverAddress);
      const serverUrl = managerBaseUrl(
        normalizeServerAddress(resolvedCluster?.masterAddress || input.serverAddress),
      );
      const resp = await fetch(`${serverUrl}/api/client/auth-config`, {
        signal: controller.signal,
        headers: { "X-Client-Version": VERSION },
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `服务端返回 ${resp.status}`);
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, 502, {
        error: `注册功能状态获取失败：${error.name === "AbortError" ? "连接超时" : error.message}`,
        registerEnabled: false,
        forgotEnabled: false,
        registerEndpoint: null,
      });
    } finally {
      clearTimeout(timeout);
    }
    return true;
  }

  // 0.10.0：注册/忘记密码中继——浏览器 → 客户端 → 集群主节点（或本服务端）9400 客户端 API。
  // 从节点不落注册数据，统一由 registerEndpoint 指向的主节点完成注册与密码重置。
  if (pathname === "/api/auth/relay" && req.method === "POST") {
    const input = await readJson(req);
    const RELAY_ACTIONS = {
      captcha: { method: "GET", path: "/api/client/captcha" },
      sliderCaptcha: { method: "GET", path: "/api/client/slider-captcha" },
      registerSendCode: { method: "POST", path: "/api/client/register/send-code" },
      register: { method: "POST", path: "/api/client/register" },
      forgotSendCode: { method: "POST", path: "/api/client/forgot/send-code" },
      forgotReset: { method: "POST", path: "/api/client/forgot/reset" },
    };
    const action = RELAY_ACTIONS[String(input.action || "")];
    if (!action) {
      sendJson(res, 400, { error: "未知的注册操作" });
      return true;
    }
    const controller = new AbortController();
    // 发送验证码涉及外网 SMTP 投递，超时放宽到 20 秒。
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      // 0.10.2.0：集群 id 输入先解析为主节点地址再中继。
      const resolvedCluster = await resolveClusterIdInput(input.serverAddress);
      let serverUrl = managerBaseUrl(
        normalizeServerAddress(resolvedCluster?.masterAddress || input.serverAddress),
      );
      const configResp = await fetch(`${serverUrl}/api/client/auth-config`, {
        signal: controller.signal,
        headers: { "X-Client-Version": VERSION },
      });
      const config = await configResp.json().catch(() => ({}));
      if (configResp.ok && config?.registerEndpoint?.host) {
        // 集群从节点：注册接口在主节点客户端 API 上。
        const endpointHost = isIP(config.registerEndpoint.host) === 6
          ? `[${config.registerEndpoint.host}]`
          : config.registerEndpoint.host;
        serverUrl = `${SERVER_API_SCHEME}://${endpointHost}:${config.registerEndpoint.port || SERVER_API_PORT}`;
      }
      const resp = await fetch(`${serverUrl}${action.path}`, {
        method: action.method,
        signal: controller.signal,
        headers: { "Content-Type": "application/json", "X-Client-Version": VERSION },
        body: action.method === "POST" ? JSON.stringify(input.payload || {}) : undefined,
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `服务端返回 ${resp.status}`);
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, 400, {
        error: error.name === "AbortError" ? "操作超时，请稍后重试" : error.message,
      });
    } finally {
      clearTimeout(timeout);
    }
    return true;
  }

  // 0.10.0：客户端使用套餐码——服务端绑定套餐（时长 + 端口 + 流量），成功后重启 frpc 生效。
  if (pathname === "/api/account/redeem" && req.method === "POST") {
    if (!state.session) {
      sendJson(res, 401, { error: "请先登录" });
      return true;
    }
    try {
      const input = await readJson(req);
      const data = await remoteFetch("/api/client/account/redeem", {
        method: "POST",
        body: JSON.stringify({ code: String(input.code || "").trim() }),
      });
      state.session.user = data.user;
      saveState();
      // 套餐可能新增端口段：frpc 正在运行时自动重启以应用新配置。
      if (frpc.desired || Boolean(frpc.process)) frpc.restart();
      sendJson(res, 200, {
        user: data.user,
        plan: data.plan || null,
        addedRanges: data.addedRanges || [],
        message: data.message || "套餐码兑换成功",
      });
    } catch (error) {
      sendJson(res, Number(error.status) || 400, { error: error.message });
    }
    return true;
  }

  // 0.10.2.6：versionNewer / sanitizeUpdateInfo 移至 shared/core.js 统一维护，
  // 对服务端下发的更新信息做本地版本比较兜底（详见 shared/core.js 注释）。

  if (pathname === "/api/update/check" && req.method === "POST") {
    let info;
    if (state.session?.updateInfo?.downloadUrl || state.session?.updateInfo?.hasUpdate === false) {
      // 已连接：服务端心跳每 3 秒下发最新更新信息，直接使用。
      info = state.session.updateInfo;
    } else {
      // 未连接：直接向授权中心查询最新客户端版本。
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const resp = await fetch(
          `${LICENSE_CENTER_URL}/api/v1/updates/latest?role=client&version=${encodeURIComponent(VERSION)}`,
          { signal: controller.signal },
        );
        if (!resp.ok) throw new Error(`授权中心返回 ${resp.status}`);
        const data = await resp.json().catch(() => ({}));
        const latestVersion = String(data.latestVersion || "").slice(0, 32);
        info = {
          hasUpdate: Boolean(data.hasUpdate) && versionNewer(latestVersion, VERSION),
          latestVersion,
          currentVersion: VERSION,
          downloadUrl: data.downloadUrl
            ? `${LICENSE_CENTER_URL}${String(data.downloadUrl).slice(0, 500)}`
            : "",
          changelog: String(data.changelog || "").slice(0, 8000),
          publishedAt: String(data.publishedAt || "").slice(0, 40),
          urgency: String(data.urgency || "normal").slice(0, 16),
          checkedAt: new Date().toISOString(),
          source: "license-center",
        };
      } finally {
        clearTimeout(timeout);
      }
      pendingUpdate = info.hasUpdate && info.downloadUrl ? info : null;
    }
    sendJson(res, 200, { info, state: browserState(req) });
    return true;
  }
  if (pathname === "/api/update" && req.method === "POST") {
    const info = state.session?.updateInfo || pendingUpdate;
    const url = String(info?.downloadUrl || "");
    if (!url) {
      sendJson(res, 400, { error: "暂无可用的更新包，请先检测版本更新" });
      return true;
    }
    sendJson(res, 202, { ok: true, message: "更新已启动，客户端将自动重启" });
    setImmediate(() => {
      applyUpdateAndRestart({
        downloadUrl: url,
        rootDir: ROOT,
        dataDir: DATA_DIR,
        role: "client",
        ports: [PORT],
        logger: (msg) => console.log(`[updater] ${msg}`),
      }).catch((err) => console.error("update failed:", err.message));
    });
    return true;
  }

  // ---------- frpc 管理 ----------
  if (pathname === "/api/frpc/info" && req.method === "GET") {
    sendJson(res, 200, {
      installed: existsSync(FRPC_BIN),
      binary: FRPC_BIN,
      version: frpcVersion,
      serverFrpc: state.session?.serverFrpc || { available: false, version: "" },
      locked: FRPC_BIN_LOCKED,
      state: frpc.state,
    });
    return true;
  }

  // 0.10.0.1：frpc 本机锁解锁——校验锁密码后签发解锁会话 Cookie（HttpOnly+SameSite=Strict）。
  if (pathname === "/api/frpc/unlock" && req.method === "POST") {
    const ip = requestIp(req);
    frpcLockRateLimiter.assert(ip, "解锁尝试过于频繁，请 10 分钟后再试");
    const input = await readJson(req);
    if (!frpcLockPasswordMatches(input.password)) {
      frpcLockRateLimiter.failure(ip);
      sendJson(res, 401, { error: "锁密码错误" });
      return true;
    }
    frpcLockRateLimiter.clear(ip);
    const token = signToken(
      { type: "frpc-lock", exp: Math.floor((Date.now() + FRPC_LOCK_TTL_MS) / 1000) },
      state.frpcLockSecret,
    );
    res.setHeader(
      "Set-Cookie",
      `${FRPC_LOCK_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(FRPC_LOCK_TTL_MS / 1000)}`,
    );
    // Cookie 随本响应才下发，browserState 读不到：直接标注解锁结果，界面立即切换。
    const next = browserState(req);
    next.frpcLock.unlocked = true;
    sendJson(res, 200, { ok: true, state: next });
    return true;
  }

  // 0.10.0.1：重新锁定——轮换锁密钥吊销所有解锁会话并清除本浏览器 Cookie。
  if (pathname === "/api/frpc/lock" && req.method === "POST") {
    state.frpcLockSecret = randomSecret();
    saveState();
    res.setHeader(
      "Set-Cookie",
      `${FRPC_LOCK_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
    );
    const next = browserState(req);
    if (next.frpcLock) next.frpcLock.unlocked = false;
    sendJson(res, 200, { ok: true, state: next });
    return true;
  }

  // frpc 配置文件：未登录时读取/保存用户自定义 TOML；登录后返回自动生成的配置（只读）。
  if (pathname === "/api/frpc/config" && req.method === "GET") {
    let generated = null;
    if (state.session) {
      try {
        // 0.10.1.1：多节点并发映射——返回所有承载节点配置的拼接（查看用）。
        generated = frpc
          .activeKeys()
          .map((key) => configText(key))
          .join("\n");
      } catch {
        generated = null;
      }
    }
    sendJson(res, 200, {
      connected: Boolean(state.session),
      custom: String(state.customFrpcConfig || ""),
      generated,
    });
    return true;
  }

  if (pathname === "/api/frpc/config" && req.method === "POST") {
    if (state.session) {
      sendJson(res, 400, { error: "已连接服务端，配置由服务端自动生成，无需手动填写" });
      return true;
    }
    const input = await readJson(req, 256 * 1024);
    const config = String(input.config || "");
    if (config.length > 64 * 1024) {
      sendJson(res, 400, { error: "配置内容过大（超过 64KB）" });
      return true;
    }
    state.customFrpcConfig = config;
    saveState();
    // 未登录时自定义配置即生效来源：frpc 处于期望运行状态则自动重启应用新配置。
    if (frpc.desired || Boolean(frpc.process)) {
      frpc.restart();
    }
    sendJson(res, 200, { ok: true, state: browserState(req) });
    return true;
  }

  if (pathname === "/api/frpc/pull" && req.method === "POST") {
    if (FRPC_BIN_LOCKED) {
      sendJson(res, 400, { error: "已通过 FRPC_BIN 环境变量固定路径，无法覆盖" });
      return true;
    }
    if (!state.session) {
      sendJson(res, 400, { error: "请先连接服务器" });
      return true;
    }
    const target = frpReleaseTarget();
    const resp = await fetch(
      `${managerBaseUrl(state.session.serverAddress)}/api/client/frpc?platform=${target.platform}&arch=${target.architecture}`,
      {
        signal: AbortSignal.timeout(120_000),
        headers: {
          Authorization: `Bearer ${state.session.token}`,
          "X-FRP-Device-ID": state.deviceId,
          "X-Client-Version": VERSION,
        },
      },
    );
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      sendJson(res, resp.status, { error: err.error || `下载失败 (${resp.status})` });
      return true;
    }
    // 防止超大响应导致 OOM：frpc 二进制正常不超过 50MB，设 200MB 硬上限。
    const contentLength = Number(resp.headers.get("content-length") || 0);
    if (contentLength > 200 * 1024 * 1024) {
      sendJson(res, 413, { error: "下载文件过大（超过 200MB 限制）" });
      return true;
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length > 200 * 1024 * 1024) {
      sendJson(res, 413, { error: "下载文件过大（超过 200MB 限制）" });
      return true;
    }
    const version = resp.headers.get("x-frp-version") || "";
    installFrpcBinary(buffer, version);
    sendJson(res, 200, { ok: true, version, size: buffer.length });
    return true;
  }

  if (pathname === "/api/frpc/install" && req.method === "POST") {
    if (FRPC_BIN_LOCKED) {
      sendJson(res, 400, { error: "已通过 FRPC_BIN 环境变量固定路径，无法覆盖" });
      return true;
    }
    const contentType = String(req.headers["content-type"] || "");
    if (contentType.includes("application/json")) {
      const input = await readJson(req);
      const source = String(input.path || "").trim();
      if (!source || !existsSync(source)) {
        sendJson(res, 400, { error: "指定的文件路径不存在" });
        return true;
      }
      const buffer = readFileSync(source);
      installFrpcBinary(buffer);
      sendJson(res, 200, { ok: true, size: buffer.length });
      return true;
    }
    // 原始二进制上传
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 200 * 1024 * 1024) {
        sendJson(res, 413, { error: "文件不能超过 200MB" });
        return true;
      }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    if (buffer.length === 0) {
      sendJson(res, 400, { error: "上传内容为空" });
      return true;
    }
    installFrpcBinary(buffer);
    sendJson(res, 200, { ok: true, size: buffer.length });
    return true;
  }

  if (pathname === "/api/proxies" && req.method === "POST") {
    const proxy = normalizeProxy(await readJson(req));
    state.proxies.push(proxy);
    saveState();
    frpc.restart();
    sendJson(res, 201, { proxy, state: browserState(req) });
    return true;
  }

  const proxyMatch = /^\/api\/proxies\/([a-f0-9-]+)$/.exec(pathname);
  if (proxyMatch) {
    const index = state.proxies.findIndex((proxy) => proxy.id === proxyMatch[1]);
    if (index < 0) {
      sendJson(res, 404, { error: "代理不存在" });
      return true;
    }
    if (req.method === "PUT") {
      state.proxies[index] = normalizeProxy(await readJson(req), proxyMatch[1]);
      saveState();
      frpc.restart();
      sendJson(res, 200, { proxy: state.proxies[index], state: browserState(req) });
      return true;
    }
    if (req.method === "DELETE") {
      state.proxies.splice(index, 1);
      saveState();
      frpc.restart();
      sendJson(res, 200, { ok: true, state: browserState(req) });
      return true;
    }
  }

  if (pathname === "/api/frpc/start" && req.method === "POST") {
    // 未登录时必须已有自定义配置，否则 frpc 无配置可运行，直接给出明确错误。
    if (!state.session && !String(state.customFrpcConfig || "").trim()) {
      sendJson(res, 400, { error: "请先在“设置 - frpc 配置文件”中填写并保存配置内容" });
      return true;
    }
    state.customFrpcDesired = true;
    saveState();
    frpc.start();
    sendJson(res, 202, browserState(req));
    return true;
  }
  if (pathname === "/api/frpc/stop" && req.method === "POST") {
    state.customFrpcDesired = false;
    saveState();
    frpc.stop();
    sendJson(res, 202, browserState(req));
    return true;
  }
  // 0.10.1.2 规格5：仪表盘统一 frpc 管理——重启全部 frpc 进程（启停沿用上方端点）。
  if (pathname === "/api/frpc/restart" && req.method === "POST") {
    if (!state.session && !String(state.customFrpcConfig || "").trim()) {
      sendJson(res, 400, { error: "请先在“设置 - frpc 配置文件”中填写并保存配置内容" });
      return true;
    }
    frpc.restart();
    sendJson(res, 202, browserState(req));
    return true;
  }
  // 0.10.1.2 规格6：端口映射按节点单独管理 frpc 进程（启/停/重启），与仪表盘统一管理并存。
  if (pathname === "/api/frpc/node" && req.method === "POST") {
    const input = await readJson(req);
    const action = String(input.action || "");
    if (!["start", "stop", "restart"].includes(action)) {
      sendJson(res, 400, { error: "action 须为 start / stop / restart" });
      return true;
    }
    const key = String(input.key || "").trim();
    frpc.ensureSupervisors();
    const supervisor = frpc.supervisorOf(key);
    if (!supervisor) {
      sendJson(res, 404, {
        error: key
          ? `节点 ${key} 当前没有对应的 frpc 进程（该节点暂无启用中的映射）`
          : "缺少节点标识（key）",
      });
      return true;
    }
    if (action === "start") supervisor.start();
    else if (action === "stop") supervisor.stop();
    else supervisor.restart();
    sendJson(res, 202, browserState(req));
    return true;
  }
  return false;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (await handleApi(req, res, url)) return;
    if (req.method === "GET" && serveStatic(res, url.pathname)) return;
    sendJson(res, 404, { error: "接口不存在" });
  } catch (error) {
    const message =
      error.name === "AbortError"
        ? "连接服务器超时"
        : error.message || "客户端内部错误";
    sendJson(res, Number(error.status) || 400, {
      error: message,
      code: error.code,
    });
  }
});

function clientAccessUrls() {
  if (HOST !== "0.0.0.0" && HOST !== "::") {
    return [`http://${HOST}:${PORT}`];
  }
  const addresses = new Set(["127.0.0.1"]);
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const address of interfaces || []) {
      if (address.family === "IPv4" && !address.internal) {
        addresses.add(address.address);
      }
    }
  }
  return [...addresses].map((address) => `http://${address}:${PORT}`);
}

server.listen(PORT, HOST, async () => {
  setupServiceRuntime(ROOT);
  const portSource = CLI_ARGS.port
    ? "命令行参数"
    : process.env.CLIENT_PORT
      ? "环境变量 CLIENT_PORT"
      : readClientConfigFile().port != null
        ? "配置文件 data/client/config.json"
        : "默认值";
  console.log(`[client] 监听 ${HOST}:${PORT}（端口来源：${portSource}）`);
  for (const url of clientAccessUrls()) {
    console.log(`XFCloud Tunnel client UI: ${url}`);
  }
  if (HOST === "0.0.0.0" || HOST === "::") {
    console.warn("Client UI is accessible from other hosts. Restrict port access with a firewall.");
  }
  // 新版本进程监听成功即代表更新健康：清除更新标记并记录成功结果。
  if (readUpdateMarker(DATA_DIR)?.stage === "replaced") {
    clearUpdateMarker(DATA_DIR, { version: VERSION });
    console.log(`[updater] update health check passed, now running v${VERSION}`);
  }
  if (state.session) {
    await refreshProfile();
    // 重启后若账户仍待激活（首次登录未改密），保持 frpc 停止，等待用户激活。
    if (state.session && !state.session.user?.mustChangePassword) frpc.start();
  } else if (state.customFrpcDesired && String(state.customFrpcConfig || "").trim()) {
    // 未登录但上次选择了启动自定义 frpc：开机自动拉起。
    frpc.start();
  }
});

setInterval(refreshProfile, 3_000);

function shutdown() {
  frpc.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
