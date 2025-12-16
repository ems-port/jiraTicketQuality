import type { ContactTaxonomyReason } from "@/types";

export const DEFAULT_CONTACT_TAXONOMY_ENTRIES: ContactTaxonomyReason[] = [
  { topic: "System outage", status: "IN_USE" },
  { topic: "Request to transfer subscription/pass to a different hub", status: "IN_USE" },
  { topic: "info/question about my current subscription / pass", status: "IN_USE" },
  { topic: "Hub access or navigation issue", status: "IN_USE" },
  { topic: "E-bike availability issue", status: "IN_USE" },
  { topic: "E-bike damage issue", status: "IN_USE" },
  { topic: "Payment method change/edit", status: "IN_USE" },
  { topic: "Other", status: "IN_USE" },
  { topic: "Duplicate", status: "IN_USE" },
  { topic: "Customer Feedback", status: "IN_USE" },
  { topic: "My account is blocked", status: "IN_USE" },
  { topic: "General information request about the service", status: "IN_USE" },
  { topic: "Rental finish issue", status: "IN_USE" },
  { topic: "Request to cancel weekly subscription", status: "IN_USE" },
  { topic: "Issue unknown", status: "IN_USE" },
  { topic: "E-bike lost or stolen during a rental", status: "IN_USE" },
  { topic: "Info/question about my current ride", status: "IN_USE" },
  { topic: "Refund request", status: "IN_USE" },
  { topic: "Change personal information", status: "IN_USE" },
  { topic: "Request to cancel daily pass", status: "IN_USE" },
  { topic: "Can't access rentals after payment", status: "IN_USE" },
  { topic: "(B2B) Rental start issue", status: "IN_USE" },
  { topic: "Rental start issue", status: "IN_USE" },
  { topic: "Payment issues", status: "IN_USE" },
  { topic: "Dock availability issue", status: "IN_USE" },
  { topic: "Hub sold out", status: "IN_USE" },
  { topic: "General complaint", status: "IN_USE" },
  { topic: "Rental pause/resume issue", status: "IN_USE" },
  { topic: "Info about advanced booking", status: "IN_USE" },
  { topic: "Delete account", status: "IN_USE" },
  { topic: "Invoice or receipt request", status: "IN_USE" },
  { topic: "Promotions or discounts question / issue", status: "IN_USE" },
  { topic: "Login / signup issue", status: "IN_USE" },
  { topic: "Info about monthly subscription", status: "IN_USE" },
  { topic: "Answer from customer to Port outbound contact", status: "IN_USE" }
];

export function flattenTaxonomyEntries(entries: ContactTaxonomyReason[]): string[] {
  return entries
    .filter((entry) => (entry.status ?? "IN_USE") !== "CANCELLED")
    .map((entry) => {
      const topic = (entry.topic || "").trim();
      const sub = (entry.sub_reason || "").trim();
      if (!topic) return null;
      return sub ? `${topic} - ${sub}` : topic;
    })
    .filter((value): value is string => Boolean(value));
}

// Backwards-compatible flat list used by older consumers
export const DEFAULT_CONTACT_TAXONOMY: string[] = flattenTaxonomyEntries(DEFAULT_CONTACT_TAXONOMY_ENTRIES);
