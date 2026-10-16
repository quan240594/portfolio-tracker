/** One muted line under a legend that explains the forecast statuses in words (not colour only); wraps on a phone and never widens the page. */
export function ForecastNote({ text, testId }: Readonly<{ text: string; testId: string }>) {
  return (
    <p className="muted -mt-1 mb-2 min-w-0 text-center text-xs break-words" data-testid={testId}>
      {text}
    </p>
  );
}
