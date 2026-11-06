// FOUNDATION STUB, replaced by the content track: the plain-language notes shown in the panels.
//   infoFor(resolved) -> { title, kindLabel, summary, notes: [{ heading, text }], rarity, catalogue: [{ label, value }] }
// Only `catalogue` (shown behind the "Catalogue values" expander) may give away what the student is meant to
// work out: temperature, class, composition.

export function infoFor(resolved) {
    return { title: resolved.entity.code, kindLabel: resolved.entity.kind, summary: '', notes: [], rarity: '', catalogue: [] };
}
