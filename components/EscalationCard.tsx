import clsx from "clsx";

import { KPICard } from "@/components/KPICard";
import type { EscalationMetricKind, MetricSeries, TimeWindow } from "@/types";

type EscalationCardProps = {
  mode: EscalationMetricKind;
  onModeChange: (mode: EscalationMetricKind) => void;
  tierSeries: MetricSeries[];
  handoffSeries: MetricSeries[];
  selectedWindow: TimeWindow;
  footerText: string;
  onOpen: () => void;
};

const METRIC_LABELS: Record<EscalationMetricKind, string> = {
  tier: "Escalation T1→T2",
  handoff: "Handovers T1→Any"
};

export function EscalationCard({
  mode,
  onModeChange,
  tierSeries,
  handoffSeries,
  selectedWindow,
  footerText,
  onOpen
}: EscalationCardProps) {
  const activeSeries = mode === "tier" ? tierSeries : handoffSeries;
  const selectedValue =
    activeSeries.find((entry) => entry.window === selectedWindow)?.value ?? null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {(Object.keys(METRIC_LABELS) as EscalationMetricKind[]).map((metric) => (
          <button
            key={metric}
            type="button"
            onClick={() => onModeChange(metric)}
            className={clsx(
              "rounded-full px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition",
              metric === mode
                ? "bg-brand-500 text-white"
                : "border border-slate-700 text-slate-300 hover:border-brand-500 hover:text-brand-100"
            )}
          >
            {METRIC_LABELS[metric]}
          </button>
        ))}
      </div>
      <KPICard
        title={METRIC_LABELS[mode]}
        value={selectedValue}
        formatValue={(value) => (value === null ? "—" : `${Math.round(value)}%`)}
        footerText={footerText}
        series={activeSeries}
        selectedWindow={selectedWindow}
        onClick={onOpen}
      />
    </div>
  );
}
