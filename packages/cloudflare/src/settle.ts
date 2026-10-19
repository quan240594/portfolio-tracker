/** Runs a synchronous step as a promise: a thrown error becomes a rejection, like in a real adapter. */
export const settle = <T>(step: () => T): Promise<T> => Promise.resolve().then(step);
