import clsx from "clsx";

import { resolveDisplayName } from "@/lib/displayNames";

type DisplayNameProps = {
  id: string;
  mapping: Record<string, string>;
  deAnonymize: boolean;
  className?: string;
  titlePrefix?: string;
};

export function DisplayName({
  id,
  mapping,
  deAnonymize,
  className,
  titlePrefix
}: DisplayNameProps) {
  const result = resolveDisplayName(id, mapping, deAnonymize);
  const title = titlePrefix ? `${titlePrefix}: ${result.original}` : result.original;
  return (
    <span
      className={clsx(className, !result.mapped && deAnonymize && "italic text-slate-400")}
      title={deAnonymize ? title : undefined}
    >
      {result.label}
    </span>
  );
}
