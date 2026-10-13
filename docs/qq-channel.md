# QQ 官方机器人渠道（文字版）

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

目前仅转发文字，群聊只处理 @机器人 的消息。附件不下载、不转发；无文字的附件消息被忽略。回复在生成完成后发送，长回复分段发送。权限审批、计划审批和凭据输入在 Craft 中完成。实际发送仍受 QQ 平台的权限、频率、内容和回复窗口限制。

更换不同 App ID 的机器人会清除 QQ 绑定和允许用户列表，因为 QQ OpenID 属于对应机器人应用；随后需要重新配对。

## 更新与验证

打包版 `Craft Agents QQ` 自带定制构建标识，始终关闭官方自动下载和安装更新；直接打开 App 不需要环境变量。源码启动器 `Start Craft QQ.command` 则设置 `CRAFT_DISABLE_UPDATES=1`。后续更新通过 Git 合并官方源码并重新打包：

```sh
git fetch origin
git merge origin/main
PATH="$PWD/.local-tools:$PWD/node_modules/.bin:$PATH" bun install --frozen-lockfile
PATH="$PWD/.local-tools:$PWD/node_modules/.bin:$PATH" bun scripts/package-qq-mac.ts
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
