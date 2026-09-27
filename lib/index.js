// Host half of @local/dsh-wisp.
//
// This plugin deliberately does nothing on the host side. Everything the wisp
// needs is already available in the browser: the client builtins provide React,
// a package-owned stylesheet inserter, and the live Slot tree. Keeping the host
// half empty means the plugin needs no peer dependencies at all, so it loads on
// a stock DSH desktop install whose profile has an empty `dependencies` map.
//
// If you later want the wisp to react to host-side facts (model, token usage,
// job state), add a `host.call` handler here and a matching `host.call(...)`
// from lib/client.js.

export const name = 'wisp'

export function apply() {
  // Intentionally empty — see the note above.
}

export default { name, apply }
