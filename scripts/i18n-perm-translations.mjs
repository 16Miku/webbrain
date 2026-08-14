// One-off: insert translations for the standalone permission UI strings
// (3 decision buttons + 4 settings labels) into every non-English locale, in
// both builds. Idempotent. The question/verbs/long warnings are intentionally
// left to English fallback (word-order coupling / paragraph-length security
// copy that needs native review). Run: node scripts/i18n-perm-translations.mjs
import fs from 'node:fs';

const T = {
  es: { allow_once: 'Permitir una vez', always_allow: 'Permitir siempre en {host}', dont_allow: 'No permitir', permissions: 'Permisos', revoke: 'Revocar', clear_all: 'Borrar todos los permisos', gate_label: 'Preguntar antes de acciones importantes' },
  fr: { allow_once: 'Autoriser une fois', always_allow: 'Toujours autoriser sur {host}', dont_allow: 'Ne pas autoriser', permissions: 'Autorisations', revoke: 'Révoquer', clear_all: 'Effacer toutes les autorisations', gate_label: 'Demander avant les actions importantes' },
  tr: { allow_once: 'Bir kez izin ver', always_allow: '{host} için her zaman izin ver', dont_allow: 'İzin verme', permissions: 'İzinler', revoke: 'Kaldır', clear_all: 'Tüm izinleri temizle', gate_label: 'Önemli işlemlerden önce sor' },
  zh: { allow_once: '允许一次', always_allow: '始终允许 {host}', dont_allow: '不允许', permissions: '权限', revoke: '撤销', clear_all: '清除所有权限', gate_label: '执行重要操作前询问' },
  ru: { allow_once: 'Разрешить один раз', always_allow: 'Всегда разрешать на {host}', dont_allow: 'Не разрешать', permissions: 'Разрешения', revoke: 'Отозвать', clear_all: 'Очистить все разрешения', gate_label: 'Спрашивать перед важными действиями' },
  uk: { allow_once: 'Дозволити один раз', always_allow: 'Завжди дозволяти на {host}', dont_allow: 'Не дозволяти', permissions: 'Дозволи', revoke: 'Відкликати', clear_all: 'Очистити всі дозволи', gate_label: 'Питати перед важливими діями' },
  ar: { allow_once: 'السماح مرة واحدة', always_allow: 'السماح دائمًا على {host}', dont_allow: 'عدم السماح', permissions: 'الأذونات', revoke: 'إلغاء', clear_all: 'مسح كل الأذونات', gate_label: 'السؤال قبل الإجراءات المهمة' },
  ja: { allow_once: '今回のみ許可', always_allow: '{host} で常に許可', dont_allow: '許可しない', permissions: '権限', revoke: '取り消す', clear_all: 'すべての権限を消去', gate_label: '重要な操作の前に確認する' },
  ko: { allow_once: '한 번 허용', always_allow: '{host}에서 항상 허용', dont_allow: '허용 안 함', permissions: '권한', revoke: '취소', clear_all: '모든 권한 지우기', gate_label: '중요한 작업 전에 확인' },
  id: { allow_once: 'Izinkan sekali', always_allow: 'Selalu izinkan di {host}', dont_allow: 'Jangan izinkan', permissions: 'Izin', revoke: 'Cabut', clear_all: 'Hapus semua izin', gate_label: 'Tanya sebelum tindakan penting' },
  th: { allow_once: 'อนุญาตครั้งเดียว', always_allow: 'อนุญาตเสมอบน {host}', dont_allow: 'ไม่อนุญาต', permissions: 'สิทธิ์', revoke: 'เพิกถอน', clear_all: 'ล้างสิทธิ์ทั้งหมด', gate_label: 'ถามก่อนการดำเนินการสำคัญ' },
  ms: { allow_once: 'Benarkan sekali', always_allow: 'Sentiasa benarkan di {host}', dont_allow: 'Jangan benarkan', permissions: 'Kebenaran', revoke: 'Batalkan', clear_all: 'Kosongkan semua kebenaran', gate_label: 'Tanya sebelum tindakan penting' },
  tl: { allow_once: 'Payagan minsan', always_allow: 'Palaging payagan sa {host}', dont_allow: 'Huwag payagan', permissions: 'Mga pahintulot', revoke: 'Bawiin', clear_all: 'I-clear ang lahat ng pahintulot', gate_label: 'Magtanong bago ang mahahalagang aksyon' },
};

const dirs = ['src/firefox/src/ui/locales', 'src/chrome/src/ui/locales'];

for (const dir of dirs) {
  for (const [lang, v] of Object.entries(T)) {
    const file = `${dir}/${lang}.js`;
    let src = fs.readFileSync(file, 'utf8');
    if (src.includes("'sp.perm.allow_once'")) { console.log('skip (already present)', file); continue; }
    const lines = [
      `  'sp.perm.allow_once': ${JSON.stringify(v.allow_once)},`,
      `  'sp.perm.always_allow': ${JSON.stringify(v.always_allow)},`,
      `  'sp.perm.dont_allow': ${JSON.stringify(v.dont_allow)},`,
      `  'st.tab.permissions': ${JSON.stringify(v.permissions)},`,
      `  'st.perms.revoke': ${JSON.stringify(v.revoke)},`,
      `  'st.perms.clear_all': ${JSON.stringify(v.clear_all)},`,
      `  'st.perms.gate.label': ${JSON.stringify(v.gate_label)},`,
    ];
    const block = `\n  // Permission UI — standalone buttons + labels (rest falls back to English)\n${lines.join('\n')}\n`;
    src = src.replace('export default {', 'export default {' + block);
    fs.writeFileSync(file, src);
    console.log('patched', file);
  }
}
console.log('done');
