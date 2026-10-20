const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const two = (n: number): string => String(n).padStart(2, '0');

/** "Tue 02:00": the local weekday and 24-hour time of an instant, built independently of the code under test. */
export function localWeekdayTime(at: number | string): string {
  const d = new Date(at);
  return `${WEEKDAYS[d.getDay()]} ${two(d.getHours())}:${two(d.getMinutes())}`;
}
