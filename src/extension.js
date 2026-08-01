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
/** 会话列表与状态的刷新间隔 */
const LIST_INTERVAL_MS = 5000;

let output;
let store;
let muxPool;
let relay;
let statusBar;
let tailTimer;
let listTimer;
/** 手机端当前打开的会话，只 tail 这一个，避免全量扫 */
let watchedSessionId = null;
let lastStatusKey = '';
/** toolCallId -> {connection, requestId} 收到过的权限请求，用于细粒度响应 */
const pendingPermissions = new Map();
/** 最近一次从 agent 响应里拿到的完整模型清单，见 MODELS_FILE */
let modelOptions = [];
/** 与上面同来源的默认模型，避免自己编一个默认值 */
let modelCurrent;
/** caffeinate 子进程，阻止空闲休眠；中继停止时释放 */
let awake;
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

    'session:open': async (msg) => {
      const sessionId = String(msg.sessionId || '');
      watchedSessionId = sessionId;
      const h = store.readHistory(sessionId, Number(msg.limit) || 400);
      return { type: 'history', ...h };
    },

    'session:send': async (msg) => {
      const sessionId = String(msg.sessionId || '');
      const text = String(msg.text || '').trim();
      if (!sessionId || !text) throw new Error('sessionId 与 text 都不能为空');
      const r = await sendToSession(sessionId, text);
      return { type: 'sent', sessionId, via: r.via };
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

function writeDiagFile(name, data, mode) {
  try {
    fs.mkdirSync(DIAG_DIR, { recursive: true });
    const p = path.join(DIAG_DIR, name);
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
    if (mode !== undefined) fs.chmodSync(p, mode);
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
  return { sessionId, cwd, applied, failed };
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
async function sendToSession(sessionId, text) {
  const wsPath = workspaceOfSession(sessionId);
  const conn = muxPool.pickForWorkspace(wsPath);
  if (conn) {
    // session/prompt 要等整个回合结束才返回，等它就等于把「正在正常处理」判成失败。
    // 这里只观察一小段时间：期间回了错误（例如 A prompt is already in-flight）才算发送失败，
    // 否则就当已送达，回合继续在后台跑。
    let failure = null;
    const inflight = conn.sendPrompt(sessionId, text);
    inflight.then(
      () => log(`[send] 回合结束 session=${sessionId}`),
      (err) => {
        failure = err || new Error('unknown');
        log(`[send] 回合出错 session=${sessionId}: ${failure.message}`);
      }
    );
    await new Promise((r) => setTimeout(r, SEND_SETTLE_MS));
    if (!failure) {
      log(`[send] via mux port=${conn.endpoint.port} session=${sessionId}`);
      return { via: 'mux' };
    }
    log(`[send] mux 失败，降级命令: ${failure.message}`);
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
async function respondPermission(toolCallId, approve) {
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
    pendingPermissions.set(toolCallId, {
      connection,
      requestId: id,
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
    if (relay) relay.broadcast({ type: 'muxUpdate', params });
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
    if (!relay || relay.clientCount === 0 || !watchedSessionId) return;
    try {
      const d = store.tail(watchedSessionId);
      if (d.messages && d.messages.length) {
        relay.broadcast({
          type: d.reset ? 'history' : 'delta',
          sessionId: d.sessionId,
          status: d.status,
          messages: d.messages,
        });
      }
    } catch (err) {
      log(`[tail] 失败: ${err && err.message}`);
    }
  }, TAIL_INTERVAL_MS);

  listTimer = setInterval(() => {
    if (!relay || relay.clientCount === 0) return;
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
  // 同时落盘：输出面板的内容没法被外部读取，落盘才能在 IDE 之外核对结果
  try {
    fs.mkdirSync(DIAG_DIR, { recursive: true });
    fs.writeFileSync(DIAG_FILE, JSON.stringify(data, null, 2), 'utf8');
    log(`[diagnose] 已写入 ${DIAG_FILE}`);
  } catch (err) {
    log(`[diagnose] 写入失败: ${err && err.message}`);
  }
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
  watchedSessionId = null;
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

  if (vscode.workspace.getConfiguration('kiroBridge').get('autoStart', false)) {
    setTimeout(() => start(context).catch((e) => log(`自动启动失败: ${e && e.message}`)), 4000);
  } else {
    // 激活后自动跑一次只读诊断并落盘：这是「扩展确实被加载了」的唯一外部证据，
    // 也顺便探明 mux 的真实可用面。不起 relay、不发任何写操作。
    setTimeout(() => {
      muxPool
        .refresh()
        .then(async () => {
          await collectDiagnostics();
          writeEndpoints();
          // 顺带探一遍 agent 的方法面，结果落盘。都是只读调用。
          await probeAgent();
        })
        .catch((e) => log(`启动自诊断失败: ${e && e.message}`));
    }, 5000);
  }
}

function deactivate() {
  stopPolling();
  // caffeinate 是子进程，不显式收掉会把休眠一直抑制到它自己退出
  releaseAwake();
  if (relay) relay.stop();
  if (muxPool) muxPool.dispose();
}

module.exports = { activate, deactivate };
