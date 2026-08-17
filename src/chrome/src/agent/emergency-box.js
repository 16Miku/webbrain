import { OPENSTAX_CATALOG_SNAPSHOT_DATE, PREFETCHED_OPENSTAX_CATALOG } from './openstax-catalog.js';

export { OPENSTAX_CATALOG_SNAPSHOT_DATE, PREFETCHED_OPENSTAX_CATALOG };

const EMERGENCY_BOX_DB_NAME = 'webbrain_emergency_box';
const EMERGENCY_BOX_DB_VERSION = 1;
const RESOURCE_STORE = 'resources';
const RESOURCE_DIRECTORY = 'webbrain-emergency-box';
const OPENSTAX_API = 'https://openstax.org/apps/cms/api/v2';
const ALL_RESOURCE_CATEGORY_PRIORITY = Object.freeze({ communication: 0, health: 1, field: 2, education: 3 });
export const EMERGENCY_BOX_SIZE_ESTIMATES = Object.freeze({
  measuredAt: '2026-08-17',
  basicBytes: 59_937_724,
  catalogBytes: 12_063_912_733,
  hesperianBytesPerResource: 436_315,
  curatedBytesPerResource: 6_453_444,
  openStaxBytesPerResource: 91_871_600,
});
const HESPERIAN_ENGLISH_PDFS_URL = 'https://languages.hesperian.org/pages/en/pdf.html';

export const EMERGENCY_BOX_COMMUNICATION_RESOURCES = Object.freeze([
  Object.freeze({
    id: 'communication-panlex-basic-lexicon',
    title: 'Universal Basic Lexicon',
    description: 'A built-in word board with 110 everyday concepts across 1,756 languages and 2,064 language varieties.',
    category: 'communication',
    collection: 'Communication & languages',
    publisher: 'PanLex / The Long Now Foundation',
    published: '2017',
    language: '1,756 languages',
    sourceUrl: 'https://dev.panlex.org/panlex-swadesh-corpus/',
    rights: 'CC0 1.0 Universal',
    totalBytes: 3_597_069,
    builtIn: true,
    basic: true,
    format: 'lexicon',
    reader: 'emergency-communication.html',
  }),
]);

const HESPERIAN_WTND_BASIC_SECTIONS = new Set(['03', '04', '10', '13', '14', '23', 'gp']);
const HESPERIAN_WTND_SECTIONS = Object.freeze([
  ['fm', 'Front matter and copyright'],
  ['toc', 'Contents, introduction and edition notes'],
  ['int', 'Words to the village health worker'],
  ['01', 'Home cures and popular beliefs'],
  ['02', 'Sicknesses that are often confused'],
  ['03', 'How to examine a sick person'],
  ['04', 'How to take care of a sick person'],
  ['05', 'Healing without medicines'],
  ['06', 'Right and wrong uses of modern medicines'],
  ['07', 'Antibiotics: what they are and how to use them'],
  ['08', 'How to measure and give medicine'],
  ['09', 'Instructions and precautions for injections'],
  ['10', 'First aid'],
  ['11', 'Nutrition: what to eat to be healthy'],
  ['12', 'Prevention: how to avoid many sicknesses'],
  ['13', 'Some very common sicknesses'],
  ['14', 'Serious illnesses that need special medical attention'],
  ['15', 'Skin problems'],
  ['16', 'The eyes'],
  ['17', 'The teeth, gums and mouth'],
  ['18', 'The urinary system and the genitals'],
  ['19', 'Information for mothers and midwives'],
  ['20', 'Family planning'],
  ['21', 'Health and sicknesses of children'],
  ['22', 'Health and sicknesses of older people'],
  ['23', 'The medicine kit'],
  ['gp', 'Medicine uses, dosage and precautions'],
  ['info', 'Additional information'],
  ['gloss', 'Vocabulary'],
  ['resc', 'Teaching-material resources'],
  ['indx', 'Index'],
  ['bm', 'Dosage blanks and patient reports'],
]);

const HESPERIAN_DENTIST_SECTIONS = Object.freeze([
  ['fm', 'Front matter, contents and introduction'],
  ['01', 'Your own teeth and gums'],
  ['02', 'Teaching family and friends in your community'],
  ['03', 'Teaching children at school'],
  ['04', 'School activities for learning about teeth and gums'],
  ['05', 'Taking care of teeth and gums'],
  ['06', 'Examination and diagnosis'],
  ['07', 'Treating some common problems'],
  ['08', 'Scaling teeth'],
  ['09', 'Injecting inside the mouth'],
  ['10', 'How to treat a cavity'],
  ['11', 'Taking out a tooth'],
  ['12', 'HIV and care of the teeth and gums'],
  ['bm', 'Appendices'],
]);

