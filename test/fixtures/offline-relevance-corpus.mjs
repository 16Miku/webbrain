/**
 * Relevance fixture for offline retrieval.
 *
 * The passages are paraphrased field-guide content written for this fixture, not
 * copied from the shipped corpus, so the benchmark can live in the repo. What
 * matters is that they read like the real thing: procedural, dense with numbers,
 * and overlapping in vocabulary so a query has to discriminate rather than just
 * match the only document containing "water".
 */

export const RELEVANCE_CORPUS = [
  {
    id: 'burns', title: 'Burns and scalds', collection: 'Emergency health', language: 'eng',
    locator: 'Chapter 4',
    text: 'Cool the burned area under cool running water for at least twenty minutes. Do not use ice, butter, or toothpaste. After cooling, cover loosely with cling film or a clean non-fluffy cloth. Do not break blisters. Burns larger than the palm of the hand, burns on the face, hands, or genitals, and any burn that looks white or charred need medical care.',
  },
  {
    id: 'bleeding', title: 'Severe bleeding control', collection: 'Emergency health', language: 'eng',
    locator: 'Chapter 2',
    text: 'Apply firm direct pressure over the wound with a clean cloth or your gloved hand. If blood soaks through, add a second layer on top rather than removing the first. Raise the injured limb above the level of the heart if no fracture is suspected. Use a tourniquet only when direct pressure fails on a life threatening limb bleed, place it high and tight, and write down the time you applied it.',
  },
  {
    id: 'fracture', title: 'Fractures and splinting', collection: 'Emergency health', language: 'eng',
    locator: 'Chapter 7',
    text: 'Immobilise the broken limb in the position you found it. Do not try to straighten an angled bone. Pad the splint generously and extend it past the joint above and the joint below the injury. Check the fingers or toes beyond the splint for warmth, colour, and feeling every fifteen minutes, and loosen the ties if they become cold or blue.',
  },
  {
    id: 'choking-adult', title: 'Choking in adults', collection: 'Emergency health', language: 'eng',
    locator: 'Chapter 1',
    text: 'If the person cannot cough, speak, or breathe, give five sharp blows between the shoulder blades with the heel of your hand. If the obstruction remains, give five abdominal thrusts by pulling sharply inward and upward above the navel. Alternate five and five until the airway clears or the person becomes unresponsive.',
  },
  {
    id: 'choking-infant', title: 'Choking in infants under one year', collection: 'Emergency health', language: 'eng',
    locator: 'Chapter 1',
    text: 'Lay the baby face down along your forearm with the head lower than the chest and support the jaw. Give five back blows between the shoulder blades. Turn the baby face up and give five chest thrusts with two fingers on the breastbone. Never use abdominal thrusts on an infant.',
  },
  {
    id: 'cpr-adult', title: 'Chest compressions for adults', collection: 'Emergency health', language: 'eng',
    locator: 'Chapter 1',
    text: 'If an adult is unresponsive and not breathing normally, start chest compressions. Push hard in the centre of the chest to a depth of five to six centimetres at a rate of one hundred to one hundred twenty per minute. Allow the chest to recoil fully between compressions and swap rescuers every two minutes to limit fatigue.',
  },
  {
    id: 'hypothermia', title: 'Hypothermia and cold exposure', collection: 'Emergency health', language: 'eng',
    locator: 'Chapter 9',
    text: 'Move the person out of the wind and remove wet clothing. Wrap them in dry layers including the head, and insulate them from the ground, which steals more heat than the air. Give warm sweet drinks only if they are fully alert. Handle a severely cold person gently, because rough movement can trigger a dangerous heart rhythm.',
  },
  {
    id: 'heatstroke', title: 'Heat exhaustion and heatstroke', collection: 'Emergency health', language: 'eng',
    locator: 'Chapter 9',
    text: 'Move the person into shade and remove excess clothing. Cool them aggressively with water on the skin and air movement, or with cold packs at the neck, armpits, and groin. Confusion, no sweating, or a body temperature above forty degrees means heatstroke, which is a medical emergency and needs cooling started before transport.',
  },
  {
    id: 'water-treatment', title: 'Making water safe to drink', collection: 'Field manuals', language: 'eng',
    locator: 'Section 3',
    text: 'Bring water to a rolling boil for one full minute, or three minutes above two thousand metres. If you cannot boil, add unscented household bleach at two drops per litre of clear water, mix, and wait thirty minutes. A free chlorine residual of 0.2 to 0.5 milligrams per litre protects the water during storage. Let cloudy water settle or filter it through cloth first, because particles shield microbes from chlorine.',
  },
  {
    id: 'latrine', title: 'Siting latrines and sanitation', collection: 'Field manuals', language: 'eng',
    locator: 'Section 5',
    text: 'Dig latrines at least thirty metres from any well, spring, or stream, and downhill from it where the ground slopes. Keep the pit bottom at least two metres above the water table. Provide a handwashing point with soap or ash at the exit, because handwashing prevents more diarrhoea than any other single measure in a camp.',
  },
  {
    id: 'diarrhoea', title: 'Oral rehydration for diarrhoea', collection: 'Emergency health', language: 'eng',
    locator: 'Chapter 12',
    text: 'Dehydration kills faster than the infection causing it. Mix six level teaspoons of sugar and half a level teaspoon of salt into one litre of safe water. Give small sips continuously, and keep giving it after each loose stool. Sunken eyes, no tears, and skin that stays pinched are signs of severe dehydration needing urgent help.',
  },
  {
    id: 'shelter', title: 'Emergency shelter and warmth', collection: 'Field manuals', language: 'eng',
    locator: 'Section 8',
    text: 'Pick ground that is dry, above any flood channel, and clear of dead branches overhead. Keep the shelter small enough that body heat can warm it. Insulate underneath before worrying about the roof, since most heat is lost into cold ground. Leave a ventilation gap if any flame or stove burns inside, because carbon monoxide gives no warning.',
  },
  {
    id: 'wound-infection', title: 'Cleaning wounds and recognising infection', collection: 'Emergency health', language: 'eng',
    locator: 'Chapter 3',
    text: 'Irrigate the wound with plenty of clean water under pressure to flush out dirt. Do not close a dirty or animal-bite wound, because trapped bacteria cause worse infection than an open wound. Spreading redness, increasing pain after the second day, pus, or a red streak running toward the body means infection needs treatment.',
  },
  {
    id: 'snakebite', title: 'Snakebite first aid', collection: 'Emergency health', language: 'eng',
    locator: 'Chapter 14',
    text: 'Keep the person still and calm, because movement speeds venom through the body. Immobilise the bitten limb at heart level or below with a splint. Do not cut the wound, suck the venom, apply ice, or use a tight tourniquet. Note the time of the bite and any swelling boundary so a clinician can judge the progression.',
  },
  {
    id: 'childbirth', title: 'Delivering a baby without a clinic', collection: 'Emergency health', language: 'eng',
    locator: 'Chapter 18',
    text: 'Wash your hands and let the birth happen at its own pace. Support the head as it emerges but never pull. Dry the newborn immediately and put it skin to skin on the mother with a cover over both, as drying and warmth restart most struggling newborns. Tie the cord in two places and cut between them only with a sterile blade once the cord stops pulsing.',
  },
  {
    id: 'radio', title: 'Improvised antennas and radio range', collection: 'Field manuals', language: 'eng',
    locator: 'Section 11',
    text: 'Height matters more than power for VHF range. Raising a half-wave antenna a few metres often does more than doubling transmitter output. Keep the antenna clear of metal and wet foliage, and cut a quarter-wave ground plane wire to match the band. A dipole hung between two trees will usually outperform a rubber duck antenna at the same power.',
  },
  {
    id: 'fire-safety', title: 'Fire, smoke, and carbon monoxide', collection: 'Field manuals', language: 'eng',
    locator: 'Section 9',
    text: 'Smoke kills more people than flame. Stay low where the air is clearer and move toward an exit you already know. Never run a generator, charcoal, or a stove inside an enclosed space. Carbon monoxide is odourless, and headache with nausea in several people at once is often the first and only warning before collapse.',
  },
  {
    id: 'earthquake', title: 'During and after an earthquake', collection: 'Field manuals', language: 'eng',
    locator: 'Section 1',
    text: 'Drop, take cover under sturdy furniture, and hold on until the shaking stops. Stay away from windows and outside walls. After the shaking, expect aftershocks, shut off gas if you smell it, and check for trapped neighbours before entering damaged buildings. Do not use lifts, and assume stairwells may be partly collapsed.',
  },
  {
    id: 'wikipedia-hemostasis', title: 'Hemostasis', collection: 'Wikipedia', language: 'eng',
    locator: 'Hemostasis', sourceKind: 'wikipedia',
    text: 'Hemostasis is the process that causes bleeding to stop, keeping blood within a damaged blood vessel. It has three stages: vascular spasm narrowing the vessel, formation of a platelet plug, and coagulation in which fibrin strands reinforce the plug. Disorders of hemostasis include haemophilia and thrombosis.',
  },
  {
    id: 'wikipedia-chlorine', title: 'Chlorine', collection: 'Wikipedia', language: 'eng',
    locator: 'Chlorine', sourceKind: 'wikipedia',
    text: 'Chlorine is a chemical element with symbol Cl and atomic number 17. It is a yellow-green gas at room temperature and a strong oxidising agent. Chlorine is widely used to disinfect drinking water and swimming pools, and in the manufacture of plastics and solvents.',
  },
  {
    id: 'tr-kanama', title: 'Ciddi kanama kontrolü', collection: 'Emergency health', language: 'tur',
    locator: 'Bölüm 2',
    text: 'Yaranın üzerine temiz bir bezle doğrudan ve sıkı basınç uygulayın. Kan bezden geçerse ilk bezi çıkarmadan üstüne ikinci bir kat ekleyin. Kırık şüphesi yoksa yaralı uzvu kalp seviyesinin üstüne kaldırın. Turnikeyi yalnızca hayatı tehdit eden uzuv kanamalarında kullanın ve uyguladığınız saati yazın.',
  },
  {
    id: 'es-quemaduras', title: 'Quemaduras y escaldaduras', collection: 'Emergency health', language: 'spa',
    locator: 'Capítulo 4',
    text: 'Enfríe la zona quemada bajo agua corriente fresca durante al menos veinte minutos. No aplique hielo ni mantequilla. Cubra la quemadura sin apretar con film transparente o un paño limpio. No rompa las ampollas. Las quemaduras más grandes que la palma de la mano necesitan atención médica.',
  },
];

