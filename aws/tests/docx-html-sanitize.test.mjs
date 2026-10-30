/**
 * Uploaded DOCX documents are converted to HTML by mammoth and inserted into the field placement
 * editor (src/components/claim-detail/FieldPlacementEditor.tsx). The HTML is sanitized first
 * (src/lib/sanitizeDocxHtml.ts): document content still shows, scripts, frames, forms, event
 * handlers and javascript: links do not survive. Runs the real helper in a jsdom window.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import test from 'node:test';

// jsdom loads the optional canvas package when it resolves; the installed one may have no native
// build, so jsdom is loaded as if canvas were absent (sanitizing needs no canvas).
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveWithoutCanvas(request, ...rest) {
  if (request === 'canvas') throw Object.assign(new Error("Cannot find module 'canvas'"), { code: 'MODULE_NOT_FOUND' });
  return resolveFilename.call(this, request, ...rest);
};
const { JSDOM } = await import('jsdom');
Module._resolveFilename = resolveFilename;

const { DOCX_SANITIZE_CONFIG, createDocxSanitizer } = await import('../../src/lib/sanitizeDocxHtml.ts');

const sanitize = createDocxSanitizer(new JSDOM('').window);
const parse = (html) => new JSDOM(`<body>${html}</body>`).window.document.body;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('document content survives: headings, paragraphs, emphasis, lists, tables, safe links and embedded images', () => {
  const html = [
    '<h1>Contract</h1>',
    '<p>Signed by <strong>Owner</strong> and <em>Contractor</em>.</p>',
    '<ul><li>One</li><li>Two</li></ul>',
    '<table><tbody><tr><td>Cell A</td><td>Cell B</td></tr></tbody></table>',
    '<p><a href="https://checksops.com/terms">Terms</a> <a href="mailto:help@checksops.com">Mail</a> <a href="tel:+15555550100">Call</a> <a href="#sec-2">Section 2</a></p>',
    `<p><img src="${PNG}" alt="logo" /></p>`,
  ].join('');
  const body = parse(sanitize(html));
  assert.equal(body.querySelector('h1').textContent, 'Contract');
  assert.equal(body.querySelector('strong').textContent, 'Owner');
  assert.equal(body.querySelector('em').textContent, 'Contractor');
  assert.equal(body.querySelectorAll('li').length, 2);
  assert.equal(body.querySelectorAll('td').length, 2);
  const hrefs = [...body.querySelectorAll('a')].map((a) => a.getAttribute('href'));
  assert.deepEqual(hrefs, ['https://checksops.com/terms', 'mailto:help@checksops.com', 'tel:+15555550100', '#sec-2']);
  for (const a of body.querySelectorAll('a')) {
    assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(a.getAttribute('target'), '_blank');
  }
  assert.equal(body.querySelector('img').getAttribute('src'), PNG);
  assert.equal(body.querySelector('img').getAttribute('alt'), 'logo');
});

test('javascript:, vbscript: and data:text links are removed; the link text stays', () => {
  for (const href of ['javascript:alert(document.cookie)', ' JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'vbscript:msgbox(1)', 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==']) {
    const body = parse(sanitize(`<p><a href="${href}">Click me</a></p>`));
    const a = body.querySelector('a');
    assert.equal(a?.getAttribute('href') ?? null, null, href);
    assert.match(body.textContent, /Click me/, href);
  }
});

test('scripts, frames, objects, forms and styles are dropped', () => {
  const out = sanitize([
    '<p>Before</p>',
    '<script>alert(1)</script>',
    '<iframe src="https://evil.example"></iframe>',
    '<object data="x.swf"></object><embed src="x.swf">',
    '<form action="https://evil.example"><input name="pw"><button>Go</button></form>',
    '<style>body{display:none}</style>',
    '<link rel="stylesheet" href="https://evil.example/x.css"><meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/">',
    '<p>After</p>',
  ].join(''));
  for (const tag of ['<script', '<iframe', '<object', '<embed', '<form', '<input', '<button', '<style', '<link', '<meta', '<base']) {
    assert.equal(out.toLowerCase().includes(tag), false, tag);
  }
  assert.match(out, /Before/);
  assert.match(out, /After/);
});

test('event handlers and non-image data: sources are removed', () => {
  const body = parse(sanitize([
    '<img src="x" onerror="alert(1)">',
    '<p onclick="alert(2)" onmouseover="alert(3)">Text</p>',
    '<svg onload="alert(4)"><a xlink:href="javascript:alert(5)">x</a></svg>',
    '<img src="data:text/html;base64,PHNjcmlwdD4=">',
  ].join('')));
  for (const el of body.querySelectorAll('*')) {
    for (const attr of el.getAttributeNames()) assert.equal(attr.startsWith('on'), false, `${el.nodeName} ${attr}`);
  }
  assert.equal(body.querySelector('p').textContent, 'Text');
  for (const img of body.querySelectorAll('img')) {
    assert.equal((img.getAttribute('src') || '').startsWith('data:text'), false);
  }
  assert.equal(body.innerHTML.includes('javascript:'), false);
});

test('the editor sanitizes mammoth output before it reaches dangerouslySetInnerHTML', () => {
  const editor = fs.readFileSync(new URL('../../src/components/claim-detail/FieldPlacementEditor.tsx', import.meta.url), 'utf8');
  assert.match(editor, /import \{ sanitizeDocxHtml \} from "@\/lib\/sanitizeDocxHtml";/);
  assert.match(editor, /setDocxHtml\(sanitizeDocxHtml\(result\.value\)\)/);
  assert.equal(/setDocxHtml\(result\.value\)/.test(editor), false);
  assert.ok(DOCX_SANITIZE_CONFIG.FORBID_TAGS.includes('iframe'));
});
