# @skillre/dsh-plugin-sticky-wall · 便签墙

> 状态：experimental · 面向 DSH `0.2.2-rc.1`

在 DSH 左侧栏加一个「便签墙」入口：随手记下一闪而过的灵感、临时的活儿和短提醒，像便签贴在桌上一样**自由摆放** —— 拖动、缩放、一键整理；正文用 **Markdown** 写，卡片上直接渲染出来。便签与摆位都由 Host 持久化，重启 DSH 后位置和内容都在。

[English](README.en.md)

## 它解决什么

灵感往往出现在最忙的时候，而「打开一个文档、想个标题、找个位置」的摩擦足以让灵感溜走。便签墙把这件事压缩成三步：点侧栏 → 写一行 → `⌘/Ctrl + Enter`。它是**速记板**，不是知识库：不追求层级、双链或富文本，只保证「想到就记下、回头找得到」。

非目标：不做任务管理（不排期、不分派、不提醒）、不做协作共享、不导出 Markdown 知识库、不做富文本所见即所得编辑器（正文是纯 Markdown 源码，渲染只是阅读视图）。

## 功能

- **左侧栏入口**：`sidebar.panellist` 中的「便签墙」图标，点击把中央区域切换到便签墙页面。
- **自由画布**：便签不是列表项，而是画布上的卡片。位置、旋转角、宽度三档（小/中/大）都属于便签数据，由 Host 保存；同一面墙在另一个窗口打开时摆位一致。
- **拖动摆放**：按住卡片任意位置即可拖动，松手立刻落到新位置再把结果写回 Host（不会先弹回原处）。拖动本身**不会**改 `updatedAt`，所以「按更新」排序不会因为你整理桌面而乱掉。
- **圆心构图**：整理把整面墙排成一个**以原点为中心的圆环**（向日葵螺旋排布），中心空出一块给问候语和快速记录框；相机打开时把整面墙框进视野并居中。
- **中心即入口**：便签墙正中是随时可用的快速记录框 —— 写一句按回车就落成一张便签，不用打开表单。
- **一键整理**：「整理」把全部便签按确定性算法重新排布并做真实碰撞检测 —— 同一面墙按两次得到同一个结果，卡片永不重叠。
- **三种视图**：画布（默认，自由摆位）、网格（响应式瀑布流，适合读长文）、列表（一行一条，适合按标题找）。
- **全幅画布**：便签墙占满整个窗口，没有顶部标题栏和工具栏；所有控件收进底部一条**浮动菜单栏**（搜索、筛选、视图、排序、缩放、整理、新建）。
- **相机**：拖动空白纸面平移，滚轮平移，`⌘/Ctrl + 滚轮` 以指针为锚点缩放（0.35×–2×），底部 `− / 百分比 / + / 重置 / 整理`；打开与重置时自动把整面墙框进视野。
- **Markdown 正文**：正文按 Markdown 渲染 —— 标题、段落、粗体/斜体/删除线、`代码`、代码块、有序/无序列表、`- [ ]` 复选、引用、分隔线、表格、http(s)/mailto 链接。编辑时右侧有「预览」切换。
- **随手记录**：`+ 新建` 打开便签纸，标题可选、正文必填，可打标签、选六种柔和底色、选卡片宽度。
- **置顶与归档**：置顶的便签带左侧色条与星标；归档的便签默认隐藏，「归档」筛选会单独拉取它们，「清空归档」是永久删除。
- **便签操作**：悬停或用键盘聚焦便签时，右上角出现置顶、换尺寸、编辑、归档、删除五个按钮；触屏设备上常驻显示。
- **搜索与排序**：按正文、标题、标签实时过滤；可按「置顶优先 / 按创建 / 按更新」排序。
- **深浅色**：只使用 DSH 主题 token 绘制框架，便签底色与文字色为插件自有配色并各自提供深色变体。
- **中英双语**：跟随 DSH 界面语言实时切换，无需刷新。
- **模型可用**：可选注册 `sticky_wall` 工具，直接对我说「记一下……」即可落成一张便签；也能让我 `arrange` 整理整面墙。

## 数据与权限

