// ComfyUI-Danbooru-Autocomplete 前端扩展
// 在所有提示词输入框（textarea.comfy-multiline-input，如 CLIP Text Encode）中提供
// Danbooru 标签自动补全：输入字母后弹出候选列表。
// 列表为虚拟滚动：无论候选有多少条，始终只渲染可见的十几行，用滚轮/键盘翻页浏览。
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const ROW_H = 26; // 每行高度(px)，与 CSS 中 .dbac-row 保持一致
const LS_KEY = "DanbooruAutocomplete.settings";
const DEFAULTS = {
	enabled: true, // 启用补全
	hideNsfw: false, // 隐藏 NSFW 标签（需要词库带 nsfw 标记）
	minChars: 1, // 最少输入字符数
	maxVisible: 12, // 列表最多可见行数
	maxResults: 4000, // 参与候选的最大条数（虚拟滚动，超出部分滚轮翻不到）
	insertComma: true, // 选中后自动追加 ", "
	manualOnly: false, // 仅 Ctrl+Space 手动触发（关闭则输入字母自动弹出）
	insertSpace: false, // 插入时把下划线转成空格（适配自然语言类模型）
	showGeneral: true, // 类别显示开关：general（常规）
	showArtist: true, // 类别显示开关：artist（画师）
	showCopyright: true, // 类别显示开关：copyright（系列）
	showCharacter: true, // 类别显示开关：character（角色）
	showMeta: true, // 类别显示开关：meta（元信息）
};
const KEYS_CONSUMED = new Set([
	"ArrowDown", "ArrowUp", "PageUp", "PageDown", "Home", "End",
	"Enter", "Tab", "Escape",
]);

function readStore() {
	try {
		return JSON.parse(localStorage.getItem(LS_KEY) || "{}") || {};
	} catch (e) {
		return {};
	}
}
function saveStore() {
	try {
		localStorage.setItem(LS_KEY, JSON.stringify(settings));
	} catch (e) {}
}
const settings = Object.assign({}, DEFAULTS, readStore());

// ---------------- 收藏 / 最近使用 ----------------
let favList = [];
let recentList = [];
const favSet = new Set();
try {
	favList = JSON.parse(localStorage.getItem("DanbooruAutocomplete.favorites") || "[]") || [];
	recentList = JSON.parse(localStorage.getItem("DanbooruAutocomplete.recent") || "[]") || [];
} catch (e) {}
favList.forEach((n) => favSet.add(n));

function persistFavRecent() {
	try {
		localStorage.setItem("DanbooruAutocomplete.favorites", JSON.stringify(favList));
		localStorage.setItem("DanbooruAutocomplete.recent", JSON.stringify(recentList));
	} catch (e) {}
}

function toggleFav(name) {
	if (favSet.has(name)) {
		favSet.delete(name);
		favList = favList.filter((n) => n !== name);
	} else {
		favSet.add(name);
		favList.unshift(name);
		if (favList.length > 100) favList.length = 100;
	}
	persistFavRecent();
}

function recordRecent(name) {
	recentList = recentList.filter((n) => n !== name);
	recentList.unshift(name);
	if (recentList.length > 30) recentList.length = 30;
	persistFavRecent();
}

// 收藏优先、最近使用次之，其余保持热度序
function applyPriority(items) {
	if (!favList.length && !recentList.length) return items;
	const fr = new Map(favList.map((n, i) => [n, i]));
	const rr = new Map(recentList.map((n, i) => [n, i]));
	const favs = [];
	const recs = [];
	const rest = [];
	for (const it of items) {
		if (fr.has(it.n)) favs.push(it);
		else if (rr.has(it.n)) recs.push(it);
		else rest.push(it);
	}
	favs.sort((a, b) => fr.get(a.n) - fr.get(b.n));
	recs.sort((a, b) => rr.get(a.n) - rr.get(b.n));
	return favs.concat(recs, rest);
}

// ---------------- 词库 ----------------
// TAGS: { n: 标签名, c: 类别, k: post_count, x: nsfw(0/1), z: 中文翻译 }
let TAGS = [];
let LOWER = [];
let NAME_IDX = new Map(); // 小写标签名 -> TAGS 下标
let loaded = false;
let lastTry = 0;

async function loadTags(force = false) {
	if (loaded && !force) return true;
	const now = Date.now();
	if (now - lastTry < 30000) return TAGS.length > 0; // 失败后 30s 内不反复请求
	lastTry = now;
	try {
		const res = await api.fetchApi("/danbooru_ac/tags", { cache: "no-store" });
		if (!res.ok) throw new Error("HTTP " + res.status);
		const data = await res.json();
		const arr = Array.isArray(data) ? data : data.tags || [];
		const tags = [];
		for (const t of arr) {
			if (Array.isArray(t)) {
				if (typeof t[0] === "string" && t[0]) {
					tags.push({ n: t[0], c: t[1] || 0, k: t[2] || 0, x: t[3] || 0, z: t[4] || "" });
				}
			} else if (t && typeof t.n === "string") {
				tags.push({ n: t.n, c: t.c || 0, k: t.k || 0, x: t.x || 0, z: t.z || "" });
			}
		}
		tags.sort((a, b) => b.k - a.k);
		TAGS = tags;
		LOWER = TAGS.map((t) => t.n.toLowerCase());
		NAME_IDX = new Map();
		LOWER.forEach((n, i) => {
			if (!NAME_IDX.has(n)) NAME_IDX.set(n, i);
		});
		loaded = true; // 空词库也视为已加载，避免每次击键都重试请求
		if (!TAGS.length) {
			const msg = data && data.message;
			if (msg) showMissingToast(msg);
		}
		console.log(`[DanbooruAC] 词库加载完成: ${TAGS.length} 条`);
		return true;
	} catch (err) {
		console.warn("[DanbooruAC] 词库加载失败:", err);
		return false;
	}
}

// ---------------- LoRA 触发词 ----------------
// data/lora_triggers.json: {"lora文件名特征词": ["触发词1", "触发词2"]}
// 工作流里挂了文件名匹配的 LoRA 时，对应触发词在候选中置顶；已在提示词里的自动跳过
let LORA_TRIGGERS = null;

