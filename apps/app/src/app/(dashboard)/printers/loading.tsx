export default function Loading() {
  return (
    <div className="space-y-6 animate-pulse">
      {/* Header + actions */}
      <div className="flex items-center justify-between">
        <div className="h-8 w-32 rounded bg-gray-200 dark:bg-gray-700" />
        <div className="h-9 w-28 rounded-md bg-gray-200 dark:bg-gray-700" />
      </div>

      {/* Printer card grid */}
      <div className="grid grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-5 space-y-4"
          >
            {/* Card header */}
            <div className="flex items-center justify-between">
              <div className="h-4 w-28 rounded bg-gray-200 dark:bg-gray-700" />
              <div className="h-5 w-16 rounded-full bg-gray-200 dark:bg-gray-700" />
            </div>
            {/* Status detail rows */}
            <div className="space-y-2.5">
              {Array.from({ length: 3 }).map((_, j) => (
                <div key={j} className="flex justify-between">
                  <div className="h-3 w-20 rounded bg-gray-100 dark:bg-gray-800" />
                  <div className="h-3 w-16 rounded bg-gray-100 dark:bg-gray-800" />
                </div>
              ))}
            </div>
            {/* Progress bar */}
            <div className="h-2 w-full rounded-full bg-gray-100 dark:bg-gray-800">
              <div
                className="h-2 rounded-full bg-gray-200 dark:bg-gray-700"
                style={{ width: `${40 + i * 20}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
