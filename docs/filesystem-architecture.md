# 文件系统架构

Ren'Ts 有两套完全独立的文件系统抽象，分别服务于不同的场景：

- **运行时文件系统**（`IFileSystem`）— 引擎运行游戏时读取脚本和素材
- **转换器文件系统**（`IConverterFs`）— 工具页面把游戏原始文件转换成 ZipFS 包

两套接口互不依赖，命名相似但职责完全不同。

---

## 一、运行时文件系统（IFileSystem）

**定义位置**：`src/filesystem.ts`

### 作用

引擎运行时的唯一 I/O 入口。`loader.ts`、`assets.ts`、`audio.ts` 等模块都通过它读取文件，从不直接访问磁盘或网络。

### 接口

```ts
interface IFileSystem {
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  resolveUrl(path: string): Promise<string>;   // 返回可直接给 <img src> 用的 URL
  exists(path: string): Promise<boolean>;
}
```

### 生命周期

模块内维护一个单例 `_fs`，通过以下函数管理：

| 函数 | 说明 |
|------|------|
| `mountFilesystem(impl)` | 挂载一个实现，游戏启动时调用一次 |
| `getFs()` | 获取当前实例，未挂载则抛错 |
| `hasFilesystem()` | 检查是否已挂载 |
| `unmountFilesystem()` | 卸载并释放 Blob URL 缓存（换游戏时调用） |

### 实现类

#### `ZipFS`

读取用户选择的 `.zip` 游戏包（即 ZipFS 格式）。

- 启动时解析 ZIP Central Directory，建立路径→偏移量索引（只读一次）
- `STORE`（method=0）：直接 `File.slice()` 返回原始字节，零拷贝，适合图片/音频
- `DEFLATE`（method=8）：按需用 `DecompressionStream` 解压，适合 `.rrs`/`.json`
- `resolveUrl()`：首次调用时创建 Blob URL 并缓存；`dispose()` 时统一 revoke
- 支持 ZIP64（超过 4 GB 的包）

#### `WebFetchFS`

用于 Web 自托管部署，直接通过 HTTP 请求静态服务器上的文件。

- 路径直接拼接到 `base` URL，不需要任何索引
- `resolveUrl()` 直接返回 `/assets/...` 路径，浏览器自己缓存

### 路径约定（ZIP 内部）

```
data/manifest.json          — 游戏清单
data/day1.rrs               — 转换后的脚本
images/BGs/bg_entrance.jpg  — 背景图
images/CGs/cg_arrival1.jpg  — CG
images/Sprites/...          — 立绘
Audio/BGM/main.ogg          — 背景音乐
Audio/Voice/...             — 语音
videos/op.webm              — 视频
```

`assets.ts` 中的 `_toFsPath()` 负责把脚本里的裸路径（如 `"BGs/bg.jpg"`）
转换为上述带前缀的 ZIP 内路径（`"images/BGs/bg.jpg"`）。

---

## 二、转换器文件系统（IConverterFs）

**定义位置**：`src/converterFs/types.ts`  
**入口（barrel）**：`src/converterFs.ts`

### 作用

工具页面把游戏目录（含 `.rpy`/`.rpyc`/`.rpa`/素材）转换成 ZipFS 包时使用。
转换完成后，该接口的实例即可丢弃；运行游戏只用 `IFileSystem`。

### 接口

```ts
interface IConverterFs {
  readonly label: string;                         // 目录名，显示在 UI 上

  walkDir(dir: string,
          predicate: (name: string) => boolean): Promise<string[]>;

  readText(relPath: string):   Promise<string | null>;
  readBinary(relPath: string): Promise<Uint8Array | null>; // 二进制（.rpyc 等）
  writeText(relPath: string, content: string): Promise<void>;
  exists(relPath: string): Promise<boolean>;

  pickZipSaveTarget(): Promise<unknown | null>;   // 在用户手势中预占保存目标
  buildZip(...): Promise<void>;                   // 流式写入 ZIP
}
```

`readBinary` 与 `readText` 的区别：不做任何字符编码转换，保证 `.rpyc`
等二进制文件不被 UTF-8 解码破坏。

### 实现类

两个实现对调用方完全透明，都通过 `pickConverterFs()` 工厂函数按平台自动选择：

```ts
// src/converterFs.ts
export async function pickConverterFs(): Promise<ConverterFsResult | null> {
  if (isTauri) return pickTauriConverterFs();
  return pickFsaConverterFs();
}
```

#### `FsaConverterFs`（浏览器 / Web）

基于 **File System Access API**（Chrome/Edge 86+）。

- 用 `showDirectoryPicker()` 让用户选目录，获得 `FileSystemDirectoryHandle`
- 目录遍历：`fsaWalkDir()`（`src/converterFs/fsaHelpers.ts`），递归枚举
  `dirHandle.values()`，自动跳过 `.git`、`node_modules` 等系统目录
- 路径解析：`fsaResolveFile()` / `fsaResolveDir()` 按路径段逐级 `getDirectoryHandle()`
- ZIP 写入：`buildZip()` 调用 `showSaveFilePicker()` 拿到可写流，
  通过 `CompressionStream("deflate")` 流式压缩，**JS 堆内存始终 O(管道缓冲)**，
  与游戏总大小无关

#### `TauriConverterFs`（桌面 Tauri）

基于 **Tauri plugin-fs** 原生文件 API。

- 用 `pickDirectory()` 调出原生目录选择对话框
- 所有路径在调用 Tauri API 前拼接成绝对路径（`rootPath + "/" + rel`）
- ZIP 写入：调用 Rust 侧的 `streamingBuildZip` 命令，在进程内完成，
  性能比浏览器更高，且不受 Service Worker / OPFS 限制

