// Inlined by scripts/build-exe.mjs: esbuild's text loader turns web/index.html
// into a string export, so a single executable has the UI without a web/
// directory next to it.
//
// A normal npm install never loads this file — server.mjs imports it lazily and
// falls back to reading web/index.html from disk, because Node refuses to import
// a .html module outside the bundle.
import indexHtml from "../web/index.html";

export { indexHtml };