# dshx

[![CI](https://github.com/ZoeHao2026/dshx/actions/workflows/ci.yml/badge.svg)](https://github.com/ZoeHao2026/dshx/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**English:** `dshx` is a Windows CLI that lets OpenAI Codex delegate a task to
DeepSeek Harness (DSH) without modifying Codex. It runs the official
`dsh --profile headless` entry, reuses the DeepSeek account sign-in already
stored by the DSH desktop app via a temporary overlay, and returns the final
answer on stdout. It also provides `continue`, JSON output, progress tracking,
and environment diagnostics.

`dshx` 是一个面向 **Codex** 的本机 CLI：Codex 在 PowerShell 里调用它，把任务交给
**DeepSeek Harness（DSH）** 执行；DSH 在 Codex 当前工作目录里读写文件、运行命令，
CLI 把最终答复返回给 Codex。

它刻意**不往 Codex 里加任何东西**：不改 `~/.codex`，不加 MCP、hooks、plugin、
AGENTS.md 或 `config.toml`。你只需要在 Codex 对话里粘贴一次 `dshx brief` 的输出，
让 Codex 知道有这个命令即可。

```
Codex (PowerShell)
  └─ dshx.cmd ask "..."            ← 一次性任务
       └─ node @deepseek-ai/dsh/lib/bin.js --profile headless ...
            └─ DSH agent（deepseek-account / deepseek-flash）
                 └─ 在同一个工作区读写文件、运行命令
       ← 最终答复（stdout）
```

## 为什么不是 MCP / hooks / SDK

- MCP、hooks、Codex plugin 都要改 Codex 配置，违背“不要往 Codex 里加东西”。
- 运行中的 DSH Desktop Host API 需要浏览器启动 token / 签名 cookie，是内部协议，
  不适合外部 CLI 复用。
- DSH 的 `sdk` profile 是长生命周期 stdio JSON-RPC 服务，需要自己管理 daemon、
  stdout 纯净和取消语义；对 Codex 的一次性 shell 调用过重。
- `dsh --profile headless` 是 DSH 官方为脚本/CI 提供的一次性入口：NDJSON 事件、
  稳定退出码、`--session-id` 续接，正好匹配 Codex 的 shell 工具。

`dshx` 直接驱动官方 headless 入口，不复制 DSH 的 Agent 实现。

## 安装

要求：

- Windows（v0.1 只支持 Windows PowerShell；WSL 原生 DSH 不在范围内）。
- Node `^22.19` 或 `>=24`；DSH CLI 版本在 `0.2.0-rc.2`、`0.2.1-rc.2`、
  `0.2.1-rc.3` 白名单内（其他版本需 `--allow-unvalidated-version`）。
- 已安装官方 DSH CLI：`npm i -g @deepseek-ai/dsh`（或桌面版自带的 CLI）。

克隆仓库并安装：

```powershell
git clone https://github.com/ZoeHao2026/dshx.git
cd dshx
npm install -g .
```

npm 会在 `%APPDATA%\npm` 生成 `dshx`、`dshx.cmd`、`dshx.ps1`。Codex 的 agent shell
是 Windows PowerShell；**请让 Codex 调用 `dshx.cmd`**，不要依赖不带扩展名的
`dshx`：PowerShell 可能优先命中 `.ps1`，在受限执行策略下会被 `PSSecurityException`
拦截。

开发时也可以：

```powershell
npm link
```

## 快速开始

```powershell
# 体检（不调用模型）
dshx.cmd doctor

# 只读 smoke test
dshx.cmd ask --permission-mode read-only "Reply with exactly OK. Do not use any tools."

# 新任务（默认 danger-full-access，与当前 Codex 线程一致）
dshx.cmd ask "Review the current diff and list concrete risks"

# 继续当前工作目录最近一次 dshx 会话
dshx.cmd continue "Now implement the highest-risk fix"

# 机器可读
dshx.cmd ask --json "Reply with exactly OK"

# 多行任务
@'
请阅读当前目录，完成……
'@ | dshx.cmd ask

# 查看 dshx 记录过的会话
dshx.cmd sessions
```

`dshx ask` 的 stdout 只放 DSH 的最终答复；过程信息、错误和 `--progress` 工具摘要走
stderr。`--json` 时 stdout 严格是一条 JSON，适合 Codex 解析。

## 告诉 Codex（粘贴一次）

运行：

```powershell
dshx.cmd brief
```

把输出原样粘贴到 Codex 对话即可。内容如下：

```text
你现在可以使用 dshx.cmd 这个本机 CLI，把任务交给 DeepSeek Harness (DSH) 执行。
DSH 是独立智能体，会在当前目录读写文件、运行命令，并返回最终答复。

- 新任务：dshx.cmd ask "<完整、自包含的任务说明>"
- 继续同一对话：dshx.cmd continue "<后续要求>"
- 多行任务（PowerShell）：
  @'
  ...完整任务...
  '@ | dshx.cmd ask
- 机器可读：dshx.cmd ask --json ...（stdout 是一条 JSON：ok/sessionId/text）
- 长任务加 --progress：stderr 会实时显示 turn/step/tool 摘要（不是逐 token）
- 先检查环境：dshx.cmd doctor；完整参数：dshx.cmd --help
- 默认全权访问（与当前 Codex 会话一致）；需要限制时加 --permission-mode workspace-write 或 read-only
- 退出码：0 成功，1 任务失败，2 用法，3 环境/登录不可用，4 协议错误，124 超时
- 给 DSH 完整上下文；不要在提示里放密钥；它和你共享工作区，避免同时改同一文件
- 如果提示登录不可用，不要循环重试；把错误告诉用户
- PowerShell 中请调用 dshx.cmd，不要依赖不带扩展名的 dshx（可能命中 .ps1）
```

这不会写入 Codex 的任何配置文件；它只是对话上下文。

## 实时跟踪

加 `--progress` 后，DSH 的 turn/step/tool 事件会立即写到 **stderr**，例如：

```text
dshx: [20:42:10] turn 1 started
dshx: [20:42:12] step 1 started
dshx: [20:42:15] tool write
dshx: [20:42:15] tool result completed
dshx: [20:42:19] turn ended: completed
```

这是**工具/步骤级**的实时摘要，不是逐 token 的文本流：DSH headless 的 `--json` 把
`text`/`thinking` 按提交步骤投影，不按 token 推送；`dshx` 默认也不把 thinking 灌进
Codex 上下文。最终答复仍然只在结束时写到 stdout。

Codex 的 `exec_command` 支持运行中 session/poll；如果它把 `--progress` 命令作为长任务
运行，就能在等待期间看到这些 stderr 行。命令完成后，Codex 拿到的仍是干净的最终答复。
不会实时同步到 DSH Desktop GUI：dshx 启动的是独立的 headless 会话。

## 认证与模型

默认复用 **DSH Desktop 已保存的 DeepSeek 账号登录**，不需要新的 API key：

- 每次运行生成一个临时 overlay，重新启用 headless profile 默认关闭的
  `credentials`、`authorization`、`deepseek-account` 三行；
- 把 `agent-default-model` 设为 `deepseek-account / deepseek-flash /
  reasoningEffort=max`，与桌面端默认一致；
- overlay 机制通过 `dsh --profile headless --patch <tmp> --dump-config` 校验；
  `dshx doctor` 与 `dshx ask --dry-run` 每次都会重新校验，常规运行直接使用生成结果；
- **不创建、不修改** DSH profile；headless profile 由 DSH 自己初始化。

已在本机验证：真实账号链路成功返回 `OK`，`continue` 成功返回 `DONE`，会话 id 一致。

账号不可用时的 fallback：

```powershell
# 在 DSH 能读到的位置提供 key（当前进程环境或 %USERPROFILE%\.dsh\.env）
$env:DEEPSEEK_API_KEY = 'sk-...'
dshx.cmd ask --provider deepseek-official "Reply with exactly OK"
```

注意：

- 账号路由与 API-key 路由互不回退；`--provider deepseek-official` 时需要 key。
- 桌面端登录如果过期，DSH 可能在 401 时清理共享 grant；首次验证使用隔离 DSH_HOME
  的副本，不会影响真实登录。真实运行前建议备份 `%USERPROFILE%\.dsh\.credentials.yaml`。
- `dshx doctor` 只检查 grant record 是否存在，不打印 token，也不代表 token 一定有效；
  `dshx doctor --live` 才会真实调用一次极短 prompt（会计费）。

## 权限与安全

默认：

- `--permission-mode danger-full-access`：DSH 拥有与当前用户相同的文件、网络、
  子进程能力；与 Codex 当前 `danger-full-access` 线程一致。
- 更安全的选择：`workspace-write`（工作区内写、越界/提权请求在 headless 中
  fail-closed）或 `read-only`。

```powershell
dshx.cmd ask --permission-mode workspace-write "..."
dshx.cmd ask --permission-mode read-only "..."
```

注意：

- DSH 是独立智能体，和 Codex 共享同一个工作区；不要并发修改同一文件。
- DSH session 会持久化到 `%USERPROFILE%\.dsh\sessions`；不要在 prompt 里放密钥。
- `danger-full-access` + prompt injection 可能造成越权文件/网络操作；处理不可信内容
  时优先 `workspace-write`/`read-only`。
- 在 Codex `workspace-write` 沙箱线程下，沙箱用户对 `~\.dsh`、`%APPDATA%\npm` 往往
  只有读权限，DSH 可能无法写 session/cache；v0.1 的目标运行模式是当前线程的
  `danger-full-access`，并使用 `dshx.cmd` 规避 `.ps1` 限制。

## 会话

- `ask` 每次创建新 headless 会话（DSH 生成 `session-<uuid>`）。
- `continue` 按 `cwd + DSH_HOME + profile` 选择最近一次成功的 dshx 会话，传
  `--session-id` 续接；没有记录时退出 3，提示先 `ask`。
- 显式续接：`dshx.cmd ask --session <id> "..."`。
- DSH 的恢复要求 cwd 完全一致、同 profile/preset；**GUI 桌面会话有 preset，不能通过
  dshx 续接**。dshx 只续接自己创建的 headless 会话。
- 记录在 `%USERPROFILE%\.dshx\sessions.jsonl`，只存 id/cwd/模型/权限/时间，不存 prompt。
- 如果 `continue` 发现会话不可恢复，会追加 tombstone，避免反复选中坏记录。
- 被截断的长答复全文保存在 `%USERPROFILE%\.dshx\runs\`。

## 命令参考

```text
dshx ask [options] [prompt...]        一次性任务（别名 run / -p）
dshx continue [options] [prompt...]   续接当前目录最近一次 dshx 会话
dshx sessions [--all] [--cwd DIR] [--profile NAME] [--limit N] [--json]
dshx doctor [--json] [--live]
dshx brief
dshx --help / --version
```

`ask` / `continue` 主要选项：

| 选项 | 默认 | 说明 |
|---|---|---|
| `-C, --cwd DIR` | 当前目录 | DSH 工作区；也是会话 cwd 约束 |
| `--session ID` | — | 显式续接；不能与 `continue` 同用 |
| `--provider ID` | `deepseek-account` | 账号路线；或 `deepseek-official` |
| `--model ID` | `deepseek-flash` | 账号路由还支持 `deepseek-v4-pro` |
| `--reasoning-effort LEVEL` | `max` | `off`、`low`、`high`、`max` |
| `--permission-mode MODE` | `danger-full-access` | `read-only`、`workspace-write`、`danger-full-access` |
| `--profile NAME` | `headless` | 必须是 headless 兼容 profile |
| `--patch FILE` | — | 额外 DSH overlay，可重复；排在生成的 overlay 之后 |
| `--dsh FILE` | 自动 | 指向 `...\@deepseek-ai\dsh\lib\bin.js` |
| `--dsh-home DIR` | 继承/`~\.dsh` | 设置子进程 `DSH_HOME`（测试用） |
| `--timeout SECONDS` | `1800` | 整体截止时间；`0` 表示无期限 |
| `--max-output-bytes N` | `65536` | 答复上限； `0` 表示不限制 |
| `--json` | 否 | 输出单条 JSON envelope |
| `--progress` | 否 | 把带时间戳的 turn/step/tool 摘要写到 stderr |
| `--verbose` | 否 | 路径/耗时/会话/DSH stderr |
| `--dry-run` | 否 | 只做 overlay 与 `--dump-config` 校验，不跑模型 |
| `--no-auth-overlay` | 否 | 不启用账号 rows（高级） |
| `--allow-unvalidated-version` | 否 | 版本白名单逃生口 |

prompt 省略或为单独的 `-` 时从 stdin 读取（8 MiB 上限）；给出位置 prompt 时不读 stdin。
所有 prompt 都经 stdin 传给 DSH，不拼进命令行。

## JSON 与退出码

成功：

```json
{
  "schemaVersion": 1,
  "ok": true,
  "sessionId": "session-...",
  "text": "OK",
  "truncated": false,
  "durationMs": 7100,
  "provider": "deepseek-account",
  "model": "deepseek-flash",
  "reasoningEffort": "max",
  "permissionMode": "read-only",
  "cwd": "C:\\work\\project",
  "dshHome": "C:\\Users\\you\\.dsh"
}
```

失败：

```json
{
  "schemaVersion": 1,
  "ok": false,
  "error": { "code": "AUTH_UNAVAILABLE", "message": "...", "hint": "..." },
  "exitCode": 3
}
```

退出码：

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | DSH 任务失败（turn 未完成/工具错误/空答复等） |
| 2 | dshx 用法错误 |
| 3 | DSH/版本/认证/会话/状态目录不可用 |
| 4 | 协议错误（事件 JSON、未知事件、缺 final 等） |
| 124 | 超时，DSH 进程树已停止 |
| 130 | SIGINT 中断 |
| 143 | SIGTERM 终止 |

## 工作原理

1. 定位 `@deepseek-ai/dsh/lib/bin.js`，执行 `--version` 并检查白名单。
2. 生成临时 overlay（0600），重新启用账号 rows 并设置模型。
3. 启动：

   ```text
   node <dsh-bin> --profile headless --patch <overlay> [--patch <user>...]
     -- --json [--session-id <id>] -
   ```

   - cwd 为 `--cwd`；env 显式设置 `DSH_PERMISSION_MODE`，并剔除父进程的
     `DSH_PROFILE`/`DSH_SESSION_ID`/`DSH_WEB_URL` 等标记。
   - prompt 走 stdin；stdout 解析 NDJSON；stderr 保留最后 64 KiB 诊断。
4. 只接受 `session`/`status`/`text`/`thinking`/`tool_call`/`tool_result`/`error`/`final`；
   插件写入 stdout 的非 JSON 行作为诊断噪声，不污染 final。
5. 退出 0 + `final` + 无 `error` + `turn_end=completed` 才算成功；否则按错误码映射。
6. 成功后写会话记录；`--json`/文本渲染；超过输出上限时保存全文。

## 已知边界

- DSH headless 是一次性进程：后台 jobs 随进程结束；没有 in-band cancel；每次调用约
  5 秒冷启动。
- headless 使用 base 工具集，不含桌面 Web UI 的插件/自定义 agent preset；GUI 会话
  不能续接。
- 不支持 WSL 原生运行；从 WSL 调用会得到 `PLATFORM_UNSUPPORTED` 提示。Codex 的
  agent shell 是 PowerShell，因此不影响当前用法。
- 版本白名单之外的 DSH 需要 `--allow-unvalidated-version`，并重跑验收。
- 在 Codex `workspace-write` 线程下，`~\.dsh` 的写权限和 `.ps1` 执行策略可能阻止
  dshx；请使用当前 `danger-full-access` 线程和 `dshx.cmd`。

## 故障排查

```powershell
dshx.cmd doctor
dshx.cmd doctor --json
dshx.cmd ask --dry-run "..."          # 只验证 profile/overlay，不调用模型
dshx.cmd ask --verbose "..."          # 看 dsh 路径、耗时、会话、DSH stderr
```

常见问题：

- `DSH_UNAVAILABLE` / `DSH_VERSION_UNSUPPORTED`：确认 `dsh` 在 PATH，或传
  `--dsh <...\lib\bin.js>`；版本不匹配时安装白名单版本。
- `AUTH_UNAVAILABLE`：确认 DSH Desktop 已登录；或设 `DEEPSEEK_API_KEY` 并使用
  `--provider deepseek-official`。
- `SESSION_UNAVAILABLE`：不要用 GUI session id；先 `dshx ask`，再 `dshx continue`。
- `STATE_UNAVAILABLE`：设置 `DSHX_STATE_DIR` 到可写目录。
- 超时：增大 `--timeout` 或拆分任务；超时会杀进程树。
- 输出被截断：查看 stderr 给出的 `~\.dshx\runs\...md` 全文。

## 开发与测试

```powershell
git clone https://github.com/ZoeHao2026/dshx.git
cd dshx
npm test
npm link
```

测试覆盖：

- 参数解析/隐式 ask/stdin/退出码；
- overlay 生成与 `--dump-config` 校验；
- NDJSON 行边界、未知事件、final 后事件、插件噪声；
- 会话记录、过滤、tombstone、prune；
- fake DSH 的成功/认证失败/会话失败/协议错误/大输出/超时杀进程树；
- `doctor` 的账号 grant 存在/缺失；
- 截断与 JSON envelope。

当前验证结果：43 项测试全部通过；真实账号 smoke test 返回 `OK`，`continue` 返回
`DONE`，临时工作区写文件成功；真实超时返回 124；无 Codex 配置改动。

## 验证记录（开发机）

- `dshx.cmd doctor`：node/DSH/account-grant/state-dir/overlay 全 ok，并提示
  `danger-full-access` 安全警告。
- `dshx ask --permission-mode read-only "Reply with exactly OK..."`：退出 0，stdout `OK`。
- `dshx continue --json "Reply with exactly DONE..."`：退出 0，同一 `sessionId`。
- 临时工作区创建 `hello.txt` 内容 `hi`：成功。
- `--timeout 3`：退出 124，进程树被停止。
- 无效 `--session`：退出 3，`SESSION_UNAVAILABLE`。
- 未修改 `~/.codex`；未添加 MCP/hooks/plugin/config。

## 文件布局

```text
dshx/
  bin/dshx.js
  src/
    args.js errors.js locate.js overlay.js events.js runner.js
    render.js sessions.js doctor.js brief.js main.js version.js
  fixtures/fake-dsh.mjs
  test/*.test.js
  .github/workflows/ci.yml
  package.json
  LICENSE
  README.md
```

## 版本

`dshx 0.1.0`。DSH 版本白名单：`0.2.0-rc.2`、`0.2.1-rc.2`、`0.2.1-rc.3`。

## 免责声明

这是一个独立的社区项目，与 OpenAI、DeepSeek 没有隶属或背书关系；Codex、
DeepSeek Harness 及相关名称/商标归各自权利人所有。`dshx` 会让 DSH 以你的 OS
用户权限运行，默认 `danger-full-access`，请自行评估任务与内容信任边界。

## License

MIT，见 [LICENSE](LICENSE)。
