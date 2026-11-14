/**
 * Loomy 网关 DSH 插件 · Host 半侧
 *
 * 职责：
 *  1. 托管内置 Python 网关进程（起停/状态/日志）；
 *  2. 注册同源 HTTP 路由 /__loomy/api/*，供 Client 面板调用并转发到网关；
 *  3. 把网关 /v1/models 同步进 dsh-llm-pi-ai 的自定义路由配置，
 *     让模型出现在 DSH 的模型选择器里。
 *
 * 设计约束：
 *  - 零第三方运行时依赖（只用 Node 内置模块），本地目录 bundle 被 link 进
 *    profile，无法保证能 resolve profile 里的 schemastery；
 *  - 所有可变状态（accounts.json / config.json / logs / state.json）都放在
 *    用户数据目录 ~/.dsh/loomy/，绝不写进插件包（包可能只读或被替换）；
 *  - 静态 bundle 的 Client 半侧没有 host.call，通信只能走 HTTP 路由。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = dirname(fileURLToPath(import.meta.url));
const GATEWAY_DIR = join(PKG_DIR, 'gateway');
const SERVE_SCRIPT = join(GATEWAY_DIR, 'dsh_serve.py');
const PI_AI_NAME = '@deepseek-ai/dsh-llm-pi-ai';
// v2：早期版本用 apply 返回的 cleanup 撤路由，disable/enable 往返会留下
// 无主旧路由并触发 duplicate prefix。改用 ctx.effect 后换新前缀，保证新
// fiber 能独立注册；旧的无主 v1 路由无害，用户下次重启 Host 自然回收。
const ROUTE_PREFIX = '/__loomy/v2/api';

const DEFAULTS = {
  port: 17890,
  pythonPath: '',
  strategy: 'balance',
  defaultModel: 'deepseek-v4-flash-0731',
  providerRoute: 'loomy',
  // 插件启用即自动拉起/接管网关（用户明确要求「重启后总是自动启动」）。
  // 可在面板「设置」里关掉；state.json 不存在时也按此默认值生效。
  autoStart: true,
  // 桌面客户端登录态扫描根目录；空 = 按平台自动探测（WSL 走 /mnt/c/...）
  clientRoot: '',
  // WSL 里直连讯飞上游常因 TLS 握手失败而挂住；填系统代理（如
  // http://127.0.0.1:7890）可让额度查询走代理。留空 = 直连。
  proxy: '',
  // 额度查询的 socket 超时（秒）。保持较短，避免上游不可达时拖慢面板写入。
  quotaTimeout: 5,
};

// ---------------------------------------------------------------- utilities

function dataDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'loomy');
}

function ensureDataDir() {
  const dir = dataDir();
  mkdirSync(join(dir, 'logs'), { recursive: true });
  return dir;
}

function readState() {
  const file = join(dataDir(), 'state.json');
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeState(state) {
  const dir = ensureDataDir();
  const file = join(dir, 'state.json');
  writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
  try { chmodSync(file, 0o600); } catch { /* Windows / 受限 FS 忽略 */ }
}

/**
 * 本机自用 API key。
 *
 * 用固定占位值而不是随机 secret：网关只绑 127.0.0.1，进不来外部流量；
 * 而 pi-ai 的路由配置会写进 profile 的 cordis.patch.yml（可能被 git/备份同步），
 * 固定占位值即使泄露也没有意义，反而避免把真实随机密钥复制进配置文件。
 * 面板的 Host 路由自身做了 Origin 校验，只代理本机请求。
 */
const LOCAL_API_KEY = 'loomy-local-gateway-key';
function localApiKey() { return LOCAL_API_KEY; }

/** 写网关 config.json；所有可变路径用绝对路径，避免上游 PROJECT_ROOT 落进插件包。 */
function writeGatewayConfig(state, key) {
  const dir = ensureDataDir();
  const accounts = join(dir, 'accounts.json');
  const logs = join(dir, 'logs');
  if (!existsSync(accounts)) writeFileSync(accounts, JSON.stringify({ accounts: [] }, null, 2), 'utf8');
  const cfg = {
    host: '127.0.0.1',
    port: Number(state.port) || 17890,
    api_keys: [key],
    accounts_file: accounts,
    log_dir: logs,
    strategy: state.strategy || 'balance',
    default_model: state.defaultModel || 'deepseek-v4-flash-0731',
    log_console: true,
    log_requests: true,
    sessions_from_client: true,
    // WSL 下客户端数据目录是 Windows 盘符的 drvfs 挂载点，Python 侧的
    // CLIENT_PUBLIC_ROOT 字面量在这里无效，必须显式下发。
    client_root: String(state.clientRoot || CLIENT_ROOT_DEFAULT),
    proxy: String(state.proxy || ''),
    quota_timeout: Number(state.quotaTimeout) || 5,
    models_timeout: 5,
  };
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
  try { chmodSync(file, 0o600); } catch { /* ignore */ }
  return file;
}

