'use strict';
/**
 * Kiro Remote Bridge — 扩展入口。
 *
 * 数据来源分两层，各取其确定可行的部分：
 *   会话列表 / 历史 / 状态  →  读 ~/.kiro/sessions（格式已实测确认）
 *   发消息 / 细粒度批准     →  agent mux server（能力更强，不可用时降级到 VS Code 命令）
 *
 * 任何一层不可用都不会让另一层失效；自诊断会把实际生效的路径写进日志。
 */
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { SessionStore } = require('./sessionStore');
const { MuxPool } = require('./muxClient');
const { Relay } = require('./relay');
const { parseConfigOptions } = require('./presets');

/**
 * 自诊断落盘位置。用独立目录，不写进 ~/.kiro —— 那是 IDE 自己的空间，
 * 混用会让「哪些文件属于谁」变得不清楚。
 */
const DIAG_DIR = path.join(os.homedir(), '.kiro-bridge');
const DIAG_FILE = path.join(DIAG_DIR, 'diagnostics.json');
/** agent 方法探测结果：把原始返回落盘，便于在扩展之外核对结构 */
const PROBE_FILE = path.join(DIAG_DIR, 'agent-probe.json');
/**
 * mux 端点（含 token）落盘，权限 0600，仅用于本机调试。
 * 有它才能在扩展之外直接连 agent 试方法，不必为每次试错重载一遍 IDE。
 * 不需要时删掉这个文件即可；relay 重启后 token 也会变。
 */
const ENDPOINTS_FILE = path.join(DIAG_DIR, 'mux-endpoints.json');
/**
 * 模型清单缓存。
 *
 * `_kiro/config/template` 在结构上就不返回模型：产物里 handleConfigTemplate 调
 * Ws8(modeId, modes, currentModelId=undefined, …)，而模型 select 是由 currentModelId
 * 生成的，传 undefined 就整条被省略（Effort 同理）。所以没有任何参数能让它带上模型。
 *
 * 全量清单只出现在 session/new 与 session/set_config_option 的返回里。见到一次就存下来，
 * 供之后新建会话时选择，否则只能退回「历史里用过的模型」，清单是不全的。
 */
const MODELS_FILE = path.join(DIAG_DIR, 'model-options.json');
/**
 * 访问 token 落盘位置（权限 0600）。
 *
 * 之前 token 是每次启动随机生成的，而它只出现在 Mac 屏幕上的二维码里。后果是：人在外面时
 * 只要扩展重新激活（重载窗口、Kiro 重启、睡醒后激活），token 就变了，而你拿不到新二维码
 * —— 直接永久失联，没有自救手段。所以改成持久化，并提供「轮换 token」命令来兜住泄露风险。
 */
const TOKEN_FILE = path.join(DIAG_DIR, 'relay-token.json');

/** 活跃会话的 tail 轮询间隔 */
const TAIL_INTERVAL_MS = 900;
/**
 * 判定「消息已送达」的观察窗口。session/prompt 不会立刻返回，只有立即性的错误
 * （会话不存在、已有回合在跑）会在这段时间内回来。
 */
const SEND_SETTLE_MS = 2000;
/** viewSession 之后留给桌面加载会话的时间；太短会导致重试仍报 not found */
const ATTACH_SETTLE_MS = 1500;
/** 会话列表与状态的刷新间隔 */
const LIST_INTERVAL_MS = 5000;

let output;
let store;
let muxPool;
let relay;
let statusBar;
let tailTimer;
let listTimer;
/**
 * 手机端打开的会话记在**连接上**（conn.watchedSessionId），不再是一个全局值。
 *
 * 原来是全局单值：第二台手机打开另一个会话，会把第一台的 tail 抢走 —— 第一台就此
 * 静默停止更新，界面上没有任何异常提示。而 delta 又是广播给所有客户端的，等于每台
 * 手机都收到别人会话的内容再自己丢掉。
 */
function watchedSessionIds() {
  const ids = new Set();
  if (!relay) return ids;
  for (const conn of relay.connections) {
    if (conn.watchedSessionId) ids.add(conn.watchedSessionId);
  }
  return ids;
}
let lastStatusKey = '';
/**
 * toolCallId -> {connection, requestId, optionIds, at} 收到过的权限请求，用于细粒度响应。
 *
 * 必须会过期。原来只在手机端回应时删除，而实测有相当一部分请求会在 6~130ms 内被 agent
 * 自己取消（不匹配白名单的命令），那些条目就永久留下了。两个后果：表只增不减，以及
 * 对一个早已死掉的 requestId 调 respond —— agent 那边没人在等，手机上却会看到
 * 「已批准」。后者比内存更值得修：它是一个假成功。
 */
const pendingPermissions = new Map();
/** 权限请求的保留时长。与 sessionStore 的 WAITING_WINDOW_MS 对齐，人可能离开手机一会儿 */
const PERMISSION_TTL_MS = 30 * 60 * 1000;
/** 最近一次从 agent 响应里拿到的完整模型清单，见 MODELS_FILE */
let modelOptions = [];
/** 与上面同来源的默认模型，避免自己编一个默认值 */
let modelCurrent;
/** caffeinate 子进程，阻止空闲休眠；中继停止时释放 */
let awake;
/**
 * 已订阅的会话：sessionId -> port。port 变了说明 mux 重连过，订阅已失效。
 * 用 Map 而不是单值，因为多台手机可以同时各看一个会话。
 */
const subscribedTo = new Map();
/** activate 时存下来，轮换 token 后要用它重启中继 */
let extContext;

function log(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  if (output) output.appendLine(`[${ts}] ${msg}`);
}

function setStatus(text, tooltip) {
  if (!statusBar) return;
  statusBar.text = text;
  statusBar.tooltip = tooltip || '';
  statusBar.show();
}

// ---------------------------------------------------------------- 手机端消息

