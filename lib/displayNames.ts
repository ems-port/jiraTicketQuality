export interface DisplayNameResult {
  label: string;
  mapped: boolean;
  original: string;
}

export function buildAnonymizedLabel(id: string, baseLabel = "Hidden user"): string {
  const label = baseLabel.trim() || "Hidden user";
  if (!id) {
    return label;
  }
  const hash = Math.abs(
    Array.from(id).reduce((acc, char) => {
      const next = (acc << 5) - acc + char.charCodeAt(0);
      return next | 0;
    }, 7)
  );
  const code = (hash % 1679616).toString(36).toUpperCase().padStart(4, "0");
  return `${label} #${code}`;
}

export function resolveDisplayName(
  id: string,
  mapping: Record<string, string>,
  enabled: boolean,
  agentMapping?: Record<string, string>
): DisplayNameResult {
  if (!id) {
    return { label: "Unknown", mapped: true, original: id };
  }

  if (agentMapping && agentMapping[id]) {
    const preferred = agentMapping[id];
    if (preferred.trim().length) {
      return { label: preferred, mapped: true, original: id };
    }
  }

  if (!enabled) {
    return { label: id, mapped: true, original: id };
  }

  const label = mapping[id];
  if (label) {
    return { label, mapped: true, original: id };
  }

  return { label: id, mapped: false, original: id };
}

export function resolveDisplayList(
  ids: string[],
  mapping: Record<string, string>,
  enabled: boolean,
  agentMapping?: Record<string, string>
): DisplayNameResult[] {
  return ids.map((id) => resolveDisplayName(id, mapping, enabled, agentMapping));
}
