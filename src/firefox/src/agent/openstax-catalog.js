// Bundled OpenStax catalog snapshot. The Emergency Box can refresh it from OpenStax on demand.
export const OPENSTAX_CATALOG_SNAPSHOT_DATE = '2026-08-15';

const BOOKS = Object.freeze([
  [
    873,
    "Additive Manufacturing Essentials",
    "2025",
    "en",
    "additive-manufacturing-essentials"
  ],
  [
    867,
    "Algebra 1",
    "2025",
    "en",
    "algebra-1"
  ],
  [
    38,
    "Algebra and Trigonometry",
    "2016",
    "en",
    "algebra-and-trigonometry"
  ],
  [
    553,
    "Algebra and Trigonometry 2e",
    "2021",
    "en",
    "algebra-and-trigonometry-2e"
  ],
  [
    84,
    "American Government",
    "2016",
    "en",
    "american-government"
  ],
  [
    300,
    "American Government 2e",
    "2019",
    "en",
    "american-government-2e"
  ],
  [
    518,
    "American Government 3e",
    "2021",
    "en",
    "american-government-3e"
  ],
  [
    931,
    "American Government 4e",
    "2025",
    "en",
    "american-government-4e"
  ],
  [
    35,
    "Anatomy and Physiology",
    "2016",
    "en",
    "anatomy-and-physiology"
  ],
  [
    585,
    "Anatomy and Physiology 2e",
    "2022",
    "en",
    "anatomy-and-physiology-2e"
  ],
  [
    47,
    "The AP Physics Collection",
    "2016",
    "en",
    "college-physics-ap-courses"
  ],
  [
    81,
    "Astronomy",
    "2016",
    "en",
    "astronomy"
  ],
  [
    576,
    "Astronomy 2e",
    "2022",
    "en",
    "astronomy-2e"
  ],
  [
    121,
    "Biology",
    "2016",
    "en",
    "biology"
  ],
  [
    207,
    "Biology 2e",
    "2018",
    "en",
    "biology-2e"
  ],
  [
    162,
    "Biology for AP® Courses",
    "2017",
    "en",
    "biology-ap-courses"
  ],
  [
    261,
    "Business Ethics",
    "2018",
    "en",
    "business-ethics"
  ],
  [
    340,
    "Business Law I Essentials",
    "2019",
    "en",
    "business-law-i-essentials"
  ],
  [
    975,
    "Business Law I Essentials 2e",
    "2026",
    "en",
    "business-law-i-essentials-2e"
  ],
  [
    74,
    "Calculus Volume 1",
    "2016",
    "en",
    "calculus-volume-1"
  ],
  [
    75,
    "Calculus Volume 2",
    "2016",
    "en",
    "calculus-volume-2"
  ],
  [
    76,
    "Calculus Volume 3",
    "2016",
    "en",
    "calculus-volume-3"
  ],
  [
    43,
    "Chemistry",
    "2016",
    "en",
    "chemistry"
  ],
  [
    298,
    "Chemistry 2e",
    "2019",
    "en",
    "chemistry-2e"
  ],
  [
    299,
    "Chemistry: Atoms First 2e",
    "2019",
    "en",
    "chemistry-atoms-first-2e"
  ],
  [
    93,
    "Chemistry: Atoms First",
    "2016",
    "en",
    "chemistry-atoms-first"
  ],
  [
    814,
    "Clinical Nursing Skills",
    "2024",
    "en",
    "clinical-nursing-skills"
  ],
  [
    39,
    "College Algebra",
    "2016",
    "en",
    "college-algebra"
  ],
  [
    550,
    "College Algebra 2e",
    "2021",
    "en",
    "college-algebra-2e"
  ],
  [
    443,
    "College Algebra with Corequisite Support",
    "2020",
    "en",
    "college-algebra-corequisite-support"
  ],
  [
    554,
    "College Algebra 2e with Corequisite Support",
    "2021",
    "en",
    "college-algebra-corequisite-support-2e"
  ],
  [
    31,
    "College Physics",
    "2016",
    "en",
    "college-physics"
  ],
  [
    603,
    "College Physics 2e",
    "2022",
    "en",
    "college-physics-2e"
  ],
  [
    604,
    "College Physics For AP® Courses 2e",
    "2022",
    "en",
    "college-physics-ap-courses-2e"
  ],
  [
    506,
    "College Physics with Courseware",
    "2021",
    "en",
    "college-physics-courseware"
  ],
  [
    382,
    "College Success",
    "2020",
    "en",
    "college-success"
  ],
  [
    694,
    "College Success Concise",
    "2023",
    "en",
    "college-success-concise"
  ],
  [
    34,
    "Concepts of Biology",
    "2016",
    "en",
    "concepts-biology"
  ],
  [
    689,
    "Contemporary Mathematics",
    "2023",
    "en",
    "contemporary-mathematics"
  ],
  [
    130,
    "Elementary Algebra",
    "2017",
    "en",
    "elementary-algebra"
  ],
  [
    414,
    "Elementary Algebra 2e",
    "2020",
    "en",
    "elementary-algebra-2e"
  ],
  [
    314,
    "Entrepreneurship",
    "2019",
    "en",
    "entrepreneurship"
  ],
  [
    190,
    "Fizyka dla szkół wyższych. Tom 1",
    "2017",
    "en",
    "fizyka-dla-szkół-wyższych-tom-1"
  ],
  [
    219,
    "Fizyka dla szkół wyższych. Tom 2",
    "2018",
    "en",
    "fizyka-dla-szkół-wyższych-tom-2"
  ],
  [
    245,
    "Fizyka dla szkół wyższych. Tom 3",
    "2018",
    "en",
    "fizyka-dla-szkół-wyższych-tom-3"
  ],
  [
    870,
    "Foundations of Information Systems",
    "2025",
    "en",
    "foundations-information-systems"
  ],
  [
    815,
    "Fundamentals of Nursing",
    "2024",
    "en",
    "fundamentals-nursing"
  ],
  [
    131,
    "Intermediate Algebra",
    "2017",
    "en",
    "intermediate-algebra"
  ],
  [
    418,
    "Intermediate Algebra 2e",
    "2020",
    "en",
    "intermediate-algebra-2e"
  ],
  [
    573,
    "Introduction to Anthropology",
    "2022",
    "en",
    "introduction-anthropology"
  ],
  [
    844,
    "Introduction to Behavioral Neuroscience",
    "2024",
    "en",
    "introduction-behavioral-neuroscience"
  ],
  [
    259,
    "Introduction to Business",
    "2018",
    "en",
    "introduction-business"
  ],
  [
    960,
    "Introduction to Business 2e",
    "2026",
    "en",
    "introduction-business-2e"
  ],
  [
    847,
    "Introduction to Computer Science",
    "2024",
    "en",
    "introduction-computer-science"
  ],
  [
    489,
    "Introduction to Intellectual Property",
    "2021",
    "en",
    "introduction-intellectual-property"
  ],
  [
    601,
    "Introduction to Philosophy",
    "2022",
    "en",
    "introduction-philosophy"
  ],
  [
    598,
    "Introduction to Political Science",
    "2022",
    "en",
    "introduction-political-science"
  ],
  [
    775,
    "Introduction to Python Programming",
    "2024",
    "en",
    "introduction-python-programming"
  ],
  [
    466,
    "Introduction to Sociology",
    "2020",
    "en",
    "introduction-sociology"
  ],
  [
    32,
    "Introduction to Sociology 2e",
    "2016",
    "en",
    "introduction-sociology-2e"
  ],
  [
    515,
    "Introduction to Sociology 3e",
    "2021",
    "en",
    "introduction-sociology-3e"
  ],
  [
    189,
    "Introductory Business Statistics",
    "2017",
    "en",
    "introductory-business-statistics"
  ],
  [
    751,
    "Introductory Business Statistics 2e",
    "2023",
    "en",
    "introductory-business-statistics-2e"
  ],
  [
    36,
    "Introductory Statistics",
    "2016",
    "en",
    "introductory-statistics"
  ],
  [
    750,
    "Introductory Statistics 2e",
    "2023",
    "en",
    "introductory-statistics-2e"
  ],
  [
    391,
    "Life, Liberty, and the Pursuit of Happiness",
    "2020",
    "en",
    "life-liberty-and-pursuit-happiness"
  ],
  [
    834,
    "Lifespan Development",
    "2024",
    "en",
    "lifespan-development"
  ],
  [
    843,
    "Marketing Podstawy",
    "2024",
    "en",
    "marketing-podstawy"
  ],
  [
    813,
    "Maternal-Newborn Nursing",
    "2024",
    "en",
    "maternal-newborn-nursing"
  ],
  [
    820,
    "Medical-Surgical Nursing",
    "2024",
    "en",
    "medical-surgical-nursing"
  ],
  [
    83,
    "Microbiology",
    "2016",
    "en",
    "microbiology"
  ],
  [
    743,
    "Makroekonomia – Podstawy",
    "2023",
    "en",
    "makroekonomia-podstawy"
  ],
  [
    610,
    "Mikroekonomia – Podstawy",
    "2022",
    "en",
    "mikroekonomia-podstawy"
  ],
  [
    771,
    "Nutrition for Nurses",
    "2024",
    "en",
    "nutrition"
  ],
  [
    707,
    "Organic Chemistry: A Tenth Edition",
    "2023",
    "en",
    "organic-chemistry"
  ],
  [
    315,
    "Organizational Behavior",
    "2019",
    "en",
    "organizational-behavior"
  ],
  [
    770,
    "Pharmacology for Nurses",
    "2024",
    "en",
    "pharmacology"
  ],
  [
    415,
    "Physics",
    "2020",
    "en",
    "physics"
  ],
  [
    772,
    "Population Health for Nurses",
    "2024",
    "en",
    "population-health"
  ],
  [
    46,
    "Prealgebra",
    "2016",
    "en",
    "prealgebra"
  ],
  [
    392,
    "Prealgebra 2e",
    "2020",
    "en",
    "prealgebra-2e"
  ],
  [
    37,
    "Precalculus",
    "2016",
    "en",
    "precalculus"
  ],
  [
    551,
    "Precalculus 2e",
    "2021",
    "en",
    "precalculus-2e"
  ],
  [
    720,
    "Preparing for College Success",
    "2023",
    "en",
    "preparing-for-college-success"
  ],
  [
    303,
    "Principles of Accounting, Volume 1: Financial Accounting",
    "2019",
    "en",
    "principles-financial-accounting"
  ],
  [
    292,
    "Principles of Accounting, Volume 2: Managerial Accounting",
    "2019",
    "en",
    "principles-managerial-accounting"
  ],
  [
    865,
    "Principles of Data Science",
    "2025",
    "en",
    "principles-data-science"
  ],
  [
    40,
    "Principles of Economics",
    "2016",
    "en",
    "principles-economics"
  ],
  [
    177,
    "Principles of Economics 2e",
    "2017",
    "en",
    "principles-economics-2e"
  ],
  [
    620,
    "Principles of Economics 3e",
    "2022",
    "en",
    "principles-economics-3e"
  ],
  [
    583,
    "Principles of Finance",
    "2022",
    "en",
    "principles-finance"
  ],
  [
    976,
    "Principles of Finance 2e",
    "2026",
    "en",
    "principles-finance-2e"
  ],
  [
    41,
    "Principles of Macroeconomics",
    "2016",
    "en",
    "principles-macroeconomics"
  ],
  [
    178,
    "Principles of Macroeconomics 2e",
    "2017",
    "en",
    "principles-macroeconomics-2e"
  ],
  [
    622,
    "Principles of Macroeconomics 3e",
    "2022",
    "en",
    "principles-macroeconomics-3e"
  ],
  [
    48,
    "Principles of Macroeconomics for AP® Courses",
    "2016",
    "en",
    "principles-macroeconomics-ap-courses"
  ],
  [
    186,
    "Principles of Macroeconomics for AP® Courses 2e",
    "2017",
    "en",
    "principles-macroeconomics-ap-courses-2e"
  ],
  [
    304,
    "Principles of Management",
    "2019",
    "en",
    "principles-management"
  ],
  [
    629,
    "Principles of Marketing",
    "2023",
    "en",
    "principles-marketing"
  ],
  [
    42,
    "Principles of Microeconomics",
    "2016",
    "en",
    "principles-microeconomics"
  ],
  [
    155,
    "Principles of Microeconomics 2e",
    "2017",
    "en",
    "principles-microeconomics-2e"
  ],
  [
    621,
    "Principles of Microeconomics 3e",
    "2022",
    "en",
    "principles-microeconomics-3e"
  ],
  [
    49,
    "Principles of Microeconomics for AP® Courses",
    "2016",
    "en",
    "principles-microeconomics-ap-courses"
  ],
  [
    188,
    "Principles of Microeconomics for AP® Courses 2e",
    "2017",
    "en",
    "principles-microeconomics-ap-courses-2e"
  ],
  [
    470,
    "Psychologia",
    "2020",
    "en",
    "psychologia-polska"
  ],
  [
    810,
    "Psychiatric-Mental Health Nursing",
    "2024",
    "en",
    "psychiatric-mental-health"
  ],
  [
    45,
    "Psychology",
    "2016",
    "en",
    "psychology"
  ],
  [
    417,
    "Psychology 2e",
    "2020",
    "en",
    "psychology-2e"
  ],
  [
    413,
    "Statistics",
    "2020",
    "en",
    "statistics"
  ],
  [
    44,
    "U.S. History",
    "2016",
    "en",
    "us-history"
  ],
  [
    82,
    "University Physics Volume 1",
    "2016",
    "en",
    "university-physics-volume-1"
  ],
  [
    94,
    "University Physics Volume 2",
    "2016",
    "en",
    "university-physics-volume-2"
  ],
  [
    95,
    "University Physics Volume 3",
    "2016",
    "en",
    "university-physics-volume-3"
  ],
  [
    690,
    "World History, Volume 1: to 1500",
    "2023",
    "en",
    "world-history-volume-1"
  ],
  [
    745,
    "Workplace Software and Skills",
    "2023",
    "en",
    "workplace-software-skills"
  ],
  [
    623,
    "World History, Volume 2: from 1400",
    "2022",
    "en",
    "world-history-volume-2"
  ],
  [
    555,
    "Writing Guide with Handbook",
    "2021",
    "en",
    "writing-guide"
  ],
  [
    939,
    "Zywienie",
    "2025",
    "en",
    "zywienie"
  ],
  [
    578,
    "Cálculo volumen 1",
    "2022",
    "es",
    "cálculo-volumen-1"
  ],
  [
    579,
    "Cálculo volumen 2",
    "2022",
    "es",
    "cálculo-volumen-2"
  ],
  [
    580,
    "Cálculo volumen 3",
    "2022",
    "es",
    "cálculo-volumen-3"
  ],
  [
    534,
    "Física universitaria volumen 1",
    "2021",
    "es",
    "física-universitaria-volumen-1"
  ],
  [
    547,
    "Física universitaria volumen 2",
    "2021",
    "es",
    "física-universitaria-volumen-2"
  ],
  [
    548,
    "Física universitaria volumen 3",
    "2021",
    "es",
    "física-universitaria-volumen-3"
  ],
  [
    564,
    "Introducción a la estadística",
    "2022",
    "es",
    "introducción-estadística"
  ],
  [
    565,
    "Introducción a la estadística empresarial",
    "2022",
    "es",
    "introducción-estadística-empresarial"
  ],
  [
    597,
    "Precálculo 2ed",
    "2022",
    "es",
    "precálculo-2ed"
  ],
  [
    599,
    "Química 2ed",
    "2022",
    "es",
    "química-2ed"
  ],
  [
    600,
    "Química: Comenzando con los átomos 2ed",
    "2022",
    "es",
    "química-comenzando-átomos-2ed"
  ]
]);

export const PREFETCHED_OPENSTAX_CATALOG = Object.freeze(BOOKS.map(([id, title, published, language, slug]) => Object.freeze({
  id: `openstax-${id}`,
  title,
  description: 'Open textbook. Download the compact PDF for offline reading.',
  category: 'education',
  collection: 'OpenStax',
  publisher: 'OpenStax, Rice University',
  published,
  language,
  detailUrl: `https://openstax.org/apps/cms/api/v2/pages/${id}/`,
  sourceUrl: `https://openstax.org/details/books/${encodeURI(slug)}`,
  format: 'pdf',
  rights: 'See the publisher source for license and reuse terms.',
})));