/** 解析 Python 可执行文件：用户指定优先，否则依次试探 PATH 上的常见名字。 */
function resolvePython(state) {
  const preferred = String(state.pythonPath || '').trim();
  const candidates = preferred ? [preferred] : ['python', 'python3', 'py'];
  for (const cmd of candidates) {
    const args = cmd.toLowerCase().endsWith('py') && !preferred ? ['-3', '--version'] : ['--version'];
    const probe = spawnSync(cmd, args, { encoding: 'utf8', timeout: 8000, windowsHide: true });
    if (!probe.error && (probe.status === 0 || /Python 3\./.test((probe.stdout || '') + (probe.stderr || '')))) {
      return { ok: true, cmd, extra: cmd === 'py' && !preferred ? ['-3'] : [] };
    }
  }
  return {
    ok: false,
    message: preferred
      ? `配置的 Python 不可用：${preferred}（${candidates.length} 个候选均未通过 --version 探测）`
      : '未找到 Python 3。请在「设置」里填写 python/python3 的绝对路径（需要 3.9+）。',
  };
}

/** Windows 存在系统预留端口段；启动前先真实 bind 一次，失败给可操作诊断。 */
function probePort(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', (err) => resolve({ ok: false, message: `端口 ${port} 不可用：${err.code || err.message}。可能是被其他进程占用，或落在 Windows 系统预留端口段（换一个端口重试）。` }));
    srv.listen(port, host, () => srv.close(() => resolve({ ok: true })));
  });
}

function isLoopbackOrigin(origin) {
  if (!origin) return true; // 同源 GET / 无 Origin 的请求
  try {
    const u = new URL(origin);
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname);
  } catch { return false; }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象');
  return parsed;
}

// ------------------------------------------------ 桌面客户端登录态扫描
// 上游 pool.py 会 glob <root>/*/userData/auth-session.json 自动导入，但那些是
// 派生的临时账号（persist=False，不写回 accounts.json）。这里提供主动扫描 +
// 一键把选中项持久化为可管理账号的能力。

/**
 * 桌面客户端数据根目录。
 *
 * Windows 原生: C:\Users\Public\Loomy
 * WSL:          /mnt/c/Users/Public/Loomy （同一目录经 drvfs 挂载）
 *
 * 插件 Host 跑在 WSL 里时，Windows 路径字面量在 POSIX 上根本不存在
 * （readdirSync('C:\\...') → ENOENT），扫描会静默返回空清单，用户看到
 * 「未发现客户端登录态文件」并以为导入失败。这里按平台选默认值，并在
 * WSL 下校验 /mnt/<drive> 确实存在，避免给出一个同样无效的猜测。
 */
function defaultClientRoot() {
  if (process.platform !== 'linux') return 'C:\\Users\\Public\\Loomy';
  const wslRoot = join('/mnt', 'c', 'Users', 'Public', 'Loomy');
  try {
    if (existsSync('/mnt/c')) return wslRoot;
  } catch { /* ignore */ }
  // 非 WSL 的 Linux：仍返回 Windows 字面量，让 UI 明确提示用户手动填写。
  return 'C:\\Users\\Public\\Loomy';
}

const CLIENT_ROOT_DEFAULT = defaultClientRoot();
const SESSION_SECONDS = 14 * 24 * 3600;

function maskPhone(v) {
  const s = String(v || '');
  const d = s.replace(/\D/g, '');
  return d.length >= 7 ? `${d.slice(0, 3)}****${d.slice(-4)}` : (s || '—');
}

function maskSession(v) {
  const s = String(v || '');
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : (s ? '••••' : '—');
}

/**
 * 扫描客户端登录态。返回脱敏摘要；完整 session 只留在 Host 内存的
 * scanCache 里，通过 token 索引，绝不发给浏览器。
 */
function scanClientSessions(root) {
  const base = String(root || CLIENT_ROOT_DEFAULT).trim();
  const found = [];
  const errors = [];
  let entries = [];
  try { entries = readdirSync(base, { withFileTypes: true }); }
  catch (err) {
    return { ok: true, data: { root: base, items: [], errors: [`无法读取扫描目录：${err.message}`] } };
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const file = join(base, ent.name, 'userData', 'auth-session.json');
    try {
      // 客户端根目录下可能混有 .migration 等非客户端目录；没有该文件就静默跳过。
      let st;
      try { st = statSync(file); } catch { continue; }
      if (!st.isFile()) continue;
      const data = JSON.parse(readFileSync(file, 'utf8'));
      const session = String(data.session || '');
      if (!session) { errors.push(`${ent.name}: 文件里没有 session`); continue; }
      const updatedMs = Number(data.updatedAt || 0);
      const obtainedSec = updatedMs ? Math.floor(updatedMs / 1000) : 0;
      const expireSec = obtainedSec ? obtainedSec + SESSION_SECONDS : 0;
      const daysLeft = expireSec ? Math.max(0, Math.floor((expireSec * 1000 - Date.now()) / 86400000)) : null;
      found.push({
        token: `${ent.name}:${session.slice(0, 8)}`,
        dir: ent.name,
        path: file,
        phone: String(data.phone || ''),
        phoneMasked: maskPhone(data.phone),
        userid: String(data.userid || ''),
        sessionMasked: maskSession(session),
        updatedAt: updatedMs,
        daysLeft,
        expired: daysLeft !== null && daysLeft <= 0,
        // 完整值只放缓存，不进返回体
        _session: session,
        _name: `client-${String(data.phone || ent.name).slice(-4)}`,
      });
    } catch (err) {
      errors.push(`${ent.name}: ${err.message}`);
    }
  }
  return { ok: true, data: { root: base, items: found, errors } };
}

// ------------------------------------------------------------------- plugin

