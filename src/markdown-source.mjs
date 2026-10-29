export function prepareMarkdown(text) {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((s, i) =>
      i % 2
        ? s
        : s
            .replace(/!?\[\[([^\]]+)\]\]/g, (_, link) => {
              const [target, alias] = link.split("|");
              return `[${alias || target}](#note=${encodeURIComponent(target.split("#")[0])})`;
            })
            .replace(
              /^([ \t]*>[ \t]*)\[!([^\]]+)\][+-]?[ \t]*([^\r\n]*)/gm,
              (_, prefix, kind, title) =>
                `${prefix}**${kind}${title ? " " + title : ""}**`,
            ),
    )
    .join("");
}
