# ComfyUI-Danbooru-Autocomplete

在 ComfyUI 的提示词输入框（CLIP Text Encode 等所有多行文本框）中提供 **Danbooru 标签自动补全**：
输入英文字母自动弹出候选列表，虚拟滚动浏览，带中文翻译、热度排序、收藏、权重快捷键。

## 功能总览

- **虚拟滚动候选列表**：无论匹配多少条，只渲染屏幕可见的十几行，滚轮/键盘翻页，不卡顿
- **热度排序**：候选严格按 Danbooru 使用次数（post_count）从大到小排列，完整匹配置顶
- **中文翻译**：候选行显示中文译名（约 5.1 万条，覆盖全部热门标签）
- **中文反查**：在提示词框里直接打中文（如"长发"），立刻弹出对应英文标签候选，选中后替换掉中文
- **收藏 ★**：候选行点击星标收藏，收藏的标签永久置顶（存浏览器本地）
- **最近使用**：手动补全过的标签自动记录（最多 30 个），置顶显示、次优先于收藏
- **Tab 连续换候选**：补全后光标还停在该词上时，`Tab` 把它原地替换成下一个候选（`Shift+Tab` 上一个），快速试同类词
- **LoRA 触发词联想**：在 `data/lora_triggers.json` 登记"文件名特征词 → 触发词"后，输入
  `lora` 进入 LoRA 列表，点击行即可插入/移除触发词（只能从这里输入，普通补全不混入）
- **权重快捷键**：选中一段（或光标所在词）`Ctrl+↑/↓` 包裹/调整 `(tag:1.1)`，步进 0.1，回到 1.0 自动去括号，走浏览器撤销栈
- **跟随光标右下角**：候选框固定从光标右下角弹出；靠近屏幕边缘自动压缩行数/翻转，基本不遮挡已输入文字
- **手动触发**：`Ctrl+Space` 随时唤起；光标处无输入时展示全库热门词；可开启"仅手动触发"模式
- **NSFW 过滤**：全库按"显式/擦边"两档规则标注（约 5,800 条），设置里一键隐藏
- **中文输入法兼容**：拼音组合过程中不会误触发，Enter 确认候选词安全
- **空格匹配**：输入 `long hair` 自动匹配 `long_hair`
- **插入选项**：补全后自动追加 `, `（可关闭）；可选"下划线转空格"输出
- **类目着色**：色条与中文译名按类别着色（蓝=general、红=artist、紫=copyright、绿=character、橙=meta）
- **类别过滤**：设置里五类各自开关，关掉就不出现在候选中
- 对所有 `comfy-multiline-input` 输入框生效（原生 CLIP Text Encode、各类自定义提示词节点）

## 安装

本目录已位于 `ComfyUI/custom_nodes/` 下，重启 ComfyUI（或刷新浏览器）即可。
词库已预置（10 万条标签 + 5.1 万中文翻译），开箱即用。

## 使用

| 操作 | 方式 |
| --- | --- |
| 唤起补全 | 直接输入字母（默认）；或按 `Ctrl+Space`（任何时候） |
| 浏览候选 | 鼠标滚轮 / `PgUp` `PgDn` 翻页 |
| 选择 | `↑` `↓`（循环滚动）/ 鼠标悬停 |
| 补全 | `Tab` 或 `Enter`，或鼠标点击 |
| 收藏 | 点击候选行尾的 ★ |
| 调权重 | 选中文字后 `Ctrl+↑` / `Ctrl+↓`（弹窗关闭时） |
| 中文反查 | 直接打中文，如 `长发` → 选 `long_hair` 替换 |
| 换候选 | 补全后光标停在该词上按 `Tab` / `Shift+Tab` |
| LoRA 触发词 | 输入 `lora` → 弹出 LoRA 列表 → 点击行插入/移除触发词，`Esc` 退出 |
| 类别过滤 | 弹窗顶部彩色 chips 点击开关（与设置页同步） |
| 关闭 | `Esc` / 点击输入框以外区域 |

例：输入 `long_h` → 弹出 `long_hair` 等候选 → 滚轮浏览 → `Tab` 补成 `long_hair, `。

## 设置

ComfyUI 菜单 → **设置(Settings)**，搜索 `Danbooru`：

| 设置项 | 默认 | 说明 |
| --- | --- | --- |
| 启用 | 开 | 总开关 |
| 隐藏 NSFW 标签 | 关 | 依赖词库的 NSFW 标记（见下文"NSFW 标记"） |
| 选中后追加逗号 | 开 | 补全为 `tag, ` |
| 仅手动触发 | 关 | 开启后输入字母不再自动弹出，仅 `Ctrl+Space` 唤起 |
| 插入时下划线转空格 | 关 | 适配偏自然语言的模型 |
| 类别显示开关 ×5 | 全开 | general / artist / copyright / character / meta 五类各自独立开关，关掉的类别不再出现在候选里 |
| 最少输入字符数 | 1 | |
| 列表可见行数 | 12 | 虚拟滚动窗口大小 |
| 最多候选条数 | 4000 | 参与排序的最大匹配数 |