function buildHandlers() {
  return {
    /** 手机连上来就推一次全量，避免它自己发请求 */
    __onConnect: async (conn) => {
      conn.sendJson({ type: 'hello', workspace: currentWorkspaceName() });
      conn.sendJson({ type: 'sessions', items: store.listSessions() });
      conn.sendJson({ type: 'status', ...store.aggregateStatus(), mux: muxSummary() });
    },

    'sessions:list': async () => ({ type: 'sessions', items: store.listSessions() }),

    'session:open': async (msg, conn) => {
      const sessionId = String(msg.sessionId || '');
      // 记在连接上：另一台手机打开别的会话时，这一台的 tail 不受影响
      if (conn) conn.watchedSessionId = sessionId;
      // 必须订阅：agent 只把权限请求和 session/update 发给已订阅该会话的客户端。
      // 不订阅的话，电脑侧发起的会话在手机上永远等不到授权框（只能看到从文件读出的
      // 「待确认」历史卡片，没有按钮），流式思维链也不会有。
      subscribeSession(sessionId);
      const h = store.readHistory(sessionId, Number(msg.limit) || 400);
      return { type: 'history', ...h };
    },

    'session:send': async (msg) => {
      const sessionId = String(msg.sessionId || '');
      const text = String(msg.text || '').trim();
      const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
      if (!sessionId) throw new Error('sessionId 不能为空');
      if (!text && !attachments.length) throw new Error('内容不能为空');
      const r = await sendToSession(sessionId, text, attachments);
      return { type: 'sent', sessionId, via: r.via, attachments: attachments.length };
    },

    /** approve=true 放行，false 拒绝。有细粒度通道就用，否则退回全量命令。 */
    'session:approve': async (msg) => {
      const approve = msg.approve !== false;
      const toolCallId = msg.toolCallId ? String(msg.toolCallId) : null;
      const r = await respondPermission(toolCallId, approve);
      return { type: 'approved', approve, toolCallId, via: r.via, granularity: r.granularity };
    },

    'session:cancel': async (msg) => {
      const sessionId = String(msg.sessionId || '');
      const conn = muxPool.pickForWorkspace(workspaceOfSession(sessionId));
      if (conn) {
        conn.cancel(sessionId);
        return { type: 'cancelled', sessionId, via: 'mux' };
      }
      throw new Error('mux 通道不可用，无法取消');
    },

    /** 新建会话的预设：模式、模型、自主度，以及各自的默认值 */
    'presets:list': async () => {
      const p = await listPresets();
      return {
        type: 'presets',
        modes: p.modes,
        models: p.models,
        autopilot: p.autopilot,
        defaults: p.defaults,
      };
    },

    'session:create': async (msg) => {
      const r = await createSession(msg.workspacePath, {
        mode: msg.modeId,
        model: msg.modelId,
        autopilot: msg.autopilot,
      });
      return { type: 'created', ...r };
    },

    /** 可创建会话的工作区列表（取自已连上的 IDE 窗口） */
    'workspaces:list': async () => {
      const out = [];
      for (const c of muxPool.connections.values()) {
        if (!c.ready) continue;
        for (const f of c.endpoint.folders || []) {
          if (f && f.path && !out.some((x) => x.path === f.path)) {
            out.push({ path: f.path, name: f.label || path.basename(f.path) });
          }
        }
      }
      return { type: 'workspaces', items: out };
    },

    'diagnose': async () => ({ type: 'diagnostics', data: await collectDiagnostics() }),
  };
}

/**
 * 让桥订阅某个会话的实时事件。
 *
 * 机制已在 Kiro 产物里确认：mux 处理任何带 sessionId 的请求时都会
 *   subscribeToSession(sessionId, client)
 * 并且在「此前未订阅」的情况下补发
 *   resendPendingPermissions() / resendPendingUserInputs()
 * 所以这里只要发一个**只读**请求、把 sessionId 带过去就够了，不需要专门的订阅方法。
 *
 * 选 `_kiro/session/history` 是因为它只从 messageStore 读、不改任何状态，limit=1 足够便宜。
 * 不 await、失败也不上抛：订阅只影响实时性，历史与状态仍由文件轮询兜住。
 */
function subscribeSession(sessionId) {
  if (!sessionId) return;
  const conn = muxPool.pickForWorkspace(workspaceOfSession(sessionId));
  if (!conn) {
    log(`[subscribe] 没有可用的 mux 连接，${sessionId} 只能靠文件轮询`);
    return;
  }
  const port = conn.endpoint.port;
  const probe = () => conn.request('_kiro/session/history', { sessionId, limit: 1 });
  const ok = () => {
    subscribedTo.set(sessionId, port);
    log(`[subscribe] 已订阅 ${sessionId}（port=${port}）`);
  };
  probe().then(ok, async (err) => {
    subscribedTo.delete(sessionId);
    // 重启后 agent 不认识旧会话，订阅也会失败。让桌面加载一次再试一遍。
    if (isSessionUnknown(err)) {
      log(`[subscribe] agent 不认识 ${sessionId}，先让桌面加载`);
      await attachDesktop(sessionId);
      await new Promise((r) => setTimeout(r, ATTACH_SETTLE_MS));
      probe().then(ok, (e2) =>
        log(`[subscribe] 加载后仍失败，实时事件收不到: ${e2 && e2.message}`)
      );
      return;
    }
    log(`[subscribe] 订阅 ${sessionId} 失败，实时事件收不到: ${err && err.message}`);
  });
}

/**
 * 订阅是**连接级**的：mux 断开重连、或扩展重启后，之前的订阅就没了，而手机端不一定会
 * 重新发 session:open。表现是「本来能收到审批，过一会儿又收不到了」，且没有任何报错。
 * 所以定期核对一次：会话变了、或者连接换了端口（意味着重连过），就重新订阅。
 */
function ensureSubscribed() {
  const watched = watchedSessionIds();
  // 没人再看的会话要从记账里删掉，否则这个 Map 会随手机开过的会话数一直长
  for (const id of [...subscribedTo.keys()]) {
    if (!watched.has(id)) subscribedTo.delete(id);
  }
  for (const sessionId of watched) {
    const conn = muxPool.pickForWorkspace(workspaceOfSession(sessionId));
    if (!conn) continue;
    if (subscribedTo.get(sessionId) === conn.endpoint.port) continue;
    subscribeSession(sessionId);
  }
}

