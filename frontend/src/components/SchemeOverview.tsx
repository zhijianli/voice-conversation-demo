import type { ReactNode } from "react";
import type { SchemeMeta } from "../lib/schemes";

interface SchemeOverviewProps {
  scheme: SchemeMeta;
  settings?: ReactNode;
}

export function SchemeOverview({ scheme, settings }: SchemeOverviewProps) {
  return (
    <section className="scheme-overview" aria-label={`${scheme.name} 方案说明`}>
      <header className="scheme-overview__header">
        <p className="scheme-overview__tagline">{scheme.tagline}</p>
        <span
          className={
            scheme.implemented
              ? "scheme-overview__status scheme-overview__status--live"
              : "scheme-overview__status"
          }
        >
          {scheme.implemented ? "已接入" : "待接入"}
        </span>
      </header>

      <div className="scheme-overview__meta">
        <dl className="scheme-models">
          <div className="scheme-models__row">
            <dt>数据流</dt>
            <dd>{scheme.flow}</dd>
          </div>
          <div className="scheme-models__row">
            <dt>{scheme.category === "s2s" ? "语音模型" : "底层模型"}</dt>
            <dd>{scheme.models.llm}</dd>
          </div>
          {scheme.category === "pipeline" ? (
            <>
              <div className="scheme-models__row">
                <dt>ASR 模型</dt>
                <dd>{scheme.models.asr}</dd>
              </div>
              <div className="scheme-models__row">
                <dt>TTS 模型</dt>
                <dd>{scheme.models.tts}</dd>
              </div>
            </>
          ) : null}
        </dl>
      </div>

      <table className="scheme-metrics">
        <caption>成本（30 分钟会话估算）</caption>
        <tbody>
          <tr>
            <th>费用单价成本</th>
            <td>{scheme.metrics.unitCost}</td>
          </tr>
          <tr>
            <th>计算公式</th>
            <td>{scheme.metrics.costFormula}</td>
          </tr>
          <tr>
            <th>30 分钟成本</th>
            <td>{scheme.metrics.costEstimate}</td>
          </tr>
        </tbody>
      </table>

      {settings ? settings : null}
    </section>
  );
}