function hesperianResources({ idPrefix, title, published, path, sections, basicSections = new Set() }) {
  return sections.map(([section, sectionTitle]) => Object.freeze({
    id: `health-hesperian-${idPrefix}-${section}`,
    title: `${title} — ${sectionTitle}`,
    description: `Official ${title} chapter for community health care in low-resource settings.`,
    category: 'health',
    collection: `Hesperian — ${title}`,
    publisher: 'Hesperian Health Guides',
    published,
    language: 'en',
    url: `https://hesperian.org/wp-content/uploads/pdf/${path}/${path}_${section}.pdf`,
    sourceUrl: HESPERIAN_ENGLISH_PDFS_URL,
    basic: basicSections.has(section),
  }));
}

const HESPERIAN_RESOURCES = Object.freeze([
  ...hesperianResources({
    idPrefix: 'wtnd',
    title: 'Where There Is No Doctor',
    published: '2025',
    path: 'en_wtnd_2025',
    sections: HESPERIAN_WTND_SECTIONS,
    basicSections: HESPERIAN_WTND_BASIC_SECTIONS,
  }),
  ...hesperianResources({
    idPrefix: 'dentist',
    title: 'Where There Is No Dentist',
    published: '2024',
    path: 'en_dent_2024',
    sections: HESPERIAN_DENTIST_SECTIONS,
  }),
]);

export function compareEmergencyBoxResources(left = {}, right = {}, options = {}) {
  if (options.groupCategories === true) {
    const categoryDifference = (ALL_RESOURCE_CATEGORY_PRIORITY[left.category] ?? 99)
      - (ALL_RESOURCE_CATEGORY_PRIORITY[right.category] ?? 99);
    if (categoryDifference) return categoryDifference;
  }
  const readyDifference = Number(right.status === 'ready') - Number(left.status === 'ready');
  return readyDifference || String(left.title || '').localeCompare(String(right.title || ''));
}

export function estimateEmergencyBoxResourceBytes(resource = {}) {
  const knownTotal = Number(resource.totalBytes);
  if (Number.isFinite(knownTotal) && knownTotal > 0) return knownTotal;
  const id = String(resource.id || '');
  if (id.startsWith('openstax-')) return EMERGENCY_BOX_SIZE_ESTIMATES.openStaxBytesPerResource;
  if (id.startsWith('health-hesperian-')) return EMERGENCY_BOX_SIZE_ESTIMATES.hesperianBytesPerResource;
  return EMERGENCY_BOX_SIZE_ESTIMATES.curatedBytesPerResource;
}

