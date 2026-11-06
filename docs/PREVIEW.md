# 预览图画板

详情页的预览图以**飞书画板**为编辑源，`docs/preview*.svg` 是它的导出快照。
本文件记录两种语言各自对应的画板，供 `node scripts/preview.mjs push|pull` 使用。

> 状态：当前 `docs/preview.svg` 与 `docs/preview.zh.svg` 由手写 SVG 直接绘制，
> 尚未回填到飞书画板。下表的 token 为空即表示「尚未建板」；建板后用 `push` 上传，
> 再把文档 URL 与 token 填回来，此后改图走 `pull` / `push` 往返。

| 语言 | 文档 | 画板 token |
|---|---|---|
| `en` | （待建：飞书文档 URL） | （待建：whiteboard token） |
| `zh` | （待建：飞书文档 URL） | （待建：whiteboard token） |

## 操作

```sh
# 把本地 SVG 推上画板（整板重建）
node scripts/preview.mjs push --lang zh

# 从画板导出 SVG 覆盖本地文件
node scripts/preview.mjs pull --lang zh

# 离线校验（npm run check 会自动调用）
node scripts/preview.mjs check
```

## 画面约定

两张图必须同构，只换语言：

1. **主体**：深色画布上散落 7–9 张大小、角度不同的便签卡（六色柔和底色之一），
   卡片之间刻意不排成网格 —— 这正是「自由画布」与旧版瀑布流的区别。
2. **机制**：卡内正文展示 Markdown 的真实渲染结果 —— 标题、粗体、列表、
   代码块、复选清单各出现一次，说明「正文即 Markdown」。
3. **界面**：左侧栏入口、顶部搜索框与筛选 chip、画布左下角悬浮缩放控件。
4. **细节**：置顶卡的左侧色条与星标；一张卡带拖拽提示（虚线框或光标）。

规则见 fleet 的 `docs/display-contract.md`。