async function loadLoraTriggers() {
	try {
		const res = await api.fetchApi("/danbooru_ac/lora_triggers", { cache: "no-store" });
		if (res.ok) {
			const data = await res.json();
			// 兼容两种格式：{"triggers": {...}} 包裹式，或直接 {"lora关键词": [触发词...]} 平铺式
			if (data && typeof data === "object") {
				LORA_TRIGGERS = data.triggers && typeof data.triggers === "object" ? data.triggers : data;
			} else {
				LORA_TRIGGERS = {};
			}
			const n = Object.keys(LORA_TRIGGERS).filter((k) => !k.startsWith("_")).length;
			console.log(`[DanbooruAC] LoRA 触发词映射已加载: ${n} 条`);
		} else {
			LORA_TRIGGERS = {};
		}
	} catch (e) {
		console.warn("[DanbooruAC] lora_triggers.json 解析失败（请检查 JSON 格式，行间逗号/引号）:", e);
		LORA_TRIGGERS = {};
	}
}

// 扫描工作流：收集所有已挂载的 LoRA 文件名（兼容 LoraLoader / ModelOnly / rgthree Power Lora Loader）
function collectLoras() {
	const out = [];
	try {
		const nodes = (app.graph && app.graph._nodes) || [];
		for (const n of nodes) {
			const type = String(n.comfyClass || n.type || "");
			for (const w of n.widgets || []) {
				if (w.name === "lora_name" && typeof w.value === "string" && w.value) {
					out.push(w.value);
				} else if (type.includes("Power Lora") && typeof w.value === "string" && w.value.startsWith("{")) {
					try {
						const cfg = JSON.parse(w.value);
						for (const entry of cfg.loras || []) {
							if (entry && entry.lora) out.push(entry.lora);
						}
					} catch (e) {}
				}
			}
		}
	} catch (e) {}
	return [...new Set(out)];
}

// 汇总当前 LoRA 对应的触发词（合成候选项，词库已有的用词库行）

// ---------------- 匹配 ----------------
// q: 已转为小写、空格转下划线后的当前词
// 词库按 post_count 降序存储，这里按存储顺序单趟扫描，
// 候选天然就是"热度从大到小"排列；完整匹配（等于输入词）额外置顶。
// 去掉列表中重复的标签名（保留首个）
function dedupeNames(items) {
	const seen = new Set();
	const out = [];
	for (const it of items) {
		if (seen.has(it.n)) continue;
		seen.add(it.n);
		out.push(it);
	}
	return out;
}

// 类别显示开关
function catVisible(c) {
	if (c === 0) return settings.showGeneral;
	if (c === 1) return settings.showArtist;
	if (c === 3) return settings.showCopyright;
	if (c === 4) return settings.showCharacter;
	if (c === 5) return settings.showMeta;
	return true;
}

function rowHidden(t) {
	if (settings.hideNsfw && t.x) return true;
	return !catVisible(t.c);
}

function findMatches(q, raw) {
	const cap = Math.max(100, settings.maxResults | 0);

	// 中文反查：输入含中文时按词库翻译字段匹配，返回对应的英文标签
	if (/[\u4e00-\u9fff]/.test(q)) {
		const key = ((raw || q).toLowerCase() || "").replace(/[\s_]+/g, "");
		const starts = [];
		const inner = [];
		if (key) {
			for (const t of TAGS) {
				if (!t.z || rowHidden(t)) continue;
				const z = t.z.toLowerCase();
				if (z.startsWith(key)) starts.push(t);
				else if (z.includes(key)) inner.push(t);
				if (starts.length + inner.length >= cap) break;
			}
		}
		return { items: applyPriority(starts.concat(inner)), exact: null };
	}

	let exactIdx = NAME_IDX.get(q);
	if (exactIdx != null && rowHidden(TAGS[exactIdx])) exactIdx = undefined;
	const innerMin = 3; // 包含匹配仅输入 >=3 字符时启用，减少单字符噪音
	const items = [];
	for (let i = 0; i < LOWER.length && items.length < cap; i++) {
		if (i === exactIdx) continue;
		const n = LOWER[i];
		const hit = n.startsWith(q) || (q.length >= innerMin && n.includes(q));
		if (hit && !rowHidden(TAGS[i])) items.push(TAGS[i]);
	}
	const exact = exactIdx != null ? TAGS[exactIdx] : null;
	return { items: applyPriority(items), exact };
}

// 手动触发且无输入时展示的全量热门列表
function popularItems() {
	const cap = Math.max(100, settings.maxResults | 0);
	const out = [];
	for (const t of TAGS) {
		if (rowHidden(t)) continue;
		out.push(t);
		if (out.length >= cap) break;
	}
	return applyPriority(out);
}

// ---------------- 弹出层 UI ----------------
let popup, listEl, spacerEl, footerEl, filterEl, mirror;

