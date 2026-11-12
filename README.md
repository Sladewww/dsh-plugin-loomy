# dsh-plugin-loomy

> 仓库：<https://github.com/Sladewww/dsh-plugin-loomy> · 标签：`dsh-plugin` `dsh-plugins` `dsh-plugin-market` · 许可：MIT

把 [loomy2api](https://github.com/Patrick130306/loomy2api)（MIT）改造为一个带**左侧栏入口**的 DSH 插件：

- **添加模型到 DSH**：从网关 `/v1/models` 拉目录，按启用清单写进 `@deepseek-ai/dsh-llm-pi-ai` 的自定义路由，模型出现在输入框的模型选择器里。
- **逐个模型启用开关**：面板里每行一个 `role="switch"` 开关，也可「全部启用 / 全部停用」。启用清单持久化在**本插件的 Config**（profile 的 `cordis.patch.yml`），用户不需要去「设置 → 模型」手动改。
- **设置账号池**：增删账号、启停、强制续期、查看额度、切换路由策略。
- **内置网关**：Python 源码随插件打包，Host 自动按需启动/停止，无需手工部署。
- **固定暗色主题**，不随宿主明暗切换。

## 组成

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半侧：Config、Python 子进程、`/__loomy/v2/api/*` HTTP 路由、模型启用同步 |
| `client.js` | Client 半侧：`sidebar.panellist` 图标 + `main` 主面板（React，暗色） |
| `gateway/` | 内置 loomy2api 纯 Python 源码 + `dsh_serve.py` 启动包装 |
| `cordis.patch.yml` | bundle 的 insert 行（默认 `enabledModels: []`） |
| `locale/`, `icon.svg` | 显示元数据 |

## 模型启用机制（重点）

```
面板点开关 ──POST /modelToggle──> Host
                                   ├── configEditor.edit(本插件 entry)
                                   │      └─> 写 cordis.patch.yml 的
                                   │          - id: loomy-gateway
                                   │            config:
                                   │              enabledModels: [...]
                                   └── configEditor.edit(llm-pi-ai entry)
                                          └─> 写 providers.loomy.models
                                              （只含启用项；全停则删该路由）
```

- `apply(ctx, config)` 读取 `config.enabledModels`；`configEditor.edit` 会重启本插件，新 fiber 自动拿到新清单。
- 「同步模型到 DSH」首次会默认全启用，之后保留用户手动调过的清单，只补进上游新增模型。
- 全部停用时 `providers.loomy` 被整体移除（pi-ai 不允许空 `models`）。
- **用户无需、也不应去「设置 → 模型」改这个路由**——那里会被本插件的下一次开关操作覆盖。

## 网关生命周期

`configEditor.edit` 会重启本插件，因此网关进程**不能**挂在 `ctx.effect` 的 cleanup 上（否则切个开关就断服务）。实现改为「存活即接管」：新 fiber 启动探测 `/health`，已有网关就认领（`adopted`），没有且 `autoStart` 为真才 spawn。显式「停止」按钮仍会 kill（含接管来的进程，按端口查 PID）。

## 外观

面板使用**固定暗色主题**（`#0f1115` 底层 / `#171a21` 卡片 / `#1e222b` 输入控件），
不随宿主明暗切换——因为宿主浅色时的文字 token 是深色，叠在深底上会看不见。
组件级 CSS 通过 `styles.insert` 注入（`data-loomy-panel` 作用域），处理滚动条、
placeholder、自动填充、数字输入箭头、焦点环与 `select option`，随插件卸载自动移除。

## 数据流

```
面板 ── fetch /__loomy/v2/api/* ──> Host 路由 ── HTTP 127.0.0.1:port ──> Python 网关 ──> 讯飞上游
                                       │
                                       └── configEditor.edit() ──> 两处 Config
```

静态 bundle 的 Client 没有 `host.call`，通信走同源 HTTP 路由（与官方 `dsh-plugin-codegraph-panel` 一致）。Host 路由校验 `Origin` 只允许 loopback。

## 状态位置

| 文件 | 内容 |
|---|---|
| `~/.dsh/loomy/state.json` | 插件设置（端口/Python/策略/默认模型/路由 ID/自动启动） |
| `~/.dsh/loomy/config.json` | 网关配置，由 Host 生成，含本地占位 key 与绝对路径 |
| `~/.dsh/loomy/accounts.json` | **账号池，含明文密码/session** |
| `~/.dsh/loomy/logs/` | 网关日志 |
| profile 的 `cordis.patch.yml` | **模型启用清单**（本插件那一行）+ pi-ai 路由配置 |

网关只绑 `127.0.0.1`，本地 API key 是固定占位值（非真实 secret）。账号文件按上游设计是明文，**请保护该目录，仅用于你自己的账号**。

## 安装

在 DSH 里安装本插件（三选一）：

- **插件市场 / Discover**：搜索 `dsh-plugin-loomy`（若索引已收录）。
- **本地目录**：把本仓库 clone 到任意目录，在 DSH 插件管理里用 `install_bundle` 指向该目录，或直接让 Agent 执行 `plugin_manager install_bundle` 传绝对路径。
- **Git 依赖**：在 profile 的 `package.json` 加
  `"dsh-plugin-loomy": "github:Sladewww/dsh-plugin-loomy"`，并在 `dsh.profile.bundles` 里加入包名，重启 DSH。

依赖：Python 3.9+（仅标准库，无需 pip install）、DSH >= 0.2.0。

## 使用

1. 安装并启用 `dsh-plugin-loomy`；左侧栏出现「Loomy 网关」图标。
2. 打开面板 →「服务」→「启动」。若 Python 未找到，去「设置」填 Python 3.9+ 的绝对路径。
3. 「账号池」→「添加账号」：手机号 + 讯飞账号中心设置的密码（或粘贴 32 位 session）。
4. 「模型」→「同步模型到 DSH」→ 用开关挑要启用的模型。
5. 去输入框的模型选择器选 `loomy` 路由下的模型；「测试对话」可确认链路（消耗点数）。

## 故障排查

| 现象 | 处理 |
|---|---|
| 端口不可用 / WSAEACCES | Windows 有系统预留端口段，在「设置」里换端口（如 17891） |
| 找不到 Python | 在「设置」里填绝对路径 |
| 同步模型报「pi-ai 条目不可编辑」 | 检查「设置」里的诊断信息，确认 `llm-pi-ai` 在 configEditor.entries() 里 |
| 模型目录为空 | 确认账号池至少有一个可用账号；无账号时上游会返回内置兜底清单 |
| 切开关后网关断了 | 本版本已修（存活即接管）；若仍遇到，点「启动」会接管现有进程 |

## 上游与许可

- 本项目（Host / Client / 启动包装 / 文档）：MIT，见 [LICENSE](LICENSE)，Copyright (c) 2026 Sladewww。
- 内置 `gateway/loomy2api/` 源码来自 [Patrick130306/loomy2api](https://github.com/Patrick130306/loomy2api)，同样为 MIT；其原始许可文本逐字保留在 [LICENSES/loomy2api-LICENSE](LICENSES/loomy2api-LICENSE)。未改动上游 Python 逻辑，只增加了 `gateway/dsh_serve.py` 启动包装，把 `config.json` / `accounts.json` / 日志重定向到用户数据目录，避免写进插件包。

本插件与科大讯飞 / Loomy 无关联，仅供自有账号的互操作使用。请勿用于滥用、转售或压测上游服务。
