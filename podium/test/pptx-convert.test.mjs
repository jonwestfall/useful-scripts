// Run with: node podium/test/pptx-convert.test.mjs
// Converting a PowerPoint file to a PDF, the way Issue #107 uses LibreOffice
// (Issue #107). Needs the real `soffice` binary to exercise the conversion
// itself, so a machine without it (most CI runners, today) skips those
// checks with a note rather than failing - see docs/vps.md for what to
// install if you want this coverage locally or in CI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createZip } from '../assets/js/zip.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pptxConvert = require(path.join(HERE, '..', 'server', 'pptx-convert.js'));

let ok = true;
const chk = (label, cond) => {
  if (!cond) {
    ok = false;
    console.error('FAIL', label);
  } else {
    console.log('ok  ', label);
  }
};
const rejects = async (promise) => {
  try { await promise; return null; } catch (err) { return err; }
};

console.log('-- what this module claims to convert --');
chk('exactly PowerPoint’s own formats, current and legacy', [...pptxConvert.CONVERTIBLE_EXTS].sort().join() === '.ppt,.pptx');
chk('not the wider Impress-openable neighbourhood (Keynote, ODP, "Show")',
  !['.key', '.odp', '.pps', '.ppsx'].some((e) => pptxConvert.CONVERTIBLE_EXTS.has(e)));

// --- a missing binary, deterministically - no real install needed ----------
console.log('\n-- LibreOffice not installed --');
{
  // execFile inherits process.env by default; scoping PATH to just enough to
  // still run node, but nothing named "soffice", is what forces ENOENT here
  // regardless of whether this machine actually has LibreOffice, so this
  // check runs everywhere.
  const savedPath = process.env.PATH;
  process.env.PATH = path.dirname(process.execPath);
  const err = await rejects(pptxConvert.convertToPdf(Buffer.from('anything'), '.pptx'));
  process.env.PATH = savedPath;
  chk('says plainly what to install, not a stack trace', err instanceof pptxConvert.ConversionError && /LibreOffice.*is not installed/.test(err.message));
  chk('and suggests the fallback that already exists (export images or a PDF)', /export the slides/.test(err.message));
}

// --- a minimal, genuinely valid .pptx, built the same way the rest of this
// suite builds its ZIP fixtures - see buildMinimalPptx below -----------------

const soffice = await new Promise((resolve) => {
  execFile('soffice', ['--version'], { timeout: 15000 }, (err) => resolve(!err));
});

if (!soffice) {
  console.log('\n-- soffice is not on PATH here: skipping the real conversion checks --');
} else {
  console.log('\n-- converting a real presentation --');
  {
    const pptx = await buildMinimalPptx();
    const pdf = await pptxConvert.convertToPdf(pptx, '.pptx');
    chk('produces a real PDF', pdf.subarray(0, 5).toString('latin1') === '%PDF-');
    chk('with actual page content, not an empty shell', pdf.length > 500);

    console.log('\n-- .ppt, the legacy binary format LibreOffice still reads --');
    // soffice tells formats apart by content, not the extension on the temp
    // file it is handed - proven here by converting the same OOXML bytes
    // under the legacy extension rather than hand-rolling a second, binary
    // format from scratch.
    const pdfFromPpt = await pptxConvert.convertToPdf(pptx, '.ppt');
    chk('the .ppt path converts too', pdfFromPpt.subarray(0, 5).toString('latin1') === '%PDF-');

    console.log('\n-- something that is not really a presentation --');
    const err = await rejects(pptxConvert.convertToPdf(Buffer.from('not a presentation at all'), '.pptx'));
    // LibreOffice does not use its exit code for this - it says "could not
    // be loaded" and exits 0 regardless - so this is the one behaviour in
    // the whole module that is genuinely worth a real, unmocked assertion:
    // proof that a corrupt file is still caught by checking for the output,
    // not trusted to fail loudly on its own.
    chk('is refused with a plain reason rather than crashing or hanging', err instanceof pptxConvert.ConversionError && /could not be converted/.test(err.message));

    console.log('\n-- two at once --');
    const [a, b] = await Promise.all([
      pptxConvert.convertToPdf(pptx, '.pptx'),
      pptxConvert.convertToPdf(pptx, '.pptx'),
    ]);
    // Two conversions sharing one LibreOffice profile is a documented way to
    // deadlock them both on the same lock file - this is what proves the
    // private per-call profile (-env:UserInstallation) actually works, not
    // just that the option is present in the spawned command.
    chk('both finish, proving the private profile actually keeps them apart',
      a.subarray(0, 5).toString('latin1') === '%PDF-' && b.subarray(0, 5).toString('latin1') === '%PDF-');

    chk('nothing is left behind afterwards', fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('podium-pptx-')).length === 0);
  }
}

console.log(ok ? '\nALL PASS' : '\nSOME FAILED');
process.exit(ok ? 0 : 1);

/**
 * The smallest OOXML presentation LibreOffice actually opens: one slide, one
 * title placeholder, the layout/master/theme chain a .pptx needs even to be
 * valid (a real PowerPoint export carries far more - a dozen unused slide
 * layouts, notes masters, thumbnails - none of which conversion needs). Built
 * the same way the rest of this test suite builds its ZIP fixtures, with
 * hand-written parts rather than a checked-in binary sample.
 */
async function buildMinimalPptx() {
  const rel = (rels) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
  const r = (id, type, target) => `<Relationship Id="rId${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;

  const parts = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
</Types>`,
    '_rels/.rels': rel(r(1, 'officeDocument', 'ppt/presentation.xml')),
    'ppt/presentation.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>
<p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rel(
      r(1, 'slideMaster', 'slideMasters/slideMaster1.xml') + r(2, 'slide', 'slides/slide1.xml') + r(3, 'theme', 'theme/theme1.xml'),
    ),
    'ppt/slideMasters/slideMaster1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': rel(
      r(1, 'slideLayout', '../slideLayouts/slideLayout1.xml') + r(2, 'theme', '../theme/theme1.xml'),
    ),
    'ppt/slideLayouts/slideLayout1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>
<p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr>
</p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rel(r(1, 'slideMaster', '../slideMasters/slideMaster1.xml')),
    'ppt/slides/slide1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Podium test slide</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld>
</p:sld>`,
    'ppt/slides/_rels/slide1.xml.rels': rel(r(1, 'slideLayout', '../slideLayouts/slideLayout1.xml')),
    'ppt/theme/theme1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Minimal">
<a:themeElements>
<a:clrScheme name="Minimal">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="000000"/></a:dk2><a:lt2><a:srgbClr val="FFFFFF"/></a:lt2>
<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>
<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>
<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
</a:clrScheme>
<a:fontScheme name="Minimal"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="Minimal">
<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>
</a:fmtScheme>
</a:themeElements>
</a:theme>`,
  };
  const blob = await createZip(Object.entries(parts).map(([name, data]) => ({ name, data })));
  return Buffer.from(await blob.arrayBuffer());
}
