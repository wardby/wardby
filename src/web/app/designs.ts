/**
 * Entry point of the design page (/d/<id> for a design). Task 13 replaces the body; this
 * version only pulls GrapesJS and its PostCSS parser into the bundle so the build and
 * licence checks cover them.
 */
import "grapesjs/dist/css/grapes.min.css";
import "./styles.css";
import grapesjs from "grapesjs";
import parserPostCSS from "grapesjs-parser-postcss";

export const DESIGN_EDITOR_LIBRARIES = { grapesjs, parserPostCSS };
