# .rrs 语法说明

`.rrs`（Ren'Ts Script）是本项目专用的视觉小说脚本语言，语法简洁，面向故事流程。
文件由顶层声明和若干 **label（场景入口）** 组成，引擎按 label 名加载并逐条执行。

### 顶层结构

```
// 注释用双斜线

// 顶层全局声明（在所有 label 之外）
char.k  = "Keitaro";
char.hi = "Hiro";
audio.bgm_main = "Audio/BGM/Main.ogg";
position.left1 = 0.30;

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

顶层声明**不能出现在 label 内部**，写作裸赋值。主要有四类：

#### 角色名定义

```
char.<abbr> = "全名";
```

转换器（`rpy2rrs.ts`）会自动从游戏的 `.rpy` 文件中提取 `Character("名字")` 定义，并生成对应的 `char.*` 声明。运行时 codegen 将 `speak` 语句中的缩写展开为全名后写入引擎 JSON。

#### 音频别名定义

```
audio.<alias> = "Audio/BGM/SomeTrack.ogg";
```

在 `music::play` / `sound::play` / `speak` 的语音字段中可用别名引用路径。

#### 位置定义

```
position.<name> = <xpos>;
```

由 `rpy2rrs.ts` 从 Ren'Py 的 `Position(xpos=X, xanchor='center')` 转换而来，`xpos` 为 0–1 的比例值。支持两种原始写法：

```python
define left1  = Position(xpos=0.30, xanchor='center')   # define 形式
$ p4_1 = Position(xpos=0.20, xanchor='center')           # $ 赋值形式
```

生成：

```
position.left1 = 0.30;
position.p4_1  = 0.20;
```

引擎在解析 `@ pos` 时优先查运行时位置表，找不到再回退到内置命名位置（`left`、`center`、`right` 等）。

#### 通用常量

```
GAME_NAME = "My VN Game";
```

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

**位置（position）** 内置命名值：

| 值 | 屏幕位置 |
|----|---------|
| `left` | 左侧 25% |
| `cleft` | 偏左 27% |
| `center` | 中央 50% |
| `cright` | 偏右 73% |
| `right` | 右侧 75% |
| `left1`–`left4` | 多人场景左侧各槽位 |
| `right1`–`right4` | 多人场景右侧各槽位 |
| `truecenter` | 屏幕正中（CG 全屏用） |

`p4_1`、`p7_3a` 等游戏自定义位置从 `script.rrs` 的 `position.*` 声明中动态加载。

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

`speak` 中的说话人在 `.rrs` 源文件中存储为缩写（如 `k`），codegen 根据 `char.*` 声明将其展开为全名后写入引擎 JSON。

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
score = 0;
score += 1;
flag_met_hiro = true;
```

---

### 完整示例

```
char.k  = "Keitaro";
char.hi = "Hiro";

label day1 {
  score = 0;
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


