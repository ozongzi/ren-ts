# TODO — renpy_reader

本文档列出针对项目的短期与中期任务，优先级以「测试 -> CI -> 实现/重构」为主。每一条都有目的、验收标准与预计工作量（粗略），方便按需取用或拆分为 PR。

---

## 总体目标
- 快速建立可靠的单元测试与覆盖率反馈，防止核心逻辑回归。
- 将不可测或副作用重的代码通过依赖注入或抽象改造为可测。
- 在 CI 中强制运行测试并曝光覆盖率报告。
- 优先保证解析器（`src/rrs`）、表达式求值（`src/evaluate.ts`）与引擎（`src/engine.ts`）的正确性。

---

## 测试（高优先级）
目标：覆盖核心库，确保解析/执行链稳定。

- [x] 添加测试框架与基础配置（Vitest + Testing Library）
  - 位置/文件：项目根新增 `vitest.config.ts`、`tests/setupTests.ts`
  - 验收标准：使用 `bun run test`
  - 估时：0.5d

- [x] 为词法器编写单元测试（`src/rrs/lexer.ts`）
  - 覆盖点：标识符、字符串（含转义）、数字、换行/缩进、注释、非法符号（报错位置）。
  - Fixtures：`tests/fixtures/lexer/*.rpy`
  - 估时：1d

- [x] 为语法分析器编写测试（`src/rrs/parser.ts`）
  - 覆盖点：label、menu/choice、jump、if/elif/else、define、语法错误信息。
  - 测试方式：输入示例源 -> 断言 AST 关键字段存在且正确（不要断言整对象以免脆弱）。
  - 估时：1.5d

- [x] 为 codegen 编写测试（`src/rrs/codegen.ts`）
  - 覆盖点：从 AST 到中间指令/序列的映射、行号/位置映射一致性。
  - 估时：1d

- [x] 为表达式求值编写测试（`src/evaluate.ts`）
  - 覆盖点：运算优先级、逻辑短路、类型转换、异常（例如除 0）、变量作用域。
  - 估时：1d

- [x] 为引擎状态机编写测试（`src/engine.ts`）
  - 覆盖点：执行流程（逐条执行）、分支选择、保存/恢复执行点、错误恢复路径。
  - 方法：依赖注入 mock loader / audio / UI 回调，避免真实 IO（通过 spy / mock loader 接口）。
  - 估时：2d

- [ ] loader / assets 测试（`src/loader.ts`、`src/assets.ts`）
  - 覆盖点：资源过滤、路径解析、错误与空目录处理。
  - 估时：0.5d

- [ ] 保存/加载测试（`src/save.ts`）
  - 覆盖点：序列化与反序列化一致性、版本字段测试（兼容性）。
  - 估时：0.5d

- [ ] 关键 UI 组件测试（选择性，`src/components`）
  - 先覆盖：`DialogueBox`, `ChoiceMenu`, `GameScreen` 的关键交互（渲染文本、响应选择、回调触发）
  - 工具：@testing-library/react + user-event
  - 估时：各组件 0.5d

- [x] 测试夹具与工具目录
  - 创建 `tests/fixtures` 存放小型 rpy/rrs 源、AST JSON、保存样板（已添加 lexer fixtures）。
  - 创建 `tests/utils.ts`（常用的 mock helper，例如 fakeLoader、makeEngine） — （部分 helper 已在 engine tests 内以 spy 的方式使用）。
  - 估时：0.5d

本地测试与覆盖率（执行摘要）
- 本地运行：`bun run test`（Vitest + coverage）
- 测试结果：6 个测试文件，44 个测试，全通过（0 failed）。
- 覆盖率摘要（本次本地 run 的 istanbul 报表）：
  - All files: Statements 26.39% | Branch 25.29% | Functions 19.78% | Lines 27.54%
  - 核心模块（已重点测试）：
    - src/rrs (lexer/parser/codegen)：Statements ~64.5%、Lines ~65.7%（lexer/parser/codegen 三者覆盖率明显优于项目平均）
    - src/evaluate.ts：Statements 84.02%（表达式求值逻辑已覆盖较多场景）
- 说明：解析/编译/求值/引擎核心链已建立测试，输出与运行行为稳定；项目总体覆盖率仍偏低，因为 UI、Tauri、IO、保存/加载等文件尚未覆盖。

