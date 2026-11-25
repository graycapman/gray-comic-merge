import { Project } from '../js/model.js';
import { groupFiles, prepareImport, commitImport } from '../js/importer.js';
import { ZipWriter } from '../js/zip.js';

export const bytes = (label) => new TextEncoder().encode(`image:${label}`);
export const fakeFile = (name, label = name) => new File([bytes(label)], name.split('/').pop(), { lastModified: 1000 });

/** Builds a CBZ File whose pages contain their own path as content. */
export async function makeCbz(name, paths) {
  const zip = new ZipWriter();
  for (const p of paths) await zip.addFile(p, new Blob([bytes(`${name}:${p}`)]));
  return new File([await zip.finish()], name, { lastModified: 2000 });
}

/** specs: [{folder:'Comic', paths:[...]}] | [{cbz:'a.cbz', paths:[...]}] | [{loose:[names]}] */
export async function buildRaws(specs) {
  const pairs = [];
  for (const s of specs) {
    if (s.folder) for (const p of s.paths) pairs.push({ path: `${s.folder}/${p}`, file: fakeFile(p, `${s.folder}/${p}`) });
    if (s.cbz) pairs.push({ path: s.cbz, file: await makeCbz(s.cbz, s.paths) });
    if (s.loose) for (const n of s.loose) pairs.push({ path: n, file: fakeFile(n) });
  }
  return groupFiles(pairs);
}

export async function importSpecs(project, specs, overrides = {}) {
  const { raws, skipped } = await buildRaws(specs);
  const sources = await prepareImport(project, raws, []);
  for (const s of sources) if (overrides[s.label]) s.selection = overrides[s.label];
  const result = commitImport(project, sources, []);
  return { sources, skipped, ...result };
}

export async function projectFrom(specs, overrides) {
  const project = new Project();
  const info = await importSpecs(project, specs, overrides);
  return { project, ...info };
}

export const names = (project) => project.order.map((id) => project.item(id).name);
export const paths = (project) => project.order.map((id) => project.item(id).path);
