# QQ 官方机器人渠道

此分支基于官方 `main` 的 `20e98eed968b9663d80f9efd40c10d363ea0b781`，使用腾讯 SDK `@tencent-connect/qqbot-nodejs@1.0.4`。

## 启动与连接

1. 退出其他 Craft Agents 实例，打开 `/Applications/Craft Agents QQ.app`。它与原版 App 并存，使用 Craft 原有的数据目录、凭据和 Workspace。开发时也可以双击仓库根目录的 `Start Craft QQ.command` 运行源码构建。
2. 在 QQ 开放平台 `https://q.qq.com/` 创建官方机器人，取得 App ID、App Secret，开启所需的群聊/单聊能力并选择 WebSocket 消息接收。群聊可用范围以机器人控制台的测试配置、权限和发布状态为准。
3. 在目标 Workspace 的设置 → Messaging → QQ 中输入凭据，验证后保存。凭据进入 Craft 现有凭据存储，普通 messaging 配置只保存 App ID 和连接/访问设置。
4. 将机器人加入目标群。在 Craft 对话菜单选择「连接消息平台 → QQ」，在该群中 `@机器人 /pair 六位配对码`。
5. 群内 `@机器人 你的问题` 驱动已绑定对话；私聊直接发消息即可。

每个 Workspace 只连接一个 QQ 机器人。同一个机器人不能同时配置到两个已启用的 Workspace。不同群聊分别绑定独立 Craft 对话；同一个群聊再次配对会替换原来的绑定。

## 切换对话

在群中 @机器人后发送以下命令，私聊不需要 @：

- `/pair 六位配对码`：绑定或切换到 Craft 菜单中选择的对话。
- `/bind`：列出当前 Workspace 最近的对话。
- `/bind 编号` 或 `/bind 会话ID`：切换到列表中的对话。
- `/new 名称`：新建并绑定一个对话。
- `/status`：查看当前绑定状态。
- `/unbind`：解除当前群聊/私聊绑定。
- `/help`：显示命令。

默认仅允许已授权用户驱动机器人；第一次成功配对会将配对人加入允许用户列表。其他用户的请求会在 QQ 设置的待处理请求中显示，由操作者决定是否允许。已绑定的群聊会共享对应 Craft 对话的上下文和输出。

支持文字及图片、文件附件，群聊只处理 @机器人 的消息。回复在生成完成后发送，长回复分段发送。权限审批、计划审批和凭据输入在 Craft 中完成。实际发送仍受 QQ 平台的权限、频率、内容和回复窗口限制。

## 附件收发

- 接收：在已配对的群中 @机器人并添加图片或文件，私聊直接发送。附件会保存到对应 Craft 会话，文本、图片、PDF 和 Office 文档沿用 Craft 的解析、缩放及转换流程。仅附件的消息也会进入会话。每条消息最多 5 个附件，每个最多 20 MB；未授权或未绑定的消息不会触发附件下载。
- 发送：AI 在最终回复中提供本地文件的 Markdown 链接时，QQ 网关会将文件作为附件回传。例如 `[报告](/绝对路径/report.pdf)` 或 `[报告](<包含空格的路径>)`。仅发送对应会话目录或工作目录中的文件，每轮最多 5 个，每个最多 20 MB；不会上传隐藏配置或凭据文件。
- 图片使用 QQ 图片接口；普通文件使用官方文件消息接口，需要机器人具备对应权限。如果发送失败，QQ 中会提示到 Craft App 查看，不会将失败误报为成功。音视频等文件能否被 AI 理解取决于当前模型和 Craft 的解析能力。

更换不同 App ID 的机器人会清除 QQ 绑定和允许用户列表，因为 QQ OpenID 属于对应机器人应用；随后需要重新配对。

## 远程 Workspace

定制版保留原有「连接远程服务器」入口、WebSocket RPC、服务地址和 Token 认证方式，协议版本仍为 `1.0`。普通远程会话可连接同一基线、协议兼容的官方服务；这不代表任意新旧版本的全部功能都兼容。