export const EMERGENCY_BOX_HEALTH_RESOURCES = Object.freeze([
  {
    id: 'health-who-icrc-basic-emergency-care',
    title: 'WHO / ICRC Basic Emergency Care',
    description: 'A practical approach to acutely ill and injured patients in low-resource settings.',
    category: 'health',
    collection: 'Emergency health',
    publisher: 'World Health Organization and ICRC',
    published: '2018',
    language: 'en',
    url: 'https://hlh.who.int/docs/librariesprovider4/hlh-documents/who-icrc-basic-emergency-care.pdf?sfvrsn=4460e22e_5',
    sourceUrl: 'https://www.who.int/publications-detail-redirect/basic-emergency-care-approach-to-the-acutely-ill-and-injured',
    basic: true,
  },
  {
    id: 'health-ifrc-first-aid-guidelines-2020',
    title: 'International First Aid Guidelines',
    description: 'Evidence-based first aid guidance for common illnesses, injuries and emergencies.',
    category: 'health',
    collection: 'First aid',
    publisher: 'International Federation of Red Cross and Red Crescent Societies',
    published: '2020',
    language: 'en',
    url: 'https://www.ifrc.org/sites/default/files/2022-02/EN_GFARC_GUIDELINES_2020.pdf',
    sourceUrl: 'https://www.ifrc.org/document/international-first-aid-resuscitation-and-education-guidelines',
    basic: true,
  },
  {
    id: 'health-who-essential-medicines-2023',
    title: 'WHO Model List of Essential Medicines',
    description: 'The 23rd WHO model list of medicines considered essential for a basic health system.',
    category: 'health',
    collection: 'Medicines',
    publisher: 'World Health Organization',
    published: '2023',
    language: 'en',
    whoHandle: '10665/371090',
    sourceUrl: 'https://www.who.int/publications/i/item/WHO-MHP-HPS-EML-2023.02',
    basic: true,
  },
  {
    id: 'health-who-surgical-care-district-hospital',
    title: 'Surgical Care at the District Hospital',
    description: 'Emergency and essential surgical procedures for facilities with limited specialist support.',
    category: 'health',
    collection: 'Clinical care',
    publisher: 'World Health Organization',
    published: '2003',
    language: 'en',
    whoHandle: '10665/43141',
    sourceUrl: 'https://iris.who.int/handle/10665/43141',
  },
  {
    id: 'field-who-medical-guide-for-ships',
    title: 'International Medical Guide for Ships',
    description: 'Diagnosis and treatment guidance for ships and other isolated settings.',
    category: 'field',
    collection: 'Remote care',
    publisher: 'World Health Organization',
    published: '2007',
    language: 'en',
    whoHandle: '10665/43814',
    sourceUrl: 'https://iris.who.int/handle/10665/43814',
  },
  {
    id: 'field-niosh-chemical-hazards-pocket-guide',
    title: 'NIOSH Pocket Guide to Chemical Hazards',
    description: 'Workplace chemical exposure limits, symptoms, protection and first-aid information.',
    category: 'field',
    collection: 'Chemical hazards',
    publisher: 'National Institute for Occupational Safety and Health',
    published: '2007',
    language: 'en',
    url: 'https://www.cdc.gov/niosh/docs/2007-107/pdfs/2007-107.pdf',
    sourceUrl: 'https://www.cdc.gov/niosh/npg/',
  },
  {
    id: 'field-army-first-aid-fm-4-25-11',
    title: 'First Aid — U.S. Army Field Manual',
    description: 'Field assessment and immediate treatment procedures for injuries and environmental emergencies.',
    category: 'field',
    collection: 'Field manuals',
    publisher: 'U.S. Department of the Army',
    published: '2002',
    language: 'en',
    archiveIdentifier: 'fm-4-25.11-first-aid',
    sourceUrl: 'https://archive.org/details/fm-4-25.11-first-aid',
  },
  ...HESPERIAN_RESOURCES,
  {
    id: 'health-who-pocket-hospital-care-children',
    title: 'Pocket Book of Hospital Care for Children',
    description: 'WHO guidance for common and serious childhood illnesses in first-referral hospitals.',
    category: 'health', collection: 'WHO clinical care', publisher: 'World Health Organization',
    published: '2013', language: 'en', whoHandle: '10665/81170',
    sourceUrl: 'https://www.who.int/publications/i/item/978-92-4-154837-3',
  },
  {
    id: 'health-who-antenatal-care-positive-pregnancy',
    title: 'WHO Recommendations on Antenatal Care',
    description: 'Evidence-based routine antenatal care recommendations for a positive pregnancy experience.',
    category: 'health', collection: 'Maternal care', publisher: 'World Health Organization',
    published: '2016', language: 'en', whoHandle: '10665/250796',
    sourceUrl: 'https://iris.who.int/handle/10665/250796',
  },
  {
    id: 'health-who-pregnancy-childbirth-postpartum-newborn-care',
    title: 'Pregnancy, Childbirth, Postpartum and Newborn Care',
    description: 'A WHO guide for essential practice across pregnancy, birth, postpartum and newborn care.',
    category: 'health', collection: 'Maternal care', publisher: 'World Health Organization',
    published: '2015', language: 'en', whoHandle: '10665/249580',
    sourceUrl: 'https://iris.who.int/handle/10665/249580',
  },
  {
    id: 'health-who-managing-pregnancy-childbirth-complications',
    title: 'Managing Complications in Pregnancy and Childbirth',
    description: 'WHO guidance for midwives and doctors managing urgent maternal and childbirth complications.',
    category: 'health', collection: 'Maternal care', publisher: 'World Health Organization',
    published: '2017', language: 'en', whoHandle: '10665/255760',
    sourceUrl: 'https://iris.who.int/handle/10665/255760',
  },
  {
    id: 'health-who-imci-chart-booklet',
    title: 'Integrated Management of Childhood Illness — Chart Booklet',
    description: 'IMCI assessment, classification and treatment charts for sick children in first-level facilities.',
    category: 'health', collection: 'WHO clinical care', publisher: 'World Health Organization',
    published: '2014', language: 'en', whoHandle: '10665/104772',
    sourceUrl: 'https://iris.who.int/handle/10665/104772',
  },
  {
    id: 'health-who-imai-district-clinician',
    title: 'IMAI District Clinician Manual',
    description: 'Hospital care for adolescents and adults with limited medicines, tests and equipment.',
    category: 'health', collection: 'WHO clinical care', publisher: 'World Health Organization',
    published: '2011', language: 'en', whoHandle: '10665/77751',
    sourceUrl: 'https://www.who.int/publications/i/item/9789241548281',
  },
  {
    id: 'health-msf-clinical-guidelines',
    title: 'MSF Clinical Guidelines — Diagnosis and Treatment',
    description: 'Diagnosis and treatment guidance for curative programmes in hospitals and dispensaries.',
    category: 'health', collection: 'MSF medical guidelines', publisher: 'Médecins Sans Frontières',
    published: '2026', language: 'en', basic: true,
    url: 'https://medicalguidelines.msf.org/sites/default/files/2026-05/guideline-170-en.pdf',
    sourceUrl: 'https://medicalguidelines.msf.org/en',
  },
  {
    id: 'health-msf-essential-drugs',
    title: 'MSF Essential Drugs',
    description: 'Practical medicine selection, dosing and administration guidance for low-resource care.',
    category: 'health', collection: 'MSF medical guidelines', publisher: 'Médecins Sans Frontières',
    published: '2026', language: 'en', basic: true,
    url: 'https://medicalguidelines.msf.org/sites/default/files/pdf/guideline-339-en.pdf',
    sourceUrl: 'https://medicalguidelines.msf.org/en/viewport/EssDr/english/essential-drugs-16682376.html',
  },
  {
    id: 'health-msf-obstetric-newborn-care',
    title: 'MSF Essential Obstetric and Newborn Care',
    description: 'Practical guidance for routine and emergency obstetric and newborn care.',
    category: 'health', collection: 'MSF medical guidelines', publisher: 'Médecins Sans Frontières',
    language: 'en', url: 'https://medicalguidelines.msf.org/sites/default/files/pdf/guideline-449-en.pdf',
    sourceUrl: 'https://medicalguidelines.msf.org/en',
  },
  {
    id: 'health-msf-cholera-epidemic',
    title: 'MSF Management of a Cholera Epidemic',
    description: 'Field guidance for cholera preparation, treatment centres, surveillance and outbreak control.',
    category: 'health', collection: 'MSF medical guidelines', publisher: 'Médecins Sans Frontières',
    language: 'en', url: 'https://medicalguidelines.msf.org/sites/default/files/pdf/guideline-800-en.pdf',
    sourceUrl: 'https://medicalguidelines.msf.org/en',
  },
  {
    id: 'health-msf-measles-epidemic',
    title: 'MSF Management of a Measles Epidemic',
    description: 'Vaccination, surveillance and clinical response guidance for measles outbreaks.',
    category: 'health', collection: 'MSF medical guidelines', publisher: 'Médecins Sans Frontières',
    published: '2025', language: 'en',
    url: 'https://medicalguidelines.msf.org/sites/default/files/2026-05/Measles_2025_EN.pdf',
    sourceUrl: 'https://medicalguidelines.msf.org/en',
  },
  {
    id: 'health-msf-tuberculosis',
    title: 'MSF Tuberculosis Guidelines',
    description: 'Clinical and programme guidance for tuberculosis diagnosis, treatment and follow-up.',
    category: 'health', collection: 'MSF medical guidelines', publisher: 'Médecins Sans Frontières',
    published: '2025', language: 'en',
    url: 'https://medicalguidelines.msf.org/sites/default/files/2025-06/Tuberculosis%202025_EN.pdf',
    sourceUrl: 'https://medicalguidelines.msf.org/en',
  },
  {
    id: 'field-msf-public-health-engineering',
    title: 'MSF Public Health Engineering',
    description: 'Water, sanitation, shelter and vector-control engineering for humanitarian field operations.',
    category: 'field', collection: 'Field sanitation', publisher: 'Médecins Sans Frontières',
    published: '2010', language: 'en',
    url: 'https://medicalguidelines.msf.org/sites/default/files/2022-06/Public_health_engineering_2010.pdf',
    sourceUrl: 'https://medicalguidelines.msf.org/en',
  },
  {
    id: 'health-icrc-first-aid-armed-conflict',
    title: 'ICRC First Aid in Armed Conflicts',
    description: 'Life-saving and stabilizing first aid for armed conflict and other situations of violence.',
    category: 'health', collection: 'Conflict medicine', publisher: 'International Committee of the Red Cross',
    published: '2006', language: 'en',
    url: 'https://www.icrc.org/sites/default/files/external/doc/en/assets/files/other/icrc-002-0870.pdf',
    sourceUrl: 'https://www.icrc.org/en/publication/0870-first-aid-armed-conflicts-and-other-situations-violence',
  },
  {
    id: 'health-icrc-war-surgery-volume-1',
    title: 'ICRC War Surgery — Volume 1',
    description: 'Surgical care for war injuries when staff, equipment and evacuation options are limited.',
    category: 'health', collection: 'Conflict medicine', publisher: 'International Committee of the Red Cross',
    published: '2009', language: 'en',
    url: 'https://www.icrc.org/sites/default/files/external/doc/en/assets/files/other/icrc-002-0973.pdf',
    sourceUrl: 'https://www.icrc.org/en/publication/0973-war-surgery-working-limited-resources-armed-conflict-and-other-situations-violence',
  },
  {
    id: 'field-army-special-forces-medical-handbook',
    title: 'Special Forces Medical Handbook — ST 31-91B',
    description: 'Field assessment and treatment reference for austere and isolated medical operations.',
    category: 'field', collection: 'Field manuals', publisher: 'U.S. Department of the Army',
    language: 'en', archiveIdentifier: 'ST_31-91B_Special_Forces_Medical_Handbook',
    sourceUrl: 'https://archive.org/details/ST_31-91B_Special_Forces_Medical_Handbook',
  },
  {
    id: 'field-army-survival-fm-21-76',
    title: 'Survival — FM 21-76',
    description: 'Shelter, water, food, fire, navigation, signaling and survival in hostile environments.',
    category: 'field', collection: 'Survival manuals', publisher: 'U.S. Department of the Army',
    language: 'en', archiveIdentifier: 'Fm21-76SurvivalManual',
    sourceUrl: 'https://archive.org/details/Fm21-76SurvivalManual',
  },
  {
    id: 'field-army-survival-fm-3-05-70',
    title: 'Survival — FM 3-05.70',
    description: 'Updated U.S. Army survival guidance for shelter, water, food, navigation and recovery.',
    category: 'field', collection: 'Survival manuals', publisher: 'U.S. Department of the Army',
    published: '2002', language: 'en', basic: true, totalBytes: 21_019_230,
    storageKey: 'field-army-survival-fm-3-05-70-wikimedia-v1',
    url: 'https://upload.wikimedia.org/wikipedia/commons/7/70/FM_3-05.70_%28FM_21-76%29_Survival_-_May_2002.pdf',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:FM_3-05.70_(FM_21-76)_Survival_-_May_2002.pdf',
  },
  {
    id: 'field-army-radio-fm-24-18',
    title: 'Tactical Radio Communications — FM 24-18',
    description: 'Planning and operating single-channel tactical radio communications.',
    category: 'field', collection: 'Communications manuals', publisher: 'U.S. Department of the Army',
    published: '1987', language: 'en', archiveIdentifier: 'FM2418TacticalSingleChannelRadioCommunicationsTechniques',
    sourceUrl: 'https://archive.org/details/FM2418TacticalSingleChannelRadioCommunicationsTechniques',
  },
  {
    id: 'health-army-emergency-war-surgery-5e',
    title: 'Emergency War Surgery — 5th Edition',
    description: 'Definitive U.S. military guidance for surgical care of combat casualties.',
    category: 'health', collection: 'Conflict medicine', publisher: 'U.S. Army / Borden Institute',
    published: '2018', language: 'en', archiveIdentifier: 'emergency-war-surgery-5th-edition',
    sourceUrl: 'https://jts.health.mil/index.cfm/education/resources',
  },
]);