/** 从历史会话里聚合出用过的模型，按出现次数排序。这是确定可用的兜底来源。 */
function modelsFromHistory() {
  const count = new Map();
  for (const s of store.listSessions()) {
    if (!s.modelId) continue;
    count.set(s.modelId, (count.get(s.modelId) || 0) + 1);
  }
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => ({ id, label: id, source: 'history' }));
}

// parseConfigOptions 已抽到 ./presets（顶部 require 引入），此处不再重复定义。

/**
 * 往 ~/.kiro-bridge 写一个诊断文件。
 *
 * 权限默认 0600，而不是「调用方记得传 mode 才收紧」。之前是后者，结果只有 token 与
 * mux 端点两个文件是 0600，而 agent-probe.json（36 条会话标题 + 工作区绝对路径）和
 * diagnostics.json（最新会话标题、局域网 IP）落在 0644 —— 同一个目录里，敏感度相当，
 * 保护程度却取决于有没有人在调用处想起这件事。
 *
 * 目录本身也收成 0700：文件权限对了但目录可列举，等于把文件名和存在性白送出去。
 */
function writeDiagFile(name, data, mode = 0o600) {
  try {
    fs.mkdirSync(DIAG_DIR, { recursive: true, mode: 0o700 });
    // mkdirSync 的 mode 只对「这次真的创建了目录」生效；目录已存在时它什么都不做，
    // 所以老用户升级上来仍是旧权限。显式 chmod 一次，让新老装机收敛到同一状态。
    try { fs.chmodSync(DIAG_DIR, 0o700); } catch (_) { /* 非 POSIX 文件系统上可忽略 */ }
    const p = path.join(DIAG_DIR, name);
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
    // writeFileSync 对已存在的文件不改权限，所以每次都显式设一遍
    fs.chmodSync(p, mode);
    return true;
  } catch (err) {
    log(`[diag] 写 ${name} 失败: ${err && err.message}`);
    return false;
  }
}

/**
 * 取回配置模板。成功与失败都落盘 —— 早先只在成功时写文件，
 * 结果调用抛错时外部看不到任何线索，只能靠猜。
 */
async function fetchConfigTemplate() {
  const conn = muxPool.anyReady();
  if (!conn) {
    writeDiagFile('config-template.json', { error: 'no ready mux connection' });
    return { modes: [], models: [], raw: null };
  }
  try {
    const tpl = await conn.configTemplate();
    writeDiagFile('config-template.json', tpl);
    const parsed = parseConfigOptions(tpl && tpl.configOptions);
    log(
      `[config] mode=${parsed.mode.items.length} model=${parsed.model.items.length}` +
        ` autopilot=${parsed.autopilot.items.length} 顶层键=${Object.keys(tpl || {}).join(',')}`
    );
    return parsed;
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    log(`[config] _kiro/config/template 调用失败: ${msg}`);
    writeDiagFile('config-template.json', { error: msg, method: '_kiro/config/template' });
    return { mode: { items: [] }, model: { items: [] }, autopilot: { items: [] } };
  }
}

/**
 * 探测 agent 的可用方法面，把每个方法的原始返回或错误落盘。
 * 只调只读方法，不产生任何副作用。
 */
async function probeAgent() {
  const out = { at: new Date().toISOString(), probes: [] };
  const conn = muxPool.anyReady();
  if (!conn) {
    out.error = 'no ready mux connection';
    writeDiagFile('agent-probe.json', out);
    return out;
  }
  out.endpoint = { port: conn.endpoint.port, label: conn.label };
  out.agentCapabilities = (conn.initializeResult || {}).agentCapabilities || null;

  const tries = [
    ['_kiro/config/template', {}],
    ['session/list', {}],
    ['_kiro/session/list', {}],
    ['_kiro/account/getUsage', {}],
  ];
  for (const [method, params] of tries) {
    try {
      const result = await conn.request(method, params, 15000);
      const text = JSON.stringify(result);
      out.probes.push({
        method,
        ok: true,
        topKeys: result && typeof result === 'object' ? Object.keys(result) : null,
        bytes: text ? text.length : 0,
        // 超大返回不整块落盘，但保留一段原文预览 —— 结构信息不能丢
        result: text && text.length > 60000 ? undefined : result,
        preview: text && text.length > 60000 ? text.slice(0, 6000) : undefined,
        truncated: !!(text && text.length > 60000),
      });
      log(`[probe] ${method} 成功，顶层键=${Object.keys(result || {}).join(',')}`);
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      out.probes.push({ method, ok: false, error: msg });
      log(`[probe] ${method} 失败: ${msg}`);
    }
  }
  writeDiagFile('agent-probe.json', out);
  return out;
}

/** 落盘 mux 端点（含 token），仅本机调试用，权限 0600 */
function writeEndpoints() {
  const eps = [];
  for (const [port, c] of muxPool.connections) {
    eps.push({
      port,
      token: c.endpoint.token,
      windowId: c.endpoint.windowId,
      label: c.label,
      folders: c.endpoint.folders,
      ready: c.ready,
    });
  }
  writeDiagFile('mux-endpoints.json', { at: new Date().toISOString(), endpoints: eps }, 0o600);
}

/** 读取模型清单缓存。没有缓存是正常状态，不当成错误。 */
function loadModelOptions() {
  try {
    const raw = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8'));
    if (raw && Array.isArray(raw.items) && raw.items.length) {
      modelOptions = raw.items;
      if (raw.current) modelCurrent = String(raw.current);
      log(`[models] 载入缓存 ${modelOptions.length} 项（抓取于 ${raw.at || '未知时间'}）`);
    }
  } catch (_) {
    /* 首次运行没有缓存，属正常 */
  }
}

