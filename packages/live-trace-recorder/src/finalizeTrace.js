'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const yazl = require('yazl');

async function listFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(full));
    else out.push(full);
  }
  return out;
}

async function finalizeTrace(rawDir, outputZip, traceName = 'trace') {
  const entries = [];
  const addFile = (file, name) => { if (fs.existsSync(file)) entries.push({ file, name }); };
  addFile(path.join(rawDir, `${traceName}.trace`), 'trace.trace');
  addFile(path.join(rawDir, `${traceName}.network`), 'trace.network');
  addFile(path.join(rawDir, `${traceName}.stacks`), 'trace.stacks');
  for (const file of await listFiles(path.join(rawDir, 'resources'))) {
    entries.push({ file, name: path.relative(rawDir, file).replace(/\\/g, '/') });
  }
  if (!entries.length) throw new Error(`没有可归档的 Trace 文件: ${rawDir}`);
  await fsp.mkdir(path.dirname(outputZip), { recursive: true });
  const temp = `${outputZip}.tmp-${process.pid}-${Date.now()}`;
  await new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.outputStream.on('error', reject);
    zip.outputStream.on('close', resolve);
    for (const entry of entries) zip.addFile(entry.file, entry.name);
    zip.end();
    zip.outputStream.pipe(fs.createWriteStream(temp));
  });
  await fsp.rename(temp, outputZip);
  return { outputZip, entries: entries.map((e) => e.name) };
}

module.exports = { finalizeTrace };
