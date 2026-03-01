# Refactor Plan

This document tracks planned improvements to the codebase, ordered by priority.
Each item includes the problem, the exact change needed, and the files affected.

---

## 🔴 P1 — Fix First

### R1 · `_inlineRegistry` 内存泄漏

**问题**

每次玩家做选择（menu）或进入 `if` 分支，`_registerInlineSteps` 都会往
`_inlineRegistry` 写入一个 `__inline_N` 条目。`runUntilBlocked` 在 inline label
耗尽时只删当前 label，但由于 `jump` 会清空 callStack 后继续执行新 label，
之前堆积在栈里的 inline label 永远不会被删除。玩一个长游戏足以让这个 Map
积累数千条废弃 entry。

**改法**

在 `engine.ts` 的 `jump` 处理逻辑里，执行跳转前把 `_inlineRegistry` 里所有
当前 callStack 引用到的 inline label 全部删除：

```ts
// engine.ts — executeStep > case "jump"
// 跳转清栈时，清理所有不再可达的 inline label
function _pruneInlineRegistry(callStack: StackFrame[]): void {
  const reachable = new Set(callStack.map((f) => f.label));
  for (const key of _inlineRegistry.keys()) {
    if (!reachable.has(key)) {
      _inlineRegistry.delete(key);
    }
  }
}
```

在 `jump` 清空 callStack 之前调用 `_pruneInlineRegistry(state.callStack)`；
`load save` 时（`applySave`）同样调用一次。

**涉及文件**

- `src/engine.ts`

---

### R2 · Debug 日志用编译开关控制

**问题**

`engine.ts` 里约 30 处 `console.log/info` 在生产包里仍然执行，包含大量
`JSON.stringify`、字符串模板插值，对每一帧的推进都产生不必要的开销。
每个调用都被包在 `try/catch` 里，进一步增加了 overhead。

**改法**

在 `engine.ts` 顶部用 Vite 的编译时常量替代：

```ts
// src/engine.ts 顶部
const DBG = import.meta.env.DEV;
```

把所有 `try { console.log("[engine-debug] ...") } catch {}` 替换为：

```ts
if (DBG) console.log("[engine-debug] ...");
```

Vite 生产构建时 `import.meta.env.DEV` 被替换为字面量 `false`，
esbuild/terser 会将整个 `if (false) { ... }` 块 tree-shake 掉，
生产包里零 console 调用、零字符串分配。

同时去掉所有 `try/catch` 包裹（本来就是为了"忽略日志错误"——
日志本身用编译开关控制后不需要这层防御）。

**涉及文件**

- `src/engine.ts`

---

### R3 · 拆分 God Object Store

**问题**

`src/store.ts` 约 540 行，把引擎状态、UI 开关、存档 I/O、音量设置、
Tauri 目录管理全部混在一个 `create<Store>()` 调用里。职责过多导致：
- 修改任何一块都要通读整个文件
- 单测无法只针对某个 slice 做隔离测试
- `StoreState` 把 `GameState` 和 UI 状态用 `extends` 混合，
  造成 `set(next as Partial<Store>)` 这类强制类型转换

**改法**

采用 Zustand 官方推荐的 **slice pattern**，把 store 拆成五个独立文件，
再在 `store.ts` 里合并：

```
src/store/
  gameSlice.ts     — GameState 字段 + click / choose / jumpTo / newGame / enterGame
  uiSlice.ts       — showGallery / showSettings / showTools / saveError / showSaveSelector
  saveSlice.ts     — saveFileHandle / saveFilePath / saveFileName + saveExport / saveImport / continueSave
  volumeSlice.ts   — volumeMaster/BGM/SFX/Voice + setVolume* + loadVolumes/saveVolumes
  assetsSlice.ts   — assetsDir + setAssetsDir / clearAssetsDir + init
src/store.ts       — 组合入口 + 所有 selector 保持不变（对外 API 零破坏）
```

每个 slice 的签名：

```ts
// 示例：volumeSlice.ts
export interface VolumeSlice {
  volumeMaster: number;
  volumeBGM: number;
  volumeSFX: number;
  volumeVoice: number;
  setVolumeMaster: (v: number) => void;
  setVolumeBGM: (v: number) => void;
  setVolumeSFX: (v: number) => void;
  setVolumeVoice: (v: number) => void;
}

export const createVolumeSlice: StateCreator<
  VolumeSlice,
  [],
  [],
  VolumeSlice
> = (set, get) => ({ ... });
```

`Store` 类型变为各 slice 接口的交集，`useGameStore` 保持单一导出，
所有已有的 selector（`selectGameScreen` 等）无需改动。

