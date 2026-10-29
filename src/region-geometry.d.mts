import type { Region } from "./types";
export function hitRegions(regions: Region[], x: number, y: number): Region[];
export function boxStyle(box: number[]): {
  left: string;
  top: string;
  width: string;
  height: string;
};
