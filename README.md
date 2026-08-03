# Kiro Remote Bridge

在手机浏览器里浏览和操作**本机 Kiro IDE** 的 agent 会话：看会话列表与历史、跟着流式思维链、发消息、新建会话。

一个 VS Code 扩展 + 一个自带的手机端页面。零运行时依赖，只用 Node 标准库。

## 先说清楚这是什么

我不是技术出身，是个产品经理。这个东西是为了解决我自己的一个痛点：agent 在我电脑上跑长任务，我想离开桌子但又不想失去对进度的可见性。做出来之后在公司和校园网这类局域网环境下刚好够用，就整理出来分享给同事，希望能帮上忙。

**几件必须提前说的：**

- **代码的严谨程度我没有能力负责。** 大部分实现是我和 AI 一起完成的，测试写了 294 条、也逐个跑通了，但那不等于没有设计缺陷或安全漏洞。**装之前请自己审计一遍代码**，尤其是 `src/relay.js`（对外的 HTTP/WebSocket 入口）和 `src/extension.js`（权限响应逻辑）。文件不多，全部只用 Node 标准库，没有第三方依赖，读起来不费劲。
- **这个服务会打开一个能驱动你 agent 的入口。** 拿到访问 URL 的人可以看你全部会话历史、发消息、批准工具调用 —— 也就是能让你的机器执行命令。请务必读完[安全说明](#安全说明)再决定。
- **只在 macOS + 局域网下验证过。** 出了这个范围我不知道会怎样。
- **欢迎提建议、也欢迎直接改。** 你 fork 过去改成自己的样子完全没问题（MIT）。发现问题告诉我，或者直接提 PR，我都很感谢。

> 另有几个明确的已知限制，见[已知限制](#已知限制)。版本历史见 [CHANGELOG](./CHANGELOG.md)。

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
- **能在手机上批准工具调用** —— 四个选项（Allow / Always allow / Deny / Always deny）逐个显示，点哪个就提交哪个；实机验证通过
- **等审批不会自己作废** —— 有审批就一直等你，行为与电脑端一致；等确认的会话在列表上是琥珀色「待确认」并排到最前
- **一致性门禁** —— 294 个测试，含审批链路端到端验证与 UI 一致性检查（DOM id / CSS class / 前后端消息类型双向对齐 / 解析器 kind 与渲染分支对齐）

## 快速开始

需要 macOS + Kiro IDE。（只在 macOS 上验证过；代码本身没有平台假设，但安装脚本里的路径是 macOS 的。）

```bash
git clone https://github.com/AMMPNK/kiro-remote-bridge.git
cd kiro-remote-bridge

# 打包
node scripts/package.js

# 安装（推荐走官方 CLI，会写入完整 metadata）
# 版本号从 package.json 取，这样这条命令不会因为发了新版就过时
"/Applications/Kiro.app/Contents/Resources/app/bin/code" --force \
  --install-extension "dist/local.kiro-remote-bridge-$(node -p "require('./package.json').version").vsix"
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

**远程批准工具调用已经可用（0.7.0 起，实机验证通过）。** 这一条从项目第一版起一直写着「不可用」，0.7.0 定位到根因并修好了。

手机上弹出授权框，四个选项（Allow / Always allow / Deny / Always deny）逐个显示，点哪个就把那个 `optionId` 原样提交。实机验证：点 `Always allow` → 4.9 秒后 `outcome=selected`、`selectedOption=always-accept`，工具正常执行并返回数据。

<details>
<summary>根因与定位过程（值得留着，因为前两轮都错了）</summary>

**根因**：此前所有版本都在用错的提交机制 —— bridge 回 JSON-RPC 应答，而 Kiro 的 mux 给每个客户端标了 role，**observer 的 permission 应答会被直接丢弃**。产物里的日志字符串就是答案：

```
discarded observer permission response ... (waiting for _kiro/permission/respond)
```

只有 `primary`（拥有会话的桌面面板）的应答才转发给 agent，而 bridge 是 observer。正确做法是调 `_kiro/permission/respond`，参数 `{ toolCallId, optionId, sessionId }`（形状照 Kiro 自己的两处调用抄）。

**为什么错了两轮**：前两轮都在统计历史数据，而那 183 次审批**全是从电脑上批的** —— 「从手机批」这个动作在样本里出现过零次。拿一份不含目标现象的数据做了两轮精细统计，精细本身成了错的来源。第三轮直接读产物实现，二十分钟就找到了。

**真正的破案钥匙是耗时，不是 outcome**。同一个会话里三种结局并列：

| 耗时 | 结局 | 含义 |
| --- | --- | --- |
| 0.0s | `cancelled` | 无 handler，直接返回默认值 |
| 305.2s | `cancelled` | 有 handler 在等，但收不到我们的响应 → 超时（产物里 `300 * 1e3`） |
| 4.9s | `selected` | 修复后，手机批准落地 |

前两者的 `outcome` 字段一模一样，只有耗时能区分，而两者的修法完全不同。

**为什么 30 条测试全绿却没抓到**：它们钉的是旧契约（应答形状符合 ACP 规范、requestId 正确）。那个形状完全正确，只是送错了通道 —— 而假的 mux connection 对任何应答都返回成功，所以这个验证在原理上就不可能发现「mux 会按 role 丢弃它」。

</details>

**`user_input` 类型的交互还不能在手机上回答。** 就是「Build a Feature / Fix a Bug」那种选择题，目前只渲染成待确认卡片、没有按钮。产物里有对应的 `_kiro/userInput/respond`（形状 `{ toolCallId, action, answer }`），通道是通的，只是还没接。

**模型清单在首次使用时不完整。** `_kiro/config/template` 在结构上不返回模型列表（它把 `currentModelId` 传成 `undefined`，模型项整条被省略）。全量清单只出现在 `session/new` 与 `session/set_config_option` 的返回里，所以本项目见到一次就缓存下来。后果是：**第一次打开模型选择时只有你用过的模型**，从手机新建一次会话之后才完整。降级级别会写进日志（`[presets] ... 来源 agent|cache|history`）。


## 安全说明

> **0.7.0 起 token 的权力变大了，请重新评估。** 在此之前远程批准工具调用是坏的，所以拿到 token 最多能看历史和发消息。现在批准能生效了 —— **持有 token 就等于能让这台机器执行命令**，而工具审批本来是最后一道闸门。如果你之前按「只能看」来评估风险，请按这一条重新判断。

- 中继**默认监听 `0.0.0.0`**，即同一局域网内可达。不要在不可信网络（公共 WiFi、共享办公网）里开着。
- **手机上点 `Always allow` 是永久授权，行为与电脑一致（0.7.1 起）。** 它会写进 `~/.kiro/settings/permissions.yaml`，之后那类调用不再询问 —— **在手机上误点一下的后果和在电脑上一样重**，而撤销要手工编辑那个文件，手机上做不到。

  刻意不加二次确认，因为 Kiro 已经在上游判断过了：`Always allow` 只在允许永久授权时才出现在选项列表里（`askType === "explicit"` 的请求根本不给这个选项）。所以你能点到它，就说明 Kiro 认可这次可以持久化；在这之上再加一层拦截，该生效时是多余的、不该生效时反而会砍掉本来允许的能力。

  0.7.0 及更早版本这里的行为是「只对当前会话生效」，当时 README 把它写成了一条限制 —— 其实只是少传了 `_meta.kiro.consent.scope` 这一个字段。
- **审批的实际破坏力取决于你的 `permissions.yaml`。** 那份白名单是历史上一路点「Always allow」攒出来的，很容易长到上百条并包含 `rm`、`bash`、`curl`。开这个服务之前建议先看一眼：`Kiro Bridge` 用不到它，但 agent 用得到。命令面板里的 `Kiro: Open Permissions (User)` 能直接打开。
- 鉴权是 URL 里的 token，43 字符随机生成，**持久化在 `~/.kiro-bridge/relay-token.json`（权限 0600）**。持久化是为了让「人在外面、机器重启一次」不至于永久失联；代价是泄露后长期有效，所以怀疑泄露就执行 `Kiro Bridge: 轮换访问 token`（旧链接立即失效，手机需重新扫码）。
- 二维码与访问地址里含 token，不要截图外发。
- `~/.kiro-bridge/` 目录权限 0700，里面所有文件 0600。这里会有会话标题、工作区绝对路径、mux token，敏感度按最高的那份对待。
- **扩展在你执行「启动远程会话」之前不会连接 agent，也不写任何文件。** 曾经有一段激活后无条件跑的只读探测（连全部 mux、发 4 个 RPC、把 mux token 落盘），现在收在 `kiroBridge.debugProbeOnStartup` 开关下，默认关闭。需要排障时打开它，或直接用 `Kiro Bridge: 探测 agent 方法` 命令跑一次。
- 静态资源做了路径穿越防护；外壳页可无 token 加载，但不含任何会话数据。

## 在公司或学校网络里用之前

这一节是给同事的。上面的安全说明讲的是「这个工具本身有多大权限」，这一节讲「你所在的环境允许不允许」—— 后者我没法替你判断。

- **明文 HTTP，没有 TLS。** 会话历史里有你的代码、文档内容、工作区绝对路径，这些会以明文经过局域网。在受管控的公司网络里这可能本身就是个合规问题，值得先问一下。
- **会开一个监听 `0.0.0.0` 的端口（默认 3939）。** 有些公司的终端安全策略会拦、会告警、或者干脆不允许。
- **同一网络下的其他人只要拿到 URL 就能进。** 鉴权只有 URL 里那个 43 字符 token，没有设备绑定、没有二次确认。共享办公网、教学楼 WiFi 这类环境要特别小心。
- **不建议为了远程访问去开公网隧道。** 理由见[出门在外怎么用](#出门在外怎么用)。如果要跨网络，组网（Tailscale / ZeroTier）比暴露端口安全得多 —— 但装第三方组网工具本身在很多公司也是要报备的。
- **Tailscale 打不通直连时会走 DERP 中继**，流量端到端加密，但链路会经过第三方服务器。如果你的数据不允许出境或经过外部设施，这一点要先确认。

我的实际用法是：公司内网 + 只在需要离开工位时开着 + 用完执行 `Kiro Bridge: 停止远程会话`。**不建议让它长期挂着。**

## 开发

```bash
node test/run-all.mjs        # 全量测试（294 项）
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

## 反馈与贡献

- 有问题或建议，开一个 [Issue](https://github.com/AMMPNK/kiro-remote-bridge/issues) 就好，说清你的环境（Kiro 版本、macOS 版本、手机浏览器）会更容易定位。
- 想直接改的话，PR 我都会看。本地跑一下 `node test/run-all.mjs` 确认 294 条全绿即可，没有别的要求。
- 如果你把它 fork 去做成自己的版本，完全欢迎，不用告诉我 —— MIT 许可，拿去用就是了。

再重复一次开头那句：**代码的严谨程度我没有能力负责，装之前请自己审计。** 如果你看出问题，尤其是安全上的，麻烦告诉我一声。

## License

[MIT](./LICENSE)
