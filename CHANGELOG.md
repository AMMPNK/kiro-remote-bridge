# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

> 0.1.2 及更早的版本在本文件建立之前，未逐条记录。

## [0.2.0]

### 新增

- **正文也走实时流。** 此前只有思考是流式的，正文靠文件 tail 约 1 秒一批，两者体验割裂。
  现在同时消费 `agent_message_chunk`。
  实现要点：原始文本累积在 `data-raw` 上、每次整体重渲染 —— markdown 标记会被切在两个
  增量之间（`**粗` + `体**`），逐块追加 HTML 会渲染成字面的 `**粗体**`。

### 修复

- **手机新建的会话，审批请求会在 6~20ms 内被取消。** 根因在 ACP SDK：`requestPermission`
  按 sessionId 找 handler，**找不到就直接返回 `cancelled`**（源码注释原文
  "defaults to cancelled if no handler"），而 handler 由拥有该会话的桌面面板通过
  `onPermissionRequest(sessionId, …)` 注册。纯靠 mux 创建的会话没有面板拥有它，于是无
  handler、立即取消。
  现在新建会话后调用 `kiroAgent.viewSession` 让桌面 attach —— Kiro 自己的程序化建会话
  流程也是先 viewSession 再发 prompt。代价是桌面侧边栏会切到该会话。
  **只在新建时调用**，不在打开已有会话时调用：那会把你在电脑上正在用的会话挤掉，反而
  弄坏本来正常的审批。
- **订阅在 mux 重连后会静默失效。** 订阅是连接级的，重连或扩展重启后就没了，而手机端不
  一定会重新发 `session:open`。表现是「本来能收到审批，过一会儿又收不到」，且没有任何
  报错。现在每轮列表轮询核对一次 `{sessionId, port}`，端口变了（说明重连过）就重新订阅。

### 已知限制

打开一个「历史上由手机创建、桌面从未打开过」的会话时，审批仍可能被立即取消 —— 因为不会
为它调用 `viewSession`（避免挤掉你正在用的会话）。绕过办法：在电脑上打开该会话一次。

## [0.1.9]

### 修复

- **电脑侧发起的会话，在手机上收不到授权框，也没有流式思维链。** 根因：agent 只把
  `session/request_permission` 与 `session/update` 发给**已订阅该会话**的客户端，而
  `session:open` 只读本地文件、从不与 mux 交互，所以桥从未订阅过这些会话。手机上看到的
  「待确认」只是从会话文件读出的历史卡片，没有按钮。
  现在打开会话时会用该 sessionId 发一个只读的 `_kiro/session/history`（limit=1）请求。
  Kiro 的实现里，任何带 sessionId 的请求都会 `subscribeToSession`，并在此前未订阅时补发
  `resendPendingPermissions` / `resendPendingUserInputs` —— 所以已经挂起的审批也会被重新发来。

### 说明

此前记录的「权限请求在 6–130ms 内被自动取消」只在**桥自己创建的会话**里成立，不是普遍行为：
实测电脑侧会话的审批请求可存活 100 秒以上并正常批准。桥创建会话时的取消是另一个问题，
机制尚未查清，仍在跟踪。

## [0.1.8]

为「出门在外用」做准备。这两项不做的话，任何远程访问方案都会在第一次重启后失效。

### 新增

- 访问 token 持久化到 `~/.kiro-bridge/relay-token.json`（权限 0600）。此前 token 每次启动随机生成，而它只出现在电脑屏幕上的二维码里 —— 人在外面时只要扩展重新激活（重载窗口、Kiro 重启、睡醒后激活），就再也拿不到新地址，等于永久失联。
- 新命令 `Kiro Bridge: 轮换访问 token`，用于兜住持久 token 的泄露风险：作废旧 token 并重启中继。
- 中继运行期间调用 `caffeinate -i` 抑制空闲休眠，停止与 deactivate 时释放。**注意它阻止不了合盖休眠**，文档中已如实说明。
- README 增加「出门在外怎么用」：推荐组网（Tailscale / ZeroTier）而非公网隧道，并说明原因与前提条件。

## [0.1.7]

### 修复

- 模型清单不完整：`_kiro/config/template` 在结构上不返回模型项（内部把 `currentModelId` 传成 `undefined`，模型 select 整条被省略），导致取值静默退回「历史里用过的模型」。现在从 `session/new` 与 `session/set_config_option` 的返回里捕获全量清单并落盘缓存，取值改为三级阶梯 `agent → cache → history`，每级都标 `source` 并写日志。
- 默认模型不再自己编造，取自缓存下来的真实响应。

## [0.1.6]

### 新增

- 流式思维链：消费 mux 的 `agent_thought_chunk` 增量。此前该增量已被广播为 `muxUpdate`，但前端从未处理，收到即丢弃。
- 实时内容作为临时占位，权威内容（文件 tail）到达后替换，避免同一段思考重复出现。

### 修复

- 思考块不会自动折叠：原判据是「是否为最后一个 live 的思考块」，导致最近那块一直展开到下一次思考出现。改为「它后面是否还有内容」。
- UI 一致性门禁「后端广播的类型前端都处理了」失效：该检查原本拿一份**手写数组**当后端类型清单，新增 `muxUpdate` 时无人同步，于是静默放行。改为从 `src/extension.js` 与 `src/relay.js` 直接提取，新类型默认必须被处理；豁免项需登记理由。

## [0.1.5]

### 新增

- 思考块改为流式展开、结束后自动折叠，标签 `Thinking…` / `Thought complete`。
- 内联 Markdown 渲染：`**加粗**` 与 `` `行内代码` ``（先转义再替换，标记只可能来自 Markdown 语法）。

### 修复

- 连续助手片段的合并改用 `innerHTML`：原先用 `textContent` 会把 `<strong>` / `<code>` 标记抹平。
- 用户消息气泡提高对比度，在深色背景下可辨。

## [0.1.4]

### 新增

- 思考与正文分离：按 `operationType`（`Reasoning` / `Say`）拆成两类。二者共享 `executionId`，此前只按 `executionId` 合并会把内部推理和给用户的回答粘成一段。
- 思考默认折叠，复用工具卡片的折叠交互。

## [0.1.3]

### 修复

- `session/prompt` 不再使用 30 秒默认超时。该请求要等整个回合结束才返回，超时会把「已送达且正在处理」误报成发送失败，并因降级重发撞上 `A prompt is already in-flight`。改为只观察短时间内是否回错误。
- 权限响应在找不到 `allow` 选项时不再回一个缺 `optionId` 的 `selected`（协议上无效，agent 侧会当取消处理，而手机端显示「已回应」）。改为显式报错。
- 手机端不再对已被取消的权限请求显示有效授权框：结局到达后自动关闭并说明「该请求已被取消，批准未生效」。