`applyGameState` 和 `syncAudio` 作为模块私有函数留在 `gameSlice.ts` 中，
不暴露到 store 接口。

**涉及文件**

- `src/store.ts` → 拆分为 `src/store/` 目录 + 原路径保留为重导出入口
- `src/store/gameSlice.ts` (新建)
- `src/store/uiSlice.ts` (新建)
- `src/store/saveSlice.ts` (新建)
- `src/store/volumeSlice.ts` (新建)
- `src/store/assetsSlice.ts` (新建)

---

## 🟡 P2 — 应该做

### R4 · 提取 `<IconButton>` 组件，消除 `App.tsx` 内联样式重复

**问题**

`App.tsx` 里设置和工具两个按钮的样式对象完全相同（约 20 行），
只有 emoji 和 `aria-label` 不同。后续新增按钮时极易出现样式不一致。

**改法**

新建 `src/components/IconButton.tsx`：

```tsx
interface IconButtonProps {
  icon: string;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}

export const IconButton: React.FC<IconButtonProps> = ({ icon, label, disabled, onClick }) => (
  <button
    className={`icon-btn${disabled ? " icon-btn--disabled" : ""}`}
    aria-label={label}
    disabled={disabled}
    onClick={onClick}
  >
    <span role="img" aria-label={label}>{icon}</span>
  </button>
);
```

对应样式移入 `src/index.css`（`.icon-btn` + `.icon-btn--disabled`），
替换 `App.tsx` 里两处内联 `<button>` 为 `<IconButton>`。

**涉及文件**

- `src/components/IconButton.tsx` (新建)
- `src/App.tsx`
- `src/index.css`

---

### R5 · 封装 `Loader` 类，消除模块级可变状态

**问题**

`src/loader.ts` 顶层有 6 个 `let/const` 可变变量（`labelIndex`、
`loadedFiles`、`defineVars` 等），靠一个暴露出去的 `reset()` 函数在
测试间手动清理。这种模式在平行测试或热重载时容易出现状态污染。

**改法**

把所有状态封装进 `GameData` 类，对外暴露同名函数作为默认单例的薄包装：

```ts
// src/loader.ts
export class GameData {
  private labelIndex = new Map<string, Step[]>();
  private loadedFiles = new Set<string>();
  private manifestFiles: string[] = [];
  private manifestStart = "start";
  private manifestGame: string | undefined;
  private manifestGallery: GalleryEntry[] = [];
  private defineVars: Record<string, unknown> = {};

  async loadAll(): Promise<void> { ... }
  async loadFile(filename: string): Promise<void> { ... }
  getLabel(name: string): Step[] | null { ... }
  hasLabel(name: string): boolean { ... }
  allLabels(): string[] { ... }
  getManifestStart(): string { ... }
  getManifestGame(): string | undefined { ... }
  getGallery(): GalleryEntry[] { ... }
  getDefineVars(): Record<string, unknown> { ... }
  reset(): void { ... }
}

// 向后兼容：默认单例 + 同名函数导出
export const defaultGameData = new GameData();
export const loadAll    = () => defaultGameData.loadAll();
export const getLabel   = (n: string) => defaultGameData.getLabel(n);
// ...其余同理
```

测试中直接 `new GameData()` 即可得到干净实例，不再依赖 `reset()`。

**涉及文件**

- `src/loader.ts`
- `tests/` 中使用 `reset()` 的测试文件

---

### R6 · `AudioManager` 支持多 SFX 通道

**问题**

`sfxEl` 是单个 `HTMLAudioElement | null`，同时触发两个音效时后者会
打断前者。Ren'Py 本身支持多通道 SFX，部分游戏依赖叠音效。

**改法**

用一个小型对象池替换单元素：

```ts
// src/audio.ts — AudioManager 内部
private sfxPool: HTMLAudioElement[] = [];
private readonly SFX_POOL_SIZE = 4;

playSFX(src: string): void {
  if (!src) return;
  // 找一个空闲的（已结束或未使用的）元素
  let el = this.sfxPool.find((e) => e.paused || e.ended);
  if (!el) {
    if (this.sfxPool.length < this.SFX_POOL_SIZE) {
      el = new Audio();
      this.sfxPool.push(el);
    } else {
      // 池满：复用最早开始播放的那个
      el = this.sfxPool[0];
      el.pause();
    }
  }
  el.src = src;
  el.volume = this._effectiveVolume("sfx");
  el.play().catch(() => {});
}

stopSFX(): void {
  for (const el of this.sfxPool) {
    el.pause();
    el.src = "";
  }
}
```

`setVolumes` 也需要对 pool 里所有元素更新 volume。

**涉及文件**

- `src/audio.ts`

