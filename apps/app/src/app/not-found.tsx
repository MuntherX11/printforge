import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 dark:bg-gray-950 px-4">
      <div className="text-center space-y-4 max-w-md">
        <p className="text-6xl font-bold text-brand-600 dark:text-brand-400">404</p>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Page not found</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
        <Link
          href="/"
          className="inline-flex items-center px-4 py-2 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-700 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
        >
          Go to dashboard
        </Link>
      </div>
    </div>
  );
}
