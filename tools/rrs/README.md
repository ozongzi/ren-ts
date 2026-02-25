# rrs 工具链

`tools/rrs/` 包含与 `.rrs` 格式相关的全部离线工具，以及 `.rrs` 语言本身的完整说明。

---

## 文件索引

| 文件 | 说明 |
|------|------|
| `rpy2rrs.ts` | **主工具**：将 Ren'Py `.rpy` 文件批量转换为 `.rrs` |
| `cli.ts` | 编译器：`.rrs` → JSON Step 数组（调试用） |
| `decompile.ts` | 反编译器：JSON Step 数组 → `.rrs` |
| `batch_roundtrip.ts` | 往返一致性测试（decompile → compile） |
| `lexer.ts` | 词法分析器 |
| `parser.ts` | 语法分析器（生成 AST） |
| `codegen.ts` | AST → `Step[]` 代码生成器 |
| `types.ts` | 工具链内部类型定义 |
| `validate_assets.ts` | 资源引用检查器（验证 `.rrs` 中的图片/音频路径） |

> 前端运行时的解析器位于 `src/rrs/`，与此处的工具链实现相互独立，结构相同。

---

## 快速上手

所有工具均通过 `package.json` 中的 script 调用，在项目根目录执行：

```bash
# Ren'Py → .rrs（批量，生成 manifest.json）
bun run rpy2rrs /path/to/game/ -o assets/data/ --manifest

# 编译单个 .rrs → JSON Steps（调试用）
bun run rrs:compile assets/data/day1.rrs

# 反编译 JSON Steps → .rrs
bun run rrs:decompile assets/data/day1.json

# 往返一致性测试
bun run rrs:roundtrip assets/data/
```

---

## .rrs 语法说明

`.rrs`（Ren'Py Reader Script）是本项目专用的视觉小说脚本语言，语法简洁，面向故事流程。
文件由顶层声明和若干 **label（场景入口）** 组成，引擎按 label 名加载并逐条执行。

### 顶层结构

顶层声明写作裸赋值（无关键字）。**在 label 外部**的赋值自动成为全局定义（define）；**在 label 内部**的赋值是存档变量。

```
// 注释用双斜线

// 顶层全局声明（在所有 label 之外）
char.k  = "Keitaro";
char.hi = "Hiro";
audio.bgm_main = "Audio/BGM/Main.ogg";

// label 块
label scene_name {
  // 语句列表...
}

label another_scene {
  // ...
}
```

---

### 顶层声明

顶层声明**不能出现在 label 内部**，写作裸赋值。主要有三类：

#### 角色名定义

```
char.<abbr> = "全名";
```

转换器（`rpy2rrs.ts`）会自动从游戏的 `.rpy` 文件中提取 `Character("名字")` 定义，并在每个 `.rrs` 文件头部生成对应的 `char.*` 声明。

运行时 codegen 将 `speak` 语句中的 `<abbr>` 展开为全名，写入引擎 JSON。

#### 音频别名定义

```
audio.<alias> = "Audio/BGM/SomeTrack.ogg";
```

在 `music::play` / `sound::play` / `speak` 的语音字段中，可以用 `audio.<alias>` 引用已定义的路径。

#### 通用常量

```
CAMP_NAME = "Camp Buddy";
```

通用常量可在条件表达式和变量赋值右侧引用。

---

### 语句速查表

