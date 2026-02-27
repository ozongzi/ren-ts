import ts from "/root/.nvm/versions/node/v22.21.1/lib/node_modules/typescript/lib/typescript.js";

const tsProcessor = {
  preprocess(text, filename) {
    const isTsx = filename.endsWith('.tsx');
    const out = ts.transpileModule(text, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ESNext,
        jsx: isTsx ? ts.JsxEmit.ReactJSX : ts.JsxEmit.None,
      },
      fileName: filename,
      reportDiagnostics: false,
      removeComments: true,
    });
    return [out.outputText];
  },
  postprocess(messages) {
    return messages[0] ?? [];
  },
  supportsAutofix: false,
};

export default [
  { ignores: ["dist", "src-tauri"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: {
      local: {
        processors: {
          ts: tsProcessor,
        },
      },
    },
    processor: "local/ts",
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: "module",
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_|^React$" }],
      "no-unreachable": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
    },
  },
];
