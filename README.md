# @skillre/dsh-plugin-sticky-wall · 便签墙

> 状态：experimental · 面向 DSH `0.2.1-rc.5`

在 DSH 左侧栏加一个「便签墙」入口：随手记下一闪而过的灵感、临时的活儿和短提醒，重要的置顶，过期的归档。便签由 Host 持久化，重启 DSH 后仍在。

[English](README.en.md)

## 它解决什么

灵感往往出现在最忙的时候，而「打开一个文档、想个标题、找个位置」的摩擦足以让灵感溜走。便签墙把这件事压缩成三步：点侧栏 → 写一行 → `⌘/Ctrl + Enter`。它是**速记板**，不是知识库：不追求层级、双链或富文本，只保证「想到就记下、回头找得到」。

非目标：不做任务管理（不排期、不分派、不提醒）、不做协作共享、不导出 Markdown 知识库。

## 功能

- **左侧栏入口**：`sidebar.panellist` 中的「便签墙」图标，点击把中央区域切换到便签墙页面。
- **随手记录**：`+ 新建` 打开便签纸，标题可选、正文必填，可打标签、选六种柔和底色。
- **置顶与归档**：置顶的便签永远排在最前；归档的便签默认隐藏，可随时恢复或永久删除。
- **搜索与排序**：按正文、标题、标签实时过滤；可按「置顶优先 / 按创建 / 按更新」排序。
- **深浅色**：只使用 DSH 主题 token 绘制框架，便签底色与文字色为插件自有配色并各自提供深色变体。
- **中英双语**：跟随 DSH 界面语言实时切换，无需刷新。
- **模型可用**：可选注册 `sticky_wall` 工具，直接对我说「记一下……」即可落成一张便签。

## 数据与权限

| 项目 | 说明 |
|---|---|
| 数据所有者 | Host。便签通过 DSH 原生 `storageDomain` 持久化，域名为 `skillre_sticky_wall`，`per-record` 布局（一张便签一个文件）。 |
| 数据位置 | 由 profile 的 storage 后端决定；shipped profile 的 `storage-json` 行把域文件放在 `$DSH_HOME/storages` 下。 |
| 网络 | 无外部网络请求。浏览器 ↔ Host 只走本机 DSH 的 `/api` 通道。 |
| 文件系统 | 仅经由 storage 后端读写该域目录，不读写任意用户文件。 |
| 密钥 | 不使用任何密钥。 |
| 模型可见 | 仅当 `enableAgentTool` 为真（默认）时注册 `sticky_wall` 工具；便签内容在工具调用返回时进入会话。 |

## 配置

在 profile 的 `cordis.patch.yml` 中按行 id 覆盖（`config` 整行替换，未写出的键取默认值）：

```yaml
- id: skillre-sticky-wall
  name: '@skillre/dsh-plugin-sticky-wall'
  config:
    maxNotes: 400
    enableAgentTool: true
    seedWelcomeNote: true
```

| 键 | 默认 | 含义 |
|---|---|---|
| `maxNotes` | `400` | 未归档便签的数量上限（1–5000）。达到上限后新建会返回 `sticky-wall/wall-full`，需先归档或删除。 |
| `enableAgentTool` | `true` | 是否向模型注册 `sticky_wall` 工具。 |
| `seedWelcomeNote` | `true` | 全新的空墙是否写入一张欢迎便签（说明快捷键与用法）。 |

## 安装

开发与测试完成后，**由用户本人**在 DSH Desktop Client 或 Web UI 的 **Plugins / 插件管理**界面选择来源并确认安装、启用，开发者或 agent 不在用户 profile 中代装。

- 已发布时：在安装对话框输入 npm 包规格 `@skillre/dsh-plugin-sticky-wall@<version>`。
- 未发布时：可提供已构建产物的 `.tgz` 绝对路径，前提是先核实该管理器接受此来源且包可安装。
- GitHub 仓库 URL 只有在目标管理器支持、且仓库具备安全自包含的 `prepare` 构建并经验证后才可作为来源。

## 更新与回滚

- 更新：在同一插件管理界面选择新版本安装；Host 行配置保持不变，便签数据不受影响。
- 回滚：安装回已知可用的旧版本。数据域带 `version` 字段，向后兼容只发生在同版本；跨版本降级前先备份 `$DSH_HOME/storages` 下的该域目录。
- 卸载：见 [UNINSTALL.md](UNINSTALL.md)。卸载插件**不会**自动删除便签数据。

## 已知限制

- 便签墙是速记板：正文上限 4000 字符、标题 120 字符、标签 8 个，均为硬限制。
- 归档区不参与 `maxNotes` 计数，但「清空归档」是永久删除，不可撤销。
- 多窗口同时打开时会各自拉取快照；Host 是唯一事实源，但界面不会实时推送其他窗口的改动。
- 本版本仅在 DSH `0.2.1-rc.5` 上做过真实挂载验证，未宣称兼容其他 DSH 版本。

## 兼容性

见 [compatibility.json](compatibility.json)：记录真实挂载过的 DSH 版本、验证日期与检查项。`engines.dsh` 只是安装声明，**不是**兼容性证据。

## 开发

```sh
npm install
npm run check          # typecheck + 测试 + 打包视图
npm pack               # 生成可安装的 tarball
```

包内容：`lib/`（Host 与 Client 构建产物及声明）、`cordis.patch.yml`、`compatibility.json`、`locale/*.json`、`icon.svg`、文档与许可证。

## 许可

MIT