const CSS = `
#dbac-popup {
	position: fixed;
	z-index: 99999;
	display: none;
	flex-direction: column;
	min-width: 280px;
	max-width: 480px;
	background: var(--comfy-menu-bg, #1e1e1e);
	color: var(--input-text, #dddddd);
	border: 1px solid var(--border-color, #444444);
	border-radius: 6px;
	box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55);
	overflow: hidden;
	font: 12px/1.4 "Segoe UI", system-ui, sans-serif;
}
#dbac-popup.open { display: flex; }
#dbac-list {
	position: relative;
	overflow-y: auto;
	overscroll-behavior: contain;
	user-select: none;
	max-height: 70vh;
}
#dbac-spacer { position: absolute; top: 0; left: 0; width: 1px; }
.dbac-row {
	position: absolute;
	left: 0;
	right: 0;
	height: ${ROW_H}px;
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 0 10px;
	cursor: pointer;
	white-space: nowrap;
}
.dbac-row:hover { background: var(--comfy-input-bg, #333333); }
.dbac-row.sel { background: #2a5d8f; color: #ffffff; }
.dbac-name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; }
.dbac-name b { color: #8ecbff; font-weight: 600; }
.dbac-row.sel .dbac-name b { color: #ffffff; }
.dbac-cn { flex: 0 1 auto; max-width: 45%; overflow: hidden; text-overflow: ellipsis; }
.dbac-row.cat-0 .dbac-cn { color: #8ab4dc; } /* general 蓝 */
.dbac-row.cat-1 .dbac-cn { color: #d98c8c; } /* artist 红 */
.dbac-row.cat-3 .dbac-cn { color: #c39ac3; } /* copyright 紫 */
.dbac-row.cat-4 .dbac-cn { color: #8fc78f; } /* character 绿 */
.dbac-row.cat-5 .dbac-cn { color: #e0a05c; } /* meta 橙 */
.dbac-row.sel .dbac-cn { filter: brightness(1.3); }
.dbac-row.lora-row .dbac-name { flex: 0 1 auto; max-width: 38%; }
.dbac-row.lora-row .dbac-cn { flex: 1 1 auto; max-width: none; }
.dbac-row.lora-row .dbac-count { color: #e0a05c; }
.dbac-row.lora-row.sel .dbac-count { color: #ffd76e; }
.dbac-count { flex: 0 0 auto; color: #888888; font-size: 11px; font-variant-numeric: tabular-nums; }
.dbac-row.sel .dbac-count { color: #cfe3ff; }
.dbac-star { flex: 0 0 auto; width: 16px; text-align: center; color: #666666; cursor: pointer; font-size: 12px; }
.dbac-star:hover { color: #f5c542; }
.dbac-star.on { color: #f5c542; }
.dbac-row.sel .dbac-star { color: #d0d0d0; }
.dbac-row.sel .dbac-star.on { color: #ffd76e; }
.dbac-row.cat-0 { border-left: 3px solid #8ab4dc; } /* general */
.dbac-row.cat-1 { border-left: 3px solid #cc6666; } /* artist */
.dbac-row.cat-3 { border-left: 3px solid #aa77aa; } /* copyright */
.dbac-row.cat-4 { border-left: 3px solid #66aa66; } /* character */
.dbac-row.cat-5 { border-left: 3px solid #dd8833; } /* meta */
#dbac-filter {
	flex: 0 0 auto;
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
	padding: 5px 8px;
	border-bottom: 1px solid var(--border-color, #444444);
}
.dbac-chip {
	padding: 1px 8px;
	border-radius: 10px;
	font-size: 11px;
	cursor: pointer;
	border: 1px solid #555555;
	color: #777777;
	user-select: none;
}
.dbac-chip:hover { border-color: #999999; color: #bbbbbb; }
.dbac-chip[data-cat="0"].on { color: #8ab4dc; border-color: #8ab4dc; }
.dbac-chip[data-cat="1"].on { color: #d98c8c; border-color: #d98c8c; }
.dbac-chip[data-cat="3"].on { color: #c39ac3; border-color: #c39ac3; }
.dbac-chip[data-cat="4"].on { color: #8fc78f; border-color: #8fc78f; }
.dbac-chip[data-cat="5"].on { color: #e0a05c; border-color: #e0a05c; }
#dbac-footer {
	flex: 0 0 auto;
	padding: 4px 10px;
	border-top: 1px solid var(--border-color, #444444);
	color: #888888;
	font-size: 11px;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
#dbac-list::-webkit-scrollbar { width: 8px; }
#dbac-list::-webkit-scrollbar-thumb { background: #555555; border-radius: 4px; }
#dbac-list::-webkit-scrollbar-track { background: transparent; }
`;

const CAT_NAMES = { 0: "general", 1: "artist", 3: "copyright", 4: "character", 5: "meta" };

function fmtCount(k) {
	if (!k) return "";
	if (k >= 1e6) return (k / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
	if (k >= 1e3) return Math.round(k / 1e3) + "k";
	return String(k);
}

function buildUI() {
	if (popup) return;
	const style = document.createElement("style");
	style.textContent = CSS;
	document.head.appendChild(style);

	popup = document.createElement("div");
	popup.id = "dbac-popup";
	listEl = document.createElement("div");
	listEl.id = "dbac-list";
	spacerEl = document.createElement("div");
	spacerEl.id = "dbac-spacer";
	footerEl = document.createElement("div");
	footerEl.id = "dbac-footer";
	filterEl = document.createElement("div");
	filterEl.id = "dbac-filter";
	filterEl.innerHTML = `
		<span class="dbac-chip" data-cat="0">常规</span>
		<span class="dbac-chip" data-cat="1">画师</span>
		<span class="dbac-chip" data-cat="3">系列</span>
		<span class="dbac-chip" data-cat="4">角色</span>
		<span class="dbac-chip" data-cat="5">元信息</span>`;
	listEl.appendChild(spacerEl);
	popup.appendChild(filterEl);
	popup.appendChild(listEl);
	popup.appendChild(footerEl);
	document.body.appendChild(popup);

	filterEl.addEventListener("mousedown", (e) => {
		// preventDefault 防止输入框失焦
		e.preventDefault();
		e.stopPropagation();
		const chip = e.target.closest(".dbac-chip");
		if (!chip) return;
		const key = { 0: "showGeneral", 1: "showArtist", 3: "showCopyright", 4: "showCharacter", 5: "showMeta" }[+chip.dataset.cat];
		if (!key) return;
		settings[key] = !settings[key];
		saveStore();
		syncSettingUI(key);
		renderChips();
		if (state.ta) refreshIfOpen(state.ta);
	});

	listEl.addEventListener("scroll", () => renderRows());
	listEl.addEventListener("mousedown", (e) => {
		// preventDefault 防止输入框失焦
		e.preventDefault();
		const row = e.target.closest(".dbac-row");
		if (!row) return;
		if (e.target.closest(".dbac-star")) {
			toggleFav(row.dataset.name);
			renderRows();
			return;
		}
		const it = state.items[+row.dataset.i];
		if (it && it.lora) {
			handleLoraClick(it); // LoRA 行：插入/移除触发词，弹窗保持打开
			return;
		}
		accept(+row.dataset.i);
	});
	listEl.addEventListener("mousemove", (e) => {
		const row = e.target.closest(".dbac-row");
		if (!row) return;
		const i = +row.dataset.i;
		if (i !== state.sel) {
			state.sel = i;
			highlight();
		}
	});
}

// ---------------- 状态 ----------------
const state = {
	open: false,
	ta: null, // 当前输入框
	items: [], // 当前候选
	sel: 0, // 当前选中下标
	tokenStart: 0, // 当前词起点
	tokenEnd: 0, // 光标位置
	query: "", // 当前匹配词
	lastCompletion: null, // 最近一次补全（Tab 换候选用）
	suppress: false, // 跳过下一次 input 事件（程序化修改内容时）
	loras: [], // 当前工作流里挂载的 LoRA 文件名
	promptTokens: null, // 当前提示词里已有的标签集合
};

function isPromptArea(el) {
	if (!el || el.tagName !== "TEXTAREA") return false;
	if (el.classList.contains("comfy-multiline-input")) return true;
	return !!el.closest(".comfy-graph-canvas, .graph-canvas-container, #graph-canvas-container");
}

// 取光标所在的“当前词”：以逗号/换行为分隔
function currentToken(ta) {
	const pos = ta.selectionStart ?? ta.value.length;
	const value = ta.value;
	let start = pos;
	while (start > 0) {
		const ch = value[start - 1];
		if (ch === "," || ch === "\n") break;
		start--;
	}
	let ts = start;
	while (ts < pos && (value[ts] === " " || value[ts] === "\t")) ts++;
	return { start: ts, end: pos, raw: value.slice(ts, pos) };
}

function close() {
	state.open = false;
	state.ta = null;
	state.items = [];
	state.loraMode = false;
	if (popup) popup.classList.remove("open");
}

// LoRA 浏览模式行：左边 LoRA 名，右边配置的触发词
function loraBrowseItems() {
	const out = [];
	for (const key in LORA_TRIGGERS) {
		if (key.startsWith("_")) continue;
		const words = LORA_TRIGGERS[key];
		if (!Array.isArray(words) || !words.length) continue;
		out.push({ n: key, c: 5, k: 0, x: 0, z: words.join(", "), lora: words });
	}
	return out;
}

// 点击 LoRA 行：还有未插入的触发词 -> 全部插入（末尾补逗号）；都已插入 -> 全部移除
function handleLoraClick(item) {
	const ta = state.ta;
	if (!ta) return;
	const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, "_");
	const tokens = new Set(ta.value.split(/[,\n]/).map(norm).filter(Boolean));
	const missing = item.lora.filter((w) => !tokens.has(norm(w)));
	state.suppress = true;
	if (missing.length) {
		insertLoraTriggers(ta, missing);
	} else {
		removeLoraTriggers(ta, item.lora);
	}
	update(ta, true); // 刷新行尾的"点击插入/移除"标记
}

