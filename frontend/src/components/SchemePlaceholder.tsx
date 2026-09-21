import type { SchemeMeta } from "../lib/schemes";
import { SchemeOverview } from "./SchemeOverview";

interface SchemePlaceholderProps {
  scheme: SchemeMeta;
}

export function SchemePlaceholder({ scheme }: SchemePlaceholderProps) {
  return (
    <div className="scheme-panel">
      <SchemeOverview scheme={scheme} />
      <p className="scheme-panel__hint">
        后端尚未接入。当前仅展示方案分类与对比信息，实现后可在此页直接试用。
      </p>
    </div>
  );
}