### RPA 透明挂载

两个实现都内置了 `.rpa` 资源包的透明处理：

1. 首次 `walkDir()` 时扫描根目录下所有 `*.rpa` 文件
2. 解析每个 RPA 的索引（路径→偏移量），缓存到 `_rpaCache`（`Map<relPath, RpaVirtualFile>`）
3. `walkDir` 返回的文件列表 = 磁盘文件 ∪ RPA 虚拟文件（磁盘优先，同路径时磁盘文件覆盖 RPA）
4. `readText` / `readBinary` / `buildZip` 中，若目标文件在 RPA 内，则从 RPA 中提取原始字节

对调用方（`Tools.tsx`）完全透明，无需感知文件来自磁盘还是 RPA。

### 子模块分工

| 文件 | 职责 |
|------|------|
| `converterFs/types.ts` | `IConverterFs`、`ZipProgress`、`VirtualZipEntry`、`CancelledError` 等公共类型 |
| `converterFs/fsaHelpers.ts` | FSA 路径解析（`fsaResolveFile`/`Dir`）和目录递归（`fsaWalkDir`） |
| `converterFs/zipWriter.ts` | 浏览器侧 ZIP 格式工具函数：常量、CRC-32、Local Header / Central Dir / EOCD 构建、`deflateStream()` |
| `converterFs/FsaConverterFs.ts` | FSA 实现 + `pickFsaConverterFs()` 工厂 |
| `converterFs/TauriConverterFs.ts` | Tauri 实现 + `pickTauriConverterFs()` / `tauriConverterFsFromPath()` 工厂 |
| `converterFs.ts`（根） | barrel 文件，统一 re-export 所有公共符号 + `pickConverterFs()` 平台分发 |

---

## 三、输入文件处理（转换流程）

转换工具（`src/components/Tools.tsx`）通过 `IConverterFs` 读取三种输入格式：

### `.rpy`（明文脚本，最优先）

- `walkDir("", f => f.endsWith(".rpy"))` 收集所有脚本
- `readText(path)` 直接读取 UTF-8 文本
- 通过 `rpy-rrs-bridge/` 中的文本解析器转换为 `.rrs`

### `.rpyc`（编译脚本，当无 `.rpy` 时使用）

- `walkDir("", f => f.endsWith(".rpyc"))` 收集，同名 `.rpy` 存在时跳过
- `readBinary(path)` 读取原始字节（不做 UTF-8 转换）
- `src/rpycReader.ts`：解析 rpyc 格式（支持旧版行分隔和 Ren'Py 8.x 二进制表两种布局），zlib 解压 AST slot
- `src/pickle.ts`：解码 Python pickle 流，还原 `renpy.ast.*` 节点树
- `rpy-rrs-bridge/rpyc2rrs-core.ts`：AST 节点树 → `.rrs` 文本

### `.rpa`（资源包）

- 由 `_getRpaIndex()` 在首次 walkDir 时自动发现并索引
- `src/rpaReader.ts`：解析 RPA 索引（pickle 格式的路径→偏移量映射）
- 后续 `readBinary` / `buildZip` 透明地从 RPA 中提取文件字节

---

## 四、关系总览

```
用户选择游戏目录
       │
       ▼
 pickConverterFs()
  ├─ isTauri → TauriConverterFs   (src/converterFs/TauriConverterFs.ts)
  └─ 浏览器  → FsaConverterFs     (src/converterFs/FsaConverterFs.ts)
       │           两者均实现 IConverterFs，透明支持 RPA 挂载
       │
       ▼
  Tools.tsx（转换流程）
  ├─ .rpy   → readText()  → rpy-rrs-bridge  → .rrs 文本
  ├─ .rpyc  → readBinary() → rpycReader → pickle → rpyc2rrs-core → .rrs 文本
  ├─ .rpa   → _getRpaIndex() 自动索引，读取时透明提取
  └─ 素材    → buildZip() 流式打包
       │
       ▼
    assets.zip（ZipFS 格式）
       │
       ▼
 用户打开游戏 → mountFilesystem(ZipFS)
       │
       ▼
  ZipFS / WebFetchFS    (src/filesystem.ts)
  均实现 IFileSystem，引擎/加载器通过 getFs() 访问
       │
  ┌────┴────────────────┐
  ▼                     ▼
loader.ts            assets.ts
读 data/*.rrs        解析图片/音频路径
parseScript()        resolveAssetAsync()
建立 labelIndex      返回 Blob URL / HTTP URL
```

---

## 五、关键设计决策

| 决策 | 原因 |
|------|------|
| 运行时与转换器使用不同接口 | 运行时只需只读，转换器需要写入、目录遍历、ZIP 打包，职责差异大 |
| `IConverterFs` 同时暴露 `readText` 和 `readBinary` | `.rpyc` 等二进制文件不能经过 UTF-8 解码，必须有独立的二进制读取路径 |
| RPA 透明挂载在 `IConverterFs` 层 | 上层工具代码（Tools.tsx）无需感知文件来自磁盘还是 RPA，统一路径空间 |
| `buildZip` 流式写入 | 避免将整个游戏包（可能数 GB）加载进 JS 堆，FSA 版内存始终 O(管道缓冲) |
| `pickZipSaveTarget()` 与 `buildZip()` 分离 | 浏览器要求 `showSaveFilePicker()` 必须在同步用户手势中调用，而 buildZip 前有大量异步工作，必须提前占坑 |
| ZipFS 只在首次 `mount` 时解析 Central Directory | ZIP Central Directory 在文件末尾，只需一次随机读取即可建立完整索引，后续访问为 O(1) 查表 |