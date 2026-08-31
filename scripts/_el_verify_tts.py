import subprocess
from pathlib import Path

OPENCLI = str(Path.home() / "AppData/Roaming/npm/node_modules/@jackwener/opencli/dist/src/main.js")
js = r"""(() => {
  const raw = localStorage.getItem("firebase:authUser:AIzaSyBSsRE_1Os04-bxpd5JTLIniy3UK4OqKys:[DEFAULT]");
  const token = JSON.parse(raw).stsTokenManager.accessToken;
  return fetch("https://api.elevenlabs.io/v1/convai/agents/agent_6201m1bc8x7he9xsvdewcbwse2pv", {
    headers: { Authorization: "Bearer " + token },
  })
    .then((r) => r.json())
    .then((d) => {
      const t = d.conversation_config?.tts || {};
      return {
        voice_id: t.voice_id,
        model: t.model_id,
        stability: t.stability,
        speed: t.speed,
        similarity: t.similarity_boost,
      };
    });
})()"""
r = subprocess.run(
    ["node", OPENCLI, "browser", "el-coach", "eval", js],
    capture_output=True,
    text=True,
    encoding="utf-8",
    errors="replace",
)
print(r.stdout)
print(r.stderr)