// 按光标把提示词切成左右两半，触发词插到中间：左半与右半的原有内容/顺序原样保留
function insertLoraTriggers(ta, triggers) {
	const value = ta.value;
	const caret = ta.selectionStart ?? value.length;
	const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, "_");
	const leftSegs = value.slice(0, caret).split(/[,\n]/);
	const lastLeft = (leftSegs[leftSegs.length - 1] || "").trim();
	const leftTokens = leftSegs.map((t) => t.trim()).filter(Boolean);
	if (/^lora/i.test(lastLeft)) leftTokens.pop(); // "lora" 引导词被触发词组替换
	const rightTokens = value.slice(caret).split(/[,\n]/).map((t) => t.trim()).filter(Boolean);
	const trigNorm = new Set(triggers.map(norm));
	const leftClean = leftTokens.filter((t) => !trigNorm.has(norm(t)));
	const rightClean = rightTokens.filter((t) => !trigNorm.has(norm(t)));
	let newValue = [...leftClean, ...triggers, ...rightClean].join(", ");
	if (!rightClean.length) newValue += ","; // 插在末尾时补尾逗号，方便继续输入
	const caretPos = [...leftClean, ...triggers].join(", ").length + (rightClean.length ? 0 : 1);
	replaceWhole(ta, newValue, Math.min(caretPos, newValue.length));
}

function removeLoraTriggers(ta, triggers) {
	const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, "_");
	const targets = new Set(triggers.map(norm));
	const parts = ta.value
		.split(/[,\n]/)
		.map((t) => t.trim())
		.filter((t) => t && !targets.has(norm(t)));
	const newValue = parts.join(", ");
	replaceWhole(ta, newValue, newValue.length);
}

function replaceWhole(ta, value, caret) {
	ta.focus();
	let ok = false;
	try {
		ta.setSelectionRange(0, ta.value.length);
		ok = document.execCommand("insertText", false, value);
	} catch (e) {}
	if (!ok) {
		ta.setRangeText(value, 0, ta.value.length, "end");
		ta.dispatchEvent(new Event("input", { bubbles: true }));
	}
	if (typeof caret === "number") {
		try {
			ta.setSelectionRange(caret, caret);
		} catch (e) {}
	}
}

function highlight() {
	for (const row of listEl.querySelectorAll(".dbac-row")) {
		row.classList.toggle("sel", +row.dataset.i === state.sel);
	}
}

// 弹窗顶部的类别过滤 chips（与设置页开关同步）
function renderChips() {
	if (!filterEl) return;
	filterEl.querySelectorAll(".dbac-chip").forEach((chip) => {
		const cat = +chip.dataset.cat;
		chip.classList.toggle("on", catVisible(cat));
	});
}

// 把程序内修改的设置值同步回设置页 UI
function syncSettingUI(key) {
	try {
		if (app.ui.settings && app.ui.settings.setSettingValue) {
			app.ui.settings.setSettingValue("DanbooruAC." + key, settings[key]);
		}
	} catch (e) {}
}

function visibleRowsBase() {
	return Math.max(3, settings.maxVisible | 0);
}

function visibleRows() {
	const base = visibleRowsBase();
	return state.fitRows ? Math.max(2, Math.min(base, state.fitRows)) : base;
}