/** 任何响应里出现完整模型清单就记下来（session/new、set_config_option 都带） */
function rememberModelOptions(parsed) {
  const items = parsed && parsed.model && parsed.model.items;
  if (!Array.isArray(items) || !items.length) return;
  const grew = items.length !== modelOptions.length;
  modelOptions = items;
  modelCurrent = (parsed.model.current || modelCurrent) || undefined;
  writeDiagFile('model-options.json', {
    at: new Date().toISOString(),
    current: modelCurrent,
    items,
  });
  if (grew) log(`[models] 记录到 ${items.length} 项完整模型清单`);
}

async function listPresets() {
  const p = await fetchConfigTemplate();
  // 降级阶梯：agent 直接给的 > 缓存过的完整清单 > 历史里用过的（不全）。
  // 每一级都标 source 并落日志 —— 之前退到历史是静默发生的，前端看不出清单已经不全。
  let models = p.model.items.map((m) => ({ ...m, source: 'agent' }));
  if (!models.length && modelOptions.length) {
    models = modelOptions.map((m) => ({ ...m, source: 'cache' }));
  }
  if (!models.length) models = modelsFromHistory();
  log(
    `[presets] 模式 ${p.mode.items.length} 项，模型 ${models.length} 项` +
      `（来源 ${(models[0] && models[0].source) || '无'}）`
  );
  return {
    modes: p.mode.items,
    models,
    autopilot: p.autopilot.items,
    defaults: {
      mode: p.mode.current,
      // template 不带模型，默认值也只能来自缓存下来的那次响应，不自己编
      model: p.model.current || modelCurrent,
      autopilot: p.autopilot.current,
    },
  };
}

/**
 * 新建会话：工作区 -> 建会话 -> 依次套用模式与模型。
 *
 * 模式 / 模型设置失败都不算整体失败 —— 会话已经建好了，只是落在默认预设上。
 * 返回时逐项报告结果，前端据此提示到底哪一步没生效。
 */
async function createSession(workspacePath, picks) {
  const conn = muxPool.pickForWorkspace(workspacePath);
  if (!conn) throw new Error('mux 通道不可用，无法新建会话（对应的 IDE 窗口需要开着）');
  const cwd =
    workspacePath ||
    (conn.endpoint.folders && conn.endpoint.folders[0] && conn.endpoint.folders[0].path) ||
    undefined;

  const res = await conn.newSession(cwd);
  const sessionId = res && (res.sessionId || res.id);
  if (!sessionId) throw new Error('session/new 未返回 sessionId');
  // session/new 自带 configOptions，记下当前值便于跳过无需改动的项
  const current = parseConfigOptions(res && res.configOptions);
  // session/new 的返回带全量模型清单，这是唯一能拿到它的通路，见 MODELS_FILE
  rememberModelOptions(current);
  log(
    `[create] ${sessionId} 默认 mode=${current.mode.current}` +
      ` model=${current.model.current} autopilot=${current.autopilot.current}`
  );

  const LABEL = { mode: '模式', model: '模型', autopilot: '自主度' };
  const applied = [];
  const failed = [];
  for (const configId of ['mode', 'model', 'autopilot']) {
    const value = picks && picks[configId];
    if (!value) continue;
    // 已经是目标值就不必再发一次请求
    if (current[configId] && current[configId].current === String(value)) {
      applied.push(LABEL[configId]);
      continue;
    }
    try {
      const r = await conn.setConfigOption(sessionId, configId, value);
      const now = parseConfigOptions(r && r.configOptions);
      rememberModelOptions(now);
      const ok = !now[configId].current || now[configId].current === String(value);
      if (ok) applied.push(LABEL[configId]);
      else failed.push(`${LABEL[configId]}未生效（仍为 ${now[configId].current}）`);
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      failed.push(`${LABEL[configId]}失败`);
      log(`[create] 设置${LABEL[configId]}失败（会话已创建，用默认值）: ${msg}`);
    }
  }
  // 让桌面端 attach 到这个会话，否则它的审批请求会被立刻取消。
  // 依据：ACP SDK 的 requestPermission 是「按 sessionId 找 handler，找不到就直接返回
  // cancelled」（源码注释原文 defaults to cancelled if no handler），而 handler 由
  // 拥有该会话的桌面面板通过 onPermissionRequest(sessionId, …) 注册。纯靠 mux 创建的
  // 会话没有面板拥有它 → 无 handler → 实测 6~20ms 内就被判 cancelled，手机上批不动。
  // Kiro 自己的程序化建会话流程也是先 viewSession 再发 prompt，这里沿用同一做法。
  await attachDesktop(sessionId);

  return { sessionId, cwd, applied, failed };
}

/**
 * 把会话在桌面侧打开，使其注册权限 handler。
 *
 * 副作用是桌面侧边栏会切到这个会话 —— 这是必要代价：不 attach 就等于这个会话的所有
 * 审批都会被静默取消。只在「手机新建会话」时调用，不在打开已有会话时调用：
 * 那会把你在电脑上正在用的会话挤掉，反而弄坏本来正常的审批。
 */
async function attachDesktop(sessionId) {
  try {
    await vscode.commands.executeCommand('kiroAgent.viewSession', sessionId);
    log(`[attach] 桌面已打开 ${sessionId}，审批 handler 应已注册`);
  } catch (err) {
    log(`[attach] 打开失败，该会话的审批可能会被直接取消: ${err && err.message}`);
  }
}

function currentWorkspaceName() {
  const f = vscode.workspace.workspaceFolders;
  return f && f.length ? f[0].name : '(无工作区)';
}

function workspaceOfSession(sessionId) {
  const s = store.listSessions().find((x) => x.sessionId === sessionId);
  return s && s.workspacePaths && s.workspacePaths.length ? s.workspacePaths[0] : null;
}

