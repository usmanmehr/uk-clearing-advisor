// UK Clearing Advisor - GenerateExport (GET /export?queryId=X&format=pdf|xlsx).
// Zero-dependency XLSX (hand-built OOXML via zlib) and PDF generators.
// Uploads to the exports bucket and returns a presigned GET URL.
import { deflateRawSync } from 'node:zlib';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  ddb, GetCommand, PutCommand, UpdateCommand,
  maskIp, putMetric, log, json, errorResponse, checkRateLimit,
} from './shared.mjs';

const s3 = new S3Client({});
const QUERY_CACHE_TABLE = process.env.QUERY_CACHE_TABLE;
const RATE_LIMITS_TABLE = process.env.RATE_LIMITS_TABLE;
const EXPORTS_BUCKET = process.env.EXPORTS_BUCKET;

// ---------- ZIP (store/deflate) with CRC32 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function makeZip(files) {
  // files: [{ name, data: Buffer }]
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const comp = deflateRawSync(f.data);
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);       // version needed
    local.writeUInt16LE(0, 6);        // flags
    local.writeUInt16LE(8, 8);        // method deflate
    local.writeUInt16LE(0, 10);       // mod time
    local.writeUInt16LE(0x21, 12);    // mod date (arbitrary valid)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, comp);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(f.data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(central);
  const centralStart = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

function xmlEscape(s) {
  return String(s ?? '').replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

// ---------- XLSX (single "Shortlist" sheet, styled header) ----------
function buildXlsx(rows) {
  const headers = ['University', 'Course', 'Status', 'Typical offer',
    'Graduate prospects % (CUG 2027)', 'National median salary £ (HESA)', 'Clearing phone', 'Clearing page'];
  const colWidths = [26, 30, 22, 16, 22, 22, 24, 40];

  const cell = (ref, style, text) =>
    `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
  const colLetter = (i) => {
    let s = '', n = i + 1;
    while (n) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  };

  let sheetData = '<sheetData>';
  sheetData += '<row r="1" ht="20" customHeight="1">';
  headers.forEach((h, c) => { sheetData += cell(`${colLetter(c)}1`, 1, h); });
  sheetData += '</row>';
  rows.forEach((row, ri) => {
    const r = ri + 2;
    const vals = [row.universityName, row.courseTitle, row.statusBadge?.label || '',
      row.typicalOffer,
      row.graduateProspects != null ? `${row.graduateProspects}` : 'Not verified',
      row.nationalMedianSalary != null ? `${row.nationalMedianSalary}` : 'Not verified',
      row.clearingPhone || '', row.clearingPage || ''];
    sheetData += `<row r="${r}">`;
    vals.forEach((v, c) => { sheetData += cell(`${colLetter(c)}${r}`, 2, v); });
    sheetData += '</row>';
  });
  sheetData += '</sheetData>';

  let cols = '<cols>';
  colWidths.forEach((w, i) => { cols += `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`; });
  cols += '</cols>';

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    + `<sheetFormatPr defaultRowHeight="15"/>${cols}${sheetData}`
    + `<pageMargins left="0.5" right="0.5" top="0.5" bottom="0.5" header="0.3" footer="0.3"/></worksheet>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<fonts count="2"><font><sz val="11"/><name val="Arial"/></font>`
    + `<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Arial"/></font></fonts>`
    + `<fills count="3"><fill><patternFill patternType="none"/></fill>`
    + `<fill><patternFill patternType="gray125"/></fill>`
    + `<fill><patternFill patternType="solid"><fgColor rgb="FF1F3864"/><bgColor indexed="64"/></patternFill></fill></fills>`
    + `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>`
    + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
    + `<cellXfs count="3">`
    + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`
    + `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>`
    + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>`
    + `</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
    + `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<sheets><sheet name="Shortlist" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>`
    + `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

  return makeZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes) },
    { name: '_rels/.rels', data: Buffer.from(rootRels) },
    { name: 'xl/workbook.xml', data: Buffer.from(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels) },
    { name: 'xl/styles.xml', data: Buffer.from(styles) },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet) },
  ]);
}