| 项目 | 说明 |
|---|---|
| 数据所有者 | Host。便签（含画布摆位）通过 DSH 原生 `storageDomain` 持久化，域名为 `skillre_sticky_wall`，`per-record` 布局（一张便签一个文件）。 |
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
| `maxNotes` | `400` | 未归档便签的数量上限（1–5000）。新建、取消归档、批量恢复都受此约束，超出时返回 `sticky-wall/wall-full`，需先归档或删除。 |
| `enableAgentTool` | `true` | 是否向模型注册 `sticky_wall` 工具。 |
| `seedWelcomeNote` | `true` | 全新的空墙是否写入一张欢迎便签（说明快捷键与用法）。 |

## 安装

开发与测试完成后，**由用户本人**在 DSH Desktop Client 或 Web UI 的 **Plugins / 插件管理**界面选择来源并确认安装、启用，开发者或 agent 不在用户 profile 中代装。

- **已加入插件市场**：在 **Plugins → Discover → Index sources** 添加 `https://skillre.github.io/dsh-plugin-market/index.json`（需先启用实验包 *Custom plugin markets*），然后在 Discover 里直接安装本插件。
- **npm（推荐，也是唯一支持原地更新的来源）**：在安装对话框输入 npm 包规格 `@skillre/dsh-plugin-sticky-wall@<version>`。
- 未发布时：可提供已构建产物的 `.tgz` 绝对路径，前提是先核实该管理器接受此来源且包可安装。
- 本仓库是**自包含**的 Git 源：`lib/` 构建产物已提交，且不声明 `scripts.prepare`，因此安装不触发构建脚本。对应的固定 spec 形如 `git+https://github.com/skillre/dsh-plugin-sticky-wall.git#<commit>`，已实测可安装。

## 更新与回滚

DSH `0.2.2` 线起，插件页有官方的**版本**区块（`listVersions` / `updateBundle`），可以原地检查并更新。
能否走这条路，**只取决于安装来源和包内容**，与仓库配置无关：

| 安装来源 | 能原地更新吗 |
|---|---|
| npm registry（`@skillre/dsh-plugin-sticky-wall@<version>`） | ✅ 详情页出现「版本」区块，可检查更新并原地升级 |
| `git+https://…#<commit>`（本仓库的市场条目） | ❌ 没有「版本」区块，只能卸载后重装 |
| `.tgz` 本地文件 / `file:` | ❌ 同上 |

本插件的 `updatable` 条件全部满足：第三方 bundle、以自己包名保存的 registry spec、合法 SemVer、
不携带 `@deepseek-ai/dsh-plugin-manager` 等受保护的插件管理行。**因此想获得官方更新能力，请用 npm 包名安装。**

更新语义（如实记录，避免误期）：

- **只升不降**：界面不会提供比已装版本更旧的版本；
- 更新成功后 profile 依赖被写成**精确版本**（原本是 range 也会变成精确版），失败回装同理；
- 更新 = 先移除再安装两步，HMR 下回装的 bundle 可能排到 bundle 列表末尾，改变配置层顺序；
- 失败可恢复：装不上/取消/起不来会回装原版本；回装也失败则该包处于未安装状态；
- 新版本若需要新的 build-script 批准会失败并回装旧版；
- 版本豁免（`allow-version`）只有 CLI 与 agent 工具，插件页没有入口。

- **回滚**：npm 版本不可覆盖。故障版本用 `npm deprecate` 标记并发布新的修复版本；用户在插件管理界面
  移除故障 bundle 后重装已知可用的版本（若界面不支持指定旧版，需由用户决定恢复渠道）。
- **数据兼容**：数据域带 `version` 字段，向后兼容只发生在同版本。跨版本降级前先备份
  `$DSH_HOME/storages` 下的该域目录。画布摆位是本版本新增的可选字段，旧便签读入时 `layout` 为
  `null`，由界面按 id 推导一个预览位置，因此**降级不会因为缺字段而报错**。
- **卸载**：见 [UNINSTALL.md](UNINSTALL.md)。卸载插件**不会**自动删除便签数据。

## 显示元数据（插件卡片与详情页）

