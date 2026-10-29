export function hitRegions(regions, x, y) {
  return regions
    .filter(
      (r) =>
        r.kind !== "page" &&
        x >= r.box[0] &&
        x <= r.box[2] &&
        y >= r.box[1] &&
        y <= r.box[3],
    )
    .sort((a, b) => {
      if (a.role === "equation-block" && b.parentId === a.id) return -1;
      if (b.role === "equation-block" && a.parentId === b.id) return 1;
      return (
        (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]) -
          (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]) || a.order - b.order
      );
    });
}
export function boxStyle(box) {
  return {
    left: `${box[0] * 100}%`,
    top: `${box[1] * 100}%`,
    width: `${(box[2] - box[0]) * 100}%`,
    height: `${(box[3] - box[1]) * 100}%`,
  };
}

export function toggleRegions(selected, region, additive, regions) {
  if (!additive) return [region];
  if (selected.some((r) => r.id === region.id))
    return selected.filter((r) => r.id !== region.id);
  const byId = new Map([...regions, ...selected, region].map((r) => [r.id, r]));
  const ancestor = (a, b) => {
    const seen = new Set();
    let cursor = b;
    while (cursor?.parentId && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      if (cursor.parentId === a.id) return true;
      cursor = byId.get(cursor.parentId);
    }
    return false;
  };
  return [
    ...selected.filter((r) => !ancestor(r, region) && !ancestor(region, r)),
    region,
  ];
}

export function selectedRegions(anchor, regions) {
  const selections = anchor.regions?.length
    ? anchor.regions
    : anchor.regionId
      ? [anchor]
      : [];
  return selections
    .map((s) => {
      const existing = regions.find((r) => r.id === s.regionId);
      return {
        ...(existing || {
          id: s.regionId,
          sourceId: anchor.sourceId,
          page: s.page,
          kind: s.section?.split(" · ")[0]?.toLowerCase() || "region",
          text: s.quote,
          box: s.box,
          parentId: null,
          order: 0,
          origin: "saved anchor",
        }),
        revision: s.revision,
      };
    })
    .filter((r) => r.box);
}
export function selectionAnchor(sourceId, page, regions, revision) {
  const ordered = [...regions].sort(
    (a, b) => a.page - b.page || a.order - b.order,
  );
  const entries = ordered.map((r) => ({
    regionId: r.id,
    page: r.page,
    quote: r.text.slice(0, 10000),
    section: `${r.kind[0].toUpperCase() + r.kind.slice(1)} · page ${r.page}`,
    revision: r.revision || revision,
    box: r.box,
  }));
  return {
    sourceId,
    page,
    quote: entries
      .map((e) => (entries.length > 1 ? `[${e.section}]\n${e.quote}` : e.quote))
      .join("\n\n")
      .slice(0, 10000),
    ...(entries.length
      ? {
          regions: entries,
          section:
            entries.length === 1
              ? entries[0].section
              : `${entries.length} regions · pages ${[...new Set(entries.map((e) => e.page))].join(", ")}`,
        }
      : {}),
    ...(entries.length === 1
      ? {
          regionId: entries[0].regionId,
          revision: entries[0].revision,
          box: entries[0].box,
        }
      : {}),
  };
}
