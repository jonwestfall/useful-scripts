// The deck editor's code editor (Issue #226): CodeMirror 6, bundled once into
// ../assets/vendor/codemirror.esm.js so deck.html works offline and with no
// CDN, exactly like marp.esm.js. Only what deck-editor.js uses is exported.
export {
  EditorState, EditorSelection, StateEffect, StateField, Compartment, RangeSetBuilder, Transaction,
} from '@codemirror/state';
export {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection,
  dropCursor, rectangularSelection, crosshairCursor, Decoration, ViewPlugin, placeholder, WidgetType,
} from '@codemirror/view';
export {
  defaultKeymap, history, historyKeymap, indentWithTab, undo, redo, toggleComment, isolateHistory,
} from '@codemirror/commands';
export {
  syntaxHighlighting, defaultHighlightStyle, HighlightStyle, foldGutter, foldKeymap, foldService,
  indentOnInput, bracketMatching, codeFolding, foldEffect, unfoldEffect, foldedRanges, unfoldAll,
  StreamLanguage, LanguageDescription, LanguageSupport,
} from '@codemirror/language';
export { markdown, markdownLanguage } from '@codemirror/lang-markdown';
export { html } from '@codemirror/lang-html';
export { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
export {
  autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, startCompletion,
} from '@codemirror/autocomplete';
export { linter, lintGutter, setDiagnostics, forceLinting } from '@codemirror/lint';
export { tags } from '@lezer/highlight';
