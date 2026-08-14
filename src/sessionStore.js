'use strict';
/**
 * 读取 Kiro IDE 当前的会话存储（只读）。
 *
 * 布局（IDE 1.0.242 / kiro-agent 1.0.428 实测）：
 *   ~/.kiro/sessions/<workspaceHash>/<sessionId>/
 *       session.json     会话元数据
 *       messages.jsonl   事件流，每行 {id, timestamp, payload}
 *       snapshots/       文件快照（本模块不读）
 *
 * 注意：旧路径 globalStorage/kiro.kiroagent/workspace-sessions 已于会话迁移后停用
 * （同目录留有 .migrated-<id>.json 标记），本模块不再读取它。
 *
 * 所有内部映射一律以「完整路径」为键 —— 各会话目录下的文件同名（都叫
 * session.json / messages.jsonl），用 basename 当键会互相覆盖。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const SESSIONS_ROOT = path.join(os.homedir(), '.kiro', 'sessions');

/**
 * 判定「真的在跑」的时间窗。
 *
 * session.json 的 status 字段不能当实时状态用：它是会话最后一次写入时的快照，
 * 会话被中断（关窗口 / 切走 / 崩溃）时会永久停在 in_progress。实测有 7 个几周前
 * 的会话都带着 in_progress。所以必须结合事件流末尾与文件 mtime 一起判断。
 *
 * RUNNING 窗口取 3 分钟：单个工具调用可能耗时较久（跑测试、装依赖），
 * 但两次事件之间的间隔通常远小于此。
 * WAITING 窗口取 30 分钟：卡在等批准可以等很久，但窗口关掉后就没有意义了。
 */
/**
 * readHistory 首次回读的字节数。
 * 实测 18 个「历史足够长」的真实会话里，产出 400 条渲染消息所需的回读量中位 1383KB、
 * 最大 8147KB。取 2MB 是为了让多数会话一次读够；不够时按密度估算再读一次。
 * 这个值只影响读几次，不影响正确性。
 */
const HISTORY_WINDOW_BYTES = 2 * 1024 * 1024;
/**
 * 「正在跑」的时间窗。这个窗口是必要的：会话被中断会永久停在 turn_start，
 * 没有时间窗就会一直显示运行中。
 */
const RUNNING_WINDOW_MS = 3 * 60 * 1000;
/*
 * 这里原来还有一个 WAITING_WINDOW_MS = 30 分钟，用来判「等确认」。已删除 ——
 * 等审批时文件本来就不动，用静置时长去判断它，等于专门把这个状态判错。
 * 现在「等确认」只看 pending / resolved 是否成对，不看时间。
 */
/** 从文件尾部回读的字节数，够覆盖最近若干个事件 */
const TAIL_PROBE_BYTES = 16 * 1024;
/**
 * 查「某个授权请求有没有结局」时回读的字节数。
 *
 * 比 TAIL_PROBE_BYTES 大得多，因为 pending 与它的 resolved 之间可能夹着整轮工具调用；
 * 实测有 agent 不等审批继续跑、在 pending 之后写了 1.28MB 的情况。
 * 这个查询只在「打开会话要重放待批」和「提交失败要核对」两条冷路径上跑，不是热路径。
 */
const RESOLVE_PROBE_BYTES = 1024 * 1024;

