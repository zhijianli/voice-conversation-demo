import { FreeCoachVoicePage } from "./pages/FreeCoachVoicePage";
import { RealtimePage } from "./pages/RealtimePage";

function isRealtimePath() {
  return window.location.pathname.replace(/\/+$/, "").endsWith("/openai");
}

export default function App() {
  return isRealtimePath() ? <RealtimePage /> : <FreeCoachVoicePage />;
}