// 虚拟滚动渲染：只创建可视区附近窗口内的行
function renderRows() {
	renderChips();
	const items = state.items;
	if (!popup || !state.open) return;
	const vis = Math.min(items.length, visibleRows());
	listEl.style.height = vis * ROW_H + "px";
	spacerEl.style.height = items.length * ROW_H + "px";
	const first = Math.max(0, Math.floor(listEl.scrollTop / ROW_H) - 3);
	const last = Math.min(items.length, first + vis + 6);
	for (const child of Array.from(listEl.children)) {
		if (child !== spacerEl) child.remove();
	}
	const frag = document.createDocumentFragment();
	for (let i = first; i < last; i++) {
		const it = items[i];
		const row = document.createElement("div");
		row.className =
			"dbac-row cat-" +
			(it.c in CAT_NAMES ? it.c : 0) +
			(it.lora ? " lora-row" : "") +
			(i === state.sel ? " sel" : "");
		row.title = it.z ? it.n + "：" + it.z : it.n;
		row.style.top = i * ROW_H + "px";
		row.dataset.i = i;

		const name = document.createElement("span");
		name.className = "dbac-name";
		if (it.n.toLowerCase().startsWith(state.query)) {
			const b = document.createElement("b");
			b.textContent = it.n.slice(0, state.query.length);
			name.appendChild(b);
			name.appendChild(document.createTextNode(it.n.slice(state.query.length)));
		} else {
			name.textContent = it.n;
		}
		row.appendChild(name);

		if (it.z) {
			const cn = document.createElement("span");
			cn.className = "dbac-cn";
			cn.textContent = it.z.split(",")[0];
			row.appendChild(cn);
		}

		const star = document.createElement("span");
		star.className = "dbac-star" + (favSet.has(it.n) ? " on" : "");
		star.textContent = favSet.has(it.n) ? "★" : "☆";
		star.title = "收藏/取消收藏";
		row.appendChild(star);

		const count = document.createElement("span");
		count.className = "dbac-count";
		if (it.lora) {
			const tokens = new Set(
				(state.ta ? state.ta.value : "").split(/[,\n]/).map((x) => x.trim().toLowerCase().replace(/\s+/g, "_")).filter(Boolean)
			);
			count.textContent = it.lora.every((w) => tokens.has(w.toLowerCase().replace(/\s+/g, "_"))) ? "点击移除" : "点击插入";
		} else {
			count.textContent = fmtCount(it.k) || CAT_NAMES[it.c] || "";
		}
		row.appendChild(count);

		frag.appendChild(row);
	}
	listEl.appendChild(frag);
	const extra = settings.hideNsfw ? " · NSFW已隐藏" : "";
	footerEl.textContent = `${items.length} 个匹配 · 滚轮翻页 · ↑↓选择 · Tab/Enter补全 · ★收藏 · Esc关闭${extra}`;
}

function ensureVisible() {
	const top = state.sel * ROW_H;
	const bottom = top + ROW_H;
	if (top < listEl.scrollTop) listEl.scrollTop = top;
	else if (bottom > listEl.scrollTop + listEl.clientHeight) listEl.scrollTop = bottom - listEl.clientHeight;
}

// 光标像素坐标（镜像 div 方案）
function caretCoords(ta, pos) {
	if (!mirror) {
		mirror = document.createElement("div");
		mirror.setAttribute("aria-hidden", "true");
		document.body.appendChild(mirror);
	}
	const s = mirror.style;
	const cs = getComputedStyle(ta);
	s.position = "absolute";
	s.left = "-9999px";
	s.top = "0";
	s.visibility = "hidden";
	s.whiteSpace = "pre-wrap";
	s.overflowWrap = cs.overflowWrap; // 换行策略与输入框一致
	s.wordBreak = cs.wordBreak;
	s.boxSizing = "content-box";
	// 内容宽度 = clientWidth（不含滚动条/边框）- 左右内边距，保证换行位置与输入框完全一致
	s.width = Math.max(0, ta.clientWidth - parseFloat(cs.paddingLeft || "0") - parseFloat(cs.paddingRight || "0")) + "px";
	s.fontFamily = cs.fontFamily;
	s.fontSize = cs.fontSize;
	s.fontWeight = cs.fontWeight;
	s.fontStyle = cs.fontStyle;
	s.letterSpacing = cs.letterSpacing;
	s.wordSpacing = cs.wordSpacing;
	s.lineHeight = cs.lineHeight;
	s.textTransform = cs.textTransform;
	s.tabSize = cs.tabSize;
	s.paddingLeft = cs.paddingLeft;
	s.paddingRight = cs.paddingRight;
	s.paddingTop = cs.paddingTop;
	s.paddingBottom = cs.paddingBottom;
	mirror.textContent = ta.value.substring(0, pos);
	const span = document.createElement("span");
	span.textContent = ta.value.substring(pos) || ".";
	mirror.appendChild(span);
	const left = span.offsetLeft;
	const top = span.offsetTop;
	mirror.textContent = "";
	return { left, top };
}

function positionPopup() {
	const ta = state.ta;
	if (!ta) return;
	const rect = ta.getBoundingClientRect();
	const cs = getComputedStyle(ta);
	const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5 || 20;
	popup.classList.add("open"); // 先显示才能测量
	let pw = popup.offsetWidth;
	let ph = popup.offsetHeight;
	const chrome = ph - listEl.offsetHeight; // 过滤条 + 底栏的高度
	const vw = window.innerWidth;
	const vh = window.innerHeight;

	// 固定跟随光标右下角
	const caret = caretCoords(ta, Math.min(state.tokenEnd, ta.value.length));
	const cx = rect.left + caret.left - ta.scrollLeft;
	const cy = rect.top + caret.top - ta.scrollTop;
	let x = cx + 6;
	let y = cy + lineH + 6;

	// 高度自适应：下方放不下时先压缩可见行数（最少 2 行）
	const availBelow = vh - 8 - y - chrome;
	if (availBelow < visibleRows() * ROW_H) {
		const fit = Math.max(2, Math.min(visibleRows(), Math.floor(availBelow / ROW_H)));
		if (fit < visibleRows()) {
			state.fitRows = fit;
			renderRows();
			ph = popup.offsetHeight;
		}
	}

	// 视口钳制与翻转
	if (x + pw > vw - 8) x = Math.max(8, vw - pw - 8); // 贴右边（不翻到光标左侧）
	if (y + ph > vh - 8) {
		const above = cy - ph - 6;
		y = above > 8 ? above : Math.max(8, vh - ph - 8); // 只剩 2 行都放不下才翻到光标上方
	}
	popup.style.left = Math.round(x) + "px";
	popup.style.top = Math.round(y) + "px";
}