/** 发消息：优先 mux 的 session/prompt（可定向到任意会话），失败退回 VS Code 命令 */
/**
 * 发一次 prompt 并只观察一小段时间。
 *
 * session/prompt 要等整个回合结束才返回，等它就等于把「正在正常处理」判成失败。
 * 所以只看这段窗口里有没有回错误（例如 A prompt is already in-flight、Session not found），
 * 没有就当已送达，回合继续在后台跑。返回 null 表示没观察到错误。
 */
/** 文本类 mime：这些用 resource.text 送，agent 侧能直接当文本读 */
const TEXTISH = /^text\/|json|xml|csv|yaml|javascript|typescript|markdown|x-sh|x-python/i;

/**
 * 把手机传来的附件转成 ACP 内容块。
 *
 * 形状取自 Kiro 产物里的 zContentBlock（都已核实）：
 *   图片       -> { type:'image', data:<base64>, mimeType }
 *   文本类文件 -> { type:'resource', resource:{ uri, mimeType, text } }
 *   其他二进制 -> { type:'resource', resource:{ uri, mimeType, blob:<base64> } }
 * 手机端统一传 base64，文本类在这里解码，省得前端判断编码。
 */
function blocksFor(text, attachments) {
  const blocks = [];
  if (text) blocks.push({ type: 'text', text });
  for (const a of attachments || []) {
    const data = String((a && a.data) || '');
    if (!data) continue;
    const name = String((a && a.name) || 'file');
    const mimeType = String((a && a.mimeType) || 'application/octet-stream');
    if (mimeType.startsWith('image/')) {
      blocks.push({ type: 'image', data, mimeType });
      continue;
    }
    const uri = `attachment://${encodeURIComponent(name)}`;
    if (TEXTISH.test(mimeType)) {
      let decoded = '';
      try {
        decoded = Buffer.from(data, 'base64').toString('utf8');
      } catch (err) {
        log(`[send] 附件 ${name} 解码失败，改按二进制发送: ${err && err.message}`);
      }
      if (decoded) {
        blocks.push({ type: 'resource', resource: { uri, mimeType, text: decoded } });
        continue;
      }
    }
    blocks.push({ type: 'resource', resource: { uri, mimeType, blob: data } });
  }
  return blocks;
}

async function tryPrompt(conn, sessionId, prompt) {
  let failure = null;
  const inflight = conn.sendPrompt(sessionId, prompt);
  inflight.then(
    () => log(`[send] 回合结束 session=${sessionId}`),
    (err) => {
      failure = err || new Error('unknown');
      log(`[send] 回合出错 session=${sessionId}: ${failure.message}`);
    }
  );
  await new Promise((r) => setTimeout(r, SEND_SETTLE_MS));
  return failure;
}

/**
 * 判断错误是否为「agent 不认识这个会话」。
 *
 * 重载或窗口重启后，agent 是个新进程，内存里没有旧会话的 state —— 磁盘上文件都在，
 * 但 session/prompt 与 _kiro/session/history 都会报 Session ... not found。
 */
function isSessionUnknown(err) {
  return /not found|unknown session|no such session/i.test(String((err && err.message) || err));
}

async function sendToSession(sessionId, text, attachments) {
  const atts = Array.isArray(attachments) ? attachments : [];
  const prompt = blocksFor(text, atts);
  const wsPath = workspaceOfSession(sessionId);
  const conn = muxPool.pickForWorkspace(wsPath);
  if (conn) {
    if (atts.length) {
      const kinds = prompt.map((b) => b.type).join(',');
      log(`[send] 带 ${atts.length} 个附件 session=${sessionId} 块=${kinds}`);
    }
    let failure = await tryPrompt(conn, sessionId, prompt);
    // agent 不认识这个会话 → 让桌面加载一次再重试。
    // 不用 ACP 的 session/load：它要求传 mcpServers，传空数组有可能让该会话丢掉 MCP 工具，
    // 属于会静默降级的副作用；走桌面加载则用它自己的配置。
    if (failure && isSessionUnknown(failure)) {
      log('[send] agent 不认识该会话（重启后常见），先让桌面加载一次再重试');
      await attachDesktop(sessionId);
      // viewSession 只是把面板切过去，加载是异步的；不留一点时间的话重试仍会 not found
      await new Promise((r) => setTimeout(r, ATTACH_SETTLE_MS));
      failure = await tryPrompt(conn, sessionId, prompt);
    }
    if (!failure) {
      log(`[send] via mux port=${conn.endpoint.port} session=${sessionId}`);
      return { via: 'mux' };
    }
    log(`[send] mux 失败，降级命令: ${failure.message}`);
  }
  // 降级通道只能传纯文本。带附件时如实报错 —— 悄悄把附件丢掉再显示「已发送」，
  // 是最坏的一种失败：用户以为图发出去了，而 agent 从没见过它。
  if (atts.length) {
    throw new Error(`mux 通道不可用，带附件的消息发不出去（降级通道只支持纯文本）`);
  }
  // 降级：kiroAgent.sessions.sendPrompt(sessionId, text) 在扩展产物中确认 sessionId 有效
  try {
    await vscode.commands.executeCommand('kiroAgent.sessions.sendPrompt', sessionId, text);
    log(`[send] via command kiroAgent.sessions.sendPrompt session=${sessionId}`);
    return { via: 'command' };
  } catch (err) {
    throw new Error(`发送失败（mux 与命令都不可用）: ${err && err.message}`);
  }
}

/**
 * 响应权限请求。
 * 细粒度：mux 送来过该 toolCallId 的 request_permission，就直接回它。
 * 粗粒度：否则用 runOrAcceptAll / rejectAll —— 注意这作用于当前活动会话的整批操作。
 */
/** 丢掉过期的权限请求记录，并返回丢掉的条数 */
function prunePendingPermissions(now = Date.now()) {
  let n = 0;
  for (const [id, rec] of pendingPermissions) {
    if (now - (rec.at || 0) > PERMISSION_TTL_MS) {
      pendingPermissions.delete(id);
      n++;
    }
  }
  if (n) log(`[approve] 清掉 ${n} 条过期的权限请求记录`);
  return n;
}

