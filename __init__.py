# -*- coding: utf-8 -*-
"""ComfyUI-Danbooru-Autocomplete

在 ComfyUI 的提示词输入框（CLIP Text Encode 等）中提供 Danbooru 标签自动补全：
输入英文字母后弹出候选列表，列表采用虚拟滚动（只渲染可见行，滚轮翻页浏览）。

词库文件: data/danbooru_tags.json
  - 可用 tools/crawl_danbooru_tags.py 联网从 Danbooru API 爬取（推荐，数据最新）
  - 或用 tools/convert_tags_csv.py 离线转换已有 CSV（无需联网）
"""

import gzip
import json
import os

from aiohttp import web

__version__ = "1.0.0"

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

_DIR = os.path.dirname(os.path.realpath(__file__))
DATA_FILE = os.path.join(_DIR, "data", "danbooru_tags.json")
LORA_TRIGGERS_FILE = os.path.join(_DIR, "data", "lora_triggers.json")

try:
    from server import PromptServer

    _routes = PromptServer.instance.routes

    _gz_cache = {"key": None, "body": None}

    @_routes.get("/danbooru_ac/tags")
    async def danbooru_ac_tags(request):
        """返回词库 JSON。格式为紧凑数组: [name, category, post_count, nsfw?, cn_name?]"""
        if not os.path.isfile(DATA_FILE):
            return web.json_response({
                "tags": [],
                "message": (
                    "未找到词库 data/danbooru_tags.json。请运行 "
                    "tools/crawl_danbooru_tags.py（联网爬取 Danbooru），"
                    "或 tools/convert_tags_csv.py（离线转换已有 CSV），然后刷新页面。"
                ),
            })
        accept = (request.headers.get("Accept-Encoding") or "").lower()
        if "gzip" in accept:  # 词库约 3.5MB，gzip 后 <1MB
            try:
                key = os.path.getmtime(DATA_FILE)
                if _gz_cache["key"] != key:
                    with open(DATA_FILE, "rb") as f:
                        raw = f.read()
                    _gz_cache["body"] = gzip.compress(raw, 6)
                    _gz_cache["key"] = key
                return web.Response(
                    body=_gz_cache["body"],
                    content_type="application/json",
                    headers={"Content-Encoding": "gzip", "Cache-Control": "no-store"},
                )
            except Exception:
                pass
        return web.FileResponse(DATA_FILE, headers={"Cache-Control": "no-store"})

    @_routes.get("/danbooru_ac/lora_triggers")
    async def danbooru_ac_lora_triggers(request):
        """返回 LoRA 触发词映射表（用户可在 data/lora_triggers.json 自行维护）。"""
        if not os.path.isfile(LORA_TRIGGERS_FILE):
            return web.json_response({"triggers": {}})
        return web.FileResponse(LORA_TRIGGERS_FILE, headers={"Cache-Control": "no-store"})

    @_routes.get("/danbooru_ac/status")
    async def danbooru_ac_status(request):
        """词库状态（用于检查爬取结果）。"""
        if not os.path.isfile(DATA_FILE):
            return web.json_response({"exists": False, "path": DATA_FILE})
        count = -1
        try:
            with open(DATA_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            count = len(data) if isinstance(data, list) else len(data.get("tags", []))
        except Exception:
            pass
        st = os.stat(DATA_FILE)
        return web.json_response({
            "exists": True,
            "count": count,
            "size": st.st_size,
            "mtime": int(st.st_mtime),
            "path": DATA_FILE,
        })

except Exception as e:  # 无 PromptServer 的环境下不阻塞导入
    print(f"[DanbooruAutocomplete] web 路由注册跳过: {e}")

print(f"[DanbooruAutocomplete] 已加载 v{__version__}")
