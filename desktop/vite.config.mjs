import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 렌더러만 vite 로 묶는다. main·worker·preload 는 tsc 가 따로 굽는다 (tsconfig.main.json).
export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react()],
  build: { outDir: "../../build/renderer", emptyOutDir: true },
});
