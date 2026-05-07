export default function Loading() {
  return (
    <div className="space-y-6 animate-pulse">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="h-8 w-36 rounded bg-gray-200 dark:bg-gray-700" />
        <div className="h-9 w-32 rounded-md bg-gray-200 dark:bg-gray-700" />
      </div>

      {/* Table */}
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden">
        <div className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-2.5 grid grid-cols-5 gap-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-3 rounded bg-gray-200 dark:bg-gray-700" />
          ))}
        </div>
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="border-b border-gray-100 dark:border-gray-800 last:border-0 px-4 py-3 grid grid-cols-5 gap-4 items-center"
          >
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded bg-gray-100 dark:bg-gray-800 shrink-0" />
              <div className="h-4 w-24 rounded bg-gray-100 dark:bg-gray-800" />
            </div>
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
