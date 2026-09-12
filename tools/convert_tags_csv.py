#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""离线转换：把已有的 danbooru 风格 tag CSV 转成插件词库 JSON（不需要联网）。

自动按表头识别以下格式：
  1) name,cn_name,wiki,post_count,category,nsfw   —— 如 ComfyUI-Danbooru-Anima-Prompt 的 tags_enhanced.csv
  2) name,category,post_count[,aliases]           —— 如 gelbooru_tags.csv / a1111 tagcomplete 的 danbooru.csv

用法:
    python convert_tags_csv.py "C:\\path\\to\\tags_enhanced.csv"
    python convert_tags_csv.py a.csv b.csv        # 多个文件合并（按 post_count 排序去重）

输出默认写到  ../data/danbooru_tags.json
"""

import argparse
import csv
import json
import os
import sys

HERE = os.path.dirname(os.path.realpath(__file__))
DEFAULT_OUT = os.path.normpath(os.path.join(HERE, "..", "data", "danbooru_tags.json"))


def to_int(v, default=0):
    try:
        return int(float(str(v).strip() or default))
    except (ValueError, TypeError):
        return default


def convert_row(row):
    name = (row.get("name") or "").strip()
    if not name or " " in name:  # danbooru 标签不含空格，含空格的行视为脏数据
        return None
    count = to_int(row.get("post_count") or row.get("count"))
    cat = to_int(row.get("category"))
    if cat not in (0, 1, 3, 4, 5):
        cat = 0
    nsfw = to_int(row.get("nsfw"))
    cn = (row.get("cn_name") or "").strip()
    if cn.lower() in ("none", "null", "nan"):
        cn = ""
    out = [name, cat, count]
    if nsfw or cn:
        out.append(nsfw)
    if cn:
        out.append(cn)
    return out


def open_text(path):
    """依次尝试 utf-8 / gb18030 / latin-1 打开（中文 CSV 常为 ANSI/GBK 编码）。"""
    for enc in ("utf-8-sig", "gb18030", "latin-1"):
        try:
            f = open(path, "r", encoding=enc, newline="")
            f.readline()
            f.seek(0)
            return f
        except UnicodeDecodeError:
            continue
    raise ValueError(f"无法识别文件编码: {path}")


def convert_file(path, seen):
    added = 0
    skipped = 0
    with open_text(path) as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames or "name" not in [c.strip().lower() for c in reader.fieldnames]:
            print(f"  跳过 {path}: 未找到 name 列（表头: {reader.fieldnames}）")
            return 0
        # 统一列名为小写
        rows = ({k.strip().lower(): v for k, v in r.items() if k} for r in reader)
        for r in rows:
            out = convert_row(r)
            if out is None:
                skipped += 1
                continue
            name = out[0]
            if name in seen:
                if out[2] > seen[name][2]:  # 同名取计数更高者
                    seen[name][:] = out
                continue
            seen[name] = out
            added += 1
    print(f"  {os.path.basename(path)}: 新增 {added}，跳过脏数据 {skipped}")
    return added


def main():
    ap = argparse.ArgumentParser(description="CSV -> 插件词库 JSON（离线）")
    ap.add_argument("csvs", nargs="+", help="输入 CSV 路径（可多个）")
    ap.add_argument("--out", default=DEFAULT_OUT, help=f"输出 JSON 路径 (默认 {DEFAULT_OUT})")
    args = ap.parse_args()

    seen = {}
    total = 0
    for path in args.csvs:
        if not os.path.isfile(path):
            print(f"  找不到文件: {path}")
            continue
        total += convert_file(path, seen)

    rows = sorted(seen.values(), key=lambda x: -x[2])
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    tmp = args.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, args.out)

    nsfw_n = sum(1 for r in rows if len(r) > 3 and r[3])
    cn_n = sum(1 for r in rows if len(r) > 4 and r[4])
    size_mb = os.path.getsize(args.out) / 1024 / 1024
    print(f"\n完成！共 {len(rows)} 条标签 -> {args.out} ({size_mb:.1f} MB)")
    print(f"  带 NSFW 标记: {nsfw_n} 条 | 带中文翻译: {cn_n} 条")
    top = "、".join(r[0] for r in rows[:5])
    print(f"  热度 Top5: {top}")
    print("重启 ComfyUI 或刷新浏览器页面即可生效。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
