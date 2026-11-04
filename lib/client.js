window.__ModuleLoader__.load({
	id: "@skillre/dsh-plugin-sticky-wall",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		"use strict";
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __export = (target, all) => {
		  for (var name in all)
		    __defProp(target, name, { get: all[name], enumerable: true });
		};
		var __copyProps = (to, from, except, desc) => {
		  if (from && typeof from === "object" || typeof from === "function") {
		    for (let key of __getOwnPropNames(from))
		      if (!__hasOwnProp.call(to, key) && key !== except)
		        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
		  }
		  return to;
		};
		var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

		// src/client/index.tsx
		var index_exports = {};
		__export(index_exports, {
		  apply: () => apply,
		  inject: () => inject
		});
		module.exports = __toCommonJS(index_exports);

		// src/types.ts
		var ENDPOINT = "skillre-sticky-wall/execute";
		var PANEL_ID = "skillre-sticky-wall";
		var LIMITS = Object.freeze({
		  /** One note's body, in characters. */
		  body: 4e3,
		  /** One note's title, in characters. */
		  title: 120,
		  /** A note's free-form tag list. */
		  tags: 8,
		  /** One tag, in characters. */
		  tag: 32,
		  /** Live (non-archived) notes a wall may hold. */
		  notes: 400,
		  /** Note ids accepted in one request. */
		  bulk: 200
		});
		var COLORS = Object.freeze([
		  "yellow",
		  "pink",
		  "green",
		  "blue",
		  "purple",
		  "orange"
		]);
		var SORTS = Object.freeze(["pinned", "created", "updated"]);

		// src/client/api.ts
		var ActionError = class extends Error {
		  constructor(code, message, details = {}) {
		    super(message);
		    this.code = code;
		    this.details = details;
		    this.name = "ActionError";
		  }
		};
		function unwrap(result) {
		  if (result === null || typeof result !== "object" || !("ok" in result)) throw new ActionError("invalid-response", "The Host returned an invalid sticky-wall response.");
		  if (!result.ok) throw new ActionError(result.error.code, result.error.message, result.error.details);
		  return result.value;
		}
		function createApi(connection, lifetime) {
		  const call = async (request, signal) => {
		    const signalToUse = signal === void 0 ? lifetime : AbortSignal.any([lifetime, signal]);
		    return unwrap(await connection.rpc.call("/api", ENDPOINT, request, signalToUse));
		  };
		  return {
		    async list(includeArchived, sort, signal) {
		      const value = await call({ action: "list", includeArchived, sort }, signal);
		      return Array.isArray(value?.notes) ? value.notes : [];
		    },
		    async create(input, signal) {
		      const value = await call({ action: "create", note: input }, signal);
		      const note = value?.changed?.[0];
		      if (!note) throw new ActionError("invalid-response", "The Host created no note.");
		      return note;
		    },
		    async update(id, patch, signal) {
		      const value = await call({ action: "update", id, patch }, signal);
		      const note = value?.changed?.[0];
		      if (!note) throw new ActionError("invalid-response", "The Host updated no note.");
		      return note;
		    },
		    async archive(ids, archived, signal) {
		      const value = await call({ action: "archive", ids, archived }, signal);
		      return Array.isArray(value?.changed) ? value.changed : [];
		    },
		    async remove(ids, signal) {
		      const value = await call({ action: "delete", ids }, signal);
		      return Array.isArray(value?.removed) ? value.removed : [];
		    },
		    async clearArchived(signal) {
		      const value = await call({ action: "clear-archived" }, signal);
		      return Array.isArray(value?.removed) ? value.removed : [];
		    }
		  };
		}

		// src/client/text.ts
		var NAMESPACE = "skillreStickyWall";
		var zh = {
		  "nav": "\u4FBF\u7B7E\u5899",
		  "title": "\u4FBF\u7B7E\u5899",
		  "subtitle": "\u968F\u624B\u8BB0\u4E0B\u4E00\u95EA\u800C\u8FC7\u7684\u7075\u611F\uFF0C\u548C\u4E34\u65F6\u7684\u6D3B\u513F\u3002",
		  "empty": "\u8FD8\u6CA1\u6709\u4FBF\u7B7E\u3002\u70B9\u300C\u65B0\u5EFA\u300D\u5199\u4E0B\u7B2C\u4E00\u6761\u3002",
		  "emptyArchived": "\u5F52\u6863\u533A\u662F\u7A7A\u7684\u3002",
		  "new": "\u65B0\u5EFA",
		  "save": "\u4FDD\u5B58",
		  "cancel": "\u53D6\u6D88",
		  "close": "\u5173\u95ED",
		  "edit": "\u7F16\u8F91",
		  "pin": "\u7F6E\u9876",
		  "unpin": "\u53D6\u6D88\u7F6E\u9876",
		  "archive": "\u5F52\u6863",
		  "restore": "\u6062\u590D",
		  "delete": "\u5220\u9664",
		  "clearArchived": "\u6E05\u7A7A\u5F52\u6863",
		  "confirmClear": "\u786E\u5B9A\u6C38\u4E45\u5220\u9664\u6240\u6709\u5F52\u6863\u4FBF\u7B7E\uFF1F",
		  "confirmDelete": "\u786E\u5B9A\u5220\u9664\u9009\u4E2D\u7684\u4FBF\u7B7E\uFF1F",
		  "showArchived": "\u663E\u793A\u5F52\u6863",
		  "hideArchived": "\u9690\u85CF\u5F52\u6863",
		  "sortPinned": "\u7F6E\u9876\u4F18\u5148",
		  "sortCreated": "\u6309\u521B\u5EFA",
		  "sortUpdated": "\u6309\u66F4\u65B0",
		  "all": "\u5168\u90E8",
		  "filters": "\u7B5B\u9009",
		  "search": "\u641C\u7D22\u4FBF\u7B7E\u2026",
		  "bodyPlaceholder": "\u5199\u70B9\u4EC0\u4E48\u2026",
		  "titlePlaceholder": "\u6807\u9898\uFF08\u53EF\u9009\uFF09",
		  "tagsPlaceholder": "\u6807\u7B7E\uFF0C\u7528\u7A7A\u683C\u5206\u9694",
		  "colorLabel": "\u989C\u8272",
		  "saveHint": "\u2318/Ctrl + Enter \u4FDD\u5B58 \xB7 Esc \u53D6\u6D88",
		  "count": "{count} \u5F20\u4FBF\u7B7E",
		  "countArchived": "{count} \u5F20\u5DF2\u5F52\u6863",
		  "updated": "\u66F4\u65B0\u4E8E {time}",
		  "created": "\u521B\u5EFA\u4E8E {time}",
		  "loading": "\u52A0\u8F7D\u4E2D\u2026",
		  "failed": "\u64CD\u4F5C\u5931\u8D25",
		  "noResults": "\u6CA1\u6709\u5339\u914D\u7684\u4FBF\u7B7E",
		  "retry": "\u91CD\u8BD5",
		  "tooLong": "\u5185\u5BB9\u592A\u957F\u4E86",
		  "emptyBody": "\u4FBF\u7B7E\u4E0D\u80FD\u4E3A\u7A7A",
		  "wallFull": "\u4FBF\u7B7E\u5899\u6EE1\u4E86\uFF0C\u8BF7\u5148\u5F52\u6863\u6216\u5220\u9664\u4E00\u4E9B\u4FBF\u7B7E",
		  "emptyTags": "\u8FD8\u6CA1\u6709\u6807\u7B7E",
		  "pinHint": "\u7F6E\u9876\u7684\u4FBF\u7B7E\u6392\u5728\u6700\u524D",
		  "more": "\u66F4\u591A",
		  "agentHint": "\u4E5F\u53EF\u4EE5\u8BA9\u6211\u5E2E\u4F60\u8BB0\uFF1A\u76F4\u63A5\u8BF4\u300C\u8BB0\u4E00\u4E0B\u2026\u2026\u300D"
		};
		var en = {
		  "nav": "Notes",
		  "title": "Sticky wall",
		  "subtitle": "Jot down a passing idea, or a piece of temporary work.",
		  "empty": 'No notes yet. Hit "New" to write the first one.',
		  "emptyArchived": "Nothing archived yet.",
		  "new": "New",
		  "save": "Save",
		  "cancel": "Cancel",
		  "close": "Close",
		  "edit": "Edit",
		  "pin": "Pin",
		  "unpin": "Unpin",
		  "archive": "Archive",
		  "restore": "Restore",
		  "delete": "Delete",
		  "clearArchived": "Clear archive",
		  "confirmClear": "Permanently delete every archived note?",
		  "confirmDelete": "Delete the selected notes?",
		  "showArchived": "Show archived",
		  "hideArchived": "Hide archived",
		  "sortPinned": "Pinned first",
		  "sortCreated": "By created",
		  "sortUpdated": "By updated",
		  "all": "All",
		  "filters": "Filter",
		  "search": "Search notes\u2026",
		  "bodyPlaceholder": "Write something\u2026",
		  "titlePlaceholder": "Title (optional)",
		  "tagsPlaceholder": "Tags, space separated",
		  "colorLabel": "Color",
		  "saveHint": "\u2318/Ctrl + Enter to save \xB7 Esc to cancel",
		  "count": "{count} notes",
		  "countArchived": "{count} archived",
		  "updated": "Updated {time}",
		  "created": "Created {time}",
		  "loading": "Loading\u2026",
		  "failed": "Something went wrong",
		  "noResults": "No matching notes",
		  "retry": "Retry",
		  "tooLong": "Too long",
		  "emptyBody": "A note cannot be empty",
		  "wallFull": "The wall is full \u2014 archive or delete a note first",
		  "emptyTags": "No tags yet",
		  "pinHint": "Pinned notes stay on top",
		  "more": "More",
		  "agentHint": 'You can also ask me to note it: say "note that \u2026"'
		};

		// src/client/view.tsx
		var import_react = require("react");

		// src/client/styles.ts
		var WALL_CSS = `
		.skw-page { height: 100%; display: flex; flex-direction: column; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; overflow: hidden; -webkit-font-smoothing: antialiased; }
		.skw-page *, .skw-page *::before, .skw-page *::after { box-sizing: border-box; }
		.skw-page button { font: inherit; }
		.skw-head { flex: 0 0 auto; display: flex; align-items: flex-start; gap: 12px; padding: 16px 20px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
		.skw-head-text { min-width: 0; flex: 1; }
		.skw-title { margin: 0; font-size: 18px; line-height: 26px; font-weight: 600; letter-spacing: .1px; display: flex; align-items: center; gap: 8px; }
		.skw-subtitle { margin: 2px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
		.skw-actions { display: flex; align-items: center; gap: 6px; flex: none; }
		.skw-btn { height: 28px; padding: 0 10px; display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); cursor: pointer; white-space: nowrap; }
		.skw-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
		.skw-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
		.skw-btn[disabled] { opacity: .5; cursor: default; }
		.skw-btn-primary { background: var(--dsw-alias-brand-primary); border-color: transparent; color: var(--dsw-alias-label-primary-foreground); font-weight: 500; }
		.skw-btn-primary:hover { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-foreground); filter: brightness(1.06); }
		.skw-btn-quiet { border-color: transparent; background: transparent; }
		.skw-btn-danger { color: var(--dsw-alias-state-error-primary); border-color: transparent; background: transparent; }
		.skw-btn-danger:hover { background: var(--dsw-alias-state-error-secondary); color: var(--dsw-alias-label-primary-foreground); }

		.skw-toolbar { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 10px 20px; border-bottom: 1px solid var(--dsw-alias-border-l1); flex-wrap: wrap; }
		.skw-search { flex: 1 1 220px; min-width: 140px; height: 30px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
		.skw-search::placeholder { color: var(--dsw-alias-label-tertiary); }
		.skw-search:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
		.skw-seg { display: inline-flex; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px; overflow: hidden; }
		.skw-seg button { height: 28px; padding: 0 9px; border: 0; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 12px; }
		.skw-seg button + button { border-left: 1px solid var(--dsw-alias-border-l1); }
		.skw-seg button[data-on="true"] { background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); font-weight: 500; }
		.skw-toggle { height: 28px; padding: 0 9px; display: inline-flex; align-items: center; gap: 6px; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 12px; }
		.skw-toggle[data-on="true"] { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
		.skw-count { margin-left: auto; font-size: 12px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }

		.skw-body { flex: 1 1 auto; overflow: auto; overscroll-behavior: contain; padding: 16px 20px 32px; }
		.skw-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 12px; align-items: start; }
		.skw-empty { margin: 48px auto 0; max-width: 360px; text-align: center; color: var(--dsw-alias-label-secondary); }
		.skw-empty p { margin: 0 0 12px; }
		.skw-empty-icon { font-size: 28px; line-height: 1; display: block; margin-bottom: 10px; opacity: .7; }

		.skw-note { position: relative; display: flex; flex-direction: column; gap: 6px; min-height: 118px; padding: 12px 12px 10px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); box-shadow: 0 1px 2px var(--dsw-alias-bg-mask-2); cursor: default; transition: box-shadow .15s ease, transform .15s ease; }
		.skw-note:hover { box-shadow: 0 4px 14px var(--dsw-alias-bg-mask-2); transform: translateY(-1px); }
		.skw-note[data-archived="true"] { opacity: .72; }
		.skw-note[data-pinned="true"] { box-shadow: 0 2px 10px var(--dsw-alias-bg-mask-2); }
		.skw-note-head { display: flex; align-items: flex-start; gap: 6px; }
		.skw-note-title { font-size: 12.5px; line-height: 18px; font-weight: 600; overflow-wrap: anywhere; }
		.skw-note-body { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 19px; flex: 1; }
		.skw-note-body.is-clamped { display: -webkit-box; -webkit-line-clamp: 9; -webkit-box-orient: vertical; overflow: hidden; }
		.skw-note-tags { display: flex; flex-wrap: wrap; gap: 4px; }
		.skw-tag { padding: 0 6px; height: 18px; line-height: 18px; border-radius: 9px; font-size: 11px; background: var(--dsw-alias-bg-mask-2); color: inherit; opacity: .85; }
		.skw-note-foot { display: flex; align-items: center; gap: 4px; font-size: 11px; line-height: 16px; opacity: .82; }
		.skw-note-foot .skw-spacer { flex: 1; }
		.skw-note-tools { position: absolute; top: 6px; right: 6px; display: flex; gap: 2px; opacity: 0; transition: opacity .12s ease; }
		.skw-note:hover .skw-note-tools, .skw-note:focus-within .skw-note-tools { opacity: 1; }
		.skw-icon-btn { width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 0; border-radius: 6px; background: var(--dsw-alias-bg-mask-2); color: inherit; cursor: pointer; }
		.skw-icon-btn:hover { background: var(--dsw-alias-bg-mask-3); }
		.skw-icon-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
		.skw-icon-btn[data-on="true"] { color: var(--dsw-alias-brand-primary); }
		.skw-pin { flex: none; font-size: 12px; line-height: 16px; }

		/* Pastel palettes: each keeps a light and dark ink pair. */
		.skw-note[data-color="yellow"] { background: #fdf6d8; color: #4a3f14; border-color: #efe1a8; }
		.skw-note[data-color="pink"]   { background: #fde8ee; color: #5a2739; border-color: #f3ccd8; }
		.skw-note[data-color="green"]  { background: #e5f6e8; color: #21432a; border-color: #c6e7ce; }
		.skw-note[data-color="blue"]   { background: #e4f0fd; color: #1f3a55; border-color: #c5dcf3; }
		.skw-note[data-color="purple"] { background: #efe8fd; color: #3a2b5a; border-color: #d9ccf4; }
		.skw-note[data-color="orange"] { background: #fdeee0; color: #553318; border-color: #f3d6b8; }
		body[data-ds-dark-theme] .skw-note[data-color="yellow"] { background: #4a4322; color: #f5ecc4; border-color: #5f5630; }
		body[data-ds-dark-theme] .skw-note[data-color="pink"]   { background: #4a2a35; color: #f8dfe6; border-color: #613a47; }
		body[data-ds-dark-theme] .skw-note[data-color="green"]  { background: #22422c; color: #d9f2df; border-color: #2f5940; }
		body[data-ds-dark-theme] .skw-note[data-color="blue"]   { background: #21374b; color: #d8e9fb; border-color: #2e4b64; }
		body[data-ds-dark-theme] .skw-note[data-color="purple"] { background: #322a4a; color: #e5dcfa; border-color: #443a63; }
		body[data-ds-dark-theme] .skw-note[data-color="orange"] { background: #4a3520; color: #f9e2c9; border-color: #63472b; }

		/* Composer sheet */
		.skw-scrim { position: fixed; inset: 0; background: var(--dsw-alias-bg-mask-2); display: flex; align-items: center; justify-content: center; padding: 24px; z-index: 40; }
		.skw-sheet { width: min(560px, 100%); max-height: 86vh; display: flex; flex-direction: column; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); box-shadow: 0 12px 40px var(--dsw-alias-bg-mask-3); overflow: hidden; }
		.skw-sheet-head { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1); font-weight: 600; }
		.skw-sheet-body { padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; overflow: auto; }
		.skw-input, .skw-textarea { width: 100%; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); padding: 7px 10px; }
		.skw-input:focus-visible, .skw-textarea:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
		.skw-textarea { min-height: 132px; resize: vertical; line-height: 19px; }
		.skw-swatches { display: flex; gap: 6px; align-items: center; }
		.skw-swatch { width: 22px; height: 22px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0; }
		.skw-swatch[data-on="true"] { border-color: var(--dsw-alias-label-primary); }
		.skw-sheet-foot { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--dsw-alias-border-l1); }
		.skw-sheet-foot .skw-spacer { flex: 1; }
		.skw-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
		.skw-error { margin: 0; padding: 6px 16px; font-size: 12px; color: var(--dsw-alias-state-error-primary); }

		/* Sidebar glyph */
		.skw-glyph { display: block; }
		`;
		var SWATCHES = [
		  { key: "yellow", css: "#f7d774" },
		  { key: "pink", css: "#f5b8c8" },
		  { key: "green", css: "#a8d8b0" },
		  { key: "blue", css: "#a8cdf0" },
		  { key: "purple", css: "#c3b3ee" },
		  { key: "orange", css: "#f3b98a" }
		];

		// src/client/view.tsx
		var import_jsx_runtime = require("react/jsx-runtime");
		function SidebarGlyph({ size = 18 }) {
		  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { className: "skw-glyph", width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true", children: [
		    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("rect", { x: "4", y: "7.5", width: "11.5", height: "11.5", rx: "2", stroke: "currentColor", strokeWidth: "1.6" }),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M8.5 5.2h8.2a2.4 2.4 0 0 1 2.4 2.4v8.2", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round" }),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M6.9 11h5.7M6.9 14.4h4", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", opacity: "0.75" })
		  ] });
		}
		function formatTime(iso, locale) {
		  const stamp = new Date(iso);
		  if (Number.isNaN(stamp.getTime())) return iso;
		  const now = Date.now();
		  const minutes = Math.round((now - stamp.getTime()) / 6e4);
		  const zh2 = locale.toLowerCase().startsWith("zh");
		  if (minutes < 1) return zh2 ? "\u521A\u521A" : "just now";
		  if (minutes < 60) return zh2 ? `${minutes} \u5206\u949F\u524D` : `${minutes}m ago`;
		  const hours = Math.round(minutes / 60);
		  if (hours < 24) return zh2 ? `${hours} \u5C0F\u65F6\u524D` : `${hours}h ago`;
		  const days = Math.round(hours / 24);
		  if (days < 7) return zh2 ? `${days} \u5929\u524D` : `${days}d ago`;
		  return stamp.toLocaleDateString(zh2 ? "zh-CN" : "en-US", { month: "short", day: "numeric" });
		}
		function parseTags(raw) {
		  return raw.split(/[,，\s]+/).map((tag) => tag.trim()).filter((tag) => tag !== "");
		}
		function Composer({
		  draft,
		  t,
		  busy,
		  error,
		  onChange,
		  onSave,
		  onCancel
		}) {
		  const bodyRef = (0, import_react.useRef)(null);
		  (0, import_react.useEffect)(() => {
		    bodyRef.current?.focus();
		  }, []);
		  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "skw-scrim", role: "presentation", onMouseDown: (event) => {
		    if (event.target === event.currentTarget && !busy) onCancel();
		  }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
		    "div",
		    {
		      className: "skw-sheet",
		      role: "dialog",
		      "aria-modal": "true",
		      "aria-label": draft.id ? t("edit") : t("new"),
		      onKeyDown: (event) => {
		        if (event.repeat) return;
		        if (event.key === "Escape" && !busy) onCancel();
		        if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !busy) {
		          event.preventDefault();
		          onSave();
		        }
		      },
		      children: [
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "skw-sheet-head", children: draft.id ? t("edit") : t("new") }),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "skw-sheet-body", children: [
		          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		            "input",
		            {
		              className: "skw-input",
		              value: draft.title,
		              placeholder: t("titlePlaceholder"),
		              maxLength: LIMITS.title,
		              onChange: (event) => onChange({ title: event.target.value }),
		              "aria-label": t("titlePlaceholder")
		            }
		          ),
		          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		            "textarea",
		            {
		              ref: bodyRef,
		              className: "skw-textarea",
		              value: draft.body,
		              placeholder: t("bodyPlaceholder"),
		              maxLength: LIMITS.body,
		              onChange: (event) => onChange({ body: event.target.value }),
		              "aria-label": t("bodyPlaceholder")
		            }
		          ),
		          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		            "input",
		            {
		              className: "skw-input",
		              value: draft.tags,
		              placeholder: t("tagsPlaceholder"),
		              onChange: (event) => onChange({ tags: event.target.value }),
		              "aria-label": t("tagsPlaceholder")
		            }
		          ),
		          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "skw-swatches", role: "group", "aria-label": t("colorLabel"), children: SWATCHES.map((swatch) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		            "button",
		            {
		              type: "button",
		              className: "skw-swatch",
		              "data-on": draft.color === swatch.key,
		              style: { background: swatch.css },
		              "aria-label": swatch.key,
		              "aria-pressed": draft.color === swatch.key,
		              onClick: () => onChange({ color: swatch.key })
		            },
		            swatch.key
		          )) }),
		          error !== "" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "skw-error", role: "alert", children: error })
		        ] }),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "skw-sheet-foot", children: [
		          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "skw-hint", children: t("saveHint") }),
		          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "skw-spacer" }),
		          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "skw-btn", type: "button", onClick: onCancel, disabled: busy, children: t("cancel") }),
		          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "skw-btn skw-btn-primary", type: "button", onClick: onSave, disabled: busy, children: t("save") })
		        ] })
		      ]
		    }
		  ) });
		}
		function ConfirmDialog({
		  title,
		  message,
		  confirmLabel,
		  cancelLabel,
		  busy,
		  onConfirm,
		  onCancel
		}) {
		  const cancelRef = (0, import_react.useRef)(null);
		  (0, import_react.useEffect)(() => {
		    const previous = typeof document === "undefined" ? null : document.activeElement;
		    cancelRef.current?.focus();
		    return () => {
		      if (previous !== null && typeof previous.focus === "function") previous.focus();
		    };
		  }, []);
		  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		    "div",
		    {
		      className: "skw-scrim",
		      role: "presentation",
		      onMouseDown: (event) => {
		        if (event.target === event.currentTarget && !busy) onCancel();
		      },
		      children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
		        "div",
		        {
		          className: "skw-sheet",
		          role: "dialog",
		          "aria-modal": "true",
		          "aria-label": title,
		          style: { width: "min(420px, 100%)" },
		          onKeyDown: (event) => {
		            if (event.repeat) return;
		            if (event.key === "Escape" && !busy) {
		              event.stopPropagation();
		              onCancel();
		            }
		          },
		          children: [
		            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "skw-sheet-head", children: title }),
		            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "skw-sheet-body", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { margin: 0 }, children: message }) }),
		            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "skw-sheet-foot", children: [
		              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "skw-spacer" }),
		              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { ref: cancelRef, className: "skw-btn", type: "button", onClick: onCancel, disabled: busy, children: cancelLabel }),
		              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "skw-btn skw-btn-danger", type: "button", onClick: onConfirm, disabled: busy, children: confirmLabel })
		            ] })
		          ]
		        }
		      )
		    }
		  );
		}
		function NoteCard({ note, t, locale, onEdit, onPatch, onRemove }) {
		  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
		    "article",
		    {
		      className: "skw-note",
		      "data-color": note.color,
		      "data-pinned": note.pinned,
		      "data-archived": note.archived,
		      "aria-label": note.title || note.body.slice(0, 40),
		      tabIndex: 0,
		      onDoubleClick: () => onEdit(note),
		      children: [
		        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "skw-note-tools", children: [
		          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		            "button",
		            {
		              className: "skw-icon-btn",
		              type: "button",
		              title: note.pinned ? t("unpin") : t("pin"),
		              "data-on": note.pinned,
		              "aria-label": note.pinned ? t("unpin") : t("pin"),
		              onClick: () => onPatch(note, { pinned: !note.pinned }),
		              children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "skw-pin", "aria-hidden": "true", children: note.pinned ? "\u2605" : "\u2606" })
		            }
		          ),
		          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "skw-icon-btn", type: "button", title: t("edit"), "aria-label": t("edit"), onClick: () => onEdit(note), children: "\u270E" }),
		          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		            "button",
		            {
		              className: "skw-icon-btn",
		              type: "button",
		              title: note.archived ? t("restore") : t("archive"),
		              "aria-label": note.archived ? t("restore") : t("archive"),
		              onClick: () => onPatch(note, { archived: !note.archived }),
		              children: note.archived ? "\u21A9" : "\u25A4"
		            }
		          ),
		          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "skw-icon-btn", type: "button", title: t("delete"), "aria-label": t("delete"), onClick: () => onRemove(note), children: "\u2715" })
		        ] }),
		        note.title !== "" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "skw-note-head", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "skw-note-title", children: note.title }) }),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "skw-note-body is-clamped", children: note.body }),
		        note.tags.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "skw-note-tags", children: note.tags.map((tag) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "skw-tag", children: [
		          "#",
		          tag
		        ] }, tag)) }),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "skw-note-foot", children: [
		          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: formatTime(note.updatedAt, locale) }),
		          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "skw-spacer" }),
		          note.archived && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t("archive") }),
		          note.pinned && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { "aria-hidden": "true", children: "\u2605" })
		        ] })
		      ]
		    }
		  );
		}
		function WallPage({ api, locale, t }) {
		  const [notes, setNotes] = (0, import_react.useState)([]);
		  const [filter, setFilter] = (0, import_react.useState)("all");
		  const [sort, setSort] = (0, import_react.useState)("pinned");
		  const [query, setQuery] = (0, import_react.useState)("");
		  const [showArchived, setShowArchived] = (0, import_react.useState)(false);
		  const [loading, setLoading] = (0, import_react.useState)(true);
		  const [busy, setBusy] = (0, import_react.useState)(false);
		  const [error, setError] = (0, import_react.useState)("");
		  const [draft, setDraft] = (0, import_react.useState)(null);
		  const [draftError, setDraftError] = (0, import_react.useState)("");
		  const [confirming, setConfirming] = (0, import_react.useState)(null);
		  const [, setLocaleRevision] = (0, import_react.useState)(0);
		  const alive = (0, import_react.useRef)(true);
		  const life = (0, import_react.useRef)(new AbortController());
		  const sequence = (0, import_react.useRef)(0);
		  const inFlight = (0, import_react.useRef)(false);
		  const activeLocale = locale.getSnapshot().active;
		  (0, import_react.useEffect)(() => {
		    const unsubscribe = locale.subscribe(() => {
		      if (alive.current) setLocaleRevision((value) => value + 1);
		    });
		    return unsubscribe;
		  }, [locale]);
		  const reload = (0, import_react.useMemo)(() => async (options) => {
		    const seq = ++sequence.current;
		    setLoading(true);
		    try {
		      const next = await api.list(options.includeArchived, options.sort, life.current.signal);
		      if (alive.current && seq === sequence.current) {
		        setNotes(next);
		        if (options.clearError !== false) setError("");
		      }
		    } catch (cause) {
		      if (alive.current && seq === sequence.current && !life.current.signal.aborted) setError(errorText(cause, t));
		    } finally {
		      if (alive.current && seq === sequence.current) setLoading(false);
		    }
		  }, [api, t]);
		  const includeArchived = showArchived || filter === "archived";
		  (0, import_react.useEffect)(() => {
		    alive.current = true;
		    life.current = new AbortController();
		    void reload({ includeArchived, sort });
		    return () => {
		      alive.current = false;
		      life.current.abort();
		      sequence.current += 1;
		    };
		  }, [reload, includeArchived, sort]);
		  async function mutate(run) {
		    if (inFlight.current) return;
		    inFlight.current = true;
		    setBusy(true);
		    setError("");
		    try {
		      await run();
		    } catch (cause) {
		      if (alive.current && !life.current.signal.aborted) setError(errorText(cause, t));
		    } finally {
		      if (alive.current) {
		        await reload({ includeArchived, sort, clearError: false }).catch(() => {
		        });
		        setBusy(false);
		      }
		      inFlight.current = false;
		    }
		  }
		  function openComposer(note) {
		    setDraftError("");
		    setDraft(note ? { id: note.id, title: note.title, body: note.body, tags: note.tags.join(" "), color: note.color } : { id: null, title: "", body: "", tags: "", color: "yellow" });
		  }
		  async function saveDraft() {
		    if (!draft || inFlight.current) return;
		    const body = draft.body.trim();
		    if (body === "") {
		      setDraftError(t("emptyBody"));
		      return;
		    }
		    setDraftError("");
		    await mutate(async () => {
		      const tags = parseTags(draft.tags);
		      if (draft.id === null) {
		        await api.create({ body, title: draft.title.trim(), tags, color: draft.color }, life.current.signal);
		      } else {
		        await api.update(draft.id, { body, title: draft.title.trim(), tags, color: draft.color }, life.current.signal);
		      }
		      setDraft(null);
		    });
		  }
		  const visible = (0, import_react.useMemo)(() => {
		    const needle = query.trim().toLowerCase();
		    return notes.filter((note) => {
		      if (filter === "archived" && !note.archived) return false;
		      if (filter === "pinned" && !note.pinned) return false;
		      if (filter === "all" && note.archived && !showArchived) return false;
		      if (needle === "") return true;
		      return `${note.title} ${note.body} ${note.tags.join(" ")}`.toLowerCase().includes(needle);
		    });
		  }, [notes, filter, query, showArchived]);
		  const archivedCount = notes.filter((note) => note.archived).length;
		  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "skw-page", "aria-label": t("title"), children: [
		    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("style", { children: WALL_CSS }),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", { className: "skw-head", children: [
		      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "skw-head-text", children: [
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h1", { className: "skw-title", children: t("title") }),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "skw-subtitle", children: t("subtitle") })
		      ] }),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "skw-actions", children: [
		        archivedCount > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "skw-btn skw-btn-quiet", type: "button", onClick: () => setConfirming("clear"), disabled: busy, children: t("clearArchived") }),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", { className: "skw-btn skw-btn-primary", type: "button", onClick: () => openComposer(), disabled: busy, children: [
		          "+ ",
		          t("new")
		        ] })
		      ] })
		    ] }),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "skw-toolbar", children: [
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		        "input",
		        {
		          className: "skw-search",
		          type: "search",
		          value: query,
		          placeholder: t("search"),
		          "aria-label": t("search"),
		          onChange: (event) => setQuery(event.target.value)
		        }
		      ),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "skw-seg", role: "group", "aria-label": t("filters"), children: ["all", "pinned", "archived"].map((key) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", "data-on": filter === key, onClick: () => setFilter(key), children: key === "all" ? t("all") : key === "pinned" ? t("pin") : t("archive") }, key)) }),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		        "button",
		        {
		          className: "skw-toggle",
		          type: "button",
		          "data-on": showArchived,
		          "aria-pressed": showArchived,
		          onClick: () => setShowArchived((value) => !value),
		          children: showArchived ? t("hideArchived") : t("showArchived")
		        }
		      ),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "skw-seg", role: "group", "aria-label": t("sortPinned"), children: ["pinned", "created", "updated"].map((key) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", "data-on": sort === key, onClick: () => setSort(key), children: key === "pinned" ? t("sortPinned") : key === "created" ? t("sortCreated") : t("sortUpdated") }, key)) }),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "skw-count", children: t("count", { count: visible.length }) })
		    ] }),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "skw-body", children: [
		      error !== "" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { className: "skw-error", role: "alert", children: [
		        error,
		        " ",
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "skw-btn skw-btn-quiet", type: "button", onClick: () => void reload({ includeArchived, sort }), children: t("retry") })
		      ] }),
		      loading && notes.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "skw-empty", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: t("loading") }) }) : visible.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "skw-empty", children: [
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "skw-empty-icon", "aria-hidden": "true", children: "\u{1F5D2}\uFE0F" }),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: filter === "archived" ? t("emptyArchived") : query.trim() !== "" ? t("noResults") : t("empty") }),
		        filter !== "archived" && query.trim() === "" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "skw-btn", type: "button", onClick: () => openComposer(), children: t("new") })
		      ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "skw-grid", children: visible.map((note) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		        NoteCard,
		        {
		          note,
		          t,
		          locale: activeLocale,
		          onEdit: openComposer,
		          onPatch: (target, patch) => void mutate(async () => {
		            await api.update(target.id, patch, life.current.signal);
		          }),
		          onRemove: (target) => setConfirming(target)
		        },
		        note.id
		      )) })
		    ] }),
		    draft && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		      Composer,
		      {
		        draft,
		        t,
		        busy,
		        error: draftError,
		        onChange: (patch) => setDraft((current) => current === null ? current : { ...current, ...patch }),
		        onSave: () => void saveDraft(),
		        onCancel: () => {
		          if (!busy) {
		            setDraft(null);
		            setDraftError("");
		          }
		        }
		      }
		    ),
		    confirming !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		      ConfirmDialog,
		      {
		        title: confirming === "clear" ? t("clearArchived") : t("delete"),
		        message: confirming === "clear" ? t("confirmClear") : t("confirmDelete"),
		        confirmLabel: t("delete"),
		        cancelLabel: t("cancel"),
		        busy,
		        onConfirm: () => {
		          const target = confirming;
		          setConfirming(null);
		          void mutate(async () => {
		            if (target === "clear") await api.clearArchived(life.current.signal);
		            else await api.remove([target.id], life.current.signal);
		          });
		        },
		        onCancel: () => setConfirming(null)
		      }
		    )
		  ] });
		}
		function errorText(cause, t) {
		  if (cause instanceof ActionError) {
		    const known = {
		      "sticky-wall/empty-body": "emptyBody",
		      "sticky-wall/wall-full": "wallFull",
		      "sticky-wall/body-too-long": "tooLong",
		      "sticky-wall/title-too-long": "tooLong"
		    };
		    const key = known[cause.code];
		    return key === void 0 ? cause.message : t(key);
		  }
		  return cause instanceof Error ? cause.message : String(cause);
		}

		// src/client/index.tsx
		var import_jsx_runtime2 = require("react/jsx-runtime");
		var inject = ["slots", "locale", "connection"];
		var SIDEBAR_SLOT = "sidebar.panellist";
		var MAIN_SLOT = "main";
		function registerDictionaries(ctx) {
		  try {
		    return ctx.locale.register(NAMESPACE, { zh: { ...zh }, en: { ...en } });
		  } catch {
		    return void 0;
		  }
		}
		function apply(ctx) {
		  const lifetime = new AbortController();
		  const t = ctx.locale.bind(NAMESPACE);
		  const api = createApi(ctx.connection, lifetime.signal);
		  ctx.effect(() => {
		    const disposeDictionary = registerDictionaries(ctx);
		    return () => {
		      lifetime.abort();
		      try {
		        disposeDictionary?.();
		      } catch {
		      }
		    };
		  }, "skillre-sticky-wall client lifetime");
		  ctx.effect(
		    () => ctx.slots.inject(
		      SIDEBAR_SLOT,
		      () => ctx.slots.register({ name: SIDEBAR_SLOT, id: PANEL_ID, order: 30, label: () => t("nav") }, SidebarGlyph)
		    ),
		    "skillre-sticky-wall sidebar entry"
		  );
		  ctx.effect(
		    () => ctx.slots.inject(MAIN_SLOT, () => ctx.slots.register({ name: MAIN_SLOT, key: PANEL_ID }, () => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(WallPage, { api, locale: ctx.locale, t }))),
		    "skillre-sticky-wall wall page"
		  );
		}

		return module.exports;
	}
});
