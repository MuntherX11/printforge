export default function Loading() {
  return (
    <div className="space-y-6 animate-pulse">
      {/* Page header */}
      <div className="h-8 w-48 rounded bg-gray-200 dark:bg-gray-700" />

      {/* Ledger strip */}
      <div className="grid grid-cols-6 divide-x divide-gray-100 dark:divide-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="px-5 py-4 flex flex-col gap-1.5">
            <div className="h-2.5 w-16 rounded bg-gray-200 dark:bg-gray-700" />
            <div className="h-5 w-20 rounded bg-gray-200 dark:bg-gray-700" />
          </div>
        ))}
      </div>

      {/* Two cards side by side */}
      <div className="grid grid-cols-2 gap-6">
        {Array.from({ length: 2 }).map((_, i) => (
          <div
            key={i}
            className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-5 space-y-3"
          >
            <div className="h-4 w-32 rounded bg-gray-200 dark:bg-gray-700" />
            <div className="h-3 w-full rounded bg-gray-100 dark:bg-gray-800" />
            <div className="h-3 w-4/5 rounded bg-gray-100 dark:bg-gray-800" />
            <div className="h-3 w-3/5 rounded bg-gray-100 dark:bg-gray-800" />
          </div>
        ))}
      </div>
    </div>
  );
}
