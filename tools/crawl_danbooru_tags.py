#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 Danbooru 公开 API 爬取标签词库，生成插件用的 danbooru_tags.json。

只下载标签的元数据（标签名 / 类别 / 使用次数 / 是否 NSFW），不下载任何图片或帖子内容。
匿名访问限速约 10 次/分钟，脚本会自动礼貌限速并在 429 时等待，全程约几分钟到十几分钟。

用法（在本插件目录下的 tools/ 里执行，或用绝对路径）:
    python crawl_danbooru_tags.py                       # 默认爬 Top 100000 热门标签
    python crawl_danbooru_tags.py --target 200000       # 爬更多
    python crawl_danbooru_tags.py --mode letters        # 按首字母逐个爬（覆盖更多冷门标签，更慢）
    python crawl_danbooru_tags.py --merge               # 与现有词库合并（保留已有中文/NSFW标记）
    python crawl_danbooru_tags.py --proxy http://127.0.0.1:7890   # 需要代理时

可选（Danbooru 账号可提高限速与翻页上限）:
    python crawl_danbooru_tags.py --login 你的用户名 --api-key 你的APIKey
"""

import argparse
import json
import os
import sys
import time

try:
    import requests
except ImportError:
    print("缺少 requests 库，请先安装: pip install requests")
    sys.exit(1)

API_URL = "https://danbooru.donmai.us/tags.json"
CAT_NAMES = {0: "general", 1: "artist", 3: "copyright", 4: "character", 5: "meta"}
HERE = os.path.dirname(os.path.realpath(__file__))
DEFAULT_OUT = os.path.normpath(os.path.join(HERE, "..", "data", "danbooru_tags.json"))

# 全局采集结果，行格式: [name, category, post_count] 或附加 [nsfw, cn_name]
SEEN = set()
ROWS = []


def parse_args():
    p = argparse.ArgumentParser(description="爬取 Danbooru 标签生成补全词库")
    p.add_argument("--out", default=DEFAULT_OUT, help=f"输出 JSON 路径 (默认 {DEFAULT_OUT})")
    p.add_argument("--target", type=int, default=100000, help="目标标签条数（count 模式，默认 100000）")
    p.add_argument("--mode", choices=["count", "letters"], default="count",
                   help="count=按热度翻页(默认)；letters=按首字母 a-z 逐个爬，覆盖更全但更慢")
    p.add_argument("--limit", type=int, default=1000, help="每页条数，Danbooru 最大 1000")
    p.add_argument("--delay", type=float, default=6.5, help="两次请求间隔秒数（默认 6.5，礼貌限速）")
    p.add_argument("--min-count", type=int, default=0, help="丢弃 post_count 低于该值的标签")
    p.add_argument("--category", default="all",
                   help="只保留指定类别，逗号分隔: 0=general 1=artist 3=copyright 4=character 5=meta，如 '0,4,5'")
    p.add_argument("--max-pages", type=int, default=1000, help="count 模式最大页数")
    p.add_argument("--per-letter-pages", type=int, default=8, help="letters 模式每个首字母的最大页数")
    p.add_argument("--merge", action="store_true", help="与现有词库合并（保留旧数据里的 nsfw 标记和中文翻译）")
    p.add_argument("--login", default=None, help="Danbooru 用户名（可选，提高限速）")
    p.add_argument("--api-key", default=None, help="Danbooru API Key（可选）")
    p.add_argument("--proxy", default=None, help="HTTP(S) 代理，如 http://127.0.0.1:7890")
    return p.parse_args()


def make_session(args):
    s = requests.Session()
    s.headers.update({
        "User-Agent": "comfyui-danbooru-autocomplete/1.0 (tag metadata crawler)",
        "Accept": "application/json",
    })
    if args.login and args.api_key:
        s.auth = (args.login, args.api_key)
        print("使用 Danbooru 账号认证。")
    if args.proxy:
        s.proxies = {"http": args.proxy, "https": args.proxy}
        print(f"使用代理: {args.proxy}")
    return s


def fetch_page(session, params, delay, tries=6):
    """请求一页标签，失败自动重试；返回 list 或 None（彻底失败）。"""
    for attempt in range(1, tries + 1):
        try:
            r = session.get(API_URL, params=params, timeout=30)
        except requests.RequestException as e:
            print(f"    网络错误: {e}")
            time.sleep(delay)
            continue
        if r.status_code == 200:
            try:
                data = r.json()
            except ValueError:
                print("    返回内容不是 JSON，重试…")
                time.sleep(delay)
                continue
            return data if isinstance(data, list) else []
        if r.status_code == 429:
            retry_after = r.headers.get("Retry-After", "")
            wait = float(retry_after) if retry_after.isdigit() else delay * 2
            print(f"    触发限流(429)，等待 {wait:.0f}s 后重试（第 {attempt}/{tries} 次）")
            time.sleep(wait)
            continue
        if r.status_code in (401, 403):
            print(f"    HTTP {r.status_code}: 认证/权限问题，请检查 --login/--api-key。")
            return None
        print(f"    HTTP {r.status_code}，{delay * attempt:.0f}s 后重试…")
        time.sleep(delay * attempt)
    return None


def page_limit(args):
    return max(1, min(args.limit, 1000))


def collect(session, args, extra, pages, label):
    """翻页采集一批，返回新增条数。"""
    added_total = 0
    limit = page_limit(args)
    for page in range(1, pages + 1):
        params = {
            "limit": limit,
            "page": page,
            "search[order]": "count",
            "search[is_deprecated]": "false",
        }
        if extra:
            params.update(extra)
        data = fetch_page(session, params, args.delay)
        if data is None:
            print(f"  [{label}] 第 {page} 页彻底失败，停止本批次。")
            break
        if not data:
            break
        added = 0
        for t in data:
            name = t.get("name")
            if not name or " " in name:
                continue
            count = t.get("post_count") or 0
            if count < args.min_count:
                continue
            if name in SEEN:
                continue
            SEEN.add(name)
            ROWS.append([name, t.get("category", 0), count])
            added += 1
        added_total += added
        done = len(ROWS)
        msg = f"  [{label}] 第 {page} 页: 本页 {len(data)} 条，新增 {added}，累计 {done}"
        if args.mode == "count" and added:
            remain = (args.target - done) / max(added, 1)
            if remain > 0:
                msg += f"，预计还需 ~{remain * args.delay / 60:.1f} 分钟"
        print(msg)
        if len(data) < limit:
            break
        if args.mode == "count" and done >= args.target:
            break
        time.sleep(args.delay)
    return added_total


def load_existing(path):
    if not os.path.isfile(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception as e:
        print(f"读取现有词库失败({e})，忽略旧数据。")
        return []


def with_meta(name, cat, count, nsfw, cn):
    """组装一行，nsfw/cn 仅在非空时附加，保证格式紧凑且顺序正确。"""
    row = [name, cat, count]
    if nsfw or cn:
        row.append(int(nsfw or 0))
    if cn:
        row.append(cn)
    return row


def merge_old(old_rows):
    """把旧词库的 nsfw / 中文信息按 name 并入新数据；旧数据独有条目也保留。"""
    old = {}
    for row in old_rows:
        if isinstance(row, list) and len(row) >= 3 and isinstance(row[0], str):
            old[row[0]] = row
    if not old:
        return
    hit = 0
    for row in ROWS:
        o = old.pop(row[0], None)
        if o:
            nsfw = o[3] if len(o) > 3 else 0
            cn = o[4] if len(o) > 4 else ""
            extra = with_meta(row[0], row[1], row[2], nsfw, cn)[3:]
            row.extend(extra)
            hit += 1
    kept = 0
    for name, o in old.items():  # 新爬取里没有的旧条目，原样保留
        nsfw = o[3] if len(o) > 3 else 0
        cn = o[4] if len(o) > 4 else ""
        ROWS.append(with_meta(name, o[1], o[2], nsfw, cn))
        SEEN.add(name)
        kept += 1
    print(f"合并旧词库: {hit} 条保留 nsfw/中文，另保留 {kept} 条旧数据独有条目。")


def save(args):
    rows = ROWS
    if args.category and args.category.lower() != "all":
        valid = {"0", "1", "3", "4", "5"}
        keep = {int(x.strip()) for x in args.category.split(",") if x.strip() in valid}
        rows = [r for r in rows if r[1] in keep]
    rows = [r for r in rows if r[2] >= args.min_count]
    rows.sort(key=lambda x: -x[2])
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    tmp = args.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, args.out)
    size_mb = os.path.getsize(args.out) / 1024 / 1024
    print(f"\n完成！共 {len(rows)} 条标签 -> {args.out} ({size_mb:.1f} MB)")
    print("重启 ComfyUI 或刷新浏览器页面即可生效。")


def main():
    args = parse_args()
    cats = " / ".join(f"{k}={v}" for k, v in CAT_NAMES.items())
    print(f"Danbooru 标签爬虫 | 模式: {args.mode} | 目标: {args.target} | 间隔: {args.delay}s")
    print(f"类别: {cats}")

    old = load_existing(args.out) if args.merge else []
    if old:
        print(f"现有词库 {len(old)} 条，稍后合并。")

    session = make_session(args)
    start = time.time()
    if args.mode == "count":
        print("开始按热度爬取…")
        collect(session, args, None, args.max_pages, "count")
    else:
        letters = "abcdefghijklmnopqrstuvwxyz0123456789_"
        for ch in letters:
            print(f"首字母 {ch!r}:")
            collect(session, args, {"search[name_matches]": ch + "*"}, args.per_letter_pages, ch)
            time.sleep(args.delay)

    if old:
        merge_old(old)
    save(args)
    print(f"总耗时 {(time.time() - start) / 60:.1f} 分钟。")


if __name__ == "__main__":
    main()
