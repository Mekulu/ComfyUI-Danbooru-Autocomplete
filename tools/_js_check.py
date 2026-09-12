import io, sys

path = r"C:\Apps\AI Drawing\ComfyUI-aki-v3.2\ComfyUI\custom_nodes\ComfyUI-Danbooru-Autocomplete\web\js\danbooru_autocomplete.js"
s = io.open(path, encoding="utf-8").read()

stack = []
line = 1
i = 0
n = len(s)
mode = None  # None / "'" / '"' / '`' / 'line' / 'block'
pairs = {"}": "{", ")": "(", "]": "["}
in_interp = []  # 模板字符串内 ${ 嵌套深度
errors = []

while i < n:
    c = s[i]
    if c == "\n":
        line += 1
        if mode == "line":
            mode = None
        i += 1
        continue
    if mode in ("'", '"'):
        if c == "\\":
            i += 2
            continue
        if c == mode:
            mode = None
        i += 1
        continue
    if mode == "`":
        if c == "\\":
            i += 2
            continue
        if c == "$" and i + 1 < n and s[i + 1] == "{":
            in_interp.append(True)
            stack.append(("interp", line))
            mode = None
            i += 2
            continue
        if c == "`":
            mode = None
        i += 1
        continue
    if mode == "line":
        i += 1
        continue
    if mode == "block":
        if c == "*" and i + 1 < n and s[i + 1] == "/":
            mode = None
            i += 2
            continue
        i += 1
        continue
    # normal
    if c == "/" and i + 1 < n and s[i + 1] == "/":
        mode = "line"
        i += 2
        continue
    if c == "/" and i + 1 < n and s[i + 1] == "*":
        mode = "block"
        i += 2
        continue
    if c in ("'", '"', "`"):
        mode = c
        i += 1
        continue
    if c == "{" or c == "(" or c == "[":
        stack.append((c, line))
        i += 1
        continue
    if c in pairs:
        if c == "}" and stack and stack[-1][0] == "interp":
            stack.pop()  # 关闭模板插值 ${ ，回到模板字符串
            mode = "`"
            i += 1
            continue
        if not stack or stack[-1][0] != pairs[c]:
            errors.append(f"line {line}: 不匹配的 {c} (栈顶: {stack[-1] if stack else '空'})")
            # 尝试恢复
            if stack and stack[-1][0] == "{" and c == "}":
                stack.pop()
        else:
            stack.pop()
        i += 1
        continue
    i += 1

if stack:
    for item in stack[-5:]:
        errors.append(f"未闭合: {item}")
if mode:
    errors.append(f"文件结束仍处于状态: {mode}")

if errors:
    print("发现问题:")
    for e in errors:
        print(" ", e)
else:
    print("结构完好：所有括号/字符串/模板均正确闭合")