// ---------- PDF (A4, simple text layout) ----------
function pdfEscape(s) { return String(s ?? '').replace(/([\\()])/g, '\\$1'); }
function buildPdf(rows) {
  const lines = [];
  lines.push({ t: 'UK Clearing Advisor - Course shortlist', size: 16 });
  lines.push({ t: `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, size: 9 });
  lines.push({ t: 'Offers are indicative. Confirm live vacancies by phone on Results Day.', size: 9 });
  lines.push({ t: 'Salary = national median for the subject (HESA). Prospects % = per-university, CUG 2027, where published.', size: 8 });
  lines.push({ t: '', size: 9 });
  rows.slice(0, 30).forEach((r, i) => {
    const prospects = r.graduateProspects != null ? `${r.graduateProspects}% graduate prospects (CUG 2027)` : 'Graduate prospects: not verified for this university';
    const salary = r.nationalMedianSalary != null ? `national median salary GBP ${r.nationalMedianSalary} (HESA, ${r.salaryYear || '2022/23'})` : 'Salary: not shown (no course interest selected)';
    lines.push({ t: `${i + 1}. ${r.universityName} - ${r.courseTitle}`, size: 11 });
    lines.push({ t: `   ${r.statusBadge?.label || ''} | ${r.typicalOffer} | ${prospects} | ${salary}`, size: 9 });
    lines.push({ t: `   Clearing: ${r.clearingPhone || 'see page'} | ${r.clearingPage || ''}`, size: 9 });
  });

  let y = 800;
  let content = 'BT\n';
  for (const ln of lines) {
    if (y < 40) break;
    content += `/F1 ${ln.size} Tf\n1 0 0 1 40 ${y} Tm\n(${pdfEscape(ln.t)}) Tj\n`;
    y -= ln.size + 5;
  }
  content += 'ET';
  const contentBuf = Buffer.from(content, 'latin1');

  const objects = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>');
  objects.push(`<< /Length ${contentBuf.length} >>\nstream\n${content}\nendstream`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((off) => { pdf += `${String(off).padStart(10, '0')} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

export const handler = async (event) => {
  const started = Date.now();
  const requestId = event?.requestContext?.requestId || 'n/a';
  const sourceIp = event?.requestContext?.http?.sourceIp || 'unknown';
  const qp = event?.queryStringParameters || {};
  const queryId = qp.queryId;
  const format = (qp.format || 'xlsx').toLowerCase();

  if (!queryId) return errorResponse(400, 'INVALID_INPUT', 'queryId is required.', requestId);
  if (!['xlsx', 'pdf'].includes(format)) return errorResponse(400, 'INVALID_INPUT', 'format must be pdf or xlsx.', requestId);

  // Export rate limit: 5 per 30 minutes per IP.
  const rl = await checkRateLimit(RATE_LIMITS_TABLE, `ip#${sourceIp}#export`, 5, 1800);
  if (!rl.allowed) {
    await putMetric('ExportAbuseAttempts', 1);
    return errorResponse(429, 'RATE_LIMITED', 'Too many exports. Please wait.', requestId, { retryAfter: rl.retryAfter });
  }

  try {
    const q = await ddb.send(new GetCommand({ TableName: QUERY_CACHE_TABLE, Key: { queryId } }));
    const item = q.Item;
    if (!item) return errorResponse(404, 'QUERY_EXPIRED', 'This result set has expired. Please search again.', requestId);

    if (item.exported && item.exportedAt) {
      const ageMs = Date.now() - new Date(item.exportedAt).getTime();
      if (ageMs > 5 * 60 * 1000) {
        await putMetric('ExportAbuseAttempts', 1);
        return errorResponse(409, 'ALREADY_EXPORTED', 'This shortlist has already been exported.', requestId);
      }
    }

    const rows = JSON.parse(item.results || '[]');
    const isXlsx = format === 'xlsx';
    const file = isXlsx ? buildXlsx(rows) : buildPdf(rows);
    const key = `exports/${queryId}/${Date.now()}.${format}`;
    const contentType = isXlsx
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'application/pdf';

    await s3.send(new PutObjectCommand({
      Bucket: EXPORTS_BUCKET, Key: key, Body: file, ContentType: contentType,
    }));
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: EXPORTS_BUCKET, Key: key }), { expiresIn: 3600 });

    await ddb.send(new UpdateCommand({
      TableName: QUERY_CACHE_TABLE, Key: { queryId },
      UpdateExpression: 'SET exported = :t, exportedAt = :now',
      ExpressionAttributeValues: { ':t': true, ':now': new Date().toISOString() },
    }));

    const latency = Date.now() - started;
    await Promise.all([
      putMetric('ExportGeneratedCount', 1, 'Count', [{ Name: 'Format', Value: format }]),
      putMetric('ExportLatencyMs', latency, 'Milliseconds'),
      putMetric('ExportFileSizeBytes', file.length, 'Bytes'),
    ]);
    log('INFO', { level: 'INFO', msg: 'export', requestId, sourceIp: maskIp(sourceIp), format, bytes: file.length, latency });

    return json(200, { downloadUrl: url, format, expiresIn: 3600, bytes: file.length });
  } catch (e) {
    log('ERROR', { level: 'ERROR', msg: 'export failed', requestId, error: e.message, stack: e.stack });
    await putMetric('LambdaErrorCount', 1);
    return errorResponse(500, 'INTERNAL_ERROR', 'Could not generate the export.', requestId);
  }
};