| 语句 | 语法 | 说明 |
|------|------|------|
| 变量赋值 | `name op value;` | op 可为 `=` `+=` `-=` `*=` `/=` |
| 场景切换 | `scene "path" \| transition;` | 支持路径或 CSS 颜色值 |
| 显示立绘 | `show body::face @ pos \| trans;` | 体型::表情，可选位置和过渡 |
| 变更表情 | `expr char::face @ pos \| trans;` | 仅换表情层，保持位置 |
| 隐藏立绘 | `hide key;` 或 `hide char::face;` | 按 key 或按角色::表情隐藏 |
| 播放音乐 | `music::play("path") \| fadein(n);` | 带淡入时长（秒） |
| 停止音乐 | `music::stop() \| fadeout(n);` | 带淡出时长（秒） |
| 播放音效 | `sound::play("path");` | |
| 停止音效 | `sound::stop();` | |
| 对话 | `speak Name "text" \| "voice.ogg";` | 单行，可选语音 |
| 多行对话 | `speak Name { ... }` | 见下方详细说明 |
| 等待 | `wait(秒);` | 暂停执行指定秒数 |
| 独立过渡 | `with transition;` | 不附属于其他语句的过渡动画 |
| 条件分支 | `if cond { ... } elif cond { ... } else { ... }` | |
| 选项菜单 | `menu { "选项" => { ... } }` | |
| 跳转 | `jump label_name;` | 跳到另一个 label，不返回 |
| 调用 | `call label_name;` | 调用后可 return 回来 |
| 返回 | `return;` | 从 call 返回调用处 |

---

### 过渡效果（transition）

| 名称 | 说明 |
|------|------|
| `dissolve` | 淡入淡出叠化 |
| `fade` | 渐黑后渐出 |
| `flash` | 白色闪光 |
| `move` | 位移过渡 |
| `fadeout(n)` / `fadein(n)` | 音频专用，n 为秒数（浮点） |

---

### 场景切换（scene）

```
// 纯色背景（CSS 颜色值）
scene #000000;
scene #ffffff | dissolve;

// 图片背景
scene "BGs/messhall_day.jpg";
scene "BGs/tent_day.jpg" | dissolve;
```

---

### 立绘显示（show / expr / hide）

立绘分为两层：

- **体型层**（body）：带服装的角色全身图，文件名含下划线，如 `hiro_casual`
- **表情层**（face）：仅头部表情贴图，如 `normal1`、`grin1`、`talking1`

`show body::face` 同时显示两层；`expr char::face` 仅替换表情层。

```
// 显示体型 + 表情，指定位置
show hiro_casual::normal1 @ right2;

// 显示体型 + 表情，带过渡
show hiro_casual::grin1 @ center | dissolve;

// 仅切换表情（角色已在场上）
expr hiro::talking1;
expr hiro::talking1 @ right2 | dissolve;

// 隐藏体型层
hide hiro_casual;

// 隐藏表情层
hide hiro::talking1;
```

**位置（position）** 常用值：

| 值 | 屏幕位置 |
|----|---------|
| `left` | 左侧 15% |
| `cleft` | 偏左 27% |
| `center` | 中央 50% |
| `cright` | 偏右 73% |
| `right` | 右侧 85% |
| `left2` / `right2` | 稍内移的左/右（多人场景） |
| `truecenter` | 屏幕正中（CG 全屏用） |

---

### 音频（music / sound）

```
// 播放 BGM（立即切换）
music::play("Audio/BGM/Outdoors.ogg");

// 播放 BGM（带淡入 2 秒）
music::play("Audio/BGM/Tension.ogg") | fadein(2);

// 停止 BGM（带淡出 3 秒）
music::stop() | fadeout(3);

// 播放音效
sound::play("Audio/SFX/sfx_doorknock.ogg");

// 停止音效
sound::stop();
```

---

### 对话（speak）

`speak` 中的说话人名称在 `.rrs` 源文件中存储为缩写（如 `k`），codegen 根据文件顶部的 `char.*` 声明将其展开为全名后写入引擎 JSON。

```
// 单行对话，无语音
speak k "哦，是这样的。";

// 单行对话，带语音
speak hi "哈哈！" | "Audio/Voice/voices/hiro_v_laugh1.ogg";

// 多行对话块
speak k {
  "让我想想……" | "Audio/Voice/voices/keitaro_v_thinking1.ogg";
  "对，就是这样！" | "Audio/Voice/voices/keitaro_v_sure1.ogg";
  "我们走吧。";
}

// 旁白（无具体说话人）
speak "???" "不知道该说什么好……";
```

