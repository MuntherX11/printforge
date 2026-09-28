/**
 * Column visibility in the skeleton, matching the Filaments table:
 * Type and Brand from md, Spool Price and Active Spools from lg.
 */
const COLUMN_VISIBILITY = ['', 'hidden md:block', 'hidden md:block', 'hidden lg:block', 'hidden lg:block', '', ''];

export default function Loading() {
  return (
    <div className="space-y-6 animate-pulse">
      {/* Header + actions */}
      <div className="flex items-center justify-between">
        <div className="h-8 w-32 rounded bg-gray-200 dark:bg-gray-700" />
        <div className="flex gap-2">
          <div className="h-9 w-28 rounded-md bg-gray-200 dark:bg-gray-700" />
          <div className="h-9 w-24 rounded-md bg-gray-200 dark:bg-gray-700" />
        </div>
      </div>

      {/* Filter bar */}
      <div className="h-10 w-full sm:w-72 rounded-md bg-gray-200 dark:bg-gray-700" />

      {/* Table */}
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden">
        <div className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-2.5 grid grid-cols-3 md:grid-cols-5 lg:grid-cols-7 gap-4">
          {COLUMN_VISIBILITY.map((visibility, i) => (
            <div key={i} className={`h-3 rounded bg-gray-200 dark:bg-gray-700 ${visibility}`} />
          ))}
        </div>
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="border-b border-gray-100 dark:border-gray-800 last:border-0 px-4 py-3 grid grid-cols-3 md:grid-cols-5 lg:grid-cols-7 gap-4 items-center"
          >
            <div className="flex items-center gap-2">
              <div className="h-4 w-4 rounded-full bg-gray-200 dark:bg-gray-700 shrink-0" />
              <div className="h-4 w-20 rounded bg-gray-100 dark:bg-gray-800" />
            </div>
            {COLUMN_VISIBILITY.slice(1).map((visibility, j) => (
              <div
                key={j}
                className={`h-4 rounded bg-gray-100 dark:bg-gray-800 ${visibility}`}
                style={{ width: `${60 + Math.sin(i * j) * 25}%` }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
