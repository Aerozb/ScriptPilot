export function commandOk(data = undefined) {
  if (data === undefined) {
    return { ok: true };
  }

  return { ok: true, data };
}