---

### 条件分支（if / elif / else）

```
if score >= 90 {
  jump good_end;
} elif score >= 50 {
  jump normal_end;
} else {
  jump bad_end;
}
```

---

### 选项菜单（menu）

```
menu {
  "我想了解更多。" => {
    score += 1;
    speak hi "太好了，我来解释！";
    jump next_scene;
  }
  "也许下次吧。" => {
    speak k "……好吧。";
  }
}

// 带显示条件的选项
menu {
  "继续深聊。" if score >= 5 => {
    jump special_branch;
  }
  "回去休息。" => {
    jump camp_night;
  }
}
```

---

### 跳转与调用（jump / call / return）

```
// 无条件跳转
jump day2;

// 调用子 label（执行完毕后返回）
call intro_sequence;
speak k "序列已播完。";

label intro_sequence {
  scene #000000 | fade;
  speak "???" "很久很久以前……";
  return;
}
```

---

### 变量赋值

```
let day_num = "Day 1";
score = 0;
score += 1;
persistent.animations = True;
```

---

### 完整示例

```
// 角色定义
char.k  = "Keitaro";
char.hi = "Hiro";

label day1 {
  day_num = "Day 1";
  scene #000000;
  sound::play("Audio/SFX/sfx_busengine.ogg");

  speak "???" {
    "这是一段旁白。";
    "接着是第二行。";
  }

  scene "BGs/Entrance - Day.jpg" | dissolve;
  music::play("Audio/BGM/Outdoors.ogg");

  show keitaro_casual::normal1 @ center | dissolve;
  speak k "哦！到了！" | "Audio/Voice/voices/keitaro_v_happy1.ogg";

  expr k::grin1;
  speak k "终于到夏令营了！";

  menu {
    "去找 Hiro 打招呼。" => {
      score += 1;
      jump day1_hiro;
    }
    "先四处逛逛。" => {
      jump day1_explore;
    }
  }
}

label day1_hiro {
  hide keitaro_casual;
  scene "BGs/cabin_day.jpg" | dissolve;
  show hiro_casual::normal1 @ right2;
  speak hi "Keitaro！你来了！" | "Audio/Voice/voices/hiro_v_happy1.ogg";
  jump day2;
}
```

---

## Ren'Py → .rrs 转换器（rpy2rrs.ts）

将原版游戏的 Ren'Py `.rpy` 文件批量转换为 `.rrs` 格式，并生成引擎所需的 `manifest.json`。

### 基本用法

```bash
# 转换单个文件（输出到同目录）
bun run rpy2rrs /path/to/game/day1.rpy

# 转换单个文件，指定输出路径
bun run rpy2rrs /path/to/game/day1.rpy -o assets/data/day1.rrs

# 批量转换整个目录，写入 assets/data/，同时生成 manifest.json
bun run rpy2rrs /path/to/game/ -o assets/data/ --manifest

# 指定游戏名称（写入 manifest.json 的 game 字段）
bun run rpy2rrs /path/to/game/ -o assets/data/ --manifest --game "My VN Game"
```

### 命令行选项

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `-o <path>` | 输出路径（单文件）或输出目录（目录模式） | 同源文件目录 |
| `--manifest` | 生成 `manifest.json`，列出所有含 label 的故事文件 | 关闭 |
| `--script <path>` | 资源映射文件路径（通常是 `script.rpy`） | 自动检测 |
| `--tl <dir>` | 翻译目录（如 `tl/chinese/`），启用翻译合并 | 自动检测 |
| `--no-tl` | 禁用翻译合并，输出原版文本 | — |
| `--skip <pattern>` | 额外跳过匹配该模式的文件（可多次使用） | — |
| `--stub-exit label=var` | 为指定 label 末尾注入 `jump var;`（小游戏存根用） | — |
| `--game <name>` | 游戏名称，写入 manifest.json | — |
| `--dry-run` | 仅解析，不写入文件 | — |
| `--verbose` | 将生成内容打印到 stdout | — |
| `-h`, `--help` | 显示帮助信息 | — |