## 词库数据

`data/danbooru_tags.json`，紧凑数组，每行：
`[标签名, 类别, post_count, nsfw?, 中文翻译?]`，按 post_count 降序。
类别：0=general 1=artist 3=copyright 4=character 5=meta。

当前规模：**100,999 条**（Danbooru 全站按热度前 10 万，不含已废弃标签），
其中中文翻译 51,165 条（general/meta 类热门词全覆盖）、NSFW 标记 5,845 条。

## 工具脚本（都在 tools/ 目录）

所有命令都在插件的 `tools` 文件夹里执行。打开方式：在文件管理器进入 `tools`
文件夹，在地址栏输入 `cmd` 回车（会在当前目录打开命令行窗口），然后先设置
Python 变量（**同一个窗口只需设置一次**）：

```bat
:: 把引号里的路径换成你本机 ComfyUI 自带的 Python
:: （绘世等整合包一般在 ComfyUI 目录旁边的 python 文件夹里；系统装了 Python 的直接写 python 即可）
set PY="你的ComfyUI目录\python\python.exe"
```

### 1. 爬虫 crawl_danbooru_tags.py —— 更新/扩充词库

从 Danbooru 公开 API 爬取标签元数据（只抓名字/类别/次数，不碰图片），
匿名限速约 10 次/分钟，脚本默认 6.5s/次并自动处理 429。

```bat
:: 默认：按热度爬前 10 万条（约 11 分钟）
%PY% crawl_danbooru_tags.py

:: 想爬更多：加大目标数（耗时约 = 目标数/1000 × 6.5秒）
%PY% crawl_danbooru_tags.py --target 200000     :: 约 22 分钟
%PY% crawl_danbooru_tags.py --target 500000     :: 约 54 分钟，冷门词大幅增加

:: 按首字母 a-z 逐个爬：覆盖冷门标签更彻底（很慢，适合挂机）
%PY% crawl_danbooru_tags.py --mode letters --per-letter-pages 20

:: 与现有词库合并（保留旧词的中文翻译和 NSFW 标记）——重爬时建议加
%PY% crawl_danbooru_tags.py --target 300000 --merge

:: 其它
%PY% crawl_danbooru_tags.py --category 0,5      :: 只留 general+meta（词库更纯净）
%PY% crawl_danbooru_tags.py --proxy http://127.0.0.1:7890
%PY% crawl_danbooru_tags.py --login 用户名 --api-key XXX   :: 账号可提高限速，配 --delay 2~3
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--target` | 100000 | 目标条数（count 模式） |
| `--mode` | count | `count`=按热度翻页；`letters`=按首字母爬（覆盖冷门） |
| `--limit` | 1000 | 每页条数（Danbooru 上限 1000） |
| `--delay` | 6.5 | 请求间隔秒数，匿名建议 ≥6 |
| `--min-count` | 0 | 丢弃使用次数低于该值的标签 |
| `--category` | all | 只保留指定类别，如 `0,4,5` |
| `--merge` | 关 | 与现有词库合并，保留旧数据的 nsfw/中文 |
| `--max-pages` | 1000 | 翻页上限（Danbooru 匿名上限即 1000 页） |

### 2. 词库重爬后的标准三步（重要）

爬虫**不带**中文翻译和 NSFW 标记，重爬后按顺序执行：

```bat
%PY% crawl_danbooru_tags.py --target 100000 --merge    :: 1. 重爬（--merge 保住旧翻译）
%PY% apply_translations.py                              :: 2. 回填翻译（CSV种子 + translations/ 里的批次）
%PY% mark_nsfw.py                                       :: 3. 重打 NSFW 标记
```

然后刷新浏览器页面。

### 3. apply_translations.py —— 翻译合并工具

把翻译来源合并进词库（幂等，只填空、不覆盖已有翻译），同时把历史多译名
（如 `女仆,仆人,侍女`）精简为第一个译名：

```bat
%PY% apply_translations.py                                  :: 合并全部来源
%PY% apply_translations.py --write-pending 待翻译.txt       :: 导出未翻译清单（按热度，不含画师）
%PY% apply_translations.py --no-seed                        :: 跳过 CSV 种子
%PY% apply_translations.py --dry-run                        :: 只统计
```

翻译来源（按顺序填空）：
1. `--seed` CSV：Anima-Prompt 插件的 `tags_enhanced.csv`（人工翻译 + NSFW 标记）
2. `translations/*.txt`：每行一条 `标签=中文`，**只填空**
3. `translations/override_*.txt`：**强制覆盖**已有译名（纠错用，见 override_01.txt）

想自己加翻译：在 `translations/` 里新建 `任意名字.txt`，写 `标签=中文`，跑一遍命令即可。

### 4. mark_nsfw.py —— NSFW 标记