---

## 🟢 P3 — 性能优化

### R7 · `applySetStep` 直接操作 `VarStore`，跳过全量 Record 复制

**问题**

每次执行 `set` 步骤时的调用链：
1. `state.vars.toRecord()` → 把 `_defines`（可能有数千条）和 `_game` 合并成新对象
2. `applySetStep(merged, step)` → 操作并返回新 merged 对象
3. `state.vars.replaceGameVars(result)` → 遍历所有 key 过滤掉 define 的 passthrough

对于 define 多（1000+ 条）的游戏，这意味着每次玩家触发一个变量赋值步骤
都要做两次大对象复制 + 一次线性扫描。

**改法**

在 `VarStore` 上新增 `applySet` 方法，直接在 `_game` 层操作：

```ts
// src/vars.ts — VarStore
applySet(step: Extract<Step, { type: "set" }>): VarStore {
  // 只在 _game 层读写，_defines 只读查询
  const current = this.get(step.var) ?? 0;
  const rawVal = parseValue(step.value);
  let value: unknown = typeof rawVal === "string" && this.has(rawVal)
    ? this.get(rawVal)
    : rawVal;

  switch (step.op) {
    case "=":  break;
    case "+=": value = (current as number) + (value as number); break;
    case "-=": value = (current as number) - (value as number); break;
    case "*=": value = (current as number) * (value as number); break;
    case "/=": {
      const d = value as number;
      value = d !== 0 ? (current as number) / d : 0;
      break;
    }
  }
  return this.set(step.var, value);
}
```

`engine.ts` 中 `case "set"` 从：

```ts
const merged = applySetStep(state.vars.toRecord(), step);
const vars = state.vars.replaceGameVars(merged);
```

改为：

```ts
const vars = state.vars.applySet(step);
```

注意：`applySetStep` 里还处理了 `renpy.random.randint` 函数调用。
该逻辑需要一并迁移到 `VarStore.applySet` 或作为 `VarStore` 的
静态辅助函数保留，确保功能对等后再删除旧路径。

**涉及文件**

- `src/vars.ts`
- `src/engine.ts`
- `src/evaluate.ts`（`applySetStep` 可标记为 `@deprecated` 后逐步删除）

---

### R8 · Android CI 配置签名（为正式发布准备）

**问题**

CI 里 `build-android` 生成的 APK 未签名，只能旁加载，无法上架应用商店。

**改法**

在 repository secrets 里存入 keystore（Base64 编码），在 workflow 里
注入签名配置：

```yaml
# .github/workflows/ci.yml — build-android job
- name: Decode keystore
  run: |
    echo "${{ secrets.ANDROID_KEYSTORE_BASE64 }}" | base64 --decode \
      > src-tauri/gen/android/keystore.jks

- name: Build signed APK
  run: bun run tauri android build
  env:
    NDK_HOME: ${{ env.ANDROID_HOME }}/ndk/25.2.9519653
    ANDROID_KEYSTORE_PATH: keystore.jks
    ANDROID_KEYSTORE_PASSWORD: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
    ANDROID_KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}
    ANDROID_KEY_PASSWORD: ${{ secrets.ANDROID_KEY_PASSWORD }}
```

需要在 Tauri 的 Android 配置（`src-tauri/gen/android/app/build.gradle.kts`）
里对应读取这些环境变量配置 `signingConfigs`。

所需 Secrets（在 GitHub repo Settings → Secrets 里添加）：
- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

**涉及文件**

- `.github/workflows/ci.yml`
- `src-tauri/gen/android/app/build.gradle.kts`

---

## 执行顺序建议

| 顺序 | 编号 | 预计工作量 | 说明 |
|------|------|-----------|------|
| 1 | R2 | 1–2 小时 | 改动最小、收益直接，先做可以让后续调试更干净 |
| 2 | R1 | 1 小时 | 加一个函数 + 两处调用点，风险低 |
| 3 | R7 | 2–3 小时 | 需要迁移 `randint` 逻辑，改完跑测试验证 |
| 4 | R3 | 半天 | 改动面大但对外 API 不变，按 slice 逐个迁移 |
| 5 | R5 | 2–3 小时 | 先写 `GameData` 类，再替换模块级导出 |
| 6 | R4 | 1 小时 | 纯 UI 重构，可随时穿插进行 |
| 7 | R6 | 1–2 小时 | 独立模块，不影响其他逻辑 |
| 8 | R8 | 1 小时 | 需要先生成 keystore，有外部依赖 |

每个 P1 项完成后建议跑一遍完整测试套件（`bun run test`）验证无回归。
R3（拆 store）完成后对照原有 selector 做一轮手动功能回归测试。