export function selectEmergencyBoxBasicResources(
  resources = [...EMERGENCY_BOX_COMMUNICATION_RESOURCES, ...EMERGENCY_BOX_HEALTH_RESOURCES],
) {
  return (Array.isArray(resources) ? resources : []).filter(resource => resource?.basic === true);
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Emergency Box storage transaction aborted.'));
  });
}

function safeResourceKey(value) {
  const key = String(value || '').replace(/[^a-z0-9._-]+/gi, '_').replace(/^\.+/, '').slice(0, 180);
  if (!key) throw new Error('Emergency Box resource key is invalid.');
  return `${key}.pdf`;
}

function parseContentRange(value) {
  const match = String(value || '').trim().match(/^bytes\s+([0-9]+)-([0-9]+)\/([0-9]+|\*)$/i);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === '*' ? null : Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
  if (total !== null && (!Number.isSafeInteger(total) || total <= end)) return null;
  return { start, end, total };
}

function normalizeIfRangeValidator(value) {
  const normalized = String(value || '').trim();
  if (/^"[^"\r\n]{0,252}"$/.test(normalized)) return normalized;
  if (normalized.length <= 128 && Number.isFinite(Date.parse(normalized))) return normalized;
  return '';
}

function responseIfRangeValidator(headers) {
  return normalizeIfRangeValidator(headers?.get?.('etag'))
    || normalizeIfRangeValidator(headers?.get?.('last-modified'));
}

