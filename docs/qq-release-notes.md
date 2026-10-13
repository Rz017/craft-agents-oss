Craft Agents QQ for Apple Silicon macOS.

- QQ 官方机器人支持接收图片和文件附件，并将 AI 回复中的本地文件链接作为附件回传。
- 修复 AI 在 Markdown 链接括号内添加空格时，QQ 只收到文件路径、没有收到附件的问题。
- QQ 正文中的本地附件链接只显示文件名或说明，不再显示电脑目录；Craft App 中的原始可点击链接保留。
- 附件每条消息最多 5 个，每个最多 20 MB；普通文件发送需要 QQ 平台的文件消息权限。
- 新版检查使用此仓库的 GitHub Releases，只提醒并打开下载页面，不自动替换 App。
- 下载 ZIP，解压后退出旧版，将 Craft Agents QQ.app 放入 Applications。原版 Craft Agents.app 保留。
- 本次构建使用本地临时签名，未使用 Apple Developer ID 签名或公证。
- Workspace、凭据和群聊绑定沿用现有数据。远程 Workspace 的 QQ 功能需要同步更新服务器源码。

See [QQ usage and remote deployment](https://github.com/Rz017/craft-agents-oss/blob/codex/qq-messaging/docs/qq-channel.md).
