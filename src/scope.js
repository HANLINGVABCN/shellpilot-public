// Keep an explicit empty selection; never add newly created hosts implicitly.
export function reconcileScope(selection, hosts) {
  const valid = new Set(hosts.map((host) => host.id));
  if (selection === null) return hosts.length ? [...valid] : null;
  return [...new Set(selection)].filter((id) => valid.has(id));
}

export function sameScope(a, b) {
  return a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((id, index) => id === b[index]));
}
