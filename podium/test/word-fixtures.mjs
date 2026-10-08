// Word and RTF files for the tests (Issue #258), written here rather than
// checked in: a .docx is a zip of XML, small enough to write by hand, and
// doing so says exactly what each test file contains.
//
//   import { makeDocx, makeRtf } from './word-fixtures.mjs';

import zlib from 'node:zlib';
import { createZip } from '../assets/js/zip.js';

// A 2x2 red PNG.
export function tinyPng() {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.from([0, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 0, 0]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const p = (text, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

/**
 * A .docx with a title, headings, bold/italic, a bulleted and a numbered
 * list, a table, a link, a picture, a footnote and a comment.
 */
export async function makeDocx() {
  const body = [
    p('Memory and Learning', 'Title'),
    p('Encoding', 'Heading1'),
    `<w:p><w:r><w:t xml:space="preserve">Plain, </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r><w:r><w:t xml:space="preserve"> and </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>italic</w:t></w:r><w:r><w:t xml:space="preserve"> words.</w:t></w:r>`
      + '<w:r><w:footnoteReference w:id="1"/></w:r></w:p>',
    `<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>A sentence with a comment.</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>`,
    `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First bullet</w:t></w:r></w:p>`,
    `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Second bullet</w:t></w:r></w:p>`,
    `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>Step one</w:t></w:r></w:p>`,
    p('Retrieval', 'Heading2'),
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cue</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Effect</w:t></w:r></w:p></w:tc></w:tr>'
      + '<w:tr><w:tc><w:p><w:r><w:t>Context</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Better recall</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
    `<w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>Read more</w:t></w:r></w:hyperlink></w:p>`,
    `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="190500" cy="190500"/><wp:docPr id="1" name="Picture 1" descr="A red square"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="red.png" descr="A red square"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`,
  ].join('');
  const files = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/_rels/document.xml.rels', data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rIdFoot" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/><Relationship Id="rIdCom" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/><Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/red.png"/><Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/memory" TargetMode="External"/></Relationships>' },
    { name: 'word/document.xml', data: `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>` },
    { name: 'word/styles.xml', data: `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>` },
    { name: 'word/numbering.xml', data: `<?xml version="1.0" encoding="UTF-8"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>` },
    { name: 'word/footnotes.xml', data: `<?xml version="1.0" encoding="UTF-8"?><w:footnotes ${W}><w:footnote w:id="1"><w:p><w:r><w:t>Tulving, 1974.</w:t></w:r></w:p></w:footnote></w:footnotes>` },
    { name: 'word/comments.xml', data: `<?xml version="1.0" encoding="UTF-8"?><w:comments ${W}><w:comment w:id="0" w:author="Jon" w:initials="JW"><w:p><w:r><w:t>Ask the class first.</w:t></w:r></w:p></w:comment></w:comments>` },
    { name: 'word/media/red.png', data: tinyPng() },
  ];
  return Buffer.from(await (await createZip(files)).arrayBuffer());
}

/** The same kinds of thing, as Word writes them in RTF. */
export function makeRtf() {
  const hex = tinyPng().toString('hex');
  return [
    '{\\rtf1\\ansi\\ansicpg1252\\deff0',
    '{\\fonttbl{\\f0\\froman Times New Roman;}}',
    '{\\stylesheet{\\s0 Normal;}{\\s1\\b\\fs32 heading 1;}{\\s2\\b\\fs28 heading 2;}}',
    '{\\*\\generator Test;}',
    '\\pard\\s1 Encoding\\par',
    '\\pard\\s0 Plain, {\\b bold} and {\\i italic} words.{\\super\\chftn}{\\footnote\\pard\\plain {\\super\\chftn} Tulving, 1974.}\\par',
    '\\pard A caf\\\'e9 sentence{\\*\\atnid JW}{\\*\\atnauthor Jon}\\chatn{\\*\\annotation{\\*\\atnref 0}\\pard Ask the class first.} with a comment.\\par',
    '{\\listtext\\pard\\plain \\\'b7\\tab}\\pard\\ls1\\ilvl0 First bullet\\par',
    '{\\listtext\\pard\\plain \\\'b7\\tab}\\pard\\ls1\\ilvl0 Second bullet\\par',
    '{\\listtext\\pard\\plain 1.\\tab}\\pard\\ls2\\ilvl0 Step one\\par',
    '\\pard\\s2 Retrieval\\par',
    '\\trowd\\cellx3000\\cellx6000\\pard\\intbl Cue\\cell Effect\\cell\\row',
    '\\trowd\\cellx3000\\cellx6000\\pard\\intbl Context\\cell Better recall\\cell\\row',
    '\\pard {\\field{\\*\\fldinst {HYPERLINK "https://example.com/memory"}}{\\fldrslt {\\ul Read more}}}\\par',
    `\\pard {\\*\\shppict{\\pict\\pngblip\\picw2\\pich2 ${hex}}}{\\nonshppict{\\pict\\wmetafile8 0102}}\\par`,
    '\\pard Smart \\ldblquote quotes\\rdblquote  and \\u8364?uro.\\par',
    '}',
  ].join('\n');
}
