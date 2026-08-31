import { ElevenLabsVoicePage } from "./pages/ElevenLabsVoicePage";
import { FreeCoachVoicePage } from "./pages/FreeCoachVoicePage";
import { RealtimePage } from "./pages/RealtimePage";

function currentVoicePage(): "realtime" | "elevenlabs" | "free-coach" {
  const path = window.location.pathname.replace(/\/+$/, "");
  if (path.endsWith("/openai")) return "realtime";
  if (path.endsWith("/elevenlabs")) return "elevenlabs";
  return "free-coach";
}

export default function App() {
  const page = currentVoicePage();
  if (page === "realtime") return <RealtimePage />;
  if (page === "elevenlabs") return <ElevenLabsVoicePage />;
  return <FreeCoachVoicePage />;
}
