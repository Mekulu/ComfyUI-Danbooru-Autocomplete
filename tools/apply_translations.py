#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把中文翻译合并进插件词库 danbooru_tags.json（离线工具）。

翻译来源（按顺序填空，不覆盖已有翻译）:
  1) --seed CSV：danbooru 风格 CSV（如 Anima-Prompt 的 tags_enhanced.csv，带人工中文翻译 + nsfw 标记）
  2) --dir 目录下的 *.txt：每行一条 `tag=中文翻译`，# 开头为注释
     （由人工/本地模型批量翻译生成，只对词库里存在的标签生效）

用法:
    python apply_translations.py                          # 合并全部翻译来源并写回词库
    python apply_translations.py --write-pending todo.txt --pending-limit 6000
                                                          # 导出按热度排序的未翻译清单（不含 artist 类）
    python apply_translations.py --dry-run                # 只统计不写回
"""

import argparse
import csv
import json
import os
import sys

HERE = os.path.dirname(os.path.realpath(__file__))
DEFAULT_VOCAB = os.path.normpath(os.path.join(HERE, "..", "data", "danbooru_tags.json"))
DEFAULT_SEED = os.path.normpath(
    os.path.join(HERE, "..", "..", "ComfyUI-Danbooru-Anima-Prompt", "tags_enhanced.csv")
)
DEFAULT_DIR = os.path.join(HERE, "translations")


def open_text(path):
    """依次尝试 utf-8 / gb18030 / latin-1（中文 CSV 常为 ANSI 编码）。"""
    for enc in ("utf-8-sig", "gb18030", "latin-1"):
        try:
            f = open(path, "r", encoding=enc, newline="")
            f.readline()
            f.seek(0)
            return f
        except UnicodeDecodeError:
            continue
    raise ValueError(f"无法识别文件编码: {path}")


def to_int(v, default=0):
    try:
        return int(float(str(v).strip() or default))
    except (ValueError, TypeError):
        return default


def first_term(cn):
    """只保留逗号分隔译名列表中的第一个（最恰当的）译名。"""
    for part in str(cn).replace("，", ",").split(","):
        part = part.strip()
        if part:
            return part
    return ""


def load_vocab(path):
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    rows = []
    for r in data:
        if isinstance(r, list) and len(r) >= 3 and isinstance(r[0], str):
            rows.append(r)
    rows.sort(key=lambda x: -x[2])
    return rows


def save_vocab(path, rows):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def load_seed(seed_path):
    """返回 {tag: (cn, nsfw)}。"""
    if not seed_path or not os.path.isfile(seed_path):
        return {}
    out = {}
    with open_text(seed_path) as f:
        for r in csv.DictReader(f):
            r = {(k or "").strip().lower(): v for k, v in r.items() if k}
            name = (r.get("name") or "").strip()
            cn = first_term(r.get("cn_name") or "")
            if not name or not cn:
                continue
            out[name] = (cn, to_int(r.get("nsfw")))
    return out


def load_translation_files(t_dir, vocab_names):
    """读取目录下翻译文件。普通 *.txt 只填补空缺；override_*.txt 强制覆盖已有译名。
    返回 (填空map, 覆盖map)。"""
    fill = {}
    replace = {}
    if not os.path.isdir(t_dir):
        return fill, replace
    for fn in sorted(os.listdir(t_dir)):
        if not fn.lower().endswith(".txt"):
            continue
        path = os.path.join(t_dir, fn)
        target = replace if fn.lower().startswith("override_") else fill
        kind = "覆盖" if target is replace else "填空"
        n_hit = n_miss = 0
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                tag, sep, cn = line.partition("=")
                tag = tag.strip()
                cn = first_term(cn)
                if not sep or not tag or not cn:
                    continue
                if tag in vocab_names:
                    target.setdefault(tag, cn)
                    n_hit += 1
                else:
                    n_miss += 1
        print(f"  {fn} [{kind}]: 有效 {n_hit} 条，词库中不存在 {n_miss} 条")
    return fill, replace


def main():
    ap = argparse.ArgumentParser(description="合并中文翻译进词库")
    ap.add_argument("--vocab", default=DEFAULT_VOCAB)
    ap.add_argument("--seed", default=DEFAULT_SEED, help="CSV 翻译来源（--no-seed 关闭）")
    ap.add_argument("--no-seed", action="store_true")
    ap.add_argument("--dir", default=DEFAULT_DIR, help="tag=中文 翻译文件目录")
    ap.add_argument("--write-pending", default=None, help="导出未翻译清单到该文件")
    ap.add_argument("--pending-limit", type=int, default=6000, help="清单最多条数")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    rows = load_vocab(args.vocab)
    print(f"词库: {len(rows)} 条")
    vocab = {r[0]: r for r in rows}

    # 清理历史数据里的多译名：每个标签只保留一个最恰当的译名
    normalized = 0
    for r in rows:
        if len(r) > 4:
            t = first_term(r[4])
            if not t:
                del r[4]
                normalized += 1
            elif t != r[4]:
                r[4] = t
                normalized += 1
    if normalized:
        print(f"多译名清理: {normalized} 条只保留第一个译名")

    seeded = applied = 0
    if not args.no_seed:
        seed = load_seed(args.seed)
        print(f"CSV 种子翻译: {len(seed)} 条")
        for name, (cn, nsfw) in seed.items():
            row = vocab.get(name)
            if not row:
                continue
            changed = False
            if len(row) < 5 or not row[4]:
                while len(row) < 5:
                    row.append(0)
                row[4] = cn
                changed = True
            if nsfw and not row[3]:
                row[3] = nsfw
                changed = True
            if changed:
                seeded += 1
        print(f"  从 CSV 填充翻译/标记: {seeded} 条")

    fill_map, replace_map = load_translation_files(args.dir, vocab)
    print(f"翻译文件合并来源: 填空 {len(fill_map)} 条, 覆盖 {len(replace_map)} 条")
    for name, cn in fill_map.items():
        row = vocab[name]
        if len(row) < 5 or not row[4]:
            while len(row) < 5:
                row.append(0)
            row[4] = cn
            applied += 1
    replaced = 0
    for name, cn in replace_map.items():
        row = vocab[name]
        if len(row) == 3:
            row.append(0)
        if len(row) == 4:
            row.append(cn)
        else:
            row[4] = cn
        replaced += 1

    total_cn = sum(1 for r in rows if len(r) > 4 and r[4])
    total_nsfw = sum(1 for r in rows if len(r) > 3 and r[3])
    pending = [(r[0], r[1]) for r in rows if (len(r) < 5 or not r[4]) and r[1] != 1]
    print(f"\n当前翻译覆盖: {total_cn}/{len(rows)} ({total_cn * 100 / len(rows):.1f}%)，nsfw 标记 {total_nsfw} 条，未翻译 {len(pending)} 条")

    if args.write_pending:
        with open(args.write_pending, "w", encoding="utf-8") as f:
            for name, cat in pending[: args.pending_limit]:
                f.write(f"{name}\t{cat}\n")
        print(f"未翻译清单(按热度, 前 {min(len(pending), args.pending_limit)} 条, 不含 artist) -> {args.write_pending}")

    if args.dry_run:
        print("dry-run：不写回。")
        return 0
    if seeded or applied or replaced:
        save_vocab(args.vocab, rows)
        print(f"已写回 {args.vocab}（本轮新增翻译 {seeded + applied} 条，覆盖纠错 {replaced} 条）")
    else:
        print("无新增翻译，未写回。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
