import json, os, collections

HERE = os.path.dirname(os.path.realpath(__file__))
rows = json.load(open(os.path.join(HERE, "..", "data", "danbooru_tags.json"), encoding="utf-8"))

# 找出多个标签共用同一个译名的组
groups = collections.defaultdict(list)
for r in rows:
    if len(r) > 4 and r[4]:
        groups[r[4]].append(r)

MODIFIERS = ["short", "long", "detached", "see-through", "frilled", "plain", "cross-laced"]

suspect = []   # 变体冲突：基础标签 vs 带 short/long 等修饰的变体，译名相同
other = []     # 其它同名冲突
for cn, rs in groups.items():
    if len(rs) < 2:
        continue
    rs.sort(key=lambda x: -x[2])
    names = {r[0] for r in rs}
    is_variant = False
    for r in rs:
        n = r[0]
        for m in MODIFIERS:
            if "_" + m + "_" in n or n.startswith(m + "_") or n.endswith("_" + m):
                base = n.replace("_" + m + "_", "_").replace(m + "_", "", 1) if not n.endswith("_" + m) else n[: -len("_" + m)]
                if base in names:
                    is_variant = True
                    break
        if is_variant:
            break
    entry = (cn, rs)
    (suspect if is_variant else other).append(entry)

suspect.sort(key=lambda e: -max(r[2] for r in e[1]))
other.sort(key=lambda e: -max(r[2] for r in e[1]))

out = open(os.path.join(HERE, "_collisions.report.txt"), "w", encoding="utf-8")
out.write("===== 变体冲突(基础标签与 short/long 等变体同译名) %d 组 =====\n" % len(suspect))
for cn, rs in suspect:
    out.write("[{0}] ".format(cn) + " | ".join("{0}({1})".format(r[0], r[2]) for r in rs) + "\n")
out.write("\n===== 其它同名冲突 %d 组 =====\n" % len(other))
for cn, rs in other:
    out.write("[{0}] ".format(cn) + " | ".join("{0}({1})".format(r[0], r[2]) for r in rs) + "\n")
out.close()
print("variant-collision groups:", len(suspect))
print("other same-name groups:", len(other))
print("saved to translations/_collisions.txt")
