/**
 * Client dictionaries.
 *
 * Two locales ship with the bundle: Simplified Chinese (the authoring
 * language) and English. Keys are flat, dot-namespaced, and resolved through
 * the shared `locale` service, so switching the GUI language re-renders the
 * wall without a reload.
 */

/** The namespace registered with the Client locale service. */
export const NAMESPACE = 'skillreStickyWall'

/** Chinese dictionary; the key set is the source of truth. */
export const zh: Record<string, string> = {
  'nav': '便签墙',
  'title': '便签墙',
  'subtitle': '随手记下一闪而过的灵感，和临时的活儿；拖一拖，把它们摆成你自己的样子。',
  'empty': '还没有便签。点「新建」写下第一条。',
  'emptyArchived': '归档区是空的。',
  'new': '新建',
  'save': '保存',
  'cancel': '取消',
  'close': '关闭',
  'edit': '编辑',
  'pin': '置顶',
  'unpin': '取消置顶',
  'archive': '归档',
  'restore': '恢复',
  'delete': '删除',
  'clearArchived': '清空归档',
  'confirmClear': '确定永久删除所有归档便签？',
  'confirmDelete': '确定删除选中的便签？',
  'showArchived': '显示归档',
  'hideArchived': '隐藏归档',
  'sortPinned': '置顶优先',
  'sortCreated': '按创建',
  'sortUpdated': '按更新',
  'all': '全部',
  'filters': '筛选',
  'search': '搜索便签…',
  'bodyPlaceholder': '写点什么…',
  'titlePlaceholder': '标题（可选）',
  'tagsPlaceholder': '标签，用空格分隔',
  'colorLabel': '颜色',
  'saveHint': '⌘/Ctrl + Enter 保存 · Esc 取消',
  'count': '{count} 张便签',
  'countArchived': '{count} 张已归档',
  'updated': '更新于 {time}',
  'created': '创建于 {time}',
  'loading': '加载中…',
  'failed': '操作失败',
  'noResults': '没有匹配的便签',
  'retry': '重试',
  'tooLong': '内容太长了',
  'emptyBody': '便签不能为空',
  'wallFull': '便签墙满了，请先归档或删除一些便签',
  'emptyTags': '还没有标签',
  'pinHint': '置顶的便签排在最前',
  'more': '更多',
  'agentHint': '也可以让我帮你记：直接说「记一下……」',
  'preview': '预览',
  'widthLabel': '卡片宽度',
  'width_sm': '小',
  'width_md': '中',
  'width_lg': '大',
  'resize': '换尺寸',
  'arrange': '整理',
  'viewLabel': '视图',
  'view_canvas': '画布',
  'view_grid': '网格',
  'view_list': '列表',
  'zoomLabel': '缩放',
  'zoomIn': '放大',
  'zoomOut': '缩小',
  'zoomReset': '重置视图',
  'dragHint': '拖动卡片摆放位置，⌘/Ctrl + 滚轮缩放',
  'markdownHint': '正文支持 Markdown：标题、列表、粗体、代码块、链接、表格',
}

/** English dictionary; every key mirrors {@link zh}. */
export const en: Record<string, string> = {
  'nav': 'Notes',
  'title': 'Sticky wall',
  'subtitle': 'Jot down a passing idea or a piece of temporary work — then drag the cards into your own arrangement.',
  'empty': 'No notes yet. Hit "New" to write the first one.',
  'emptyArchived': 'Nothing archived yet.',
  'new': 'New',
  'save': 'Save',
  'cancel': 'Cancel',
  'close': 'Close',
  'edit': 'Edit',
  'pin': 'Pin',
  'unpin': 'Unpin',
  'archive': 'Archive',
  'restore': 'Restore',
  'delete': 'Delete',
  'clearArchived': 'Clear archive',
  'confirmClear': 'Permanently delete every archived note?',
  'confirmDelete': 'Delete the selected notes?',
  'showArchived': 'Show archived',
  'hideArchived': 'Hide archived',
  'sortPinned': 'Pinned first',
  'sortCreated': 'By created',
  'sortUpdated': 'By updated',
  'all': 'All',
  'filters': 'Filter',
  'search': 'Search notes…',
  'bodyPlaceholder': 'Write something…',
  'titlePlaceholder': 'Title (optional)',
  'tagsPlaceholder': 'Tags, space separated',
  'colorLabel': 'Color',
  'saveHint': '⌘/Ctrl + Enter to save · Esc to cancel',
  'count': '{count} notes',
  'countArchived': '{count} archived',
  'updated': 'Updated {time}',
  'created': 'Created {time}',
  'loading': 'Loading…',
  'failed': 'Something went wrong',
  'noResults': 'No matching notes',
  'retry': 'Retry',
  'tooLong': 'Too long',
  'emptyBody': 'A note cannot be empty',
  'wallFull': 'The wall is full — archive or delete a note first',
  'emptyTags': 'No tags yet',
  'pinHint': 'Pinned notes stay on top',
  'more': 'More',
  'agentHint': 'You can also ask me to note it: say "note that …"',
  'preview': 'Preview',
  'widthLabel': 'Card width',
  'width_sm': 'S',
  'width_md': 'M',
  'width_lg': 'L',
  'resize': 'Resize',
  'arrange': 'Tidy',
  'viewLabel': 'View',
  'view_canvas': 'Canvas',
  'view_grid': 'Grid',
  'view_list': 'List',
  'zoomLabel': 'Zoom',
  'zoomIn': 'Zoom in',
  'zoomOut': 'Zoom out',
  'zoomReset': 'Reset view',
  'dragHint': 'Drag a card to place it · ⌘/Ctrl + wheel to zoom',
  'markdownHint': 'The body renders Markdown: headings, lists, bold, code blocks, links, tables',
}

/** Read one key from a dictionary, falling back to the key itself. */
export function textOf(dict: Record<string, string>, key: string): string {
  return dict[key] ?? key
}

/** Pick the dictionary for a locale id, falling back to English. */
export function dictFor(locale: string): Record<string, string> {
  return locale.toLowerCase().startsWith('zh') ? zh : en
}

/** The translate function the locale service binds for one namespace. */
export type Translate = (key: string, params?: Record<string, string | number>) => string
