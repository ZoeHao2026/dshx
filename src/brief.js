/** The exact block a user pastes once into a Codex conversation. */
export const BRIEF = `你现在可以使用 dshx.cmd 这个本机 CLI，把任务交给 DeepSeek Harness (DSH) 执行。
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
- PowerShell 中请调用 dshx.cmd，不要依赖不带扩展名的 dshx（可能命中 .ps1）`;

export function printBrief(write = (text) => process.stdout.write(text)) {
  write(`${BRIEF}\n`);
}
