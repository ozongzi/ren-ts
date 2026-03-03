# zip-rpy-migrate-tool

小型工具：递归解析 ZIP / RPA（任意多层嵌套），流式拷贝媒体资源到目标 ZIP，并把脚本（`.rpy` / `.rpyc`）收集到内存后转换成 `.rrs` 写入 `data/`。实现目标与仓库现有 `rpy-migrate-tool` 的转换逻辑复用一致。

概况
- 语言：TypeScript（与仓库风格一致）
- 位置：`ren_ts/zip-rpy-migrate-tool/src/`
- 设计原则：
  - 媒体（图片/音频/视频）完全流式拷贝（不把媒体载入 JS 堆）。
  - 脚本（`.rpy` / `.rpyc`）收集到内存并复用 `rpy-migrate-tool` 的转换器生成 `.rrs`。
  - 支持 ZIP32 / ZIP64，并能递归解析嵌套的 `.zip` 与 `.rpa`。
  - 不并发（按序处理），代码写法便于在浏览器与 Tauri 端统一调用。

实现文件（当前仓库内）
- `src/zipIndex.ts`：ZIP 中央目录解析（ZIP32 / ZIP64），并提供获取 entry 数据偏移与数据流的工具。
- `src/processor.ts`：主解析器，从上传的顶层 ZIP 中搜索最外层 `game/` 根，遍历 game 下的条目：
  - 媒体条目（图片/音频/视频）记录为 `MediaEntry`（包含来源引用），稍后可流式写入目标 ZIP。
  - 脚本 `.rpy` / `.rpyc` 全部读入内存，收集到 `scripts[]` 以便后续转换。
  - 嵌套 `.zip` / `.rpa` 以流式方式递归解析（不会一次性把整个嵌套包解入内存）。
- `src/zipWriterTool.ts`：流式写入目标 `assets.zip` 的工具（使用项目中已有的 `zipWriter` helpers），
  - 媒体：以 `STORE`（method 0）写入，流式传输并计算 CRC-32。
  - 脚本：写入 `data/*.rrs`（根据扩展名决定是否使用 DEFLATE 压缩）。
  - 最终写入 `data/manifest.json`（格式见下）。
- `src/cliTest.ts`：一个 Node 测试脚本（示例），会读取仓库下的 `assets/test.zip`，运行解析、转换，并把输出写到 `zip-rpy-migrate-tool/out/`（方便离线查看结构）。
- `package.json`（工具子包）包含简单的 build/test 脚本以便在本地调试。

对外 API（供 UI / Tauri / 浏览器 调用）
- processTopLevelZip(zipFile: File | Blob) => Promise<ProcessResult>
  - 返回 `{ gameDir, scripts, media }`
  - `scripts` 中每项 { path, data, isRpy }：`.rpy` 以 string 保持，`.rpyc` 以 Uint8Array 保持
  - `media` 中每项为 { path, source }，`source` 可以是 zip-entry ref 或 rpa-entry ref，供写入器流式读取
- buildAssetsZip(writable, mediaEntries, scriptsMap, opts) => Promise<void>
  - `writable`：目标写入流（浏览器为 `FileSystemWritableFileStream` / Tauri 为等价的写入接口）
  - `mediaEntries`：来自 `processTopLevelZip` 的 media 列表（或等价转换）
  - `scriptsMap`：Map<string, string>，键为 `xx.rrs` 名称，值为 `.rrs` 内容
  - `opts`：可选 `gallery` 与 `onProgress` 回调

manifest.json 格式（目前实现）
```json
{
  "files": ["day1.rrs", "day2.rrs", ...],
  "gallery": [...] // 可选，若有图鉴解析则填充
}
```
- `files` 是简单的 string[]（仅文件名或相对路径），与仓库其它模块约定兼容。

如何在本仓库做测试（离线 Node 快速验证）
1. 把你的测试 zip 放到仓库位置：`ren_ts/assets/test.zip`
2. 运行（在项目根或工具子包目录）：
   - 使用 root 的 TypeScript 编译器和 Node：
     - 编译：`npm run build`（项目根或正确配置的子包编译脚本）
     - 或直接将 `zip-rpy-migrate-tool/src/cliTest.ts` 用 ts-node/Node 运行（需要 Node 18+ 的 Blob 支持或做小改动）
   - 工具目录自带 `package.json`，你也可以：
     - 进入 `ren_ts/zip-rpy-migrate-tool`，运行 `npm run test`（会尝试编译并执行 `cliTest`）
3. 结果会写入 `ren_ts/zip-rpy-migrate-tool/out/`（脚本和媒体以目录结构输出），你应能看到类似：
```
out/
  data/
    day1.rrs
    day2.rrs
    manifest.json
  images/CGs/yoichi/sx_yoichi_9_6b.jpg
```

注意与限制（你需要知道的）
- 我复用了仓库已有的 `rpaReader.ts`、`rpycReader.ts`、以及 `rpy-rrs-bridge` 模块来完成 RPA 解析与脚本转换；这能避免重复实现并保持行为一致。
- 媒体流式拷贝：实现保证不会把媒体完全载入内存，但在 Node 测试中我使用了方便的 Blob/Buffer 操作 —— 在某些 Node 版本上，Blob 的 `arrayBuffer()`、`stream()` 支持需 Node 18+。
- `.rpyc` 会被解析（使用现有 `rpycReader` + `rpyc2rrs-core`）并转换为 `.rrs`；如果某些 `rpyc` 的布局极其特殊，可能需要额外适配。
- `tl/**/*.rpy`（翻译源）在当前代码路径中仅在上层调用者传入时才被使用（processor 本身只收集脚本；翻译映射由调用者构建并传入 `convertScriptsToRrs` / 或构造 `scriptsMap`）；如果你希望 processor 自动查找/应用 `tl/` 目录，请告诉我我会加上。
- 当前实现不做并发，按你要求顺序处理，便于调试与可预测性。
- UI（`Tools.tsx`）的集成需要：在浏览器/tauri 的保存流程中，用 `showSaveFilePicker()` / Tauri 保存 API 预占保存目标，然后把得到的 writable 传入 `buildAssetsZip`。这和仓库中现有 `converterFs.buildZip()` 的使用方式是一致的。

下一步建议（我可以继续做）
- 如果你希望，我可以：
  - 添加 `src/index.ts` 作为对外统一导出（`processTopLevelZip` / `buildAssetsZip` / types）并更新子包 `package.json` 的入口指向；
  - 把 UI（`Tools.tsx`）中的“选择 ZIP / 保存 assets.zip”流程接入该工具（浏览器 + Tauri 一致）；
  - 增强 `cliTest`，直接输出一个 `assets.zip`（而不是目录），用于与游戏运行时代码直接配合测试。
- 告诉我你要我接着做哪一项（或直接合并到现有 UI），我就开始实现并提交具体修改。

如果你现在要我把 `src/index.ts`（对外导出）加上并把 UI 绑定到这个工具，我可以立即开始（会在 `zip-rpy-migrate-tool` 内添加一个统一导出文件并更新 README 里的说明）。你想先让我做哪件事？