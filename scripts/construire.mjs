import { readdir, readFile, writeFile } from 'node:fs/promises';
import readXlsxFile from 'read-excel-file/node';

const RACINE = new URL('../', import.meta.url);
const DOSSIER_XML = new URL('data/xml/', RACINE);
const DOSSIER_XLSX = new URL('data/xlsx/', RACINE);
const SORTIE = new URL('donnees/', RACINE);

const NIVEAUX_CONNUS = new Set([1, 2]);
const XML_ARRETE = 5;
const ALIAS = { FLORENNE: 'FLORENNES' };
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

const codeDe = (niveau, arrete) => niveau * 10 + (arrete ? 1 : 0);

function lireXml(texte) {
  const lignes = [];
  for (const [, bloc] of texte.matchAll(/<slowdown>([\s\S]*?)<\/slowdown>/g)) {
    const station = bloc.match(/<(station|id)>([\s\S]*?)<\/\1>/)?.[2];
    const index = Number(bloc.match(/<index>\s*(\d+)\s*<\/index>/)?.[1]);
    if (!station || !Number.isInteger(index)) continue;
    const code = index === XML_ARRETE ? codeDe(2, true) : codeDe(index, false);
    lignes.push({ station: decoderEntites(station.trim()), code });
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
    .map((r) => ({
      station: String(r[iId]).trim(),
      code: codeDe(Number(r[iIndex]), cle(r[iArrete]) === 'OUI')
    }))
    .filter((l) => Number.isInteger(l.code));
}

async function lister(dossier) {
  try {
    return (await readdir(dossier)).filter((n) => NOM_FICHIER.test(n));
  } catch {
    return [];
  }
}

const fichiers = new Map();
for (const [dossier, type] of [
  [DOSSIER_XML, 'xml'],
  [DOSSIER_XLSX, 'xlsx']
]) {
  for (const nom of await lister(dossier)) {
    const [, a, m, j] = nom.match(NOM_FICHIER);
    const date = `${a}-${m}-${j}`;
    fichiers.set(date, { ...fichiers.get(date), [type]: { nom, url: new URL(nom, dossier) } });
  }
}

async function lireReleve({ xml, xlsx }) {
  if (xlsx) {
    try {
      return { nom: xlsx.nom, lignes: await lireXlsx(xlsx.url.pathname) };
    } catch (cause) {
      if (!xml) throw cause;
      console.log(`::warning::${xlsx.nom} illisible (${cause.message}), repli sur le XML`);
    }
  }
  return { nom: xml.nom, lignes: lireXml(await readFile(xml.url, 'utf8')) };
}

const dates = [...fichiers.keys()].sort();
if (!dates.length) throw new Error('aucun relevé dans data/');

const releves = [];
const anomalies = [];
const inconnus = new Map();
for (const date of dates) {
  const { nom, lignes } = await lireReleve(fichiers.get(date));
  const codes = new Array(communes.length).fill(null);
  for (const { station, code } of lignes) {
    const i = trouverCommune(station);
    if (i === null) {
      anomalies.push(`${nom} : « ${station} » ne correspond à aucune commune`);
      continue;
    }
    codes[i] = code;
    const niveau = Math.floor(code / 10);
    if (!NIVEAUX_CONNUS.has(niveau)) inconnus.set(niveau, `${nom} (${station})`);
  }
  const absentes = codes.filter((c) => c === null).length;
  if (absentes > 10) anomalies.push(`${nom} : ${absentes} zones sans état`);
  releves.push({ date, codes });
}

for (const [niveau, exemple] of inconnus) {
  console.log(`::warning::index ${niveau} jamais vu, publié en « état non reconnu » : ${exemple}`);
}

if (anomalies.length) {
  console.error(anomalies.join('\n'));
  process.exit(1);
}

const dernier = releves.at(-1);
const precedent = releves.at(-2) ?? null;

function depuis(i) {
  const code = dernier.codes[i];
  let k = releves.length - 1;
  while (k > 0 && releves[k - 1].codes[i] === code) k -= 1;
  return { depuis: releves[k].date, depuisPremierReleve: k === 0 };
}

const etat = {
  date: dernier.date,
  precedente: precedent?.date ?? null,
  source: SOURCE,
  communes: communes.map((c, i) => ({
    ...c,
    code: dernier.codes[i],
    avant: precedent?.codes[i] ?? null,
    ...(dernier.codes[i] === null ? {} : depuis(i))
  }))
};

const historique = {
  source: SOURCE,
  codage: 'index × 10 + 1 si arrêté de police',
  communes: communes.map((c) => c.nis),
  releves
};

await writeFile(new URL('etat.json', SORTIE), JSON.stringify(etat));
await writeFile(new URL('historique.json', SORTIE), JSON.stringify(historique));
const resume = {};
for (const code of dernier.codes) if (code !== null) resume[code] = (resume[code] ?? 0) + 1;
console.log(`${releves.length} relevé(s), dernier ${dernier.date} : ${JSON.stringify(resume)}`);