async function update(ta, manual = false) {
	if (!settings.enabled || !isPromptArea(ta) || document.activeElement !== ta) {
		if (state.ta === ta) close();
		return;
	}
	if (!(await loadTags())) return;
	if (!TAGS.length) return;
	const token = currentToken(ta);
	const ql = token.raw.toLowerCase();
	const q = ql.replace(/\s+/g, "_");
	if (!manual && q.length < settings.minChars) {
		close();
		return;
	}
	state.loras = collectLoras();
	state.promptTokens = new Set(
		ta.value.split(/[,\n]/).map((t) => t.trim().toLowerCase().replace(/\s+/g, "_")).filter(Boolean)
	);
	state.promptTokens.delete(q);
	state.fitRows = null; // 重新定位时会按可用空间重新压缩
	// LoRA 浏览模式：输入以 lora 开头进入（Esc 退出），列出所有已配置的 LoRA 及触发词
	const loraConfigured = LORA_TRIGGERS && Object.keys(LORA_TRIGGERS).some((k) => !k.startsWith("_"));
	if (state.ta && state.ta !== ta) state.loraMode = false; // 切换输入框时退出
	if (loraConfigured && (state.loraMode || /^lora/i.test(ql))) {
		state.loraMode = true;
		state.ta = ta;
		state.items = loraBrowseItems();
		state.sel = 0;
		state.tokenStart = token.start;
		state.tokenEnd = token.end;
		state.query = ql;
		state.open = true;
		renderChips();
		renderRows();
		positionPopup();
		return;
	}
	if (state.loraMode && !loraConfigured) state.loraMode = false;
	let items;
	let exact = null;
	if (q.length === 0) {
		items = popularItems(); // 手动触发且无输入：展示热门词
	} else {
		({ items, exact } = findMatches(q, ql));
		if (!items.length) {
			close();
			return;
		}
	}
	if (exact) items.unshift(exact);
	items = dedupeNames(items);
	state.ta = ta;
	state.items = items;
	state.sel = 0;
	state.tokenStart = token.start;
	state.tokenEnd = token.end;
	state.query = q;
	listEl.scrollTop = 0;
	state.open = true;
	renderRows();
	positionPopup();
}

// 弹窗已打开时，光标移动（点击/左右键）后刷新当前词；无效则关闭
function refreshIfOpen(ta) {
	if (!state.open || state.ta !== ta) return;
	if (state.loraMode) {
		update(ta, true); // LoRA 浏览模式下持续刷新列表状态
		return;
	}
	const token = currentToken(ta);
	const ql = token.raw.toLowerCase();
	const q = ql.replace(/\s+/g, "_");
	if (!settings.manualOnly && q.length < settings.minChars) {
		close();
		return;
	}
	state.loras = collectLoras();
	state.promptTokens = new Set(
		ta.value.split(/[,\n]/).map((t) => t.trim().toLowerCase().replace(/\s+/g, "_")).filter(Boolean)
	);
	state.promptTokens.delete(q);
	state.fitRows = null;
	let items;
	let exact = null;
	if (q.length === 0) {
		items = popularItems();
	} else {
		({ items, exact } = findMatches(q, ql));
		if (!items.length) {
			close();
			return;
		}
	}
	if (exact) items.unshift(exact);
	items = dedupeNames(items);
	state.items = items;
	state.sel = 0;
	state.tokenStart = token.start;
	state.tokenEnd = token.end;
	state.query = q;
	listEl.scrollTop = 0;
	renderRows();
	positionPopup();
}

function accept(i) {
	const ta = state.ta;
	const item = state.items[i];
	if (!ta || !item) {
		close();
		return;
	}
	if (item.lora) {
		handleLoraClick(item); // LoRA 浏览模式的行：插入/移除触发词，弹窗保持打开
		return;
	}
	recordRecent(item.n);
	let ins = settings.insertSpace ? item.n.replace(/_/g, " ") : item.n;
	if (settings.insertComma) {
		const after = ta.value.slice(state.tokenEnd).replace(/^[ \t]+/, "");
		if (!after.startsWith(",") && !after.startsWith("\n") && !after.startsWith(")")) {
			ins += ", ";
		}
	}
	ta.focus();
	const start = state.tokenStart;
	const end = state.tokenEnd;
	let ok = false;
	try {
		ta.setSelectionRange(start, end);
		ok = document.execCommand("insertText", false, ins); // 走浏览器 undo 栈
	} catch (e) {}
	if (!ok) {
		ta.setRangeText(ins, start, end, "end");
		ta.dispatchEvent(new Event("input", { bubbles: true })); // 让 ComfyUI 更新 widget 值
	}
	close();
}

// ---------------- 全局事件 ----------------
function wireEvents() {
	// 输入内容变化 -> 重新计算候选（输入法组合中不触发；仅手动模式下只在弹窗已开时刷新）
	document.addEventListener("input", (e) => {
		if (e.isComposing) return;
		if (state.suppress) { state.suppress = false; return; } // 程序化修改内容，跳过
		if (!isPromptArea(e.target)) return;
		if (settings.manualOnly && !(state.open && state.ta === e.target)) return;
		update(e.target, settings.manualOnly);
	});
	// 中文输入法确认（compositionend）后立即触发一次补全
	document.addEventListener("compositionend", (e) => {
		if (!isPromptArea(e.target)) return;
		if (settings.manualOnly && !(state.open && state.ta === e.target)) return;
		update(e.target, settings.manualOnly);
	});
	// 方向键/翻页键移动光标后刷新当前词（被弹窗消费的键除外）
	document.addEventListener("keyup", (e) => {
		if (e.isComposing || KEYS_CONSUMED.has(e.key) || !isPromptArea(e.target)) return;
		refreshIfOpen(e.target);
	});
	document.addEventListener("click", (e) => {
		if (isPromptArea(e.target)) refreshIfOpen(e.target);
	});
	document.addEventListener("focusin", (e) => {
		if (isPromptArea(e.target)) refreshIfOpen(e.target);
	});
	// 输入框失焦后延迟关闭（给行点击留出时间；行点击已用 preventDefault 保持焦点）
	document.addEventListener(
		"focusout",
		(e) => {
			if (state.ta && e.target === state.ta) {
				setTimeout(() => {
					if (state.ta && document.activeElement !== state.ta && !popup.contains(document.activeElement)) {
						close();
					}
				}, 120);
			}
		},
		true
	);
	// 点击弹层以外区域关闭
	document.addEventListener(
		"mousedown",
		(e) => {
			if (state.open && !popup.contains(e.target) && e.target !== state.ta) close();
		},
		true
	);
	// 键盘导航（捕获阶段，抢占 ComfyUI 其它快捷键）
	document.addEventListener("keydown", onKeyDownCapture, true);
	// 输入框自身滚动时，弹层跟随光标
	document.addEventListener(
		"scroll",
		(e) => {
			if (state.ta && e.target === state.ta) positionPopup();
		},
		true
	);
}

