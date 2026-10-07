// The CommonJS builds marp-core itself requires, so the bundle holds one copy
// of each rather than these and their ES module builds side by side (Issue #240).
// Code highlighting needs nothing here: a Marp instance's own `highlightjs`
// has marp-core's languages registered on it.
module.exports = { katex: require('katex'), MarkdownIt: require('markdown-it') };
