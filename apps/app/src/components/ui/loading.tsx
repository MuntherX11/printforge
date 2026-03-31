export function Loading({ text = 'Loading...' }: { text?: string }) {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="text-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-200 border-t-brand-600 mx-auto mb-3" />
        <p className="text-sm text-gray-500">{text}</p>
      </div>
    </div>
  );
}