// 权重快捷键：选中一段（或光标所在词）Ctrl+↑/↓ 包裹/调整 (tag:1.1)
function adjustWeight(ta, delta) {
	let s = ta.selectionStart;
	let e = ta.selectionEnd;
	if (s === e) {
		const tok = currentToken(ta);
		s = tok.start;
		e = tok.end;
		if (s === e) return;
	}
	const value = ta.value;
	let seg = value.slice(s, e);
	const lead = seg.match(/^\s*/)[0];
	let trail = seg.match(/\s*$/)[0];
	let core = seg.slice(lead.length, seg.length - trail.length);
	if (core.endsWith(",")) {
		trail = "," + trail;
		core = core.slice(0, -1);
	}
	if (!core) return;
	let inner = core;
	let w = null;
	const mNum = core.match(/^\((.*):([0-9.]+)\)$/s);
	const mPlain = core.match(/^\((.+)\)$/s);
	if (mNum) {
		inner = mNum[1];
		w = parseFloat(mNum[2]);
	} else if (mPlain) {
		inner = mPlain[1];
		w = 1.0;
	}
	if (!inner) return;
	let out;
	if (w !== null) {
		w = Math.round((w + delta) * 10) / 10;
		if (w < 0.1) w = 0.1;
		out = w === 1 ? inner : `(${inner}:${w.toFixed(1)})`;
	} else {
		out = delta > 0 ? `(${inner}:1.1)` : `(${inner}:0.9)`;
	}
	ta.focus();
	const baseIns = settings.insertSpace ? item.n.replace(/_/g, " ") : item.n;
	state.suppress = true; // 本次的 input 事件不需要重新弹窗
	let ok = false;
	try {
		ta.setSelectionRange(start, end);
		ok = document.execCommand("insertText", false, ins);
	} catch (e) {}
	if (!ok) {
		ta.setRangeText(ins, start, end, "end");
		ta.dispatchEvent(new Event("input", { bubbles: true }));
	}
	// 记录本次补全，供 Tab 连续换候选使用
	state.lastCompletion = {
		ta,
		start,
		base: item.n,
		baseLen: baseIns.length,
		insLen: ins.length,
		list: state.items.map((t) => t.n),
		idx: i,
	};
	close();
}

// Tab（Shift+Tab 反向）：把刚补全的标签原地替换成上一个/下一个候选
function cycleCompletion(dir) {
	const lc = state.lastCompletion;
	const ta = lc.ta;
	const next = (lc.idx + dir + lc.list.length) % lc.list.length;
	const name = lc.list[next];
	const ins = settings.insertSpace ? name.replace(/_/g, " ") : name;
	ta.focus();
	state.suppress = true;
	let ok = false;
	try {
		ta.setSelectionRange(lc.start, lc.start + lc.baseLen);
		ok = document.execCommand("insertText", false, ins);
	} catch (err) {}
	if (!ok) {
		ta.setRangeText(ins, lc.start, lc.start + lc.baseLen, "end");
		ta.dispatchEvent(new Event("input", { bubbles: true }));
	}
	recordRecent(name);
	state.lastCompletion = { ...lc, base: name, baseLen: ins.length, idx: next };
}

// 键盘捕获总入口：先处理输入法组合态与快捷键，再进入弹窗导航
function onKeyDownCapture(e) {
	if (e.isComposing || e.keyCode === 229) return;
	const ta = e.target;
	if (!isPromptArea(ta)) return;
	if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
		if (e.code === "Space") {
			// Ctrl+Space：手动唤起/刷新补全（无输入时展示热门词）
			e.preventDefault();
			e.stopPropagation();
			update(ta, true);
			return;
		}
		if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !state.open) {
			e.preventDefault();
			e.stopPropagation();
			adjustWeight(ta, e.key === "ArrowUp" ? 0.1 : -0.1);
			return;
		}
	}
	// Tab / Shift+Tab：把刚补全的标签原地替换成下一个/上一个候选（仅当光标还在该词上）
	if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey && !state.open
		&& state.lastCompletion && ta === state.lastCompletion.ta) {
		const lc = state.lastCompletion;
		const cur = ta.value.substr(lc.start, lc.baseLen);
		const expected = settings.insertSpace ? lc.base.replace(/_/g, " ") : lc.base;
		const caretOk = ta.selectionStart === lc.start + lc.baseLen || ta.selectionStart === lc.start + lc.insLen;
		if (cur === expected && caretOk) {
			e.preventDefault();
			e.stopPropagation();
			cycleCompletion(e.shiftKey ? -1 : 1);
			return;
		}
	}
	onKeyDown(e);
}

function onKeyDown(e) {
	if (!state.open || e.target !== state.ta) return;
	const max = state.items.length;
	switch (e.key) {
		case "ArrowDown":
			e.preventDefault();
			e.stopPropagation();
			if (max) {
				state.sel = (state.sel + 1) % max;
				ensureVisible();
				renderRows();
			}
			break;
		case "ArrowUp":
			e.preventDefault();
			e.stopPropagation();
			if (max) {
				state.sel = (state.sel - 1 + max) % max;
				ensureVisible();
				renderRows();
			}
			break;
		case "PageDown":
			e.preventDefault();
			e.stopPropagation();
			state.sel = Math.min(max - 1, state.sel + visibleRows());
			ensureVisible();
			renderRows();
			break;
		case "PageUp":
			e.preventDefault();
			e.stopPropagation();
			state.sel = Math.max(0, state.sel - visibleRows());
			ensureVisible();
			renderRows();
			break;
		case "Home":
			e.preventDefault();
			e.stopPropagation();
			state.sel = 0;
			listEl.scrollTop = 0;
			renderRows();
			break;
		case "End":
			e.preventDefault();
			e.stopPropagation();
			state.sel = max - 1;
			ensureVisible();
			renderRows();
			break;
		case "Enter":
		case "Tab":
			e.preventDefault();
			e.stopPropagation();
			accept(state.sel);
			break;
		case "Escape":
			e.preventDefault();
			e.stopPropagation();
			close();
			break;
	}
}

