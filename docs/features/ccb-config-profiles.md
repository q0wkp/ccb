# CCB 配置档案

打开 `/config`，选择 **CCB configuration profile**。修改在重启 CCB 后生效。

- **Compatible（兼容）**：继承官方 Claude Code 的偏好设置，共享 skills、agents、plugins、会话和缓存。CCB 的全局配置和用户设置写入 `~/.ccb/compatible/`，官方的全局配置和用户设置对 CCB 只读；共享内容仍可写。
- **Isolated（隔离）**：用户档案数据使用 `~/.ccb/isolated/`。可以沿用已有的隔离档案、导入官方档案，或从空白开始。导入和从空白初始化前，会先把已有的隔离档案移到 `~/.ccb/backups/`。

两种模式都需要在 CCB 中单独 `/login`。官方 Claude Code 的登录凭据和会产生凭据的配置不会被继承或导入。每个档案使用各自的凭据文件、刷新锁和 macOS 钥匙串服务名。MCP 服务器定义（包括各服务专用的 headers、环境变量和 header helper）仍然继承，以保证这些服务继续可用。与 Claude 凭据存放在一起的 MCP OAuth token 需要在 CCB 中重新认证。

项目文件（`.claude/`、`.mcp.json`、`CLAUDE.md`）在两种模式下都共享。隔离模式的导入会把用户内容复制为独立文件，清理已知的配置文件，并排除凭据文件和全局配置备份。符号链接会被解引用，指向凭据或配置的别名以及循环、悬空的链接会被跳过。

模式选择保存在 `~/.ccb/config.json`。`CCB_CONFIG_DIR` 修改 CCB 根目录；`CCB_OFFICIAL_CONFIG_DIR` 修改官方档案的来源目录。每个运行中的进程的档案路由在启动时固定。显式设置非空的 `CLAUDE_CONFIG_DIR` 会退出档案路由、保持原有 CLI 行为，此时档案选择器不显示。

兼容模式的全局覆盖层对对象递归合并、对数组整体替换，被删除的继承键以墓碑（tombstone）记录。旧的扁平 CCB 覆盖层仍可读取。CCB 运行期间，官方全局配置文件的改动会被实时读取。

CCB 本地保险库（local vault）为兼容起见保留原有的共享钥匙串服务；切换档案不会迁移保险库中的密钥。在 macOS 上，发布给 macOS 用户之前，请用真实的钥匙串条目验证登录、刷新和登出。