下一步建议
1. 补全 `loader/assets`、`save` 的单元测试以覆盖 IO 边界（用 mock / spy 避免真实文件系统）。估时：0.5d
2. 为关键 UI 组件（`DialogueBox`, `ChoiceMenu`, `GameScreen`）添加若干交互测试。估时：1.5d
3. 根据 TODO 中的优先级添加 CI workflow（GitHub Actions）：运行 `bun install` + `bun run test` 并上传 coverage artifact。估时：0.5d
4. 逐步提高覆盖率阈值并在 CI 中作为检查项（先从 60% 全局、关键目录 80% 开始）。

如果你同意，我将按上述顺序继续推进并在每一小步完成后更新本 TODO 的进度与本地 test/coverage 结果。
---

## CI（高优先级）
目标：在 PR/Push 时运行测试并上传覆盖率报告。

- [ ] 添加 GitHub Actions Workflow：`/.github/workflows/test.yml`
  - 步骤：checkout -> setup Bun -> install（`bun install`）-> run tests（`bun run test`，with coverage）-> upload coverage artifact
  - 说明：建议在 CI 中用 `bun run test` 来调用 package.json 的 `test` 脚本（例如运行 Vitest），这样可以保证与本地开发时使用的脚本一致。若愿意使用 Bun 自带的测试命令 `bun test`，需要额外调整配置以确保 Vitest 的行为被正确替代或迁移。
  - 验收标准：push 到分支后，workflow 执行成功并生成 coverage 报告。
  - 估时：0.5d

- [ ] 覆盖率策略与阈值
  - 初始全局门槛：60%，关键目录（`src/rrs`, `src/evaluate.ts`, `src/engine.ts`）目标 80%+
  - 在 CI 中对低于阈值的 PR 禁止合并（可先设为警告，逐步增强为阻止）。
  - 估时：配置与讨论 0.5d

- [ ] coverage 输出与展示
  - 输出 `lcov` 与 HTML 报表并上传为 artifact。
  - 可选：集成 Codecov/Codecov.io（需要 token）或 Coveralls。
  - 估时：0.5d

---

## 实现与重构任务（中/中高优先级）
目标：提高可测试性、修复已知 bug、实现重要功能。

- [ ] 将硬编码的 IO/副作用抽象化（依赖注入）
  - 目标文件：`src/engine.ts`、`src/loader.ts`、`src/audio.ts`
  - 成果：引擎接收一个 `platform` 或 `services` 对象（`loadAsset`, `playSound`, `saveData` 等），测试时传入 mock。
  - 估时：1.5d

- [ ] textParser 精简与隔离（`src/textParser.tsx`）
  - 目标：把纯文本解析逻辑拆为纯函数（便于测试），UI 组件只做渲染。
  - 估时：1d

- [ ] 明确 types 与边界条件（`src/types.ts`）
  - 增强类型声明（AST 节点、指令、保存结构），减少运行时错误。
  - 估时：0.5d

- [ ] 修复已知 bug 列表（从 issue / 最近异常日志收集）
  - 将具体 bug 列入单独 issue，再映射到 TODO 子任务。
  - 估时：按 bug 复杂度计

- [ ] 性能优化（低优先）
  - 目标：在必要时优化解析或 codegen 的热路径。
  - 估时：待明确性能问题后估算

---

## 低优先/nice-to-have
- [ ] E2E 测试（Playwright）
  - 针对完整的 UI 运行一个 end-to-end 脚本（可选，后期再做）。
- [ ] CI 自动发布 coverage 报表到静态 hosting（GH Pages）
- [ ] 引入 mutation tests（Stryker）以加强测试的质量（长期）

---

## 任务分配建议（示例）
- 核心测试与 CI：由熟悉项目的开发者（A）完成第一轮（设置 + lexer/parser tests）。
- 引擎 mock 与测试：由负责引擎的开发者（B）负责（依赖注入改造 + engine tests）。
- UI 组件测试：由熟悉 React 的开发者（C）负责（Dialog、ChoiceMenu）。
- 每条任务建议拆成小 PR（小而易评审）。

---

## 取用流程
1. 先实现基础测试框架（Vitest config + setup），并提交到 `test/bootstrap` 分支。
2. 逐个模块添加测试（lexer -> parser -> evaluate -> engine），每次合并保证 CI 通过。
3. 增加 coverage 求和阈值并逐步提高。

---

## 备注
- 测试用例应避免依赖真实文件系统或网络（使用 fixtures / mock），除非测试本身就是针对 IO 行为。
- 任何需要真实资源的集成测试应放在 `integration/` 或独立 workflow 中。
- 我可以根据你选择的第一个任务（例如：添加 Vitest 配置并提交示例测试）直接生成对应的文件与示例测试内容。
