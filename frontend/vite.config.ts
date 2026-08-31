import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/** SDK 的 constructOverrides 未转发 conversation.clientEvents；构建时补上，便于开启中间转写。 */
function patchElevenLabsClientEvents(): Plugin {
  return {
    name: "patch-elevenlabs-client-events",
    transform(code, id) {
      if (!id.replace(/\\/g, "/").includes("@elevenlabs/client/") || !id.endsWith("overrides.js")) {
        return null;
      }
      if (code.includes("client_events: config.overrides.conversation?.clientEvents")) {
        return null;
      }
      const needle =
        "conversation: {\n                text_only: config.overrides.conversation?.textOnly,\n            },";
      const replacement =
        "conversation: {\n                text_only: config.overrides.conversation?.textOnly,\n                client_events: config.overrides.conversation?.clientEvents,\n            },";
      if (!code.includes(needle)) {
        this.warn("ElevenLabs overrides.js shape changed; clientEvents patch skipped");
        return null;
      }
      return code.replace(needle, replacement);
    },
  };
}

export default defineConfig({
  plugins: [react(), patchElevenLabsClientEvents()],
  base: "/realtime/",
  appType: "spa",
  server: {
    port: 5173,
    proxy: {
      "/realtime/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/realtime\/api/, "/api"),
      },
    },
  },
});
