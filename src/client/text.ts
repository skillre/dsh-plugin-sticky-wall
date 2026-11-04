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
  'subtitle': '随手记下一闪而过的灵感，和临时的活儿。',
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
  'retry': '重试',
  'tooLong': '内容太长了',
  'emptyBody': '便签不能为空',
  'wallFull': '便签墙满了，请先归档或删除一些便签',
  'emptyTags': '还没有标签',
  'pinHint': '置顶的便签排在最前',
  'more': '更多',
  'agentHint': '也可以让我帮你记：直接说「记一下……」',
}

/** English dictionary; every key mirrors {@link zh}. */
export const en: Record<string, string> = {
  'nav': 'Notes',
  'title': 'Sticky wall',
  'subtitle': 'Jot down a passing idea, or a piece of temporary work.',
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
  'retry': 'Retry',
  'tooLong': 'Too long',
  'emptyBody': 'A note cannot be empty',
  'wallFull': 'The wall is full — archive or delete a note first',
  'emptyTags': 'No tags yet',
  'pinHint': 'Pinned notes stay on top',
  'more': 'More',
  'agentHint': 'You can also ask me to note it: say "note that …"',
}

/** Pick the dictionary for a locale id, falling back to English. */
export function dictFor(locale: string): Record<string, string> {
  return locale.toLowerCase().startsWith('zh') ? zh : en
}

/** The translate function the locale service binds for one namespace. */
export type Translate = (key: string, params?: Record<string, string | number>) => string
