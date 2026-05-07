export default function Loading() {
  return (
    <div className="space-y-6 animate-pulse">
      {/* Header */}
      <div className="h-8 w-28 rounded bg-gray-200 dark:bg-gray-700" />

      {/* Two column cards */}
      <div className="grid grid-cols-2 gap-6">
        {Array.from({ length: 2 }).map((_, i) => (
          <div
            key={i}
            className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-5 space-y-4"
          >
            <div className="h-4 w-36 rounded bg-gray-200 dark:bg-gray-700" />
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, j) => (
                <div key={j} className="space-y-1.5">
                  <div className="h-3 w-24 rounded bg-gray-200 dark:bg-gray-700" />
                  <div className="h-9 w-full rounded-md bg-gray-100 dark:bg-gray-800" />
                </div>
              ))}
            </div>
            <div className="h-9 w-24 rounded-md bg-gray-200 dark:bg-gray-700" />
          </div>
        ))}
      </div>
    </div>
  );
}
