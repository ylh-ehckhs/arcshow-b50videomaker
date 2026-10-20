/** Give each full-image OCR line one owner in the calibrated card grid.
 * Text recognition is deliberately excluded from ownership: a missed score
 * must never make multiple cards share a neighbouring score anchor.
 */
export function assignItemsToSlots(items, slots) {
  const out = new Map(slots.map((_, index) => [index, []]));
  for (const item of items) {
    const cx = item.x + item.w / 2;
    const cy = item.y + item.h / 2;
    let owner = -1;
    let distance = Infinity;
    for (let index = 0; index < slots.length; index++) {
      const r = slots[index].rect;
      if (r.w <= 0 || r.h <= 0) continue;
      // Modest bleed accepts detector boxes near the text-area edge without
      // accepting the header/footer or reaching past an adjacent card centre.
      if (cx < r.x - r.w * .12 || cx > r.x + r.w * 1.12 ||
          cy < r.y - r.h * .2 || cy > r.y + r.h * 1.2) continue;
      const dx = (cx - r.x - r.w / 2) / r.w;
      const dy = (cy - r.y - r.h / 2) / r.h;
      const score = dx * dx + dy * dy;
      if (score < distance) { owner = index; distance = score; }
    }
    if (owner >= 0) out.get(owner).push(item);
  }
  for (const lines of out.values()) lines.sort((a, b) => a.y - b.y || a.x - b.x);
  return out;
}