DSH 读取插件卡片与详情页时**不激活插件**，所以这些资源必须随包发布，且分三层：

| 层 | 文件 | 内容 |
|---|---|---|
| 卡片标题/副标题 | `locale/en.json`、`locale/zh.json` 的 `meta.title` / `meta.description` | 一行，≤ 120 字符，纯文本 |
| 详情页 | `meta.detail` → `docs/DETAIL.md` / `docs/DETAIL.zh.md` | **只有一行** `![alt](preview*.svg)` |
| 开发者文档 | `README.md` / `README.en.md`（本文件） | 安装、配置、兼容性、限制…… |

- `locale/*.json` 经 Node ESM resolver 解析，因此 `exports` 必须声明 `"./locale/*.json"`；缺这一条会抛
  `ERR_PACKAGE_PATH_NOT_EXPORTED`，而 DSH 会**静默吞掉**该错误，卡片退化成裸包名 —— 没有任何地方会报错。
- `meta.detail` 是 DSH `0.2.2` 新增的字段，指向包内相对路径的 Markdown，由 DSH 从**包目录**直接读（不走 exports），
  所以 `files` 必须包含 `docs`。缺 `meta.detail` 时 DSH 回退到 `README.md` —— 也就是把这份开发者手册塞进详情页，
  这正是本版本要修掉的问题。
- 详情页图片：`docs/preview.svg`（英文）与 `docs/preview.zh.svg`（中文），固定 640×300 逻辑比例（本仓库用 1280×600）。
  规则见 fleet 的 `docs/display-contract.md`，画板记录在 [docs/PREVIEW.md](docs/PREVIEW.md)。

```sh
node scripts/preview.mjs check   # 离线校验预览图与 locale 元数据（npm run check 会自动跑）
```

## 插件市场

本插件已发布到由本舰队生成的插件市场索引：

- 索引：`https://skillre.github.io/dsh-plugin-market/index.json`
- 条目：`@skillre/dsh-plugin-sticky-wall@0.1.2`，来源为 commit-pinned Git（`83c932f`）
- 图标：`https://skillre.github.io/dsh-plugin-market/icons/sticky-wall.svg`

安装路径已实测：从线上索引取 spec → 装进隔离 profile → `--dump-config` → 有界启动 → 路由可用（证据见 `docs/evidence/market-install-0.1.2.json`）。

## 已知限制

- 便签墙是速记板：正文上限 4000 字符、标题 120 字符、标签 8 个，均为硬限制。
- **Markdown 是刻意的子集**，不是完整 CommonMark：支持标题（`#`–`####`）、段落与换行、粗体/斜体/删除线、
  行内 `` `code` ``、`` ``` ``/`~~~` 代码块、有序/无序列表、`- [ ]` 复选、引用、分隔线、管道表格、
  http(s)/mailto 链接。**不支持**嵌套列表缩进、图片、脚注、任务列表交互（复选框是只读字形）。
- 正文里的**原始 HTML 一律当文本显示**，不会执行也不会渲染 —— 这是安全选择，不是缺陷。
- 卡片宽度只有小/中/大**三档预设**，不支持任意拖拽调整宽度；拖动会保留卡片原有的轻微倾角。
- 整理是 O(n) 的螺旋放置 + 网格碰撞检测；便签上限 400 张，超出视野的墙需要自己平移或缩小。
- 画布是二维平面：没有分组、图层、连线或吸附对齐；也不支持双指旋转或触屏捏合之外的手势。
- 自动取景有可读性下限（50%）：便签很多时整面墙不会全部挤进视野，而是居中显示、需要平移查看。中心区域是固定留白，整理不会把卡片放在问候语和记录框下面。
- 便签的位置由 Host 保存；同一面墙在两个窗口同时打开时，各自渲染自己的快照，不会实时推送另一个窗口的拖动结果。
- 归档便签不占 `maxNotes` 名额，但恢复它们会占名额；名额已满时恢复会被拒绝而不是悄悄超限。
- 「清空归档」是永久删除，不可撤销。
- 批量归档/删除要么全部生效，要么一条都不改：请求里含一个不存在的 id 时整批被拒绝。
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
