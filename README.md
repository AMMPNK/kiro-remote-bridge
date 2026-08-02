# Kiro Remote Bridge

在手机浏览器里浏览和操作**本机 Kiro IDE** 的 agent 会话：看会话列表与历史、跟着流式思维链、发消息、新建会话。

一个 VS Code 扩展 + 一个自带的手机端页面。零运行时依赖，只用 Node 标准库。

> 状态：能日常用，但有几个明确的已知限制，见[已知限制](#已知限制)。请先读那一节再决定要不要装。

## 为什么会有这个东西

官方 [Kiro for iOS](https://kiro.dev/mobile/) 连的是**云端**会话。而很多人的实际用法是：agent 跑在自己那台开着 IDE 的机器上，跑长任务时人想离开桌子，又不想失去对进度的可见性。Kiro 仓库里也有针对远程控制的讨论（[kirodotdev/Kiro#6099](https://github.com/kirodotdev/Kiro/issues/6099)）。

这个项目解决的是后者：**把本机 IDE 里正在跑的会话搬到手机上看**，不需要云端会话，也不需要把机器暴露到公网。

## 特性

- **直连 agent，不模拟 UI** —— 走 Kiro 的 agent mux server（ACP over WebSocket），不截屏、不注入 IDE 前端
- **流式思维链** —— 消费 `agent_thought_chunk` 增量，思考逐块长出来，跑完自动折叠成 `Thought complete`
- **双数据源分层降级** —— 会话列表与历史读 `~/.kiro/sessions`，发消息与批准走 mux；一层不可用不会让另一层失效
- **零运行时依赖** —— WebSocket 服务端、二维码编码器都是手写的，只用 Node 标准库
- **可以传文件** —— 图片、文本、二进制都能带上；图片在手机侧先缩边，附件预算按服务端握手时报来的真实帧上限算
- **能从手机停掉跑偏的回合** —— 正在跑时发送键换成停止键，走 `session/cancel`
- **扫码即用** —— 局域网内扫二维码打开，带 token 鉴权
- **等审批不会自己作废** —— 有审批就一直等你，行为与电脑端一致；等确认的会话在列表上是琥珀色「待确认」并排到最前
- **一致性门禁** —— 251 个测试，含审批链路端到端验证与 UI 一致性检查（DOM id / CSS class / 前后端消息类型双向对齐 / 解析器 kind 与渲染分支对齐）

## 快速开始

需要 macOS + Kiro IDE。（只在 macOS 上验证过；代码本身没有平台假设，但安装脚本里的路径是 macOS 的。）

```bash
git clone <your-repo-url> kiro-remote-bridge
cd kiro-remote-bridge

# 打包
node scripts/package.js

# 安装（推荐走官方 CLI，会写入完整 metadata）
"/Applications/Kiro.app/Contents/Resources/app/bin/code" \
  --install-extension dist/local.kiro-remote-bridge-<version>.vsix --force
```

然后在 Kiro 里重载窗口（命令面板 → `Developer: Reload Window`），再执行：

- `Kiro Bridge: 启动远程会话` —— 启动本地中继
- `Kiro Bridge: 显示访问地址与二维码` —— 用手机扫码打开

其他命令：`停止远程会话`、`轮换访问 token`、`运行自诊断`、`探测 agent 方法`、`显示日志`。

### 配置项

都在 Kiro 的 settings 里，前缀 `kiroBridge`。默认值可以直接用，不需要改。

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `port` | `3939` | 本地 relay 监听端口 |
| `bindLan` | `true` | 绑到局域网地址；关掉则只监听 `127.0.0.1`（手机就连不上了） |
| `autoStart` | `false` | IDE 启动后自动开启远程会话。多窗口时只有一个能抢到端口，其余会在日志里报启动失败 |
| `debugProbeOnStartup` | `false` | 激活后自动跑一次只读诊断并落盘（含 mux token）。仅排障用，见[安全说明](#安全说明) |

## 出门在外怎么用

默认只在局域网内可达（绑 `0.0.0.0`）。离开这个网络后，你的机器在 NAT 后面，手机连不上。

**推荐做法是组网，而不是把它暴露到公网**：装 [Tailscale](https://tailscale.com/)（或 ZeroTier），手机和电脑加入同一个 tailnet，然后用电脑的 tailnet 地址访问。**不需要改任何配置** —— 地址列表枚举所有非 internal 的网卡，Tailscale 的 `100.x.x.x` 会自动出现在二维码里。

为什么不推荐公网隧道（Cloudflare Tunnel / ngrok）：**这个服务能让持有 URL 的人驱动你的 agent 执行命令**。它有多大破坏力，取决于你 `~/.kiro/settings/permissions.yaml` 里放行了什么 —— 而那类白名单通常包含 `rm`、`bash`、`curl`。组网方案不产生公网入口，风险面小一个数量级。如果你确实要走公网，先自行补齐鉴权（一次性凭据、会话过期、设备绑定、审计日志），当前实现只有 URL token + 速率限制，且是明文 HTTP。

两个绕不开的前提：

- **机器不能睡。** 中继启动时会调 `caffeinate -i` 抑制空闲休眠，但**它阻止不了合盖休眠** —— 合上盖子且没接外接显示器/电源，系统照样会睡，远程访问随之中断。这是系统行为，不是本项目能绕开的。
- **Kiro 得开着。** 中继活在扩展进程里。

## 架构

```
手机浏览器  ──WebSocket(token)──>  relay（扩展内）
                                     │
                    ┌────────────────┴────────────────┐
                    │                                 │
            读 ~/.kiro/sessions              agent mux server
            （列表 / 历史 / tail）          （ACP over WebSocket）
            格式已实测确认                   发消息 / 权限响应 / 新建会话
```

两层各取确定可行的部分，任何一层不可用都不会让另一层失效，自诊断会把**实际生效的路径**写进日志。

思维链有两条通路，都用上了：

| 来源 | 用途 | 原因 |
| --- | --- | --- |
| mux `agent_thought_chunk` | 实时流式显示 | 逐块推送，能做到真流式 |
| `~/.kiro/sessions` tail | 权威内容与历史 | 实测思考是整块落盘的（跨度 0 秒），无法从文件做流式 |

实时内容只作为「正在思考」的临时占位，权威版本一到就替换掉，避免同一段思考出现两遍。

## 已知限制

**远程批准工具调用尚未确认可用。** 这一条此前写的是「不生效，因为请求已在 agent 侧被自动取消（实测 8 次全部在 6–130ms 内）」。把本机 183 次 `tool_approval` 全部翻出来核对之后，那个结论下得过早：

| 结局 | 次数 | 响应间隔 |
| --- | --- | --- |
| `selected`（人批了） | 173 | 中位 9.5 秒，p90 463 秒，最长 **607 分钟** |
| `cancelled`（被自动取消） | 10 | 6–130 毫秒 |

被瞬间取消的只占 **5.5%**，其余 173 次请求一直活着等人响应 —— 所以「请求已经死了」不是普遍情况。当初那 8 个样本恰好都落在被取消的那一类里。

但也**不能**因此说远程批准可用：那 173 次都是从电脑上批的，手机发出的响应到底能不能落地，仍然没有任何直接证据。桥现在会把这件事记进日志 —— 手机批准之后，一旦等到该请求的真实结局，就会打印

```
[approve] ★ 远程批准结果 toolCallId=… 手机请求=allow 实际结局=selected 间隔=…ms → 落地了
```

想确认能不能用，就从手机批一次，然后看 `Kiro Bridge: 打开日志` 里有没有这一行、以及它说落地还是没落地。

相关的三种失败会明确告诉你原因，而不是假装成功：请求已在别处被处理、已被取消、或超过 24 小时。

影响：**不在 shell 白名单里的命令，在手机上能不能放行取决于上面这件事**。白名单内的命令不受影响（不产生审批交互，直接执行）。想扩大可用范围，就往 `~/.kiro/settings/permissions.yaml` 里补命令。

**模型清单在首次使用时不完整。** `_kiro/config/template` 在结构上不返回模型列表（它把 `currentModelId` 传成 `undefined`，模型项整条被省略）。全量清单只出现在 `session/new` 与 `session/set_config_option` 的返回里，所以本项目见到一次就缓存下来。后果是：**第一次打开模型选择时只有你用过的模型**，从手机新建一次会话之后才完整。降级级别会写进日志（`[presets] ... 来源 agent|cache|history`）。

**只有思考走实时流。** 正文仍靠文件 tail，约 1 秒一批。

## 安全说明

- 中继**默认监听 `0.0.0.0`**，即同一局域网内可达。不要在不可信网络（公共 WiFi、共享办公网）里开着。
- 鉴权是 URL 里的 token，43 字符随机生成，**持久化在 `~/.kiro-bridge/relay-token.json`（权限 0600）**。持久化是为了让「人在外面、机器重启一次」不至于永久失联；代价是泄露后长期有效，所以怀疑泄露就执行 `Kiro Bridge: 轮换访问 token`（旧链接立即失效，手机需重新扫码）。
- 二维码与访问地址里含 token，不要截图外发。
- `~/.kiro-bridge/` 目录权限 0700，里面所有文件 0600。这里会有会话标题、工作区绝对路径、mux token，敏感度按最高的那份对待。
- **扩展在你执行「启动远程会话」之前不会连接 agent，也不写任何文件。** 曾经有一段激活后无条件跑的只读探测（连全部 mux、发 4 个 RPC、把 mux token 落盘），现在收在 `kiroBridge.debugProbeOnStartup` 开关下，默认关闭。需要排障时打开它，或直接用 `Kiro Bridge: 探测 agent 方法` 命令跑一次。
- 静态资源做了路径穿越防护；外壳页可无 token 加载，但不含任何会话数据。

## 开发

```bash
node test/run-all.mjs        # 全量测试（251 项）
node test/t8-ui-consistency.mjs   # 只跑 UI 一致性门禁
```

二维码测试（t4）会与 [`qrcode`](https://www.npmjs.com/package/qrcode) 逐版本对照。它是**仅用于测试的可选依赖**，不进产物：

```bash
cd test/ref && npm i
```

`media/qr.js` 是自己实现的编码器，`qrcode` 只作为校验基准。

## 致谢

灵感来自 [hopansh/kiro-remote](https://github.com/hopansh/kiro-remote)（MIT）—— 它先做出了「用手机控制本机 Kiro」这件事，本项目的产品形态（扫码接入、手机端浏览会话、远程审批）受它启发。

**代码是独立编写的**，几乎每一层的机制都不一样：

| | hopansh/kiro-remote | 本项目 |
| --- | --- | --- |
| 语言 | TypeScript | JavaScript，零运行时依赖 |
| 中继 | 独立的 relay-server 进程（含 npm 依赖） | 扩展进程内，手写 WebSocket 服务端 |
| 取会话数据 | 监听磁盘执行文件（chatWatcher / executionWatcher） | 直连 agent mux server，ACP over WebSocket |
| 工具审批 | 往 `.kiro/hooks/` 安装 hook 脚本 | 响应 ACP `session/request_permission` |
| 流式 | 正文实时流 | 思考走 `agent_thought_chunk` 实时流；正文约 1 秒一批 |
| 远程访问 | Cloudflare Tunnel + 推送通知 + PWA 离线 | 仅局域网 |
| 二维码 | 依赖库 | 手写编码器，测试中与 `qrcode` 逐版本对照 |

平心而论，对方在 Cloudflare Tunnel、推送通知、PWA 离线支持上更完整，**工具审批也确实是能用的**（走 hook 拦截点，绕开了本项目遇到的 ACP 权限请求被自动取消的问题）。本项目的侧重是直接说 ACP 协议、零依赖、以及把降级路径显式化。

同类项目还有 [Homas/kiro-telegram-integration](https://github.com/Homas/kiro-telegram-integration)，走 IM 转发通知与审批，目标相近而路子不同。

## License

[MIT](./LICENSE)
