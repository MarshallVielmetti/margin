import type { Region } from "./types";
export function hitRegions(regions: Region[], x: number, y: number): Region[];
export function boxStyle(box: number[]): {
  left: string;
  top: string;
  width: string;
  height: string;
};
import type { Anchor } from "./types";
export function toggleRegions(
  selected: Region[],
  region: Region,
  additive: boolean,
  regions: Region[],
): Region[];
export function selectedRegions(anchor: Anchor, regions: Region[]): Region[];
export function selectionAnchor(
  sourceId: string,
  page: number,
  regions: Region[],
  revision?: string,
): Anchor;
