import clsx from "clsx";

import { resolveDisplayName } from "@/lib/displayNames";
import { formatRoleLabel } from "@/lib/roles";
import type { AgentRole } from "@/types";

type DisplayNameProps = {
  id: string;
  mapping: Record<string, string>;
  deAnonymize: boolean;
  className?: string;
  titlePrefix?: string;
  role?: AgentRole | null;
  showRole?: boolean;
};

export function DisplayName({
  id,
  mapping,
  deAnonymize,
  className,
  titlePrefix,
  role,
  showRole = false
}: DisplayNameProps) {
  const result = resolveDisplayName(id, mapping, deAnonymize);
  const pillRole: AgentRole = role ?? "NON_AGENT";
  const identityTitle = deAnonymize
    ? titlePrefix
      ? `${titlePrefix}: ${result.original}`
      : result.original
    : null;
  const roleTitle = showRole ? `Role: ${formatRoleLabel(pillRole)}` : null;
  const title = [identityTitle, roleTitle].filter(Boolean).join(" · ") || undefined;
  return (
    <span className={clsx("inline-flex items-center gap-2", className)} title={title}>
      <span className={clsx(!result.mapped && deAnonymize && "italic text-slate-400")}>{result.label}</span>
      {showRole && <RolePill role={pillRole} />}
    </span>
  );
}

function RolePill({ role }: { role: AgentRole }) {
  const baseClasses =
    "rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide";
  const tone =
    role === "TIER1"
      ? "border-emerald-500/50 bg-emerald-500/20 text-emerald-100"
      : role === "TIER2"
      ? "border-sky-500/50 bg-sky-500/20 text-sky-100"
      : "border-slate-700 bg-slate-800/70 text-slate-200";
  return <span className={clsx(baseClasses, tone)}>{formatRoleLabel(role, true)}</span>;
}