async function respondPermission(toolCallId, approve) {
  const stale = toolCallId && pendingPermissions.get(toolCallId);
  if (stale && Date.now() - (stale.at || 0) > PERMISSION_TTL_MS) {
    // 显式失败，不要退到整批命令：那会对当前活动会话执行 runOrAcceptAll，
    // 作用范围远大于用户以为自己在批准的那一个工具调用。
    pendingPermissions.delete(toolCallId);
    log(`[approve] toolCallId=${toolCallId} 已过期，拒绝响应`);
    throw new Error('这个请求已经过期了，没有生效。回到会话里看看当前状态。');
  }
  if (toolCallId && pendingPermissions.has(toolCallId)) {
    const { connection, requestId, optionIds } = pendingPermissions.get(toolCallId);
    const optionId = approve ? optionIds.allow : optionIds.deny;
    // 放行必须带上具体 optionId：缺 optionId 的 selected 在协议上是无效响应，agent 侧会
    // 当成取消处理，而手机端却会看到「已回应」。宁可显式失败，也不要制造这种假成功。
    if (approve && !optionId) {
      pendingPermissions.delete(toolCallId);
      connection.respondError(requestId, -32602, 'kiro-remote-bridge: no allow option matched');
      log(`[approve] 放行失败：选项里找不到 allow toolCallId=${toolCallId}`);
      throw new Error('这次请求没有可识别的「允许」选项，未放行（已如实回错误）');
    }
    connection.respond(requestId, {
      outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' },
    });
    pendingPermissions.delete(toolCallId);
    log(
      `[approve] via mux toolCallId=${toolCallId} approve=${approve} optionId=${optionId || '-'}`
    );
    return { via: 'mux', granularity: 'single' };
  }
  const cmd = approve ? 'kiroAgent.execution.runOrAcceptAll' : 'kiroAgent.execution.rejectAll';
  await vscode.commands.executeCommand(cmd);
  log(`[approve] via command ${cmd}（整批，作用于当前活动会话）`);
  return { via: 'command', granularity: 'batch' };
}

// ---------------------------------------------------------------- mux 入站

function onMuxInbound(m) {
  const { method, params, id, connection } = m;
  // 权限请求：记下来，等手机端决定
  if (/request_permission/i.test(method) && id !== undefined) {
    const toolCallId =
      (params && (params.toolCallId || (params.toolCall && params.toolCall.toolCallId))) ||
      `req-${id}`;
    const options = (params && params.options) || [];
    const find = (re) => {
      const hit = options.find(
        (o) => o && (re.test(String(o.kind || '')) || re.test(String(o.optionId || '')))
      );
      return hit ? hit.optionId : null;
    };
    prunePendingPermissions();
    pendingPermissions.set(toolCallId, {
      connection,
      requestId: id,
      at: Date.now(),
      optionIds: { allow: find(/allow|approve|accept/i), deny: find(/reject|deny|cancel/i) },
    });
    log(`[mux] 收到权限请求 toolCallId=${toolCallId} options=${JSON.stringify(options).slice(0, 200)}`);
    if (relay) {
      relay.broadcast({
        type: 'permission',
        toolCallId,
        title: (params && (params.title || params.toolName)) || '工具调用',
        detail: JSON.stringify((params && params.toolCall) || params || {}).slice(0, 600),
        options,
      });
    }
    return;
  }
  // 流式更新：mux 会把订阅会话的增量推过来。这里只转发，渲染交给手机端。
  if (/session\/update|sessionUpdate/i.test(method)) {
    if (relay) {
      const sid = params && params.sessionId;
      // 带得出 sessionId 就只发给在看它的那台手机；带不出就退回广播，
      // 由前端按 sessionId 自己过滤（原来的行为）。
      if (sid) relay.broadcastTo((c) => c.watchedSessionId === sid, { type: 'muxUpdate', params });
      else relay.broadcast({ type: 'muxUpdate', params });
    }
    return;
  }
  if (id !== undefined) {
    // 未知的入站请求：显式回错误，避免 agent 侧一直等
    connection.respondError(id, -32601, `bridge does not implement ${method}`);
    log(`[mux] 未实现的入站请求 ${method}，已回 -32601`);
  }
}

function muxSummary() {
  const conns = [];
  for (const [port, c] of muxPool.connections) {
    conns.push({ port, label: c.label, ready: c.ready });
  }
  return {
    endpointsAvailable: muxPool.endpointsAvailable,
    connected: conns.filter((c) => c.ready).length,
    connections: conns,
  };
}

// ---------------------------------------------------------------- 轮询

function startPolling() {
  stopPolling();
  tailTimer = setInterval(() => {
    if (!relay || relay.clientCount === 0) return;
    // 每台手机各看一个会话，逐个 tail。store.cursors 是按文件路径记的，
    // 多个会话并行 tail 互不干扰。
    for (const sessionId of watchedSessionIds()) {
      try {
        const d = store.tail(sessionId);
        if (!d.messages || !d.messages.length) continue;
        // 只发给正在看这个会话的连接
        relay.broadcastTo((c) => c.watchedSessionId === sessionId, {
          type: d.reset ? 'history' : 'delta',
          sessionId: d.sessionId,
          status: d.status,
          messages: d.messages,
        });
      } catch (err) {
        log(`[tail] ${sessionId} 失败: ${err && err.message}`);
      }
    }
  }, TAIL_INTERVAL_MS);

  listTimer = setInterval(() => {
    if (!relay || relay.clientCount === 0) return;
    // 订阅是连接级的，重连后会静默失效，所以每轮核对一次（命中时不发请求）
    ensureSubscribed();
    try {
      // 只扫一次目录，状态聚合复用同一份结果
      const items = store.listSessions();
      const st = store.aggregateStatus(items);
      const key = `${st.state}|${st.running}|${st.waiting}`;
      if (key !== lastStatusKey) {
        lastStatusKey = key;
        relay.broadcast({ type: 'status', ...st, mux: muxSummary() });
        setStatus(
          `$(radio-tower) Bridge ${st.state}`,
          `远程会话运行中\n状态: ${st.state}\n手机端: ${relay.clientCount} 个`
        );
      }
      relay.broadcast({ type: 'sessions', items });
    } catch (err) {
      log(`[list] 失败: ${err && err.message}`);
    }
  }, LIST_INTERVAL_MS);
}

