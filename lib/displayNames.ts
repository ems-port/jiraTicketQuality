export interface DisplayNameResult {
  label: string;
  mapped: boolean;
  original: string;
}

export function resolveDisplayName(
  id: string,
  mapping: Record<string, string>,
  enabled: boolean
): DisplayNameResult {
  if (!id) {
    return { label: "Unknown", mapped: true, original: id };
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
  enabled: boolean
): DisplayNameResult[] {
  return ids.map((id) => resolveDisplayName(id, mapping, enabled));
}
