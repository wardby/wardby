/**
 * Test support for the secret redactor: whether `output` holds any piece of a remembered value
 * long enough to matter. Returns a boolean so a failing assertion never prints the value.
 */

/** True when `output` contains a substring of length >= `min` that is a prefix or a suffix of any value. */
export function holdsValueFragment(output: string, values: Iterable<string>, min = 3): boolean {
  for (const value of values) {
    for (let k = min; k <= value.length; k += 1) {
      if (output.includes(value.slice(0, k)) || output.includes(value.slice(value.length - k))) return true;
    }
  }
  return false;
}
