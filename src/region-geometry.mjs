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
    .sort(
      (a, b) =>
        (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]) -
          (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]) || a.order - b.order,
    );
}
export function boxStyle(box) {
  return {
    left: `${box[0] * 100}%`,
    top: `${box[1] * 100}%`,
    width: `${(box[2] - box[0]) * 100}%`,
    height: `${(box[3] - box[1]) * 100}%`,
  };
}
