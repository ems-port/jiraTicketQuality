export type ReviewIdentity = {
  id: string;
  displayName: string | null;
};

const STORAGE_ID_KEY = "misclassificationReviewUserId";
const STORAGE_NAME_KEY = "misclassificationReviewDisplayName";

export function ensureReviewIdentity(): ReviewIdentity | null {
  if (typeof window === "undefined") {
    return null;
  }
  let id = window.localStorage.getItem(STORAGE_ID_KEY);
  if (!id) {
    id = generateLocalId();
    window.localStorage.setItem(STORAGE_ID_KEY, id);
  }
  const displayName = window.localStorage.getItem(STORAGE_NAME_KEY);
  return { id, displayName: displayName && displayName.trim().length ? displayName.trim() : null };
}

export function persistReviewDisplayName(name: string): ReviewIdentity | null {
  if (typeof window === "undefined") {
    return null;
  }
  const trimmed = name.trim();
  if (trimmed) {
    window.localStorage.setItem(STORAGE_NAME_KEY, trimmed);
  } else {
    window.localStorage.removeItem(STORAGE_NAME_KEY);
  }
  const id = window.localStorage.getItem(STORAGE_ID_KEY);
  if (!id) {
    return ensureReviewIdentity();
  }
  return { id, displayName: trimmed || null };
}

export function clearReviewIdentity() {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(STORAGE_ID_KEY);
  window.localStorage.removeItem(STORAGE_NAME_KEY);
}

function generateLocalId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const random = Math.random().toString(36).slice(2, 10);
  return `anon-${random}-${Date.now().toString(36)}`;
}
