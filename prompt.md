你将接手一个基于 React + Deno/TypeScript 构建的视觉小说（VN）引擎项目。该项目的前身是专为 Camp Buddy 游戏定制的播放器，你的任务是将其重构为一个**通用的 Ren'Py 游戏剧情阅读器**，同时对内置脚本语言做一次重要的语言升级。

---

### 一、项目技术栈概览

- **前端**：React + TypeScript，Vite 构建，Zustand 状态管理
- **桌面端**：Tauri（可选，Web 模式也可独立运行）
- **运行时脚本解析**：浏览器内直接解析 `.rrs` 文本文件（无预编译 JSON）
- **离线工具链**：Deno 脚本（转换器、编译器、反编译器），位于 `tools/` 目录

---

### 二、现有脚本语言（cbscript）说明

项目自定义了一种叫做 **cbscript** 的 VN 脚本语言，文件扩展名 `.cbscript`。**你的第一项任务是给它取一个新名字**（建议 `.rrs`，或你认为更合适的名称），并在以下位置统一替换：
- 文件扩展名（`.cbscript` → `.rrs`）
- 工具链目录名（`tools/cbscript/` → `tools/rrs/`）
- 运行时目录（`src/cbscript/` → `src/rrs/`）
- 所有代码内部的注释、变量名、README 中的引用

**语言现有语法（保持不变）：**

顶层只能有 `label` 块，`label` 内支持：`scene`、`show`、`expr`、`hide`、`with`、`speak`、`music`、`sound`、`wait`、`if/elif/else`、`menu`、`jump`、`call`、`return`、变量赋值（`name op value;` 或 `let name = value;`）。

---

### 三、需要新增的语言特性：`define`

这是核心的语言升级任务。需要在语言的**顶层**（与 `label` 平级）新增 `define` 声明语法，用于在脚本文件头部集中定义游戏级别的常量与别名，取代现有转换器中的多个硬编码映射表。

#### 3.1 语法设计

```/dev/null/example.rrs#L1-12
// 角色名定义（取代 rpy2cbscript.ts 中的 CHAR_MAP）
define char.k     = "Keitaro";
define char.hi    = "Hiro";
define char.hu    = "Hunter";

// 音频别名（取代转换器中 loadAssetMaps 的 audio Map）
define audio.bgm_outdoors = "Audio/BGM/Outdoors.ogg";
define audio.sfx_door     = "Audio/SFX/sfx_door.ogg";

// 通用常量（可供 if 条件和赋值引用）
define CAMP_NAME = "Camp Buddy";
```

#### 3.2 语义规则

- `define` 只能出现在**文件顶层**，不能出现在 `label` 块内部
- 同一文件内，`define` 必须在所有 `label` 之前（或与 label 交错但不在 label 内）
- `define char.<abbr> = "全名"` → 在该文件转换时，凡遇到 `speak <abbr> "..."` 的 `who` 字段，替换为对应全名
- `define audio.<alias> = "路径"` → 在 `music::play` / `sound::play` / `speak` 的语音字段中，允许用 `audio.<alias>` 引用
- `define <VAR> = <值>` → 通用常量，可在条件表达式和变量赋值右侧使用

#### 3.3 需要修改的代码位置

**工具链（离线）：**

| 文件 | 修改内容 |
|---|---|
| `tools/rrs/lexer.ts` | `define` 是新的关键字，加入顶层关键字集 |
| `tools/rrs/types.ts` | 新增 `DefineDecl` AST 节点，`Program` 类型从 `{ labels: LabelDecl[] }` 改为 `{ defines: DefineDecl[], labels: LabelDecl[] }` |
| `tools/rrs/parser.ts` | `parse()` 顶层循环改为同时识别 `define` 和 `label`；新增 `parseDefine()` 方法 |
| `tools/rrs/codegen.ts` | `compile()` 接收 defines，build 三张 Map（char / audio / const）后传入 `CodegenContext`；`genSpeak()` 用 charMap 解析 who；音频相关 gen 方法用 audioMap 展开别名 |
| `tools/rrs/rpy2rrs.ts` | 删除硬编码的 `CHAR_MAP`、`MINIGAME_STUB_EXIT`；转换器遇到 `define char.*` / `define audio.*` 时生成对应的 `define` 语句而非直接展开 |

**运行时（浏览器端）：**

| 文件 | 修改内容 |
|---|---|
| `src/rrs/ast.ts`（或 types.ts） | 同上，新增 `DefineDecl`，更新 `Program` |
| `src/rrs/parser.ts` | 同工具链 parser，识别顶层 `define` |
| `src/rrs/codegen.ts` | 同工具链 codegen，编译时展开 define |
| `src/evaluate.ts` | `defaultVars()` 中删除 Camp Buddy 专用变量（`score_hiro` 等），改为空对象或只保留通用字段 |

---

### 四、需要去除的 Camp Buddy 专有逻辑

以下是需要参数化或删除的硬编码内容：

#### `tools/rrs/rpy2rrs.ts`

- **`CHAR_MAP`**（L56–141）：整个 Camp Buddy 角色缩写表 → 删除。转换器改为自动从目标游戏的 `.rpy` 文件中解析 `define <abbr> = Character("名字")` 行，并生成对应的 `define char.<abbr> = "名字";` 语句写入转换结果
- **`SKIP_FILES`**（L27–52）：删除 CB 专用文件名 → 保留通用的 UI/系统类别描述，改为可通过命令行参数 `--skip <pattern>` 指定。注意 `script.rpy` 不能完全跳过，见第五节说明
- **`MINIGAME_STUB_EXIT`**（L498–507）：CB 专属小游戏跳转表 → 删除，改为通用的 `--stub-exit label=varName` 命令行选项
- **`DEFAULT_SCRIPT_RPY`**（L23）：删除硬编码路径，改为必填参数

