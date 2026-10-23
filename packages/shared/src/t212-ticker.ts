/**
 * The Trading 212 ticker of an instrument (`instrument.ticker` of the Trading 212 API, e.g. `AAPL_US_EQ`, `SMGBl_EQ`: the exchange part
 * keeps lower case letters). It is stored on the profile of a held symbol so the server can ask the (undocumented, best effort) asset
 * bucket of Trading 212 for the logo. Because the ticker ends up in a URL path it is validated strictly when it is stored and again
 * before it is used: letters, digits, `_`, `.` and `-` only, 1 to 40 characters, and not made of dots alone.
 */
const T212_TICKER = /^[\w.-]{1,40}$/;
const ONLY_DOTS = /^\.+$/;

export const isT212Ticker = (value: unknown): value is string => typeof value === 'string' && T212_TICKER.test(value) && !ONLY_DOTS.test(value);
