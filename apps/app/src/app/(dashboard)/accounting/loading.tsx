export default function Loading() {
  return (
    <div className="space-y-6 animate-pulse">
      {/* Header */}
      <div className="h-8 w-40 rounded bg-gray-200 dark:bg-gray-700" />

      {/* Ledger strip */}
      <div className="grid grid-cols-4 divide-x divide-gray-100 dark:divide-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="px-5 py-4 flex flex-col gap-1.5">
            <div className="h-2.5 w-16 rounded bg-gray-200 dark:bg-gray-700" />
            <div className="h-5 w-20 rounded bg-gray-200 dark:bg-gray-700" />
          </div>
        ))}
      </div>

      {/* Chart placeholder */}
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-5">
        <div className="h-4 w-32 rounded bg-gray-200 dark:bg-gray-700 mb-4" />
        <div className="h-48 w-full rounded bg-gray-100 dark:bg-gray-800" />
      </div>

      {/* Table */}
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden">
        <div className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-2.5 grid grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-3 rounded bg-gray-200 dark:bg-gray-700" />
          ))}
        </div>
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="border-b border-gray-100 dark:border-gray-800 last:border-0 px-4 py-3 grid grid-cols-4 gap-4"
          >
            {Array.from({ length: 4 }).map((_, j) => (
              <div
                key={j}
                className="h-4 rounded bg-gray-100 dark:bg-gray-800"
                style={{ width: `${60 + Math.sin(i * j) * 25}%` }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
