**集成 unrpyc**

`rpy-rrs-bridge/rpyc-decompile.py` 是入口，调用 `unrpyc/` 下的反编译器把 `.rpyc` 转成 `.rpy`，然后 `build-ddlc-zip.py` 的 Step 1 先跑这个脚本，再把生成的 `.rpy` 送进 `rpy2rrs.ts` 转换。unrpyc 本身是 git subtree 放在项目里的，不是 npm 依赖。

---

**添加 `renpy.input` 支持**

需要动这几层：

**1. rpy2rrs-core.ts**
识别 `$ xxx = renpy.input("prompt")` 这种语句，转成新的 rrs 指令，比如：
```
input xxx "请输入名字：";
```

**2. rrs parser/codegen**
- `lexer.ts`：`input` 不需要新 token，已有 Ident 够用
- `parser.ts`：在 `parseStmt` 里加 `case "input"` 分支，解析变量名 + 提示文本
- `codegen.ts`：生成 `{ type: "input", varName: "xxx", prompt: "请输入名字：" }` 的 step
- `types.ts`：Step 联合类型里加 `InputStep`

**3. engine.ts**
`executeStep` 里加 `case "input"`，返回 `block()`，state 里需要新增一个 `inputPrompt` 字段记录当前等待输入的状态。

**4. types.ts (GameState)**
加 `inputState: { varName: string; prompt: string } | null`

**5. UI 层**
新建 `InputOverlay.tsx`，显示提示文字 + 文本框 + 确认按钮。确认后调 store 的新 action `submitInput(value)`，engine 把值写进 vars，然后继续执行。

**6. store**
加 `submitInput(value: string)` action，调 `advance(state, { kind: "input", value })`。

---

这里还是 Claude Code 都能做，改动集中在这 6 个地方，不算太分散。你想在哪里继续？