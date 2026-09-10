import { defineConfig } from "vite";
import { drawdyExtension } from "./vite-plugin-drawdy";

export default defineConfig({
    appType: "custom",
    server: {
        // 5173 is the starter's default and link-chip already sits there;
        // each dev server is an independent link in Drawdy, so DOOM gets its own.
        port: 5174,
        strictPort: true,
    },
    plugins: [drawdyExtension()],
});