/** messages.jsonl 里需要投递到前端的事件类型 */
const RENDERABLE = new Set([
  'user',
  'assistant',
  'tool_call',
  'tool_result',
  'turn_start',
  'turn_end',
  'pending_interaction',
  'interaction_resolved',
  'session_metadata',
  'session_event',
  'usage_summary',
  'sub_agent_start',
  'sub_agent_complete',
  'tombstone',
]);

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function toEpoch(iso) {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * 同一个 sessionId 在多个 workspace 目录下各有一份 session.json 时，合并成一条。
 *
 * 为什么会有多份：Kiro 把会话**元数据**同步到多个 workspace 目录，但 `messages.jsonl`
 * 只落在真正打开这个会话的那个窗口下。实测本机 48 个会话里有 2 个这样的重复，
 * 其中一份只有 `session.json`（几百字节）、完全没有消息文件。
 * （`listSessions` 里那句「没有 messages.jsonl 的会话仍然列出」说的就是这些副本，
 * 当时没认出它们其实是同一个会话。）
 *
 * 不去重的两个后果：
 *   - 手机端列表出现两条一模一样的会话，点哪条都一样。
 *   - `workspaceOfSession()` 用 `find` 取第一条，可能挑到**没有消息数据**的那个
 *     workspace，于是 `pickForWorkspace` 连到错误的窗口，`session/prompt` 报
 *     Session not found。
 *
 * 保留哪一份：**有 messages.jsonl 的那份优先**，因为 item 里的 `dir` 会被用来读历史，
 * 留错了就读不到消息。都有或都没有时取最近活动的那份。
 * 另一份的 `workspacePaths` 会合并进来，不丢候选（将来若要「逐个窗口试」用得上）。
 */
function dedupeSessions(items) {
  const byId = new Map();
  for (const it of items) {
    const prev = byId.get(it.sessionId);
    if (!prev) {
      byId.set(it.sessionId, it);
      continue;
    }
    let keep, drop;
    if (!!it.hasMessages !== !!prev.hasMessages) {
      keep = it.hasMessages ? it : prev;
      drop = it.hasMessages ? prev : it;
    } else if (it.lastActiveAt > prev.lastActiveAt) {
      keep = it;
      drop = prev;
    } else {
      keep = prev;
      drop = it;
    }
    const merged = [...(keep.workspacePaths || [])];
    for (const p of drop.workspacePaths || []) if (!merged.includes(p)) merged.push(p);
    keep.workspacePaths = merged;
    byId.set(it.sessionId, keep);
  }
  return [...byId.values()];
}

function firstLine(text, max = 120) {
  const s = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

class SessionStore {
  constructor(log) {
    this.log = log || (() => {});
    /** 完整路径 -> {size, mtimeMs} 的读取游标，用于增量 tail */
    this.cursors = new Map();
    /**
     * readHistory 首次回读的字节数。做成实例属性是为了让测试能把它调到很小，
     * 从而在小文件上覆盖「窗口起点切断合并组」这类边界，不必造几 MB 的样本。
     */
    this.historyWindow = HISTORY_WINDOW_BYTES;
    /** sessionId -> 目录，见 findSessionDir。命中时只做一次 existsSync 校验 */
    this.dirCache = new Map();
  }

  get root() {
    return SESSIONS_ROOT;
  }

  exists() {
    return fs.existsSync(SESSIONS_ROOT);
  }

  /** 枚举全部会话目录的完整路径 */
  listSessionDirs() {
    const out = [];
    if (!this.exists()) return out;
    let workspaces;
    try {
      workspaces = fs.readdirSync(SESSIONS_ROOT);
    } catch (_) {
      return out;
    }
    for (const ws of workspaces) {
      const wsDir = path.join(SESSIONS_ROOT, ws);
      let stat;
      try {
        stat = fs.statSync(wsDir);
      } catch (_) {
        continue;
      }
      if (!stat.isDirectory()) continue;
      let sessions;
      try {
        sessions = fs.readdirSync(wsDir);
      } catch (_) {
        continue;
      }
      for (const s of sessions) {
        const dir = path.join(wsDir, s);
        try {
          if (fs.statSync(dir).isDirectory()) out.push(dir);
        } catch (_) {
          /* skip */
        }
      }
    }
    return out;
  }

  /**
   * 会话摘要列表，按最后活动时间倒序。
   * messageCount 用 user 事件数（对用户来说「几轮对话」比「几条事件」有意义）。
   */
  listSessions() {
    const items = [];
    for (const dir of this.listSessionDirs()) {
      const metaPath = path.join(dir, 'session.json');
      const meta = safeReadJson(metaPath);
      if (!meta) continue;

      const jsonl = path.join(dir, 'messages.jsonl');
      let mtimeMs = toEpoch(meta.lastModifiedAt);
      let size = 0;
      let hasMessages = false;
      try {
        const st = fs.statSync(jsonl);
        // 文件 mtime 比 session.json 里的 lastModifiedAt 更实时
        mtimeMs = Math.max(mtimeMs, st.mtimeMs);
        size = st.size;
        hasMessages = true;
      } catch (_) {
        /*
         * 没有 messages.jsonl 的会话仍然列出（可能是刚建还没说话的）。
         * 但要记下这个事实：这类目录里有一部分其实是「同一会话在别的 workspace 下的
         * 元数据副本」，去重时必须优先保留有消息文件的那一份，见 dedupeSessions。
         */
      }

      const wsPaths = Array.isArray(meta.workspacePaths) ? meta.workspacePaths : [];
      items.push({
        sessionId: meta.id || path.basename(dir),
        dir,
        title: meta.title || '(未命名会话)',
        description: meta.description || undefined,
        agentMode: meta.agentMode || 'vibe',
        // status 是最后一次写入时的快照，不能当实时状态用（详见 liveState 注释）
        status: meta.status || 'unknown',
        // live 才是实时状态，前端只应依据它显示运行中 / 待确认
        live: this.liveState(jsonl),
        modelId: meta.modelId || undefined,
        autopilot: meta.autopilot === true,
        workspacePaths: wsPaths,
        workspaceName: wsPaths.length ? path.basename(wsPaths[0]) : '(无工作区)',
        createdAt: toEpoch(meta.createdAt),
        lastActiveAt: mtimeMs,
        bytes: size,
        hasMessages,
      });
    }
    // 先去重再排序：去重会改 workspacePaths，但不会改 lastActiveAt，顺序无所谓；
    // 放在排序前是因为排序后的数组更容易让人误以为「相邻的才可能重复」。
    const unique = dedupeSessions(items);
    unique.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    return unique;
  }

  /**
   * 从事件流末尾判断会话的实时状态。
   *
   * 只回读文件尾部若干 KB（seek 而非全量读），对最大 17MB 的会话也是常数开销。
   * 返回 'running' | 'waiting' | 'idle'。
   */
  liveState(jsonlPath) {
    let size;
    let mtimeMs;
    try {
      const st = fs.statSync(jsonlPath);
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch (_) {
      return 'idle';
    }
    if (size <= 0) return 'idle';

    const age = Date.now() - mtimeMs;
    /*
     * 这里原来有一句「文件静置超过 30 分钟就直接判 idle」的短路，为了省掉文件读取。
     * 它错在最要紧的场合：**agent 在等你审批时，文件本来就不动**。实测审批可以等
     * 607 分钟，于是一个正等着你的会话在列表上显示成灰色 idle —— 恰好把最需要被看见
     * 的状态藏了起来。
     *
     * 现在不看时间，只看内容。「等确认」由 pending_interaction 与 interaction_resolved
     * 是否成对来判定，这是确定性的，不需要猜。
     *
     * 保留的是**字节窗口**（只读尾部 TAIL_PROBE_BYTES）而不是时间窗口，这个区分是关键：
     * 真在等审批时 pending 就是最后写入的事件，一定落在尾部窗口里；而如果 agent 没等它、
     * 继续跑了（实测有一条这样的历史记录，pending 之后又写了 1.28MB），那个 pending
     * 会被推到窗口外，不会被误判成「正在等你」。
     *
     * 代价实测可忽略：35 个会话全部真读 16KB 尾部合计 3.16ms。
     */

    const readLen = Math.min(size, TAIL_PROBE_BYTES);
    let text = '';
    let fd;
    try {
      fd = fs.openSync(jsonlPath, 'r');
      const buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, readLen, size - readLen);
      text = buf.toString('utf8');
    } catch (_) {
      return 'idle';
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch (_) {
          /* ignore */
        }
      }
    }

    const lines = text.split('\n');
    // 回读起点可能落在某行中间，丢掉首行残片
    if (size > readLen) lines.shift();

    const events = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev && ev.payload) events.push(ev.payload);
      } catch (_) {
        /* 末尾可能是正在写入的半行 */
      }
    }
    if (!events.length) return 'idle';

    // 先收集已被回应的 toolCallId，再判断是否还有悬着的确认请求
    const resolved = new Set();
    for (const p of events) {
      if (p.type === 'interaction_resolved' && p.toolCallId) resolved.add(p.toolCallId);
    }
    for (let i = events.length - 1; i >= 0; i--) {
      const p = events[i];
      if (p.type === 'pending_interaction' && p.toolCallId && !resolved.has(p.toolCallId)) {
        return 'waiting';
      }
      // 回应之后的事件才有意义，遇到 turn_end 就说明这一轮已经收尾
      if (p.type === 'turn_end') break;
    }

    if (age > RUNNING_WINDOW_MS) return 'idle';

    // 末尾若还没出现 turn_end，说明这一轮仍在进行
    for (let i = events.length - 1; i >= 0; i--) {
      const t = events[i].type;
      if (t === 'turn_end') return 'idle';
      if (t === 'turn_start' || t === 'assistant' || t === 'tool_call' || t === 'tool_result') {
        return 'running';
      }
    }
    return 'idle';
  }

  /**
   * 由 sessionId 找到它的目录。
   *
   * 原来的写法对经过的**每一个**目录都读一次 session.json，于是查一个会话要解析
   * O(它在枚举里的位置) 个 JSON 文件 —— 而 tail 每 900ms 就要查一次（现在还要按
   * 被关注的会话数各查一次）。实测 36 个会话时单次约 3.3ms，其中大部分是这些
   * 无谓的 JSON 解析；会话只增不减，这个开销会一直长。
   *
   * 改动只有「把结果缓存下来」一件事，扫描逻辑一字不动。
   *
   * 刻意**不**改成「先把所有目录名扫一遍、再回头读 session.json」——那样看着更快，
   * 但会改变优先级：原实现是逐个目录先比目录名、再比 meta.id，所以一个「目录名不匹配
   * 而 meta.id 匹配」的靠前目录会胜过「目录名匹配」的靠后目录。两趟扫会把结果反过来。
   * 同一个 session id 确实会出现在多个 workspace 目录下（clean-empty-sessions 处理过
   * 这种情况），这里是决定「读哪个会话的历史」的地方，不值得为了快一点改语义。
   *
   * 缓存足够了：冷查一次照旧，之后每 900ms 的 tail 就都是一次 existsSync。
   */
  findSessionDir(sessionId) {
    if (!sessionId) return null;
    const cached = this.dirCache.get(sessionId);
    if (cached) {
      if (fs.existsSync(cached)) return cached;
      this.dirCache.delete(sessionId); // 目录已被删除或移动，重新找一遍
    }
    for (const dir of this.listSessionDirs()) {
      if (path.basename(dir) === sessionId) {
        this.dirCache.set(sessionId, dir);
        return dir;
      }
      const meta = safeReadJson(path.join(dir, 'session.json'));
      if (meta && meta.id === sessionId) {
        this.dirCache.set(sessionId, dir);
        return dir;
      }
    }
    return null;
  }

  /**
   * 解析一批原始事件行为前端可渲染的消息序列。
   * 连续的 assistant 片段合并成一条（IDE 是分段落写入的，平均 8 段/轮）。
   */
  static renderEvents(events) {
    const out = [];
    let pending = null;
    const flush = () => {
      if (pending) {
        out.push(pending);
        pending = null;
      }
    };

    for (const ev of events) {
      const p = ev && ev.payload;
      if (!p || !RENDERABLE.has(p.type)) continue;
      const ts = ev.timestamp || null;

      switch (p.type) {
        case 'assistant': {
          const text = typeof p.content === 'string' ? p.content : '';
          if (!text) break;
          // 思考（operationType=Reasoning）与正文（Say）必须分成两条：它们共享同一个
          // executionId，只按 executionId 合并会把内部推理和给用户的回答粘成一段。
          // operationType 是权威判据；reasoningSignature 只作为缺字段时的兜底。
          const isReasoning =
            p.operationType === 'Reasoning' ||
            (p.operationType === undefined && !!p.reasoningSignature);
          const kind = isReasoning ? 'reasoning' : 'message';
          if (
            pending &&
            pending.role === 'assistant' &&
            pending.kind === kind &&
            pending.executionId === p.executionId
          ) {
            pending.text += text;
            pending.ts = ts;
          } else {
            flush();
            pending = {
              kind,
              role: 'assistant',
              text,
              ts,
              // 折叠态要显示思考耗时，需要这一段的起点
              startTs: ts,
              executionId: p.executionId,
            };
          }
          break;
        }
        case 'user':
          flush();
          out.push({
            kind: 'message',
            role: 'user',
            text: typeof p.content === 'string' ? p.content : '',
            images: Array.isArray(p.images) ? p.images.length : 0,
            documents: Array.isArray(p.documents) ? p.documents.length : 0,
            ts,
          });
          break;
        case 'tool_call':
          flush();
          out.push({
            kind: 'tool',
            toolCallId: p.toolCallId,
            toolName: p.toolName,
            actionType: p.actionType,
            toolKind: p.kind,
            status: p.status,
            title: p.title || undefined,
            explanation:
              p.args && typeof p.args.explanation === 'string' ? p.args.explanation : undefined,
            preview: firstLine(JSON.stringify(p.args || {}), 200),
            ts,
          });
          break;
        case 'tool_result':
          flush();
          out.push({
            kind: 'toolResult',
            toolCallId: p.toolCallId,
            success: p.success !== false,
            durationMs: p.durationMs,
            preview: firstLine(p.content, 200),
            ts,
          });
          break;
        case 'pending_interaction':
          flush();
          out.push({
            kind: 'pending',
            interactionType: p.interactionType,
            toolCallId: p.toolCallId,
            question: p.question,
            options: Array.isArray(p.options) ? p.options : [],
            ts,
          });
          break;
        case 'interaction_resolved':
          flush();
          out.push({
            kind: 'resolved',
            toolCallId: p.toolCallId,
            outcome: p.outcome,
            selectedOption: p.selectedOption,
            ts,
          });
          break;
        case 'turn_start':
          flush();
          out.push({ kind: 'turnStart', executionId: p.executionId, ts });
          break;
        case 'turn_end':
          flush();
          out.push({ kind: 'turnEnd', stopReason: p.stopReason, executionId: p.executionId, ts });
          break;
        case 'session_metadata':
          if (p.key === 'contextUsage' && p.value && typeof p.value.usagePercentage === 'number') {
            flush();
            out.push({ kind: 'context', usagePercentage: p.value.usagePercentage, ts });
          } else if (p.key === 'displayError') {
            flush();
            out.push({ kind: 'error', text: firstLine(JSON.stringify(p.value), 300), ts });
          }
          break;
        case 'session_event':
          flush();
          out.push({
            kind: 'sessionEvent',
            category: p.category,
            status: p.context && p.context.status,
            ts,
          });
          break;
        case 'usage_summary':
          flush();
          out.push({ kind: 'usage', status: p.status, elapsedTime: p.elapsedTime, ts });
          break;
        case 'sub_agent_start':
          flush();
          out.push({ kind: 'subAgent', phase: 'start', name: p.subAgentName, ts });
          break;
        case 'sub_agent_complete':
          flush();
          out.push({
            kind: 'subAgent',
            phase: 'complete',
            status: p.status,
            error: p.errorMessage || undefined,
            ts,
          });
          break;
        case 'tombstone':
          // 会话被清理/压缩的分界。不删除既有内容，只插一条分隔标记。
          flush();
          out.push({ kind: 'tombstone', tombstoneKind: p.kind, ts });
          break;
        default:
          break;
      }
    }
    flush();
    return out;
  }

  /** 读整个会话历史；tailLimit 只保留最后 N 条渲染消息 */
  /**
   * 读会话历史。只回读文件尾部足够的字节，而不是整份读进来。
   *
   * 为什么要这样：实测 35 个真实会话共 107MB，全量读的耗时中位 14.8ms、p90 39.6ms、
   * 最大 69.8ms，17/35 会超过一帧（16ms）—— 而这是同步调用，期间扩展宿主完全阻塞，
   * 触发它的只是手机上点一下会话。耗时随文件线性增长，没有上界。
   *
   * 正确性依据：renderEvents 是一次流式折叠，只有局部状态（按 executionId 合并相邻的
   * assistant 片段），不依赖文件开头的任何东西。所以从中间开始读是安全的，只要处理好
   * 两个边界：
   *   1. 窗口起点可能落在某行中间 —— 总是从 start-1 读起并跳过第一个换行，
   *      这样即使起点正好是记录边界也不会多丢一条。
   *   2. 窗口起点可能切断一个合并组，使窗口里的**第一条**消息比全量读时短。
   *      所以要求窗口产出严格多于 tailLimit 条，让受影响的那条被 slice 掉；
   *      不够就把窗口翻倍重来，最坏退化成全量读（与旧行为一致）。
   */
  readHistory(sessionId, tailLimit = 400) {
    const dir = this.findSessionDir(sessionId);
    if (!dir) return { sessionId, found: false, messages: [] };
    const meta = safeReadJson(path.join(dir, 'session.json')) || {};
    const jsonl = path.join(dir, 'messages.jsonl');

    let size = 0;
    try {
      size = fs.statSync(jsonl).size;
    } catch (_) {
      /* 没有 messages.jsonl，下面按空历史处理 */
    }

    let messages = [];
    let fromStart = true;
    if (size > 0) {
      let window = Math.max(1, this.historyWindow || HISTORY_WINDOW_BYTES);
      for (;;) {
        const start = Math.max(0, size - window);
        // 起点非 0 时多读 1 字节，用来判断起点前面是不是换行
        const readFrom = start > 0 ? start - 1 : 0;
        let chunk = '';
        let fd;
        try {
          fd = fs.openSync(jsonl, 'r');
          const buf = Buffer.alloc(size - readFrom);
          fs.readSync(fd, buf, 0, buf.length, readFrom);
          chunk = buf.toString('utf8');
        } catch (_) {
          break;
        } finally {
          if (fd !== undefined) {
            try {
              fs.closeSync(fd);
            } catch (_) {
              /* ignore */
            }
          }
        }
        if (readFrom > 0) {
          // 跳到第一个换行之后，保证从完整记录开始
          const nl = chunk.indexOf('\n');
          chunk = nl < 0 ? '' : chunk.slice(nl + 1);
        }
        fromStart = start === 0;
        const events = [];
        for (const line of chunk.split('\n')) {
          if (!line.trim()) continue;
          try {
            events.push(JSON.parse(line));
          } catch (_) {
            /* 跳过写入中途的半行 */
          }
        }
        messages = SessionStore.renderEvents(events);
        // 严格大于：多出来的那条用于吸收「窗口起点切断合并组」的误差
        if (fromStart || messages.length > tailLimit) break;
        /*
         * 按实测密度估算下一个窗口，而不是盲目翻倍。
         *
         * 实测 18 个够 400 条的会话，所需回读字节中位 1383KB、最大 8147KB，一半超过 1MB。
         * 盲目 ×4 会让「需要 4.5MB」的会话依次读 1MB→4MB→16MB，解析量是下限的近 5 倍。
         * 用密度估一次通常一步到位。乘 2 是留余量，并强制至少翻倍以保证收敛。
         */
        const perMsg = messages.length > 0 ? window / messages.length : window;
        const guess = Math.ceil(perMsg * (tailLimit + 1) * 2);
        window = Math.max(window * 2, guess);
        if (window >= size) window = size;
      }
    }

    // 游标记到文件真实末尾，后续 tail 只读新增字节（与是否回读无关）
    this.cursors.set(jsonl, size);
    const truncated = !fromStart || messages.length > tailLimit;
    if (messages.length > tailLimit) messages = messages.slice(-tailLimit);
    return {
      sessionId: meta.id || sessionId,
      found: true,
      title: meta.title,
      agentMode: meta.agentMode,
      status: meta.status || 'unknown',
      live: this.liveState(jsonl),
      modelId: meta.modelId,
      workspacePaths: Array.isArray(meta.workspacePaths) ? meta.workspacePaths : [],
      truncated,
      messages,
    };
  }

  /**
   * 只读地查这个会话里**已经有结局**的授权请求，返回 toolCallId -> {outcome, selectedOption}。
   *
   * **刻意不复用 readHistory / tail —— 那两个都会把增量游标推到文件末尾。**
   * 而「这个请求还活不活」是一次查询，绝不该有副作用：一次查询吃掉一批尚未处理的信号，
   * 正是「电脑上批过了、手机上授权框还反复弹回来」那个 bug 的成因 ——
   * readHistory 把游标推到末尾之后，夹在中间的 interaction_resolved 再也不会被 tail 看到，
   * 于是那条记录永远算「未处理」，每次打开会话都被重放一次。
   *
   * 只读尾部窗口，所以**查不到不等于没有结局**（可能落在窗口外）。调用方要把
   * 「查不到」当成「不确定」，不能当成「确认还活着」。
   */
  resolvedOutcomes(sessionId, maxBytes = RESOLVE_PROBE_BYTES) {
    const out = new Map();
    const dir = this.findSessionDir(sessionId);
    if (!dir) return out;
    const jsonl = path.join(dir, 'messages.jsonl');
    let size = 0;
    try {
      size = fs.statSync(jsonl).size;
    } catch (_) {
      return out;
    }
    if (size <= 0) return out;

    const readLen = Math.min(size, maxBytes);
    let text = '';
    let fd;
    try {
      fd = fs.openSync(jsonl, 'r');
      const buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, readLen, size - readLen);
      text = buf.toString('utf8');
    } catch (_) {
      return out;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch (_) {
          /* ignore */
        }
      }
    }

    const lines = text.split('\n');
    // 回读起点可能落在某行中间，丢掉首行残片
    if (size > readLen) lines.shift();
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch (_) {
        continue; // 末尾可能是正在写入的半行
      }
      const p = ev && ev.payload;
      if (!p || p.type !== 'interaction_resolved' || !p.toolCallId) continue;
      out.set(p.toolCallId, {
        outcome: p.outcome || 'resolved',
        selectedOption: p.selectedOption || null,
      });
    }
    return out;
  }

  /**
   * 增量读取：只解析自上次游标之后新写入的字节。
   * 文件被截断（size < cursor）时从头重读，避免错位。
   */
  tail(sessionId) {
    const dir = this.findSessionDir(sessionId);
    if (!dir) return { sessionId, messages: [] };
    const jsonl = path.join(dir, 'messages.jsonl');
    let size;
    try {
      size = fs.statSync(jsonl).size;
    } catch (_) {
      return { sessionId, messages: [] };
    }
    const prev = this.cursors.get(jsonl);
    if (prev === undefined || size < prev) {
      const full = this.readHistory(sessionId);
      return {
        sessionId, reset: true, messages: full.messages,
        status: full.status, live: full.live,
      };
    }
    if (size === prev) return { sessionId, messages: [] };

    let chunk = '';
    let fd;
    try {
      fd = fs.openSync(jsonl, 'r');
      const buf = Buffer.alloc(size - prev);
      fs.readSync(fd, buf, 0, buf.length, prev);
      chunk = buf.toString('utf8');
    } catch (_) {
      return { sessionId, messages: [] };
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch (_) {
          /* ignore */
        }
      }
    }

    // 末尾可能是半行（IDE 正在写），留到下次；游标只推进到最后一个完整换行
    const lastNl = chunk.lastIndexOf('\n');
    if (lastNl < 0) return { sessionId, messages: [] };
    const complete = chunk.slice(0, lastNl);
    this.cursors.set(jsonl, prev + Buffer.byteLength(complete, 'utf8') + 1);

    const events = [];
    for (const line of complete.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch (_) {
        /* ignore */
      }
    }
    const meta = safeReadJson(path.join(dir, 'session.json')) || {};
    return {
      sessionId,
      status: meta.status || 'unknown',
      live: this.liveState(jsonl),
      messages: SessionStore.renderEvents(events),
    };
  }

  /**
   * 全局状态。依据 live 而非 status —— 用 status 会把几周前中断的会话算成运行中。
   * 有会话在等确认时优先报 waiting，那是唯一需要用户立刻介入的情形。
   */
  aggregateStatus(sessions) {
    const list = sessions || this.listSessions();
    let running = 0;
    let waiting = 0;
    let newest = 0;
    let activeTitle;
    for (const s of list) {
      if (s.live !== 'running' && s.live !== 'waiting') continue;
      if (s.live === 'running') running++;
      else waiting++;
      if (s.lastActiveAt > newest) {
        newest = s.lastActiveAt;
        activeTitle = s.title;
      }
    }
    const state = waiting > 0 ? 'waiting' : running > 0 ? 'running' : 'idle';
    return { state, running, waiting, activeTitle };
  }
}

// dedupeSessions 导出供测试：它是纯函数，直接喂构造好的 item 比在磁盘上造两个
// workspace 目录快得多，也不用改 HOME（SESSIONS_ROOT 在 require 时就固定了）。
module.exports = { SessionStore, SESSIONS_ROOT, dedupeSessions };