let toastShown = false;
function showMissingToast(msg) {
	if (toastShown || !document.body) return;
	toastShown = true;
	const t = document.createElement("div");
	t.textContent = msg;
	Object.assign(t.style, {
		position: "fixed",
		zIndex: "100000",
		left: "50%",
		transform: "translateX(-50%)",
		bottom: "24px",
		maxWidth: "70vw",
		background: "#5a2b2b",
		color: "#ffe9c8",
		padding: "10px 16px",
		borderRadius: "8px",
		boxShadow: "0 4px 16px rgba(0,0,0,.5)",
		font: "13px 'Segoe UI', system-ui, sans-serif",
	});
	document.body.appendChild(t);
	setTimeout(() => t.remove(), 10000);
}

function registerSettings() {
	try {
		const s = app.ui && app.ui.settings;
		if (!s || !s.addSetting) return;
		const clampInt = (v, lo, hi, dflt) => {
			const n = parseInt(v);
			return Number.isNaN(n) ? dflt : Math.max(lo, Math.min(hi, n));
		};
		s.addSetting({
			id: "DanbooruAC.enabled",
			name: "Danbooru 补全: 启用",
			type: "boolean",
			defaultValue: settings.enabled,
			onChange: (v) => {
				settings.enabled = !!v;
				saveStore();
			},
		});
		s.addSetting({
			id: "DanbooruAC.hideNsfw",
			name: "Danbooru 补全: 隐藏 NSFW 标签",
			type: "boolean",
			defaultValue: settings.hideNsfw,
			onChange: (v) => {
				settings.hideNsfw = !!v;
				saveStore();
			},
		});
		s.addSetting({
			id: "DanbooruAC.insertComma",
			name: "Danbooru 补全: 选中后追加逗号",
			type: "boolean",
			defaultValue: settings.insertComma,
			onChange: (v) => {
				settings.insertComma = !!v;
				saveStore();
			},
		});
		s.addSetting({
			id: "DanbooruAC.manualOnly",
			name: "Danbooru 补全: 仅手动触发（Ctrl+Space 唤起）",
			type: "boolean",
			defaultValue: settings.manualOnly,
			onChange: (v) => {
				settings.manualOnly = !!v;
				saveStore();
			},
		});
		s.addSetting({
			id: "DanbooruAC.insertSpace",
			name: "Danbooru 补全: 插入时下划线转空格",
			type: "boolean",
			defaultValue: settings.insertSpace,
			onChange: (v) => {
				settings.insertSpace = !!v;
				saveStore();
			},
		});
		const catDefs = [
			["showGeneral", "general（常规）"],
			["showArtist", "artist（画师）"],
			["showCopyright", "copyright（系列）"],
			["showCharacter", "character（角色）"],
			["showMeta", "meta（元信息）"],
		];
		for (const [key, label] of catDefs) {
			s.addSetting({
				id: "DanbooruAC." + key,
				name: "Danbooru 补全: 显示 " + label + " 类",
				type: "boolean",
				defaultValue: settings[key],
				onChange: (v) => {
					settings[key] = !!v;
					saveStore();
				},
			});
		}
		s.addSetting({
			id: "DanbooruAC.minChars",
			name: "Danbooru 补全: 最少输入字符数",
			type: "number",
			attrs: { min: 1, max: 20, step: 1 },
			defaultValue: settings.minChars,
			onChange: (v) => {
				settings.minChars = clampInt(v, 1, 20, DEFAULTS.minChars);
				saveStore();
			},
		});
		s.addSetting({
			id: "DanbooruAC.maxVisible",
			name: "Danbooru 补全: 列表可见行数",
			type: "number",
			attrs: { min: 3, max: 40, step: 1 },
			defaultValue: settings.maxVisible,
			onChange: (v) => {
				settings.maxVisible = clampInt(v, 3, 40, DEFAULTS.maxVisible);
				saveStore();
			},
		});
		s.addSetting({
			id: "DanbooruAC.maxResults",
			name: "Danbooru 补全: 最多候选条数",
			type: "number",
			attrs: { min: 100, max: 20000, step: 100 },
			defaultValue: settings.maxResults,
			onChange: (v) => {
				settings.maxResults = clampInt(v, 100, 20000, DEFAULTS.maxResults);
				saveStore();
			},
		});
	} catch (e) {
		console.warn("[DanbooruAC] 设置注册失败（不影响补全功能）:", e);
	}
}

app.registerExtension({
	name: "Danbooru.Autocomplete",
	init() {
		buildUI();
		wireEvents();
		registerSettings();
		loadLoraTriggers();
		loadTags().then((ok) => {
			if (!ok) {
				showMissingToast(
					"[Danbooru 自动补全] 词库加载失败：请确认词库文件存在（运行 tools/crawl_danbooru_tags.py 或 tools/convert_tags_csv.py 生成），然后刷新页面。详见插件 README。"
				);
			}
		});
	},
});

// 收藏导出/导入（换电脑迁移用，F12 控制台调用）
function exportFavorites() {
	if (!favList.length) {
		console.warn("[DanbooruAC] 收藏为空，没有可导出的内容");
		return;
	}
	const blob = new Blob([JSON.stringify({ favorites: favList }, null, 2)], { type: "application/json" });
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = "danbooru_favorites.json";
	a.click();
	URL.revokeObjectURL(a.href);
	console.log(`[DanbooruAC] 已导出 ${favList.length} 条收藏`);
}

function importFavorites() {
	const input = document.createElement("input");
	input.type = "file";
	input.accept = ".json,application/json";
	input.onchange = () => {
		const file = input.files && input.files[0];
		if (!file) return;
		file.text().then((txt) => {
			const data = JSON.parse(txt);
			const arr = Array.isArray(data) ? data : data.favorites || [];
			let added = 0;
			for (const n of arr) {
				if (typeof n === "string" && n && !favSet.has(n)) {
					favSet.add(n);
					favList.push(n);
					added++;
				}
			}
			persistFavRecent();
			console.log(`[DanbooruAC] 收藏导入完成：新增 ${added} 条，共 ${favList.length} 条`);
		}).catch((err) => console.warn("[DanbooruAC] 导入失败:", err));
	};
	input.click();
}

// 供控制台手动刷新词库: DanbooruAutocomplete.reloadTags()
window.DanbooruAutocomplete = {
	reloadTags: () => loadTags(true),
	exportFavorites,
	importFavorites,
	settings,
	get size() {
		return TAGS.length;
	},
};