/**
 * @param ctx Cordis 上下文
 * @param config 插件自身 Config，来自 profile 的 cordis.patch.yml 中本插件那一行。
 *   config.enabledModels 是用户启用的模型 id 清单（持久化、随插件升级保留）。
 *   插件据此决定 pi-ai 的 providers.<route>.models 里该有哪些模型，
 *   用户无需去「设置 → 模型」手动改。
 */
export function apply(ctx, config) {
  let child = null;
  let adopted = false;   // 网关由上一个 fiber 留下、被本 fiber 接管
  let lastError = '';
  let startedAt = 0;
  let tail = [];
  // 客户端登录态扫描缓存：token -> 完整 session。只留在 Host 内存，
  // 绝不跟随扫描结果返回浏览器；导入时凭 token 回查。
  let scanCache = new Map();

  const pushTail = (line) => {
    const text = String(line).replace(/\s+$/, '');
    if (!text) return;
    tail.push(text);
    if (tail.length > 200) tail.shift();
  };

  const state = () => readState();

  const gatewayUrl = () => `http://127.0.0.1:${Number(state().port) || 17890}`;

  /** 带本地 key 转发到 Python 网关，统一收敛成 {ok,data,status,message}。 */
  async function gwFetch(method, path, body, timeoutMs = 15000) {
    const s = state();
    const key = localApiKey();
    let response;
    try {
      response = await fetch(gatewayUrl() + path, {
        method,
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      return { ok: false, status: 0, message: `网关不可达：${err && err.message ? err.message : err}。请先在「服务」里启动网关。` };
    }
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok || (data && data.ok === false)) {
      return {
        ok: false,
        status: response.status,
        message: (data && (data.message || data.error)) || `HTTP ${response.status}`,
        data,
      };
    }
    return { ok: true, status: response.status, data };
  }

  async function statusPayload() {
    const s = state();
    const owned = !!child && child.exitCode === null && !child.killed;
    // 接管来的进程可能已被外部 kill；用 /health 复核，避免 status 长期
    // 显示 running=true 而实际端口已死（WSL 下手动 kill 后尤其容易）。
    let adoptedAlive = false;
    if (adopted && !owned) {
      const alive = await gwFetch('GET', '/health', undefined, 1500).catch(() => ({ ok: false }));
      adoptedAlive = !!(alive.ok && alive.data && alive.data.name === 'loomy2api');
      if (!adoptedAlive) { adopted = false; startedAt = 0; }
    }
    const running = owned || adoptedAlive;
    return {
      ok: true,
      data: {
        running,
        owned,
        adopted: !owned && adoptedAlive,
        pid: owned ? child.pid : null,
        startedAt: startedAt || null,
        port: Number(s.port) || 17890,
        pythonPath: s.pythonPath || '(自动探测)',
        strategy: s.strategy,
        defaultModel: s.defaultModel,
        providerRoute: s.providerRoute,
        autoStart: !!s.autoStart,
        dataDir: dataDir(),
        gatewayDir: GATEWAY_DIR,
        error: lastError || null,
        tail: tail.slice(-30),
      },
    };
  }

  async function startGateway() {
    if (child && child.exitCode === null) return await statusPayload();
    // `adopted` 只表示「上次探测时端口上有 loomy2api」。若那个孤儿进程后来
    // 被外部 kill（或 WSL 里手动 kill 后没走插件的 stop），标志不会自动
    // 复位，start 会永远误判「已在运行」而不再拉起。用 /health 复核一次。
    if (adopted) {
      const alive = await gwFetch('GET', '/health', undefined, 2000).catch(() => ({ ok: false }));
      if (alive.ok && alive.data && alive.data.name === 'loomy2api') return await statusPayload();
      adopted = false;
      startedAt = 0;
    }
    const s = state();
    const port = Number(s.port) || 17890;
    // 端口已被占：可能是上一次插件实例留下的孤儿网关（configEditor 重启
    // 本插件时网关仍在跑）。若它确实是 loomy2api，就接管而不是报错。
    const probe = await probePort(port);
    if (!probe.ok) {
      const health = await gwFetch('GET', '/health', undefined, 2500).catch(() => ({ ok: false }));
      if (health.ok && health.data && health.data.name === 'loomy2api') {
        adopted = true;
        startedAt = Date.now();
        lastError = '';
        return { ok: true, data: { ...(await statusPayload()).data, health: health.data, adopted: true, message: '检测到已有网关进程，已接管（无需重启）。' } };
      }
      return { ok: false, message: probe.message };
    }
    const py = resolvePython(s);
    if (!py.ok) return { ok: false, message: py.message };

    const key = localApiKey();
    const configFile = writeGatewayConfig(s, key);
    const env = {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      LOOMY_HOST: '127.0.0.1',
      LOOMY_PORT: String(Number(s.port) || 17890),
      LOOMY_API_KEYS: key,
      LOOMY_ACCOUNTS_FILE: join(dataDir(), 'accounts.json'),
      LOOMY_LOG_DIR: join(dataDir(), 'logs'),
      LOOMY_STRATEGY: s.strategy,
      LOOMY_DEFAULT_MODEL: s.defaultModel,
      LOOMY_PROXY: String(s.proxy || ''),
      LOOMY_QUOTA_TIMEOUT: String(Number(s.quotaTimeout) || 5),
      LOOMY_MODELS_TIMEOUT: '5',
      LOOMY_CLIENT_ROOT: String(s.clientRoot || CLIENT_ROOT_DEFAULT),
    };

    lastError = '';
    try {
      child = spawn(py.cmd, [...py.extra, SERVE_SCRIPT, configFile], {
        cwd: GATEWAY_DIR,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      lastError = `spawn 失败：${err.message}`;
      return { ok: false, message: lastError };
    }
    child.stdout.on('data', (buf) => pushTail(buf.toString('utf8')));
    child.stderr.on('data', (buf) => pushTail(buf.toString('utf8')));
    child.on('error', (err) => { lastError = `进程错误：${err.message}`; pushTail(lastError); });
    child.on('exit', (code, signal) => {
      const line = `网关进程退出 code=${code} signal=${signal || ''}`;
      pushTail(line);
      if (code !== 0 && !lastError) lastError = line;
      child = null;
      startedAt = 0;
    });
    startedAt = Date.now();

    // 等 /health 真正可用（最多 ~8 秒），避免"进程起来了但没监听"的假成功。
    for (let i = 0; i < 24; i += 1) {
      if (!child || child.exitCode !== null) break;
      const health = await gwFetch('GET', '/health', undefined, 1200);
      if (health.ok) return { ok: true, data: { ...(await statusPayload()).data, health: health.data } };
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!child || child.exitCode !== null) {
      return { ok: false, message: lastError || '网关启动后立即退出，请查看下方日志。' };
    }
    return { ok: true, data: { ...(await statusPayload()).data, warning: '进程已启动，但 /health 尚未就绪；稍后刷新状态。' } };
  }

  /** 按端口查监听 PID，用于停掉接管来的孤儿网关。Windows 与 Linux 分开处理。 */
  async function listenerPid(port) {
    const { execFileSync } = await import('node:child_process');
    // Linux/WSL: `ss -ltnp` 输出形如
    //   LISTEN 0 128 127.0.0.1:17890 0.0.0.0:* users:(("python",pid=5171,fd=3))
    if (process.platform === 'linux') {
      for (const [bin, args] of [['ss', ['-ltnp']], ['netstat', ['-ltnp']]]) {
        try {
          const out = execFileSync(bin, args, { encoding: 'utf8', timeout: 8000, windowsHide: true });
          for (const line of out.split(/\r?\n/)) {
            if (!line.includes(':' + port)) continue;
            const m = line.match(/pid=(\d+)/) || line.match(/\s(\d+)\/[^/\s]+/);
            if (m) { const pid = Number(m[1]); if (pid > 0) return pid; }
          }
        } catch { /* 该命令不可用，试下一个 */ }
      }
      // 兜底：从 /proc 找监听该端口的进程（ss/netstat 都缺失时）。
      try {
        const needle = (Number(port) || 17890).toString(16).toUpperCase().padStart(4, '0');
        for (const ent of readdirSync('/proc')) {
          if (!/^\d+$/.test(ent)) continue;
          try {
            const tcp = readFileSync(`/proc/${ent}/net/tcp`, 'utf8');
            for (const line of tcp.split('\n').slice(1)) {
              const cols = line.trim().split(/\s+/);
              if (cols.length > 3 && cols[1] && cols[1].split(':')[1] === needle && cols[3] === '0A') {
                return Number(ent);
              }
            }
          } catch { /* 进程已退出或无权限 */ }
        }
      } catch { /* ignore */ }
      return undefined;
    }
    // Windows: `netstat -ano -p tcp`
    try {
      const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
      for (const line of out.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        // LISTENING 行：TCP 127.0.0.1:17890 0.0.0.0:0 LISTENING 1234
        if (parts.length >= 5 && /LISTEN/i.test(parts[3]) && parts[1] && parts[1].endsWith(':' + port)) {
          const pid = Number(parts[4]);
          if (Number.isInteger(pid) && pid > 0) return pid;
        }
      }
    } catch { /* 查不到就返回 undefined */ }
    return undefined;
  }

  async function stopGateway() {
    const proc = child;
    const wasAdopted = adopted;
    child = null;
    adopted = false;
    startedAt = 0;
    if (proc && proc.exitCode === null) {
      try { proc.kill(); } catch (err) { lastError = `停止失败：${err.message}`; }
      return { ok: true, data: { stopped: true, source: 'owned' } };
    }
    if (wasAdopted) {
      const pid = await listenerPid(Number(state().port) || 17890);
      if (pid) {
        try { process.kill(pid); return { ok: true, data: { stopped: true, source: 'adopted', pid } }; }
        catch (err) { return { ok: false, message: `停止接管进程 ${pid} 失败：${err.message}` }; }
      }
      return { ok: true, data: { stopped: false, reason: '接管进程已不在运行' } };
    }
    return { ok: true, data: { stopped: false, reason: '本来就没在运行' } };
  }

  /** 面板账号池操作 → 上游 /api/panel/*。 */
  const PANEL_ACTIONS = {
    add: '/api/panel/accounts',
    update: '/api/panel/accounts/update',
    remove: '/api/panel/accounts/remove',
    renew: '/api/panel/accounts/renew',
    identity: '/api/panel/accounts/identity',
    refresh: '/api/panel/refresh',
  };

  /** 找到 pi-ai 的可编辑 entry；找不到时给出可操作诊断。 */
  function findPiAiEntry(editor) {
    const entries = editor.entries();
    const exact = entries.find((e) => e.options && e.options.name === PI_AI_NAME);
    if (exact) return { entry: exact };
    const names = entries.map((e) => `${e.options.id}:${e.options.name}`);
    return {
      error: `未找到可编辑的 ${PI_AI_NAME} 条目。当前 configEditor.entries() 共 ${entries.length} 项：${names.slice(0, 40).join(', ')}${names.length > 40 ? ' …' : ''}。请在「设置 → 模型」里手动新建一个自定义 OpenAI 兼容 API，或把本插件的同步结果粘贴到 profile 的 cordis.patch.yml。`,
    };
  }

  /** 从网关拉模型目录，映射成 pi-ai 的 models 条目。 */
  async function fetchModels() {
    const res = await gwFetch('GET', '/v1/models', undefined, 15000);
    if (!res.ok) return res;
    const rows = (res.data && Array.isArray(res.data.data)) ? res.data.data : [];
    const models = [];
    const skipped = [];
    const seen = new Set();
    for (const row of rows) {
      const id = typeof row === 'string' ? row : String((row && (row.id || row.name)) || '');
      if (!id || seen.has(id)) continue;
      // 上游把图像生成模型也列在 /v1/models 里（它们的 modalities 也带 text），
      // 但 chat 路由调用会失败。按 id 前缀排除这些纯图像生成条目。
      const isImageGen = /^(hy-image|doubao-seedream|qwen-image)/i.test(id);
      if (isImageGen) { skipped.push(id); continue; }
      const modalities = (row && Array.isArray(row.modalities)) ? row.modalities : [];
      seen.add(id);
      const ctxLen = Number(row && row.context_length);
      models.push({
        id,
        name: (row && row.name && row.name !== id) ? String(row.name) : id,
        contextWindow: Number.isFinite(ctxLen) && ctxLen > 0 ? Math.min(ctxLen, 1000000) : 128000,
        maxTokens: 8192,
        input: modalities.includes('image') || modalities.includes('video') ? ['text', 'image'] : ['text'],
      });
    }
    return { ok: true, data: { models, skipped, raw: rows } };
  }

  /** 插件自己那一行 Config 的 entry（用于读写 enabledModels）。 */
  function findSelfEntry(editor) {
    const entries = editor.entries();
    const self = entries.find((e) => e.options && e.options.name === 'dsh-plugin-loomy');
    if (self) return { entry: self };
    return { error: `未找到本插件的可编辑 entry（dsh-plugin-loomy）。entries 共 ${entries.length} 项。` };
  }

  /** 当前启用的模型 id 清单：来自插件 Config（cordis.patch.yml 里本插件那一行）。 */
  function enabledIds() {
    const raw = config && Array.isArray(config.enabledModels) ? config.enabledModels : [];
    return raw.filter((x) => typeof x === 'string' && x).map(String);
  }

  /** 「同步」= 从网关拉目录，顺带把新发现的模型默认启用，再按清单写入 pi-ai。 */
  async function syncModels() {
    const modelsRes = await fetchModels();
    if (!modelsRes.ok) return modelsRes;
    const catalog = modelsRes.data.models;
    if (!catalog.length) {
      return { ok: false, message: '网关返回的模型目录为空。请确认账号池里至少有一个可用账号。' };
    }
    // 首次同步（Config 里还没有 enabledModels）时，默认全启用；
    // 之后用户手动调过的清单保持不变，只补进上游新增的模型。
    const current = enabledIds();
    const merged = current.length
      ? [...current.filter((id) => catalog.some((m) => m.id === id)),
         ...catalog.map((m) => m.id).filter((id) => !current.includes(id))]
      : catalog.map((m) => m.id);
    const save = await setEnabledIds(merged, catalog, true);
    if (!save.ok) return save;
    return { ok: true, data: { ...save.data, catalog, skipped: modelsRes.data.skipped, enabledModels: merged } };
  }

  /**
   * 持久化启用清单到插件自己的 Config（cordis.patch.yml），然后写入 pi-ai。
   * edit 会重启本插件，所以 pi-ai 的写入必须在重启前用当前 catalog 完成。
   */
  async function setEnabledIds(ids, catalog, persist = true) {
    const editor = ctx.get('configEditor');
    if (!editor) return { ok: false, message: 'configEditor 服务未挂载。' };
    const self = findSelfEntry(editor);
    if (self.error) return { ok: false, message: self.error };

    // 先用当前 catalog 把 pi-ai 对齐到目标清单（不依赖重启后的状态）。
    const aligned = await writePiAiModelsWith(ids, catalog);
    if (!aligned.ok) return aligned;

    if (persist) {
      try {
        await editor.edit(self.entry, (current) => ({ ...(current || {}), enabledModels: ids }));
      } catch (err) {
        return {
          ok: false,
          message: `保存启用清单失败（可能被更高层配置覆盖）：${err && err.message ? err.message : err}`,
          data: aligned.data,
        };
      }
    }
    return aligned;
  }

  /** 与 writePiAiModels 相同，但直接接受目标 id 清单（不读 config，避免重启时序问题）。 */
  async function writePiAiModelsWith(ids, catalog) {
    const s = state();
    const editor = ctx.get('configEditor');
    if (!editor) return { ok: false, message: 'configEditor 服务未挂载。' };
    const found = findPiAiEntry(editor);
    if (found.error) return { ok: false, message: found.error };
    const enabled = ids.map((id) => catalog.find((m) => m.id === id)).filter(Boolean);
    const route = String(s.providerRoute || 'loomy').replace(/[^a-zA-Z0-9_-]/g, '-');
    const baseURL = `${gatewayUrl()}/v1`;
    const profile = enabled.length ? {
      api: 'openai-completions',
      displayName: 'Loomy 网关',
      baseURL,
      headers: { Authorization: `Bearer ${LOCAL_API_KEY}` },
      models: enabled,
    } : null;
    try {
      await editor.edit(found.entry, (current) => {
        const providers = { ...((current && current.providers) || {}) };
        if (profile) providers[route] = profile;
        else delete providers[route];
        return { ...(current || {}), providers };
      });
    } catch (err) {
      return { ok: false, message: `写入模型配置失败（可能被更高层配置覆盖）：${err && err.message ? err.message : err}` };
    }
    return {
      ok: true,
      data: {
        route, baseURL, count: enabled.length, models: enabled,
        message: profile
          ? `已启用 ${enabled.length} 个模型并写入 ${PI_AI_NAME} 的 ${route} 路由。`
          : `已停用全部模型，${route} 路由已从 ${PI_AI_NAME} 移除。`,
      },
    };
  }

  /** 读取 pi-ai 里当前 loomy 路由已配置的模型（用于面板"已同步"清单）。 */
  function syncedModels() {
    const editor = ctx.get('configEditor');
    if (!editor) return { ok: true, data: { route: state().providerRoute, models: [], enabledModels: enabledIds(), available: false } };
    try {
      const found = findPiAiEntry(editor);
      if (found.error) return { ok: true, data: { route: state().providerRoute, models: [], enabledModels: enabledIds(), available: false, reason: found.error } };
      const piAiConfig = (found.entry.options && found.entry.options.config) || {};
      const route = state().providerRoute;
      const profile = (piAiConfig.providers || {})[route];
      return { ok: true, data: { route, models: (profile && profile.models) || [], enabledModels: enabledIds(), available: true } };
    } catch (err) {
      return { ok: true, data: { route: state().providerRoute, models: [], enabledModels: enabledIds(), available: false, reason: err.message } };
    }
  }

  /** 切换单个模型的启用状态；启用清单持久化到插件 Config，并同步 pi-ai。 */
  async function toggleModel(id, enabled) {
    const catalogRes = await fetchModels();
    if (!catalogRes.ok) return catalogRes;
    const catalog = catalogRes.data.models;
    if (!catalog.some((m) => m.id === id)) return { ok: false, message: `模型 ${id} 不在当前网关目录中。` };
    const current = enabledIds();
    const next = enabled
      ? (current.includes(id) ? current : [...current, id])
      : current.filter((x) => x !== id);
    const result = await setEnabledIds(next, catalog, true);
    if (result.ok) result.data.enabledModels = next;
    return result;
  }

  /** 路由分发。返回值直接作为 JSON 响应体。 */
  async function dispatch(method, path, query, body) {
    switch (`${method} ${path}`) {
      case 'GET status': return await statusPayload();
      case 'POST start': return startGateway();
      case 'POST stop': return stopGateway();
      case 'GET diagnose': {
        const editor = ctx.get('configEditor');
        let entries = [];
        try { entries = editor ? editor.entries().map((e) => ({ id: e.options.id, name: e.options.name })) : []; } catch (err) { entries = [{ id: 'error', name: err.message }]; }
        return { ok: true, data: { entries, hasConfigEditor: !!editor, hasWebServer: !!ctx.get('webServer'), hasLlm: !!ctx.get('llm') } };
      }
      case 'GET config': {
        const s = state();
        return { ok: true, data: { port: s.port, pythonPath: s.pythonPath, strategy: s.strategy, defaultModel: s.defaultModel, providerRoute: s.providerRoute, autoStart: !!s.autoStart, clientRoot: s.clientRoot || '', clientRootDefault: CLIENT_ROOT_DEFAULT, proxy: s.proxy || '', quotaTimeout: Number(s.quotaTimeout) || 5, dataDir: dataDir() } };
      }
      case 'POST config': {
        const s = state();
        const next = { ...s };
        if (body.port !== undefined) {
          const p = Number(body.port);
          if (!Number.isInteger(p) || p < 1 || p > 65535) return { ok: false, message: '端口必须是 1–65535 的整数' };
          next.port = p;
        }
        if (body.pythonPath !== undefined) next.pythonPath = String(body.pythonPath || '');
        if (body.strategy !== undefined) {
          if (!['balance', 'round_robin', 'lru'].includes(body.strategy)) return { ok: false, message: 'strategy 只能是 balance / round_robin / lru' };
          next.strategy = body.strategy;
        }
        if (body.defaultModel !== undefined) next.defaultModel = String(body.defaultModel || DEFAULTS.defaultModel);
        if (body.providerRoute !== undefined) next.providerRoute = String(body.providerRoute || 'loomy').replace(/[^a-zA-Z0-9_-]/g, '-');
        if (body.autoStart !== undefined) next.autoStart = !!body.autoStart;
        if (body.clientRoot !== undefined) next.clientRoot = String(body.clientRoot || '');
        if (body.proxy !== undefined) next.proxy = String(body.proxy || '');
        if (body.quotaTimeout !== undefined) {
          const t = Number(body.quotaTimeout);
          if (!Number.isFinite(t) || t < 1 || t > 60) return { ok: false, message: '额度查询超时必须是 1–60 秒' };
          next.quotaTimeout = t;
        }
        writeState(next);
        const wasRunning = (!!child && child.exitCode === null) || adopted;
        if (wasRunning && (next.port !== s.port || next.strategy !== s.strategy || next.pythonPath !== s.pythonPath)) {
          await stopGateway();
          return { ok: true, data: { saved: true, restarted: false, message: '设置已保存；端口/Python/策略变更需重启网关才生效。请点「停止」再「启动」。' } };
        }
        return { ok: true, data: { saved: true, restarted: false } };
      }
      case 'GET state': return gwFetch('GET', '/api/panel/state' + (query.get('refresh') ? '?refresh=1' : ''), undefined, 30000);
      case 'GET models': return fetchModels();
      case 'GET synced': return syncedModels();
      case 'POST sync': return syncModels();
      case 'POST modelToggle': {
        const id = String(body.id || '').trim();
        if (!id) return { ok: false, message: '缺少模型 id' };
        return toggleModel(id, body.enabled !== false);
      }
      case 'POST modelsEnabled': {
        // 批量设置：body.ids 为要启用的完整清单；不传则全启用 / 空数组则全停用。
        const catalogRes = await fetchModels();
        if (!catalogRes.ok) return catalogRes;
        const catalog = catalogRes.data.models;
        const ids = Array.isArray(body.ids)
          ? body.ids.map(String).filter((x) => catalog.some((m) => m.id === x))
          : catalog.map((m) => m.id);
        const result = await setEnabledIds(ids, catalog, true);
        if (result.ok) result.data.enabledModels = ids;
        return result;
      }
      case 'POST refresh': return gwFetch('POST', '/api/panel/refresh', {}, 30000);
      case 'GET logs': return gwFetch('GET', `/api/panel/logs?lines=${Math.max(10, Math.min(Number(query.get('lines')) || 200, 2000))}`, undefined, 10000);
      case 'GET clientScan': {
        const scan = scanClientSessions(query.get('root') || state().clientRoot || '');
        if (!scan.ok) return scan;
        // 客户端只保留「最后登录」的那一个账号，登录另一个会覆盖 auth-session.json。
        // 这里读 accounts.json 的真实 session，把已导入池的项标出来，避免用户
        // 重复导入或误以为另一个账号还在。已持久化的账号不会因覆盖而丢失。
        let knownSessions = new Set();
        try {
          const raw = JSON.parse(readFileSync(join(dataDir(), 'accounts.json'), 'utf8'));
          for (const a of (Array.isArray(raw.accounts) ? raw.accounts : [])) {
            if (a && a.session) knownSessions.add(String(a.session));
          }
        } catch { /* 账号文件不存在/损坏时按「都未导入」处理 */ }
        // 刷新缓存，并返回脱敏后的摘要（去掉 _session / _name）
        scanCache = new Map();
        const items = scan.data.items.map((it) => {
          scanCache.set(it.token, { session: it._session, name: it._name, phone: it.phone });
          const { _session, _name, ...safe } = it;
          return { ...safe, alreadyImported: knownSessions.has(it._session) };
        });
        return { ok: true, data: { ...scan.data, items } };
      }
      case 'POST clientImport': {
        const tokens = Array.isArray(body.tokens) ? body.tokens.map(String) : [];
        if (!tokens.length) return { ok: false, message: '没有选中任何客户端登录态' };
        // panel/state 的 account view 里 session 是脱敏的（public_dict 只给前 8 位），
        // 不能用来判重。直接读 accounts.json 拿真实值最可靠。
        let existingNames = new Set();
        let existingSessions = new Set();
        try {
          const raw = JSON.parse(readFileSync(join(dataDir(), 'accounts.json'), 'utf8'));
          const list = Array.isArray(raw.accounts) ? raw.accounts : [];
          for (const a of list) {
            if (a && a.name) existingNames.add(String(a.name));
            if (a && a.session) existingSessions.add(String(a.session));
          }
        } catch (err) {
          return { ok: false, message: `读取 accounts.json 失败：${err.message}` };
        }
        const imported = [];
        const skipped = [];
        const failed = [];
        for (const token of tokens) {
          const entry = scanCache.get(token);
          if (!entry) { skipped.push({ token, reason: '缓存已失效，请重新扫描' }); continue; }
          if (existingSessions.has(entry.session)) { skipped.push({ token, reason: '该 session 已在账号池中' }); continue; }
          let name = entry.name;
          let n = 1;
          while (existingNames.has(name)) { name = `${entry.name}-${n}`; n += 1; }
          const res = await gwFetch('POST', '/api/panel/accounts', {
            name,
            loginid: entry.phone || '',
            password: '',
            session: entry.session,
            login: false,
          }, 30000);
          if (!res.ok) {
            // 网关是 ThreadingHTTPServer：即使 Host 侧 AbortSignal 先超时，
            // 请求处理线程仍会继续并把账号写进 accounts.json。直接判 failed
            // 会造成「UI 报失败、账号其实已导入」的假象（WSL 上上游 SSL
            // 超时时尤其常见）。回查文件确认真实结果再下结论。
            let persisted = false;
            try {
              const raw = JSON.parse(readFileSync(join(dataDir(), 'accounts.json'), 'utf8'));
              const list = Array.isArray(raw.accounts) ? raw.accounts : [];
              persisted = list.some((a) => a && String(a.session) === entry.session);
            } catch { /* 读不到就按失败处理 */ }
            if (persisted) {
              existingNames.add(name);
              existingSessions.add(entry.session);
              imported.push({ token, name, note: '网关响应超时，但账号已写入账号池' });
            } else {
              failed.push({ token, name, reason: res.message });
            }
            continue;
          }
          existingNames.add(name);
          existingSessions.add(entry.session);
          imported.push({ token, name });
        }
        return {
          ok: true,
          data: {
            imported, skipped, failed,
            message: `导入 ${imported.length} 个账号${skipped.length ? `，跳过 ${skipped.length} 个` : ''}${failed.length ? `，失败 ${failed.length} 个` : ''}。`,
          },
        };
      }
      case 'POST account': {
        const action = String(body.action || '');
        const target = PANEL_ACTIONS[action];
        if (!target) return { ok: false, message: `未知账号操作：${action}` };
        const payload = { ...body };
        delete payload.action;
        return gwFetch('POST', target, payload, 45000);
      }
      case 'POST test': {
        const model = String(body.model || state().defaultModel || DEFAULTS.defaultModel);
        return gwFetch('POST', '/v1/chat/completions', {
          model,
          messages: [{ role: 'user', content: '请用一句话回复：网关连通正常。' }],
          stream: false,
        }, 60000);
      }
      case 'GET health': return gwFetch('GET', '/health', undefined, 5000);
      default: return { ok: false, message: `未知接口 ${method} ${path}` };
    }
  }

  // 注册 HTTP 路由（node:http 风格 handler）。
  //
  // 重要：webServer 由 @deepseek-ai/dsh-host-webserver 提供，本插件的 fiber
  // 可能**先于**它激活（DSH 重启后加载顺序不保证）。一次性 ctx.get('webServer')
  // 会拿到 undefined，且之后不再重试 → 路由永远不注册，面板全部 404。
  // 因此这里做「延迟 + 有限重试」，直到服务可用；用 ctx.effect 拥有生命周期，
  // 卸载/重配置时清理定时器与已注册的路由。
  const route = {
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      try {
        if (!isLoopbackOrigin(req.headers.origin)) {
          json(res, 403, { ok: false, message: '拒绝跨站请求' });
          return;
        }
        const url = new URL(req.url || '/', 'http://dsh.internal');
        const path = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '') || 'status';
        const method = (req.method || 'GET').toUpperCase();
        let body = {};
        if (method === 'POST') {
          try { body = await readJsonBody(req); }
          catch (err) { json(res, 400, { ok: false, message: `请求体解析失败：${err.message}` }); return; }
        }
        const result = await dispatch(method, path, url.searchParams, body);
        json(res, result.ok === false ? 400 : 200, result);
      } catch (err) {
        json(res, 500, { ok: false, message: `内部错误：${err && err.message ? err.message : err}` });
      }
    },
  };

  let routeDispose = null;
  let retryTimer = null;
  let retries = 0;
  const MAX_ROUTE_RETRIES = 30; // 30 × 500ms = 15s，足够 webServer 就绪

  const tryRegister = () => {
    if (routeDispose) return true;
    const webServer = ctx.get('webServer');
    if (!webServer) return false;
    try {
      routeDispose = webServer.register(route);
      lastError = '';
      return true;
    } catch (err) {
      // duplicate：已有实例注册过（HMR 竞态），视为成功，不重复注册。
      if (/duplicate/i.test(String(err && err.message))) return true;
      lastError = `路由注册失败：${err && err.message ? err.message : err}`;
      return false;
    }
  };

  ctx.effect(() => {
    if (!tryRegister()) {
      retryTimer = setInterval(() => {
        retries += 1;
        if (tryRegister() || retries >= MAX_ROUTE_RETRIES) {
          clearInterval(retryTimer);
          retryTimer = null;
          if (!routeDispose) lastError = 'webServer 在 15 秒内未就绪，插件 HTTP 路由未注册（面板接口会 404）。请重启 DSH 或稍后重试。';
        }
      }, 500);
    }
    return () => {
      if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
      if (routeDispose) { try { routeDispose(); } catch { /* ignore */ } routeDispose = null; }
    };
  }, 'loomy: HTTP route (retry until webServer ready)');

  // 网关进程**不**挂在 effect cleanup 上：configEditor.edit 会重启本插件
  // （写 enabledModels / pi-ai 配置时都会），cleanup 一跑就把网关杀了，
  // 用户只是切个模型开关却会断服务。改为「存活即接管」：新 fiber 启动时
  // 探测端口，已有网关就认领、没有且 autoStart 才拉起。显式「停止」按钮
  // 仍然 kill 进程。真正卸载插件时若有残留，下次重启 DSH 自然回收。
  const adoptOrStart = async () => {
    try {
      const health = await gwFetch('GET', '/health', undefined, 2000).catch(() => ({ ok: false }));
      if (health.ok && health.data && health.data.name === 'loomy2api') {
        adopted = true;
        startedAt = Date.now();
        return; // 已运行，接管，不重复 spawn
      }
    } catch { /* 继续按 autoStart 决策 */ }
    if (state().autoStart) {
      try { await startGateway(); }
      catch (err) { lastError = String(err && err.message ? err.message : err); }
    }
  };
  adoptOrStart();
}
