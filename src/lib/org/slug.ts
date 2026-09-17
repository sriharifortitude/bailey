import { administrativeDb } from '@/lib/db/tenant';

/**
 * Turns a name into a URL-safe slug and appends a numeric suffix on
 * collision. Slugs are permanent identity in the URL space, so the choice
 * made once at creation should not silently change later -- this only runs
 * when the organisation is created.
 */
export async function generateUniqueSlug(name: string): Promise<string> {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  const candidate = base === '' ? 'team' : base;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const slug = attempt === 0 ? candidate : `${candidate}-${attempt + 1}`;
    const existing = await administrativeDb.organisation.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (existing === null) return slug;
  }

  // Astronomically unlikely with 50 attempts already exhausted; a random
  // suffix guarantees termination rather than looping forever.
  return `${candidate}-${Math.random().toString(36).slice(2, 8)}`;
}
