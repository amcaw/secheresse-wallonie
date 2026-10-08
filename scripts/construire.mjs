import { readdir, readFile, writeFile } from 'node:fs/promises';
import readXlsxFile from 'read-excel-file/node';

const RACINE = new URL('../', import.meta.url);
const DOSSIER_XML = new URL('data/xml/', RACINE);
const DOSSIER_XLSX = new URL('data/xlsx/', RACINE);
const SORTIE = new URL('donnees/', RACINE);

const ETATS = ['normal', 'diminuee', 'arrete'];
const INDEX_XML = { 1: 'normal', 2: 'diminuee', 5: 'arrete' };
const ALIAS = { FLORENNE: 'FLORENNES' };
const HORS_WALLONIE = new Set(['BRUXELLES']);
const NOM_FICHIER = /^SIT_PROD_EAU_COMMUNE_(\d{4})(\d{2})(\d{2})\.(xml|xlsx)$/i;

const SOURCE = {
  nom: 'SPW, Cortex, Aquawal et opérateurs de l’eau',
  lien: null
};

const cle = (nom) =>
  String(nom)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');

const topo = JSON.parse(await readFile(new URL('communes.topojson', SORTIE), 'utf8'));
const communes = topo.objects.communes.geometries
  .map((g) => g.properties)
  .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
const parCle = new Map(communes.map((c, i) => [cle(c.nom), i]));

function trouverCommune(station) {
  const brute = cle(station);
  const k = cle(ALIAS[brute] ?? brute);
  if (parCle.has(k)) return parCle.get(k);
  const candidates = [...parCle.keys()].filter((c) => c.startsWith(k));
  if (k.length >= 8 && candidates.length === 1) return parCle.get(candidates[0]);
  return null;
}

function lireXml(texte) {
  const lignes = [];
  for (const [, bloc] of texte.matchAll(/<slowdown>([\s\S]*?)<\/slowdown>/g)) {
    const station = bloc.match(/<station>([\s\S]*?)<\/station>/)?.[1];
    const index = Number(bloc.match(/<index>\s*(\d+)\s*<\/index>/)?.[1]);
    if (!station) continue;
    const etat = INDEX_XML[index];
    if (!etat) throw new Error(`index ${index} inconnu pour ${station}`);
    lignes.push({ station: decoderEntites(station.trim()), etat });
  }
  return lignes;
}

function decoderEntites(texte) {
  return texte
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

async function lireXlsx(chemin) {
  const [entete, ...rangees] = await readXlsxFile(chemin);
  const colonnes = entete.map((c) => cle(c));
  const iId = colonnes.indexOf('ID');
  const iIndex = colonnes.indexOf('INDEX');
  const iArrete = colonnes.findIndex((c) => c.startsWith('ARRET'));
  if (iId < 0 || iIndex < 0 || iArrete < 0) throw new Error(`colonnes inattendues : ${entete}`);
  return rangees
    .filter((r) => r[iId])
    .map((r) => {
      const index = Number(r[iIndex]);
      const arrete = cle(r[iArrete]) === 'OUI';
      if (![1, 2].includes(index)) throw new Error(`index ${index} inconnu pour ${r[iId]}`);
      return { station: String(r[iId]).trim(), etat: arrete ? 'arrete' : INDEX_XML[index] };
    });
}

async function lister(dossier) {
  try {
    return (await readdir(dossier)).filter((n) => NOM_FICHIER.test(n));
  } catch {
    return [];
  }
}

const fichiers = new Map();
for (const nom of await lister(DOSSIER_XLSX)) {
  const [, a, m, j] = nom.match(NOM_FICHIER);
  fichiers.set(`${a}-${m}-${j}`, { nom, url: new URL(nom, DOSSIER_XLSX), type: 'xlsx' });
}
for (const nom of await lister(DOSSIER_XML)) {
  const [, a, m, j] = nom.match(NOM_FICHIER);
  fichiers.set(`${a}-${m}-${j}`, { nom, url: new URL(nom, DOSSIER_XML), type: 'xml' });
}

const dates = [...fichiers.keys()].sort();
if (!dates.length) throw new Error('aucun relevé dans data/');

const releves = [];
const anomalies = [];
for (const date of dates) {
  const { nom, url, type } = fichiers.get(date);
  const lignes =
    type === 'xml' ? lireXml(await readFile(url, 'utf8')) : await lireXlsx(url.pathname);
  const etats = new Array(communes.length).fill(null);
  for (const { station, etat } of lignes) {
    if (HORS_WALLONIE.has(cle(station))) continue;
    const i = trouverCommune(station);
    if (i === null) {
      anomalies.push(`${nom} : « ${station} » ne correspond à aucune commune`);
      continue;
    }
    etats[i] = ETATS.indexOf(etat);
  }
  const absentes = etats.filter((e) => e === null).length;
  if (absentes > 10) anomalies.push(`${nom} : ${absentes} communes sans état`);
  releves.push({ date, etats });
}

if (anomalies.length) {
  console.error(anomalies.join('\n'));
  process.exit(1);
}

const dernier = releves.at(-1);
const precedent = releves.at(-2) ?? null;

function depuis(i) {
  const etat = dernier.etats[i];
  let k = releves.length - 1;
  while (k > 0 && releves[k - 1].etats[i] === etat) k -= 1;
  return { depuis: releves[k].date, depuisPremierReleve: k === 0 };
}

const comptes = Object.fromEntries(ETATS.map((e) => [e, 0]));
const etat = {
  date: dernier.date,
  precedente: precedent?.date ?? null,
  source: SOURCE,
  comptes,
  communes: communes.map((c, i) => {
    const code = dernier.etats[i];
    if (code === null) return { ...c, etat: null };
    comptes[ETATS[code]] += 1;
    const avant = precedent?.etats[i];
    return {
      ...c,
      etat: ETATS[code],
      avant: avant === null || avant === undefined ? null : ETATS[avant],
      ...depuis(i)
    };
  })
};

const historique = {
  source: SOURCE,
  etats: ETATS,
  communes: communes.map((c) => c.nis),
  releves
};

await writeFile(new URL('etat.json', SORTIE), JSON.stringify(etat));
await writeFile(new URL('historique.json', SORTIE), JSON.stringify(historique));
console.log(
  `${releves.length} relevé(s), dernier ${dernier.date} : ` +
    ETATS.map((e) => `${e} ${comptes[e]}`).join(', ')
);
