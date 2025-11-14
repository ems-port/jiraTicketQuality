import Head from "next/head";
import Link from "next/link";

type Entry = {
  version: string;
  title: string;
  date: string;
  points: string[];
};

const ENTRIES: Entry[] = [
  {
    version: "Unreleased",
    title: "Manager reasoning + parallel GPT-5 scoring",
    date: "2025-11-15",
    points: [
      "LLM prompt now returns explicit reasoning for contact-reason overrides, resolution timing, and sentiment history so reviewers can see why tickets were reclassified.",
      "CSV/UX updates: added duration-to-resolution, condensed duplicate fields, and exposed the change log link inside Settings.",
      "Performance boost: the scorer can run up to 5 GPT-5 nano calls in parallel while respecting rate limits."
    ]
  },
  {
    version: "822452b (build #16)",
    title: "Supabase live refresh & default online mode",
    date: "2025-11-14",
    points: [
      "Online DB mode is now the default data source and CSV uploads/sample loading stay disabled unless you opt out.",
      "The new refresh job orchestrates Jira ingestion + GPT processing, streams status to the UI, and automatically reloads the dashboard when finished.",
      "Fetch button/command center badges now communicate syncing state (amber) vs. healthy live data (green)."
    ]
  },
  {
    version: "42d0f64",
    title: "Fix vercel Build",
    date: "2025-11-13",
    points: ["Resolved the deployment regression so the dashboard ships reliably again."]
  },
  {
    version: "13e8197",
    title: "Dashboard polish & agent directory",
    date: "2025-11-13",
    points: [
      "Refactored the state store so toggling filters and Settings is instant.",
      "Roles CSV uploads now surface errors inline and the sample dataset label reflects the latest file.",
      "Agent drill-down cards show average durations and improved UI spacing for readability."
    ]
  },
  {
    version: "7ea90e9",
    title: "Conversation quality refresh (GPT-5)",
    date: "2025-11-12",
    points: [
      "Scoring pipeline now uses GPT-5-guided metrics and includes new test datasets.",
      "UI received minor tightening (layout, fonts) to support the richer summaries."
    ]
  },
  {
    version: "6287918",
    title: "Vercel build fix follow-up",
    date: "2025-11-12",
    points: ["Patched another Vercel build error to keep production healthy."]
  },
  {
    version: "0378d5b",
    title: "Stability clean-up",
    date: "2025-11-12",
    points: ["Miscellaneous fixes noted by the team (hot fixes during the build cycle)."]
  },
  {
    version: "ee16cc5",
    title: "Static demo timestamps",
    date: "2025-10-27",
    points: [
      "Demo environments now show fixed dates so sales walk-throughs remain consistent over time."
    ]
  },
  {
    version: "bb0ec9a",
    title: "Analytics view landed",
    date: "2025-10-24",
    points: [
      "Introduced the analytics panel with KPIs, agent ranks, and toxicity callouts for the dashboard launch."
    ]
  },
  {
    version: "8b38077",
    title: "SVG and path alias fixes",
    date: "2025-10-24",
    points: [
      "Cleaned up SVG props and TypeScript path aliases so the Next.js build works across environments."
    ]
  }
];

export default function ChangelogPage() {
  return (
    <>
      <Head>
        <title>Change Log · Conversation Quality Command Center</title>
      </Head>
      <main className="min-h-screen bg-slate-950 py-16">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6">
          <header className="flex flex-col gap-3 border-b border-slate-800 pb-6">
            <p className="text-sm uppercase tracking-wide text-slate-400">Conversation Quality</p>
            <h1 className="text-3xl font-bold text-white">Change Log</h1>
            <p className="text-sm text-slate-300">
              Highlights of what changed in the dashboard and scoring pipeline. For deeper details,
              check the{" "}
              <Link href="https://github.com/ems-port/jiraTicketQuality" className="text-brand-200">
                Git repo
              </Link>
              .
            </p>
            <Link
              href="/"
              className="w-fit rounded-full border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-brand-500 hover:text-brand-200"
            >
              ← Back to dashboard
            </Link>
          </header>
          <section className="space-y-8">
            {ENTRIES.map((entry) => (
              <article
                key={entry.version}
                className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-xl"
              >
                <header className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                  <div>
                    <h2 className="text-xl font-semibold text-white">{entry.title}</h2>
                    <p className="text-xs text-slate-500">{entry.date}</p>
                  </div>
                  <code className="rounded-full border border-slate-700 bg-slate-950/70 px-3 py-1 text-xs text-slate-300">
                    {entry.version}
                  </code>
                </header>
                <ul className="mt-4 list-disc space-y-2 pl-5 text-sm text-slate-200">
                  {entry.points.map((point, idx) => (
                    <li key={idx}>{point}</li>
                  ))}
                </ul>
              </article>
            ))}
          </section>
        </div>
      </main>
    </>
  );
}