function hasMismatchedIfRangeValidator(headers, validator) {
  const isEntityTag = validator.startsWith('"');
  const rawResponseValidator = String(headers?.get?.(isEntityTag ? 'etag' : 'last-modified') || '').trim();
  if (!rawResponseValidator) return false;
  const responseValidator = normalizeIfRangeValidator(rawResponseValidator);
  if (!responseValidator) return true;
  return isEntityTag
    ? responseValidator !== validator
    : Date.parse(responseValidator) !== Date.parse(validator);
}

function isCompleteContentRange(contentRange, start) {
  return !!contentRange
    && contentRange.start === start
    && contentRange.total !== null
    && contentRange.end + 1 === contentRange.total;
}

function normalizedRecord(resource, patch = {}) {
  return {
    ...resource,
    format: 'pdf',
    sourceUrl: resource.sourceUrl || resource.url || '',
    rights: resource.rights || 'See the publisher source for license and reuse terms.',
    ...patch,
  };
}

export function createEmergencyBoxStore(indexedDb = globalThis.indexedDB) {
  let databasePromise;
  const open = () => {
    if (!indexedDb) return Promise.reject(new Error('IndexedDB is unavailable.'));
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDb.open(EMERGENCY_BOX_DB_NAME, EMERGENCY_BOX_DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(RESOURCE_STORE)) {
          database.createObjectStore(RESOURCE_STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return databasePromise;
  };
  return {
    async list() {
      const database = await open();
      return await idbRequest(database.transaction(RESOURCE_STORE, 'readonly').objectStore(RESOURCE_STORE).getAll());
    },
    async get(id) {
      const database = await open();
      return await idbRequest(database.transaction(RESOURCE_STORE, 'readonly').objectStore(RESOURCE_STORE).get(id));
    },
    async put(record) {
      const database = await open();
      const transaction = database.transaction(RESOURCE_STORE, 'readwrite');
      transaction.objectStore(RESOURCE_STORE).put(record);
      await idbTransaction(transaction);
      return record;
    },
    async delete(id) {
      const database = await open();
      const transaction = database.transaction(RESOURCE_STORE, 'readwrite');
      transaction.objectStore(RESOURCE_STORE).delete(id);
      await idbTransaction(transaction);
    },
  };
}

export function createEmergencyBoxStorage(storageManager = globalThis.navigator?.storage) {
  async function directory(create = true) {
    if (typeof storageManager?.getDirectory !== 'function') {
      throw new Error('Origin Private File System storage is unavailable in this browser.');
    }
    const root = await storageManager.getDirectory();
    return await root.getDirectoryHandle(RESOURCE_DIRECTORY, { create });
  }
  async function handle(key, create = false) {
    return await (await directory(create)).getFileHandle(safeResourceKey(key), { create });
  }
  return {
    async open(key) {
      return await (await handle(key)).getFile();
    },
    async size(key) {
      try {
        return (await this.open(key)).size;
      } catch (error) {
        if (error?.name === 'NotFoundError') return 0;
        throw error;
      }
    },
    async createWriter(key) {
      const writable = await (await handle(key, true)).createWritable({ keepExistingData: true });
      let settled = false;
      return {
        async write(position, bytes) {
          if (settled) throw new Error('Emergency Box writer is already closed.');
          await writable.write({ type: 'write', position, data: bytes });
        },
        async truncate(size) {
          if (settled) throw new Error('Emergency Box writer is already closed.');
          await writable.truncate(size);
        },
        async close() {
          if (settled) return;
          await writable.close();
          settled = true;
        },
        async abort(reason) {
          if (settled) return;
          await writable.abort(reason);
          settled = true;
        },
      };
    },
    async delete(key) {
      try {
        await (await directory(false)).removeEntry(safeResourceKey(key));
      } catch (error) {
        if (error?.name !== 'NotFoundError') throw error;
      }
    },
  };
}

export async function loadOpenStaxCatalog(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('Network access is unavailable.');
  const response = await fetchImpl(`${OPENSTAX_API}/pages/?type=books.Book&fields=title,slug&limit=200`);
  if (!response.ok) throw new Error(`OpenStax catalog returned HTTP ${response.status}.`);
  const payload = await response.json();
  return (Array.isArray(payload?.items) ? payload.items : [])
    .filter(item => item?.id && item?.title && item?.meta?.detail_url)
    .map(item => normalizedRecord({
      id: `openstax-${item.id}`,
      title: item.title,
      description: 'Open textbook. Download the compact PDF for offline reading.',
      category: 'education',
      collection: 'OpenStax',
      publisher: 'OpenStax, Rice University',
      published: String(item.meta.first_published_at || '').slice(0, 4),
      language: String(item.meta.locale || 'en').split('-')[0],
      detailUrl: item.meta.detail_url,
      sourceUrl: item.meta.html_url || 'https://openstax.org/subjects',
    }));
}

export async function resolveEmergencyResource(resource, fetchImpl = globalThis.fetch) {
  if (resource?.url) return normalizedRecord(resource);
  if (resource?.whoHandle) {
    const handleResponse = await fetchImpl(`https://iris.who.int/handle/${encodeURI(resource.whoHandle)}`);
    if (!handleResponse.ok) throw new Error(`WHO IRIS returned HTTP ${handleResponse.status}.`);
    const itemId = String(handleResponse.url || '').match(/\/items\/([0-9a-f-]{36})(?:[/?#]|$)/i)?.[1];
    if (!itemId) throw new Error('WHO IRIS did not resolve this publication to a downloadable item.');
    const apiResponse = await fetchImpl(`https://iris.who.int/server/api/core/items/${itemId}?embed=bundles/bitstreams`, {
      headers: { Accept: 'application/json' },
    });
    if (!apiResponse.ok) throw new Error(`WHO IRIS item metadata returned HTTP ${apiResponse.status}.`);
    const payload = await apiResponse.json();
    const bundles = payload?._embedded?.bundles?._embedded?.bundles || [];
    const original = bundles.find(bundle => bundle?.name === 'ORIGINAL');
    const bitstreams = original?._embedded?.bitstreams?._embedded?.bitstreams || [];
    const languagePenalty = name => /(?:^|[_-])(rus|fre|fra|spa|ara|chi|vie|tuk|hin|mar|kor)(?:[_.-]|$)/i.test(name) ? 10 : 0;
    const score = bitstream => {
      const name = String(bitstream?.name || '');
      if (!/\.pdf$/i.test(name)) return 100;
      if (/(?:^|[_-])eng(?:[_.-]|$)|english/i.test(name)) return 0;
      if (/^\d{10,}\.pdf$/i.test(name)) return 1;
      return 2 + languagePenalty(name);
    };
    const bitstream = [...bitstreams].sort((left, right) => score(left) - score(right))[0];
    const url = bitstream?._links?.content?.href;
    if (!url || score(bitstream) >= 100) throw new Error('WHO IRIS did not provide a PDF bitstream for this publication.');
    return normalizedRecord(resource, { url });
  }
  if (resource?.archiveIdentifier) {
    const response = await fetchImpl(`https://archive.org/metadata/${encodeURIComponent(resource.archiveIdentifier)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Internet Archive metadata returned HTTP ${response.status}.`);
    const payload = await response.json();
    const candidates = (Array.isArray(payload?.files) ? payload.files : [])
      .filter(file => /\.pdf$/i.test(String(file?.name || '')) && !/(?:_text|_encrypted)\.pdf$/i.test(String(file.name)))
      .sort((left, right) => (Number(right.size) || 0) - (Number(left.size) || 0));
    if (!candidates.length) throw new Error('Internet Archive did not provide a readable PDF for this manual.');
    const filename = String(candidates[0].name).split('/').map(encodeURIComponent).join('/');
    return normalizedRecord(resource, {
      url: `https://archive.org/download/${encodeURIComponent(resource.archiveIdentifier)}/${filename}`,
    });
  }
  if (!resource?.detailUrl || !String(resource.id || '').startsWith('openstax-')) {
    throw new Error('This resource does not provide a downloadable PDF.');
  }
  const response = await fetchImpl(resource.detailUrl);
  if (!response.ok) throw new Error(`OpenStax book details returned HTTP ${response.status}.`);
  const detail = await response.json();
  const url = detail?.low_resolution_pdf_url || detail?.high_resolution_pdf_url;
  if (!url) throw new Error('OpenStax did not provide a PDF for this book.');
  return normalizedRecord(resource, { url });
}

export async function withEmergencyResourceLock(resourceId, task, options = {}) {
  const lockManager = options.lockManager ?? globalThis.navigator?.locks;
  if (typeof lockManager?.request !== 'function') return await task();
  const lockName = `webbrain-emergency-pdf:${safeResourceKey(resourceId)}`;
  const lockOptions = { mode: 'exclusive' };
  if (options.signal) lockOptions.signal = options.signal;
  return await lockManager.request(lockName, lockOptions, task);
}

async function downloadResolvedEmergencyResource(resolved, options) {
  const { store, storage, fetchImpl, signal, onProgress } = options;
  const storageKey = resolved.storageKey || resolved.id;
  const existing = await store.get(resolved.id);
  if (existing?.status === 'ready' && (existing.storageKey || existing.id) === storageKey) {
    onProgress(existing);
    return existing;
  }
  const replacedStorageKey = existing?.storageKey && existing.storageKey !== storageKey
    ? existing.storageKey
    : '';
  let offset = await storage.size(storageKey);
  const validatorMatchesStoredBytes = existing?.storageKey === storageKey
    && existing?.url === resolved.url;
  let committedIfRangeValidator = validatorMatchesStoredBytes
    ? normalizeIfRangeValidator(existing?.ifRangeValidator)
    : '';
  if (offset > 0 && !committedIfRangeValidator) offset = 0;
  let pendingIfRangeValidator = committedIfRangeValidator;
  let writer;
  let response;
  let reader;
  let rollbackWriter = false;
  let pendingRepresentationStarted = false;
  let lastPersistedAt = 0;
  const persist = async patch => {
    const record = normalizedRecord(resolved, {
      ...existing,
      url: resolved.url,
      storageKey,
      ifRangeValidator: committedIfRangeValidator,
      ...patch,
      updatedAt: Date.now(),
    });
    await store.put(record);
    onProgress(record);
    return record;
  };

  try {
    await persist({ status: 'downloading', error: '', bytesReceived: offset });
    const headers = offset > 0
      ? { Range: `bytes=${offset}-`, 'If-Range': committedIfRangeValidator }
      : undefined;
    const fetchResponse = async (requestHeaders, allowRangeNotSatisfiable = false) => {
      const nextResponse = await fetchImpl(resolved.url, { headers: requestHeaders, signal });
      if (!nextResponse.ok && !(allowRangeNotSatisfiable && nextResponse.status === 416)) {
        try { await nextResponse.body?.cancel?.(); } catch { /* preserve the HTTP error */ }
        throw new Error(`PDF download returned HTTP ${nextResponse.status}.`);
      }
      return nextResponse;
    };
    response = await fetchResponse(headers, offset > 0);
    let contentRange = parseContentRange(response.headers?.get?.('content-range'));
    if (offset > 0 && response.status !== 200 && (
      response.status !== 206
      || !isCompleteContentRange(contentRange, offset)
      || hasMismatchedIfRangeValidator(response.headers, committedIfRangeValidator)
    )) {
      // An unusable range cannot be appended safely. Retry once without Range
      // before opening the writer so the durable partial remains untouched.
      try { await response.body?.cancel?.(); } catch { /* retry the full response */ }
      response = await fetchResponse(undefined);
      offset = 0;
      contentRange = parseContentRange(response.headers?.get?.('content-range'));
    } else if (offset > 0 && response.status === 200) {
      offset = 0;
    }
    if (response.status !== 200 && response.status !== 206) {
      try { await response.body?.cancel?.(); } catch { /* preserve the status error */ }
      throw new Error(`PDF download returned unexpected HTTP ${response.status}.`);
    }
    if (response.status === 206 && !isCompleteContentRange(contentRange, offset)) {
      try { await response.body?.cancel?.(); } catch { /* preserve the range error */ }
      throw new Error('PDF download returned an incomplete or mismatched Content-Range.');
    }
    if (offset === 0) pendingIfRangeValidator = responseIfRangeValidator(response.headers);
    const expectedTotalBytes = response.status === 206 ? contentRange?.total || 0 : 0;
    const contentLength = Number(response.headers?.get?.('content-length')) || 0;
    const totalBytes = expectedTotalBytes || (contentLength ? offset + contentLength : 0);
    writer = await storage.createWriter(storageKey);
    if (offset === 0) {
      await writer.truncate(0);
      pendingRepresentationStarted = true;
    }

    reader = response.body?.getReader?.();
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal?.aborted) throw new DOMException('Download paused.', 'AbortError');
        if (expectedTotalBytes && offset + value.byteLength > expectedTotalBytes) {
          rollbackWriter = true;
          try { await reader.cancel(); } catch { /* preserve the range error */ }
          throw new Error('PDF download exceeded the declared Content-Range.');
        }
        await writer.write(offset, value);
        offset += value.byteLength;
        const now = Date.now();
        if (now - lastPersistedAt >= 500) {
          lastPersistedAt = now;
          await persist({ status: 'downloading', bytesReceived: offset, totalBytes });
        } else {
          onProgress(normalizedRecord(resolved, { ...existing, storageKey, status: 'downloading', bytesReceived: offset, totalBytes }));
        }
      }
    } else {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (expectedTotalBytes && offset + bytes.byteLength > expectedTotalBytes) {
        rollbackWriter = true;
        throw new Error('PDF download exceeded the declared Content-Range.');
      }
      await writer.write(offset, bytes);
      offset += bytes.byteLength;
    }
    if (expectedTotalBytes && offset !== expectedTotalBytes) {
      rollbackWriter = true;
      throw new Error('PDF download size did not match the declared Content-Range.');
    }
    await writer.close();
    writer = null;
    committedIfRangeValidator = pendingIfRangeValidator;

    const file = await storage.open(storageKey);
    if (expectedTotalBytes && file.size !== expectedTotalBytes) {
      committedIfRangeValidator = '';
      await storage.delete(storageKey).catch(() => {});
      throw new Error('PDF download size did not match the declared Content-Range.');
    }
    if ((await file.slice(0, 5).text()) !== '%PDF-') {
      await storage.delete(storageKey);
      committedIfRangeValidator = '';
      throw new Error('The downloaded file is not a valid PDF.');
    }
    if (replacedStorageKey) await storage.delete(replacedStorageKey).catch(() => {});
    return await persist({
      status: 'ready',
      bytesReceived: file.size,
      totalBytes: file.size,
      downloadedAt: Date.now(),
      error: '',
    });
  } catch (error) {
    try {
      if (reader) await reader.cancel(error);
      else await response?.body?.cancel?.(error);
    } catch { /* preserve the download or storage error */ }
    if (writer) {
      if (rollbackWriter) {
        try { await writer.abort?.(error); } catch { /* never commit invalid range bytes */ }
      } else {
        try {
          // Commit valid chunks so a pause or transient network failure can
          // resume; integrity failures instead abort the atomic OPFS writer.
          await writer.close();
          if (pendingRepresentationStarted) committedIfRangeValidator = pendingIfRangeValidator;
        } catch {
          try { await writer.abort?.(error); } catch { /* preserve the original failure */ }
        }
      }
      writer = null;
    }
    const bytesReceived = await storage.size(storageKey).catch(() => 0);
    const paused = error?.name === 'AbortError' || signal?.aborted;
    await persist({
      status: paused ? 'paused' : 'error',
      bytesReceived,
      error: paused ? '' : String(error?.message || error),
    });
    if (!paused) throw error;
    return await store.get(resolved.id);
  }
}

export async function downloadEmergencyResource(resource, options = {}) {
  const store = options.store || createEmergencyBoxStore();
  const storage = options.storage || createEmergencyBoxStorage();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const signal = options.signal;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const resolved = await resolveEmergencyResource(resource, fetchImpl);
  try {
    return await withEmergencyResourceLock(resolved.id, () => downloadResolvedEmergencyResource(resolved, {
      store,
      storage,
      fetchImpl,
      signal,
      onProgress,
    }), { lockManager: options.lockManager, signal });
  } catch (error) {
    if (error?.name !== 'AbortError' && !signal?.aborted) throw error;
    return await store.get(resolved.id) || normalizedRecord(resolved, {
      storageKey: resolved.storageKey || resolved.id,
      status: 'paused',
      bytesReceived: 0,
      error: '',
      updatedAt: Date.now(),
    });
  }
}

export async function deleteEmergencyResource(id, options = {}) {
  const store = options.store || createEmergencyBoxStore();
  const storage = options.storage || createEmergencyBoxStorage();
  const record = await store.get(id);
  if (!record) return false;
  await storage.delete(record.storageKey || record.id);
  await store.delete(id);
  return true;
}