远程 Workspace 的消息网关在服务器端运行，桌面端不会为它另起一个本地 QQ 连接。因此，远程 Workspace 要启用 QQ，服务器也必须使用本仓库的 `codex/qq-messaging` 分支。只更新桌面 App、继续运行未包含 QQ 的官方服务，不能为远程 Workspace 添加 QQ。

服务器构建和启动仍使用官方提供的命令，源码来源改为定制分支：

```sh
git clone --branch codex/qq-messaging https://github.com/Rz017/craft-agents-oss.git craft-agents-qq
cd craft-agents-qq
bun install --frozen-lockfile
# 沿用现有 CRAFT_SERVER_TOKEN、监听地址、TLS 等部署环境配置。
bun run server:prod
```

桌面 App 连接该服务器后，在对应远程 Workspace 的 Messaging 设置中配置 QQ 凭据并配对会话。凭据和群聊绑定保存在服务器上；本机 Workspace 的已有凭据和绑定不会自动迁移到远程 Workspace。不要让本机和远程服务同时连接同一个 QQ 机器人。

## 更新与验证

打包版 `Craft Agents QQ` 自带定制构建标识，关闭自动下载和安装；新版提醒只读取 [本 fork 的 GitHub Releases](https://github.com/Rz017/craft-agents-oss/releases)，不会检查官方更新源。启动时和「设置 → 应用 → 检查更新」都可检查；发现新版时提示打开 GitHub 下载页。下载 ZIP、退出旧版、解压后替换 Applications 中的 Craft Agents QQ 即可。源码启动器仍设置 `CRAFT_DISABLE_UPDATES=1`。

定制版本号独立保存在 `qq-release.json`，格式如 `0.15.0-qq.1`。新增发布时递增其中的版本，更新 `docs/qq-release-notes.md`，将代码推送到定制分支，再运行 GitHub Actions 中的「Release Craft Agents QQ (macOS ARM64)」。也可以推送与版本匹配的标签 `qq-v0.15.0-qq.1` 来自动触发。工作流先测试、打包和签名校验，再上传 ZIP 与 SHA256 校验文件，最后公开 Release。已有公开 Release 不会被覆盖。App 只识别 `qq-v` 标签且带完整 ARM64 ZIP 的公开稳定版本。

后续跟进官方更新通过 Git 合并官方源码并重新打包：

```sh
git fetch origin
git merge origin/main
PATH="$PWD/.local-tools:$PWD/node_modules/.bin:$PATH" bun install --frozen-lockfile
PATH="$PWD/.local-tools:$PWD/node_modules/.bin:$PATH" bun scripts/package-qq-mac.ts --archive
```

打包脚本面向 Apple Silicon macOS，在 `apps/electron/release/qq/mac-arm64/Craft Agents QQ.app` 生成本地签名的独立 App，不上传发布。内置 Bun、AI 子进程及所需工具资源，运行时无需仓库路径。退出正在运行的定制 App 后，可将新的 App 复制到 `/Applications/Craft Agents QQ.app`；保留 `/Applications/Craft Agents.app` 原版。两版共用 Craft 数据与服务锁，切换时先退出当前运行的一版。

验证命令：

```sh
export PATH="$PWD/.local-tools:$PWD/node_modules/.bin:$PATH"
bun test packages/messaging-gateway apps/electron/src/shared/__tests__/ipc-channels.test.ts apps/electron/src/transport/__tests__/channel-map-parity.test.ts
bun run typecheck:electron
bun run typecheck:shared
bun run electron:build
```

本地源码运行时，AI 子进程直接使用仓库 `.local-tools/bun`；无需依赖启动器的 PATH 条目。macOS App 会重新加载登录 shell 的 PATH，因此不能只靠启动器设置 PATH。若缺少该运行时，请安装 Bun 或补齐本地运行时后再启动。

真实联调时使用两个测试群：分别配对不同对话，确认各自的问题与回复；在其中一个群执行 `/bind` 切换，检查另一个群保持原绑定。关闭并重启 App，确认连接和绑定恢复。App Secret 在 App 中输入，不需要粘贴到聊天中。

开发参考：腾讯 [QQ 接入项目](https://github.com/tencent-connect/openclaw-qqbot)、[官方接口文档](https://github.com/tencent-connect/bot-docs)。