function stopPolling() {
  if (tailTimer) clearInterval(tailTimer);
  if (listTimer) clearInterval(listTimer);
  tailTimer = null;
  listTimer = null;
}

// ---------------------------------------------------------------- 自诊断

async function collectDiagnostics() {
  const sessions = store.listSessions();
  const cmds = await vscode.commands.getCommands(true);
  const want = [
    'kiro.agentRegistry.getAgentEndpoints',
    'kiroAgent.sessions.sendPrompt',
    'kiroAgent.sessions.switch',
    'kiroAgent.viewSession',
    'kiroAgent.execution.runOrAcceptAll',
    'kiroAgent.execution.rejectAll',
    'kiroAgent.execution.trust',
  ];
  const data = {
    at: new Date().toISOString(),
    kiroVersion: vscode.version,
    nodeVersion: process.version,
    sessionStore: {
      root: store.root,
      exists: store.exists(),
      sessionCount: sessions.length,
      workspaceCount: new Set(sessions.map((s) => (s.workspacePaths || [])[0] || '')).size,
      statusBreakdown: sessions.reduce((acc, s) => {
        acc[s.status] = (acc[s.status] || 0) + 1;
        return acc;
      }, {}),
      newest: sessions[0]
        ? { title: sessions[0].title, lastActiveAt: new Date(sessions[0].lastActiveAt).toISOString() }
        : null,
    },
    commandsPresent: Object.fromEntries(want.map((c) => [c, cmds.includes(c)])),
    mux: muxPool.diagnostics(),
    relay: relay
      ? {
          port: relay.port,
          bindLan: relay.bindLan,
          clients: relay.clientCount,
          // 只记地址形状，不落 token
          urls: relay.urls().map((u) => u.replace(/token=[^&]+/, 'token=<redacted>')),
        }
      : null,
  };
  log('[diagnose] ' + JSON.stringify(data, null, 2));
  // 同时落盘：输出面板的内容没法被外部读取，落盘才能在 IDE 之外核对结果。
  // 走 writeDiagFile 而不是自己 writeFileSync —— 这里原本是第二条写盘路径，于是
  // 「DIAG_DIR 下的文件怎么落」有了两份实现，收紧权限时只改到了一份。
  if (writeDiagFile('diagnostics.json', data)) log(`[diagnose] 已写入 ${DIAG_FILE}`);
  return data;
}

// ---------------------------------------------------------------- 生命周期

/** 读取持久化的访问 token；没有就生成一个并落盘（0600）。见 TOKEN_FILE 的说明。 */
function loadOrCreateToken() {
  try {
    const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (raw && typeof raw.token === 'string' && raw.token.length >= 32) {
      log(`[token] 复用已落盘的访问 token（生成于 ${raw.at || '未知时间'}）`);
      return raw.token;
    }
  } catch (_) {
    /* 首次运行没有这个文件，属正常 */
  }
  const token = crypto.randomBytes(32).toString('base64url');
  writeDiagFile('relay-token.json', { at: new Date().toISOString(), token }, 0o600);
  log('[token] 已生成新的访问 token 并落盘（0600）');
  return token;
}

/** 换一个新 token。持久 token 一旦泄露就长期有效，必须留一条轮换的路。 */
async function rotateToken() {
  try {
    fs.unlinkSync(TOKEN_FILE);
  } catch (_) {
    /* 本来就没有也没关系 */
  }
  const wasRunning = !!relay;
  if (wasRunning) await stop();
  log('[token] 已作废旧 token');
  if (wasRunning && extContext) {
    await start(extContext);
    vscode.window.showInformationMessage('访问 token 已轮换，中继已重启 —— 手机需要重新扫码');
  } else {
    vscode.window.showInformationMessage('访问 token 已轮换，下次启动生效');
  }
}

/**
 * 阻止空闲休眠。
 *
 * 注意：caffeinate 阻止不了「合盖休眠」—— 合上盖子且没接外接显示器/电源时，系统照样会睡，
 * 远程访问随之中断。这是系统行为，不是本项目能绕开的，所以要如实写进文档而不是假装解决了。
 */
function keepAwake() {
  if (awake) return;
  try {
    awake = spawn('caffeinate', ['-i'], { stdio: 'ignore' });
    awake.on('exit', () => {
      awake = null;
    });
    awake.on('error', (err) => {
      awake = null;
      log(`[awake] caffeinate 启动失败，机器可能会休眠: ${err && err.message}`);
    });
    log('[awake] 已抑制空闲休眠（注意：合盖仍会休眠）');
  } catch (err) {
    log(`[awake] caffeinate 不可用，机器可能会休眠: ${err && err.message}`);
  }
}

function releaseAwake() {
  if (!awake) return;
  try {
    awake.kill();
  } catch (_) {
    /* 已经退出了 */
  }
  awake = null;
  log('[awake] 已释放休眠抑制');
}

async function start(context) {
  if (relay) {
    vscode.window.showInformationMessage('Kiro Bridge 已在运行');
    return;
  }
  const cfg = vscode.workspace.getConfiguration('kiroBridge');
  const port = cfg.get('port', 3939);
  const bindLan = cfg.get('bindLan', true);

  relay = new Relay({
    mediaDir: path.join(context.extensionPath, 'media'),
    log,
    handlers: buildHandlers(),
    token: loadOrCreateToken(),
  });
  await relay.start(port, bindLan);
  // 远程访问的前提是机器活着；出门在外没人能去点一下鼠标
  keepAwake();

  const r = await muxPool.refresh();
  log(`[mux] endpoints=${r.endpointCount} 已连接=${r.connectedCount}`);

  startPolling();
  setStatus('$(radio-tower) Bridge on', '远程会话已启动');
  await showUrl();
  await collectDiagnostics();
}