### manifest.json 格式

转换器生成的 `manifest.json` 格式如下：

```json
{
  "start": "start",
  "game": "My VN Game",
  "files": ["script.rrs", "day1.rrs", "day2.rrs"]
}
```

- `start`：引擎启动时跳转的入口 label，遵循 Ren'Py 约定默认为 `"start"`
- `game`：游戏名称（可选），由 `--game` 参数写入
- `files`：所有含 label 的 `.rrs` 文件列表

### 转换器工作原理

1. **角色映射**：从 `script.rpy`（或游戏目录中的 `.rpy` 文件）解析 `define <abbr> = Character("名字")` 行，构建角色缩写 → 全名映射表。每个转换后的 `.rrs` 文件头部自动生成对应的 `char.*` 声明。
2. **资源映射**：解析音频、背景图、CG、SFX 等资源定义，为 `show` / `scene` / `music` 等语句提供路径解析依据。
3. **`script.rpy` 处理**：`script.rpy` 既作为资源映射来源，同时也被转换为 `script.rrs`，其中的 `label start` 将被引擎加载为游戏入口。
4. **翻译合并**：若存在翻译目录，将对话文本替换为目标语言（按文件逐一加载）。
5. **语句映射**：Ren'Py 语句逐条翻译为 `.rrs`，主要映射关系：

   | Ren'Py | .rrs |
   |--------|------|
   | `scene bg_X [with TRANS]` | `scene "BGs/..." \| trans;` |
   | `show BODY / show BODY FACE` | `show body::face @ pos;` |
   | `hide CHAR` | `hide char;` 或 `hide char::face;` |
   | `play music "path"` | `music::play("path");` |
   | `stop music fadeout N` | `music::stop() \| fadeout(N);` |
   | `CHAR "text"` | `speak <abbr> "text";` |
   | `menu` / `if` / `jump` / `call` | 直接结构映射 |

### 自动跳过的文件

目录模式下以下通用 UI/系统文件会被跳过（可用 `--skip` 追加自定义规则）：

- `screens.rpy`、`gui.rpy`、`options.rpy` 等 UI 框架文件
- `gallery.rpy`、`achievements.rpy` 等系统功能文件

---

## 其他工具

### 编译器（cli.ts）

将 `.rrs` 编译为引擎内部的 JSON Step 数组，便于调试和检查代码生成结果：

```bash
bun run rrs:compile assets/data/day1.rrs
# 等价于
bun run tools/rrs/cli.ts assets/data/day1.rrs
```

### 反编译器（decompile.ts）

将 JSON Step 数组反编译回可读的 `.rrs` 格式：

```bash
bun run rrs:decompile assets/data/day1.json
# 等价于
bun run tools/rrs/decompile.ts assets/data/day1.json
```

### 往返一致性测试（batch_roundtrip.ts）

对指定目录下全部 JSON 文件执行 decompile → compile 往返，验证转换无损：

```bash
bun run rrs:roundtrip assets/data/
# 等价于
bun run tools/rrs/batch_roundtrip.ts assets/data/
```

### 资源验证（validate_assets.ts）

检查所有 `.rrs` 文件中的图片和音频引用路径是否在 `assets/` 目录中实际存在：

```bash
bun run tools/rrs/validate_assets.ts \
  --data assets/data \
  --assets assets \
  --ci
```

| 退出码 | 含义 |
|--------|------|
| `0` | 所有引用均可解析（大小写不敏感） |
| `1` | 存在无法解析的引用（`--ci` 模式下触发） |
| `2` | 无法读取数据目录 |