/**
 * Queries are written the way someone actually types during an emergency:
 * fragments, wrong number, wrong tense, a typo from shaking hands, or in their
 * own language. `kind` groups them so a regression shows up as a class of
 * failure rather than a single number moving.
 */
export const RELEVANCE_QUERIES = [
  { q: 'burns', expect: 'burns', kind: 'keyword' },
  { q: 'severe bleeding', expect: 'bleeding', kind: 'keyword' },
  { q: 'splinting a fracture', expect: 'fracture', kind: 'keyword' },
  { q: 'oral rehydration', expect: 'diarrhoea', kind: 'keyword' },
  { q: 'carbon monoxide', expect: 'fire-safety', kind: 'keyword' },
  { q: 'snakebite', expect: 'snakebite', kind: 'keyword' },

  { q: 'how do i treat a burn', expect: 'burns', kind: 'question' },
  { q: 'what do i do if someone is choking', expect: 'choking-adult', kind: 'question' },
  { q: 'how do i make water safe to drink', expect: 'water-treatment', kind: 'question' },
  { q: 'how deep should chest compressions be', expect: 'cpr-adult', kind: 'question' },
  { q: 'how far should a latrine be from a well', expect: 'latrine', kind: 'question' },
  { q: 'what should i do after an earthquake', expect: 'earthquake', kind: 'question' },

  { q: 'burn', expect: 'burns', kind: 'inflection' },
  { q: 'bleed', expect: 'bleeding', kind: 'inflection' },
  { q: 'fractures', expect: 'fracture', kind: 'inflection' },
  { q: 'compression depth', expect: 'cpr-adult', kind: 'inflection' },
  { q: 'infected wound', expect: 'wound-infection', kind: 'inflection' },
  { q: 'rehydrate child', expect: 'diarrhoea', kind: 'inflection' },

  { q: 'bleedng', expect: 'bleeding', kind: 'typo' },
  { q: 'chokeing', expect: 'choking-adult', kind: 'typo' },
  { q: 'hypothermai', expect: 'hypothermia', kind: 'typo' },
  { q: 'tourniqet', expect: 'bleeding', kind: 'typo' },

  { q: 'baby not breathing', expect: 'choking-infant', kind: 'fragment' },
  { q: 'too hot confused not sweating', expect: 'heatstroke', kind: 'fragment' },
  { q: 'cold wet shivering', expect: 'hypothermia', kind: 'fragment' },
  { q: 'boil water how long', expect: 'water-treatment', kind: 'fragment' },
  { q: 'cord cut baby born', expect: 'childbirth', kind: 'fragment' },
  { q: 'antenna height radio', expect: 'radio', kind: 'fragment' },

  { q: 'kanama nasıl durdurulur', expect: 'tr-kanama', kind: 'non-english' },
  { q: 'turnike', expect: 'tr-kanama', kind: 'non-english' },
  { q: 'quemaduras', expect: 'es-quemaduras', kind: 'non-english' },
  { q: 'cómo trato una quemadura', expect: 'es-quemaduras', kind: 'non-english' },
];
