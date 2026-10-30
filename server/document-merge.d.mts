export function mergeMarkdown(
  base: string,
  local: string,
  remote: string,
): {
  text: string;
  conflicts: {
    start: number;
    end: number;
    base: string;
    local: string;
    remote: string;
  }[];
};
