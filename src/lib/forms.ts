/**
 * `FormData.get()` returns `string | File | null`, so `String(formData.get(x))`
 * on a submission where that field was tampered with into a file input
 * silently stringifies to `"[object File]"` rather than being rejected. Every
 * server action in this app reads its fields through this instead: a
 * non-string value becomes an empty string, which the existing "required
 * field" validation in each action already rejects with a real message.
 */
export function formString(data: FormData, key: string): string {
  const value = data.get(key);
  return typeof value === 'string' ? value : '';
}
