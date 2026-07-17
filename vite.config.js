import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { configDefaults } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    exclude: [...configDefaults.exclude, "e2e/**"]
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("/node_modules/")) return undefined;
          if (id.includes("/node_modules/katex/")) return "katex";
          if (
            id.includes("/node_modules/react-markdown/")
            || id.includes("/node_modules/remark-")
            || id.includes("/node_modules/rehype-")
            || id.includes("/node_modules/unified/")
            || id.includes("/node_modules/mdast-")
            || id.includes("/node_modules/hast-")
            || id.includes("/node_modules/micromark")
          ) return "rich-text";
          if (
            id.includes("/node_modules/react/")
            || id.includes("/node_modules/react-dom/")
            || id.includes("/node_modules/scheduler/")
          ) return "react-vendor";
          if (id.includes("/node_modules/lucide-react/")) return "icons";
          return "vendor";
        }
      }
    }
  }
});