async function stop() {
  stopPolling();
  releaseAwake();
  if (relay) {
    relay.stop();
    relay = null;
  }
  muxPool.dispose();
  pendingPermissions.clear();
  subscribedTo.clear();
  setStatus('$(circle-slash) Bridge off', '远程会话已停止');
}

async function showUrl() {
  if (!relay) {
    vscode.window.showWarningMessage('Kiro Bridge 未启动');
    return;
  }
  const urls = relay.urls();
  const lan = urls.find((u) => !u.includes('127.0.0.1')) || urls[0];
  const panel = vscode.window.createWebviewPanel(
    'kiroBridgeUrl',
    'Kiro Bridge 访问地址',
    vscode.ViewColumn.Beside,
    { enableScripts: true }
  );
  const qrJs = fs.readFileSync(
    path.join(__dirname, '..', 'media', 'qr.js'),
    'utf8'
  );
  panel.webview.html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
 body{font-family:-apple-system,system-ui,sans-serif;padding:24px;line-height:1.6}
 .qr{margin:16px 0;padding:16px;background:#fff;display:inline-block;border-radius:8px}
 code{background:var(--vscode-textCodeBlock-background);padding:2px 6px;border-radius:4px;
      word-break:break-all;font-size:12px}
 .warn{color:var(--vscode-editorWarning-foreground);font-size:13px;margin-top:20px}
 ul{padding-left:20px}
</style></head><body>
<h2>手机扫码接入</h2>
<div class="qr" id="qr"></div>
<p>或手动打开：</p>
<ul>${urls.map((u) => `<li><code>${u}</code></li>`).join('')}</ul>
<p class="warn">这个地址带着完整控制权限。token 是唯一的门，不要转发给别人。
绑定局域网时，同一 WiFi 下的设备都能到达该端口。</p>
<script>${qrJs}
document.getElementById('qr').innerHTML = renderQrSvg(${JSON.stringify(lan)}, 6);
</script></body></html>`;
}

function activate(context) {
  output = vscode.window.createOutputChannel('Kiro Remote Bridge');
  log('扩展已激活');
  extContext = context;
  loadModelOptions();

  store = new SessionStore(log);
  muxPool = new MuxPool(vscode, log);
  muxPool.on('inbound', onMuxInbound);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'kiroBridge.showUrl';
  setStatus('$(circle-slash) Bridge off', 'Kiro Remote Bridge 未启动');

  context.subscriptions.push(
    output,
    statusBar,
    vscode.commands.registerCommand('kiroBridge.start', () => start(context)),
    vscode.commands.registerCommand('kiroBridge.stop', () => stop()),
    vscode.commands.registerCommand('kiroBridge.showUrl', () => showUrl()),
    vscode.commands.registerCommand('kiroBridge.diagnose', async () => {
      const d = await collectDiagnostics();
      output.show(true);
      vscode.window.showInformationMessage(
        `自诊断完成：会话 ${d.sessionStore.sessionCount} 个，mux 连接 ${
          d.mux.connections.filter((c) => c.ready).length
        } 个。详情见输出面板。`
      );
    }),
    vscode.commands.registerCommand('kiroBridge.probe', async () => {
      await muxPool.refresh();
      writeEndpoints();
      const r = await probeAgent();
      output.show(true);
      const okN = (r.probes || []).filter((p) => p.ok).length;
      vscode.window.showInformationMessage(
        `探测完成：${okN}/${(r.probes || []).length} 个方法可用，结果已写入 ${PROBE_FILE}`
      );
    }),
    vscode.commands.registerCommand('kiroBridge.rotateToken', () => rotateToken()),
    vscode.commands.registerCommand('kiroBridge.showLog', () => output.show(true))
  );

  const cfg = vscode.workspace.getConfiguration('kiroBridge');
  if (cfg.get('autoStart', false)) {
    setTimeout(() => start(context).catch((e) => log(`自动启动失败: ${e && e.message}`)), 4000);
  } else if (cfg.get('debugProbeOnStartup', false)) {
    /*
     * 激活后自动跑一次只读诊断并落盘。默认关闭。
     *
     * 这段原本是无条件执行的，理由是「这是扩展确实被加载了的唯一外部证据」—— 那是开发期
     * 的需求，不该长期挂在所有人的启动路径上。它的实际代价是：用户从没启动过 bridge，
     * 扩展也已经连上全部 agent mux、发了 4 个 RPC、把 mux token 落盘。而且 mux 端点是
     * 全窗口共享的，N 个窗口会各自连上全部 N 个端点。
     *
     * 同样的事 kiroBridge.probe 命令随时能做一次，所以这里不需要默认打开。
     */
    setTimeout(() => {
      muxPool
        .refresh()
        .then(async () => {
          await collectDiagnostics();
          writeEndpoints();
          await probeAgent();
        })
        .catch((e) => log(`启动自诊断失败: ${e && e.message}`));
    }, 5000);
  } else {
    // 不做任何主动连接。「扩展被加载了」这件事由输出面板首行日志证明，够用了。
    log('已就绪，等待 kiroBridge.start（启动自诊断已关闭，需要时开 kiroBridge.debugProbeOnStartup）');
  }
}

function deactivate() {
  stopPolling();
  // caffeinate 是子进程，不显式收掉会把休眠一直抑制到它自己退出
  releaseAwake();
  if (relay) relay.stop();
  if (muxPool) muxPool.dispose();
}

module.exports = {
  activate,
  deactivate,
  /**
   * 仅供测试。这些不是对外契约，可以随时改。
   * 暴露出来是因为权限记账的失效形态是「对死掉的 requestId 回响应，手机上显示已批准」——
   * 一个假成功，静态检查看不出来，只能靠真的走一遍。
   */
  __test: { pendingPermissions, prunePendingPermissions, respondPermission, PERMISSION_TTL_MS },
};
