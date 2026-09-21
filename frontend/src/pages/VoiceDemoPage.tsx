import { useEffect, type ReactNode } from "react";
import { CategoryTabs } from "../components/CategoryTabs";
import { SchemeNav } from "../components/SchemeNav";
import { SchemeOverview } from "../components/SchemeOverview";
import { SchemePlaceholder } from "../components/SchemePlaceholder";
import { getCategory, getScheme, parseRoute, type SchemeId } from "../lib/schemes";
import { ElevenLabsVoiceContent } from "./ElevenLabsVoicePage";
import { FreeCoachVoiceContent } from "./FreeCoachVoicePage";
import { RealtimeVoiceContent } from "./RealtimePage";
import { LiveKitVoiceContent } from "./LiveKitVoicePage";
import { S2SVoiceContent } from "./S2SVoicePage";

function renderSchemeDemo(schemeId: SchemeId): ReactNode {
  switch (schemeId) {
    case "openai":
      return <RealtimeVoiceContent />;
    case "gemini-live":
    case "doubao":
    case "bailian":
    case "deepgram":
      return <S2SVoiceContent schemeId={schemeId} />;
    case "free-coach":
      return <FreeCoachVoiceContent />;
    case "livekit":
      return <LiveKitVoiceContent />;
    case "elevenlabs":
      return <ElevenLabsVoiceContent />;
    default:
      return null;
  }
}

const SELF_CONTAINED_SCHEMES = new Set<SchemeId>([
  "free-coach",
  "livekit",
  "elevenlabs",
]);

function SchemeContent({ schemeId }: { schemeId: SchemeId }) {
  const scheme = getScheme(schemeId);
  if (!scheme) return null;

  const demo = renderSchemeDemo(schemeId);
  if (!demo) {
    return <SchemePlaceholder scheme={scheme} />;
  }

  if (SELF_CONTAINED_SCHEMES.has(schemeId)) {
    return demo;
  }

  return (
    <div className="scheme-panel">
      <SchemeOverview scheme={scheme} />
      {demo}
    </div>
  );
}

export function VoiceDemoPage() {
  const { category, scheme } = parseRoute();
  const meta = getScheme(scheme);
  const categoryMeta = getCategory(category);

  useEffect(() => {
    if (meta) {
      document.title = `${meta.name} · ${categoryMeta?.label ?? "语音 Demo"}`;
    }
  }, [meta, categoryMeta?.label]);

  return (
    <div className="app">
      <header className="demo-header">
        <h1 className="demo-header__title">语音对话多方案对比</h1>
      </header>
      <CategoryTabs active={category} />
      <SchemeNav category={category} active={scheme} />
      <SchemeContent schemeId={scheme} />
    </div>
  );
}