Danbooru API 没有标签级 NSFW 字段，本脚本用约 250 个敏感词元 + 词组规则
（显式级：性器官/性行为/体液/强制等；擦边级：胸部/内衣聚焦/裸露等）给全库标注。
调整口径：编辑脚本里的 `EXPLICIT_TOKENS` / `SUGGESTIVE_TOKENS` 词表。
支持 `--dry-run` 预览。

### 5. convert_tags_csv.py —— 离线转换已有 CSV

不联网也能建词库。自动识别两种表头、自动处理 GBK/UTF-8 编码：

```bat
%PY% convert_tags_csv.py "某个danbooru词表.csv"
%PY% convert_tags_csv.py a.csv b.csv --out 自定义输出.json
```

支持：`name,cn_name,wiki,post_count,category,nsfw`（Anima-Prompt 格式）和
`name,category,post_count[,aliases]`（tagcomplete/gelbooru 格式）。

## 收藏迁移

收藏存在浏览器本地。换电脑/换浏览器时，F12 打开控制台：

```js
DanbooruAutocomplete.exportFavorites()   // 下载 danbooru_favorites.json
DanbooruAutocomplete.importFavorites()   // 选择之前导出的文件，合并导入
```

## LoRA 触发词联想

编辑 `data/lora_triggers.json`（不配置则此功能静默关闭）：

```json
{
  "lora文件名特征词": ["触发词1", "触发词2"]
}
```

使用：在提示词框输入 **`lora`**（大小写均可），弹窗切换为 LoRA 列表——**左边是 LoRA 名，
右边是你配置的全部触发词**，行尾提示"点击插入 / 点击移除"：

- **点击行**：把该 LoRA 的触发词**一次性全部插入**到 `lora` 引导词的位置（自动补好逗号，
  包括末尾逗号），弹窗保持打开，可以连续点击多个不同的 LoRA
- **再点已插入的行**：把这组触发词从提示词里移除（只删这一组，不影响其他内容）
- **Esc** 退出 LoRA 浏览，回到普通补全
- 触发词**只**通过这种方式输入，普通打字补全里不会混入

匹配规则：key 会对工作流里已挂载 LoRA 的**文件名**做包含匹配（不区分大小写，兼容
LoraLoader / LoraLoaderModelOnly / rgthree Power Lora Loader）；改完 JSON 刷新浏览器生效。

注意：① 这是 JSON 文件，**行与行之间必须有逗号**（最后一行不用），格式错了整个功能会静默失效，
F12 控制台会有 `lora_triggers.json 解析失败` 提示；② `_` 开头的 key 会被忽略；③ 新增后端接口
后需要**重启一次 ComfyUI**。

## 弹窗位置

候选框固定**跟随光标右下角**弹出（右移 6px、当前行下方 6px）；靠近屏幕右缘时自动贴右，
下方空间不足时自动压缩可见行数（最少 2 行），仍放不下才翻转到光标上方。

## 与联想插件的联动

本插件的词库同时被 **ComfyUI-Danbooru-Prompt-Assistant**（中文概念 → 相关标签联想）
复用；那边爬取的共现关联数据（related.json）以后也会反哺本插件的排序。
两个插件建议一起保留、一起更新。

## 与其它插件共存

- `comfyui-custom-scripts`（pysssss）自带补全，**默认关闭**，不冲突；若开启过请二选一
- `ComfyUI-Danbooru-Anima-Prompt` 是节点型插件，不冲突（其 CSV 被本插件复用为翻译种子）

## FAQ

- **不弹候选框？** 浏览器 F12 控制台看有没有 `[DanbooruAC] 词库加载完成`；
  访问 `http://127.0.0.1:8188/danbooru_ac/status` 检查词库；更新插件后需 `Ctrl+F5` 强刷
- **输入法打字时乱弹？** 不会——已做输入法兼容；若还有问题请反馈
- **候选全是英文？** 该词未收录翻译（多为画师名/冷门角色名），属正常
- **隐藏 NSFW 不生效？** 该词可能没有 NSFW 标记，跑一次 `mark_nsfw.py` 更新标记
- **快捷键被占用？** `Ctrl+Space` 与部分输入法切换键冲突时，可在输入法设置里改键

## 文件结构

```
ComfyUI-Danbooru-Autocomplete/
├── __init__.py                        # /danbooru_ac/tags（gzip）、/danbooru_ac/status 接口
├── web/js/danbooru_autocomplete.js    # 补全前端（虚拟滚动、收藏、权重快捷键）
├── data/danbooru_tags.json            # 词库（工具脚本生成/更新）
├── data/lora_triggers.json            # LoRA 触发词映射（自行维护，可选）
└── tools/
    ├── crawl_danbooru_tags.py         # Danbooru 词库爬虫
    ├── convert_tags_csv.py            # CSV 离线转换
    ├── apply_translations.py          # 翻译合并（种子 + 批次 + 覆盖）
    ├── mark_nsfw.py                   # NSFW 规则标注
    └── translations/                  # batch_01~04（填空）、override_01（覆盖）、待翻译清单
```
