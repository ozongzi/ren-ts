const noopProcessor = {
  preprocess() {
    return [""];
  },
  postprocess() {
    return [];
  },
  supportsAutofix: true,
};

export default [
  { ignores: ["dist", "src-tauri"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: {
      local: {
        processors: {
          noop: noopProcessor,
        },
      },
    },
    processor: "local/noop",
  },
];
