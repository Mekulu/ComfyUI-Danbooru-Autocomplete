#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""给词库全量打 NSFW 标记（词表规则，离线运行）。

Danbooru API 本身没有"单个标签是否 NSFW"的字段（nsfw 是图片属性不是标签属性），
所以这里用人工整理的敏感词表 + 词形匹配来标注，并保留已有标记（如 CSV 导入的 5101 条）。

判定口径（与 tags_enhanced.csv 的标注习惯保持一致）：
  - 显式：生殖器官 / 性行为 / 体液 / 勃起 / 强制 / 重口相关
  - 擦边：胸部及其变体 / 乳沟 / 内衣聚焦 / 裸体相关 / 绳缚等
注意：只做名词性标签的判断，不涉及任何图片内容。

用法:
    python mark_nsfw.py            # 标注并写回 data/danbooru_tags.json
    python mark_nsfw.py --dry-run  # 只统计不写回
重新爬取词库后需要重新运行一次（爬虫不带 nsfw 信息）。
"""

import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.realpath(__file__))
VOCAB = os.path.normpath(os.path.join(HERE, "..", "data", "danbooru_tags.json"))

# ===== 显式级：性器官 / 性行为 / 体液 / 强制 / 重口 =====
EXPLICIT_TOKENS = {
    "penis", "penises", "vagina", "vaginas", "pussy", "pussies", "cunt", "cunts",
    "anus", "anuses", "asshole", "rectum", "clitoris", "labia", "vulva",
    "scrotum", "testicle", "testicles", "sperm", "semen", "cum", "cumshot",
    "creampie", "precum", "cumming", "fellatio", "cunnilingus", "blowjob",
    "handjob", "footjob", "titjob", "titfuck", "paizuri", "irrumatio",
    "masturbation", "masturbating", "masturbate", "sex", "sexual", "intercourse",
    "penetration", "penetrating", "penetrated", "dildo", "dildos", "vibrator",
    "onahole", "rape", "raped", "raping", "gangbang", "orgy", "threesome",
    "foursome", "ahegao", "orgasm", "orgasmic", "defloration", "hymen",
    "cervix", "uterus", "womb", "erection", "flaccid", "uncircumcised",
    "bestiality", "zoophilia", "incest", "prostate", "nipple", "nipples",
    "areola", "areolae", "lactating", "lactation", "milking", "deepthroat",
    "facesitting", "tribadism", "scissoring", "rimjob", "anilingus", "bukkake",
    "gokkun", "pegging", "fisting", "squirting", "ejaculation", "ejaculating",
    "mating_press", "breeding", "bondage", "bdsm", "dominatrix", "femdom",
    "shibari", "uncensored", "doggystyle", "clothed_sex", "genitalia",
    "genitals", "pubic", "pubes", "smegma", "cumdumpster", "cock", "dick",
    "futanari", "chastity", "strapon", "spanking", "gagged",
    "suspended", "vaginal", "anal", "anally", "rimming", "facesitting",
    "oral", "undressing",
}

# ===== 擦边级：胸部 / 内衣聚焦 / 裸露 / 暗示 =====
SUGGESTIVE_TOKENS = {
    "breast", "breasts", "cleavage", "sideboob", "underboob", "panties",
    "pantyshot", "panty", "bra", "thong", "lingerie", "babydoll", "pasties",
    "ass", "butt", "buttocks", "underwear", "sarashi", "nudity", "seduced",
    "seducing", "erotic", "fetish", "humiliated", "humiliation",
}

# ===== 词组（跨词或含连字符，对完整标签名做包含匹配） =====
EXPLICIT_PHRASES = (
    "g-string", "cum_on", "cum_in", "penis_", "_penis", "pussy_", "_pussy",
    "sex_", "_sex", "nipple_", "_nipple", "breast_milk", "pussy_juice",
    "mating_press", "oral_", "fuck", "strap-on", "mating_season", "_rape",
    "cum_dumpster", "ball_gag", "gag_", "_gag",
)
SUGGESTIVE_PHRASES = (
    "no_panties", "panties_", "_panties", "no_bra", "bra_", "_bra",
    "see-through", "spread_legs", "legs_up", "out_of_breast", "breast_out",
    "underwear_", "_underwear", "ass_", "_ass", "butt_", "_butt",
)

TOKEN_SPLIT = re.compile(r"[_\-\s]+")


def is_nsfw(name):
    low = name.lower()
    tokens = set(TOKEN_SPLIT.split(low))
    if tokens & EXPLICIT_TOKENS:
        return 1
    if tokens & SUGGESTIVE_TOKENS:
        return 1
    for p in EXPLICIT_PHRASES:
        if p in low:
            return 1
    for p in SUGGESTIVE_PHRASES:
        if p in low:
            return 1
    return 0


def main():
    ap = argparse.ArgumentParser(description="全量标注 NSFW 标记")
    ap.add_argument("--vocab", default=VOCAB)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    with open(args.vocab, "r", encoding="utf-8") as f:
        rows = json.load(f)

    added = 0
    kept = 0
    for r in rows:
        if not isinstance(r, list) or len(r) < 3:
            continue
        existing = r[3] if len(r) > 3 else 0
        if existing:
            kept += 1
            continue
        flag = is_nsfw(r[0])
        if flag:
            if len(r) == 3:
                r.append(1)  # [name, cat, count] -> 加 nsfw 位
            else:
                r[3] = 1     # nsfw 位已存在（可能为 0），直接赋值，避免挤占中文位
            added += 1

    total = kept + added
    print(f"词库 {len(rows)} 条：已有标记 {kept} 条，新标记 {added} 条，合计 NSFW {total} 条")
    if not args.dry_run and added:
        with open(args.vocab + ".tmp", "w", encoding="utf-8") as f:
            json.dump(rows, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(args.vocab + ".tmp", args.vocab)
        print(f"已写回 {args.vocab}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