#### `src/engine.ts`

- **`currentLabel: "day1"`**（`startNewGame()` 函数内）：删除此硬编码 → 改为读取 manifest 的 `start` 字段。`start` 是 Ren'Py 的标准入口 label 名约定，manifest 中该字段的**默认值应为 `"start"`**（而非任何游戏特定的 label 名）

#### `src/evaluate.ts`

- **`defaultVars()`**：删除 `score_hiro`、`score_hunter`、`score_natsumi`、`score_taiga`、`score_yoichi`、`keitaro_route`、`current_route`、`first_time` 等 → 返回空对象 `{}`。变量初始值应来自游戏脚本自身的 `define` 或初始 label 的赋值语句

#### `src/components/DialogueBox.tsx`

- **`CHARACTER_COLORS`**：可以保留机制，但初始值改为空 `{}` → 颜色映射应从 `define` 或外部配置文件加载（这是可选的后续工作，目前可以回退到 `FALLBACK_BG`）

---

### 五、转换器处理 `script.rpy` 与入口 label

#### 5.1 自动解析 `Character()` 定义

Ren'Py 游戏通常在 `script.rpy` 或 `characters.rpy` 中这样定义角色：

```/dev/null/example.rpy#L1-4
define k  = Character("Keitaro", color="#c8ffc8")
define hi = Character("Hiro",    color="#ffca78")
define hu = Character("Hunter",  color="#ffe680")
```

转换器的 `loadAssetMaps()` 函数（现有逻辑已解析 `define audio.*`）需要扩展，同样解析 `define <abbr> = Character("名字")` 模式，将结果写入一张 `charMap: Map<string, string>`。在转换每个 `.rpy` 文件时，用这张 map 在文件顶部生成 `define char.<abbr> = "名字";` 语句，而不是把角色名直接展开到每一条 `speak` 语句里。

这样最终生成的 `.rrs` 文件是自包含的：换一个游戏时，只需重新转换，新的 `define char.*` 自然就写进文件了。

#### 5.2 `script.rpy` 中的 `label start` 必须被提取

Ren'Py 的标准入口是 `label start`，引擎启动时自动执行它。在 Camp Buddy 中，`label start` 位于 `script.rpy`，内容是初始化全局变量，最后 `jump day1`。

现有转换器把 `script.rpy` 整个加入 `SKIP_FILES`（仅用于读取资源映射表），导致 `label start` 丢失。在通用化改造中，必须修改这一行为：

- `script.rpy` 仍然作为资源映射表的来源（`loadAssetMaps()` 读取它）
- 但转换器**同时也要转换 `script.rpy` 中的 label**，将其输出为 `script.rrs`（或与其他文件合并），使 `label start` 可被引擎加载
- 如果 `label start` 中含有大量无法转换的 Python/screen 代码（会产生 `// UNHANDLED:` 注释），这是可以接受的——引擎会跳过无法执行的步骤，最终执行到 `jump day1`（或目标游戏的第一个故事 label）

---

### 六、manifest 格式升级

现有 manifest：
```/dev/null/manifest.json#L1-3
{
  "files": ["day1.rrs", "day2.rrs", ...]
}
```

升级为：
```/dev/null/manifest.json#L1-6
{
  "start": "start",
  "game": "My VN Game",
  "files": ["script.rrs", "day1.rrs", "day2.rrs", ...]
}
```

- `start`：引擎 `startNewGame()` 读取此字段确定起始 label。**默认值为 `"start"`**，遵循 Ren'Py 约定（所有标准 Ren'Py 游戏的入口 label 均为 `start`）。转换器批量模式自动写入此字段
- `game`：游戏名称，显示在标题页（可选）
- `files`：必须包含含有 `label start` 的文件（如 `script.rrs`）

---

### 七、工作建议

进行工作时创建PROGRESS.md记录进度

1. **重命名**：语言改名，扩展名改名，目录改名，全局替换引用
2. **新增 `define` AST 节点**：在 `types.ts` / `ast.ts` 中，`Program` 增加 `defines` 字段
3. **Parser 支持顶层 `define`**：工具链 parser 和运行时 parser 同步修改
4. **Codegen 展开 `define`**：char map、audio map 在 codegen 阶段展开
5. **转换器自动提取 `Character()` 定义**：替代硬编码 `CHAR_MAP`
6. **转换器不再完全跳过 `script.rpy`**：提取其中的 label，尤其是 `label start`
7. **删除 CB 专用硬编码**：CHAR_MAP、MINIGAME_STUB_EXIT、defaultVars
8. **manifest 升级**：增加 `start`（默认 `"start"`）字段，engine 读取
9. **迁移帮助工具**: 用 TS 写一个命令行工具，从指定的 game 文件夹中读取并批量转换，在项目UI中也可以使用这个工具。

---

### 八、不需要改动的部分

以下核心逻辑与游戏内容无关，保持原样即可：
- `src/engine.ts` 的执行引擎主体（除 `startNewGame` 中的硬编码 label）
- `src/components/` 中所有 React UI 组件（`GameScreen`、`DialogueBox`、`EndScreen` 等）
- `src/audio.ts`、`src/save.ts`、`src/assets.ts`、`src/store.ts`（逻辑不变）
- 工具链的 `lexer.ts`（除了加入 `define` 关键字之外）
- `src/rrs/` 下已有的语句解析逻辑（show/hide/speak/music 等）
