const DIFFICULTIES = [
  { level: 1, slug: 'easy', label: 'Easy' },
  { level: 2, slug: 'basic', label: 'Basic' },
  { level: 3, slug: 'intermediate', label: 'Intermediate' },
  { level: 4, slug: 'advanced', label: 'Advanced' },
  { level: 5, slug: 'challenging', label: 'Challenging' },
];

const THEMES = ['sky', 'mint', 'amber', 'violet', 'slate'];
const ASSETS = [
  'street-talad-noi.jpg',
  'street-snow.jpg',
  'street-night.jpg',
  'street-tangiers.jpg',
];

const literal = (id, dimension, section, value, weight = 1, critical = false) => ({
  id, dimension, section, kind: 'literal', value, weight, critical, caseSensitive: true,
});
const any = (id, dimension, section, values, weight = 1, critical = false) => ({
  id, dimension, section, kind: 'any', values, weight, critical,
});
const all = (id, dimension, section, values, weight = 1, critical = false) => ({
  id, dimension, section, kind: 'all', values, weight, critical,
});
const keywords = (value) => String(value)
  .toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .split(' ')
  .filter(word => word.length >= 4 && !['from', 'with', 'again'].includes(word));

function define(level, category, title, question, render, checks, rubric, threshold = 0.72) {
  return {
    category,
    difficulty: DIFFICULTIES[level - 1],
    title,
    question: `${question} Focus on the “${title}” screen.`,
    render: { theme: THEMES[level - 1], ...render },
    expected: { threshold, checks, successRubric: rubric },
  };
}

function authCase(level) {
  const x = [
    { heading: 'Welcome back', email: '', password: '', status: '', button: 'Sign in', disabled: false, focus: 'email', blocker: 'missing email and password' },
    { heading: 'Sign in to Atlas', email: 'maya@example.com', password: '', status: '', button: 'Continue', disabled: true, focus: 'password', blocker: 'missing password' },
    { heading: 'Administrator login', email: 'ops@example.com', password: '••••••••', status: 'Incorrect password', button: 'Log in', disabled: false, focus: '', blocker: 'incorrect password' },
    { heading: 'Verify your identity', email: 'sara@example.com', password: '482 19_', status: 'Code expires in 01:42', button: 'Verify', disabled: true, focus: 'password', blocker: 'incomplete verification code' },
    { heading: 'Session expired', email: 'nora@example.com', password: '', status: 'Too many attempts. Try again in 14:32', button: 'Sign in again', disabled: true, focus: '', blocker: 'rate limit' },
  ][level - 1];
  const checks = [
    any('purpose', 'page_purpose', 1, ['sign in', 'login', 'identity verification', 'session expired'], 1, true),
    literal('heading', 'visible_text', 2, x.heading, 2, true),
    literal('button', 'visible_text', 2, x.button, 2, true),
    all('email-input', 'inputs', 3, ['Email', x.email || 'empty'], 1),
    any('blocker', 'blockers', 5, keywords(x.blocker), 2, level > 1),
  ];
  if (x.status) checks.push(literal('status', 'state_signals', 4, x.status, 2, true));
  if (x.disabled) checks.push(any('disabled', 'inputs', 3, ['disabled', 'unavailable'], 1));
  return define(level, 'authentication', x.heading, `What is preventing the user from completing ${x.button}?`, { kind: 'auth', ...x }, checks, `Identify the ${x.heading} authentication surface, quote ${x.button}, and report ${x.blocker}.`);
}

function searchCase(level) {
  const x = [
    { heading: 'Search', query: 'camera', tab: 'All', count: '24 results', chip: '', notice: '' },
    { heading: 'Product search', query: 'wireless keyboard', tab: 'Products', count: '18 results', chip: 'In stock', notice: '' },
    { heading: 'Research library', query: 'urban heat island', tab: 'Articles', count: '1,248 results', chip: 'Since 2024', notice: 'Sorted by relevance' },
    { heading: 'Global search', query: 'fatura', tab: 'Dosyalar', count: '7 sonuç', chip: 'Son 30 gün', notice: '2 filters active' },
    { heading: 'Case-sensitive search', query: 'Orion-7B', tab: 'Exact match', count: '0 results', chip: 'Archived', notice: 'No matches for “Orion-7B”' },
  ][level - 1];
  const checks = [
    any('purpose', 'page_purpose', 1, ['search', 'results'], 1, true),
    literal('heading', 'visible_text', 2, x.heading, 1),
    literal('tab', 'visible_text', 2, x.tab, 2, true),
    literal('count', 'visible_text', 2, x.count, 2, true),
    all('query', 'inputs', 3, ['Search', x.query], 2, true),
  ];
  if (x.chip) checks.push(literal('chip', 'visible_text', 2, x.chip));
  if (x.notice) checks.push(literal('notice', 'state_signals', 4, x.notice, 1, level === 5));
  return define(level, 'search-results', x.heading, `What query is active, which result tab is selected, and how many results are shown?`, { kind: 'search', ...x }, checks, `Read the active query ${x.query}, selected tab ${x.tab}, and exact count ${x.count}.`);
}

function checkoutCase(level) {
  const x = [
    { heading: 'Your cart', total: '$24.00', button: 'Checkout', disabled: false, banner: '', item: 'Canvas tote' },
    { heading: 'Checkout', total: '$67.40', button: 'Place order', disabled: true, banner: 'Add a delivery address', item: 'Desk lamp' },
    { heading: 'Review order', total: '€132.90', button: 'Pay now', disabled: true, banner: 'Card ending 1842 was declined', item: 'Travel backpack' },
    { heading: 'Confirm purchase', total: '₺4.799,00', button: 'Siparişi onayla', disabled: false, banner: '3D Secure verification required', item: 'Kulaklık' },
    { heading: 'Order summary', total: '$1,204.08', button: 'Submit payment', disabled: true, banner: 'Price changed from $1,199.00', item: 'Studio monitor pair' },
  ][level - 1];
  const checks = [
    any('purpose', 'page_purpose', 1, ['checkout', 'cart', 'order', 'purchase'], 1, true),
    literal('heading', 'visible_text', 2, x.heading),
    literal('item', 'visible_text', 2, x.item),
    literal('total', 'visible_text', 2, x.total, 2, true),
    literal('button', 'visible_text', 2, x.button, 2, true),
  ];
  if (x.banner) checks.push(literal('banner', 'state_signals', 4, x.banner, 2, true));
  if (x.disabled) checks.push(any('blocked', 'blockers', 5, keywords(x.banner), 2, true));
  return define(level, 'checkout', x.heading, `What is the exact total, and can the visible purchase action proceed?`, { kind: 'checkout', ...x }, checks, `Quote ${x.total} and ${x.button}; correctly report whether the action is disabled and why.`);
}

function validationCase(level) {
  const x = [
    { heading: 'Create profile', label: 'Display name', value: '', placeholder: 'e.g. Maya', error: 'Display name is required', button: 'Save profile' },
    { heading: 'Shipping details', label: 'Postal code', value: '10A2', placeholder: '5 digits', error: 'Enter a valid postal code', button: 'Continue' },
    { heading: 'Invite teammate', label: 'Work email', value: 'lee@sample', placeholder: 'name@company.com', error: 'Email domain is incomplete', button: 'Send invite' },
    { heading: 'Vergi bilgileri', label: 'Vergi kimlik no', value: '348 91 2', placeholder: '10 hane', error: '3 hane eksik', button: 'Kaydet' },
    { heading: 'Publish dataset', label: 'Release tag', value: 'v2..1', placeholder: 'v1.0.0', error: 'Use semantic version format', button: 'Publish' },
  ][level - 1];
  return define(level, 'form-validation', x.heading, `Which field is invalid, what value does it contain, and what exact error is shown?`, { kind: 'validation', ...x }, [
    any('purpose', 'page_purpose', 1, ['form', 'profile', 'shipping', 'invite', 'dataset', 'tax'], 1),
    literal('heading', 'visible_text', 2, x.heading, 1),
    literal('button', 'visible_text', 2, x.button, 1),
    all('input', 'inputs', 3, [x.label, x.value || 'empty', x.placeholder], 2, true),
    literal('error', 'state_signals', 4, x.error, 2, true),
    any('blocker', 'blockers', 5, ['invalid', 'required', 'incomplete', 'missing', 'format'], 1, true),
  ], `Name ${x.label}, preserve its current value and placeholder, and quote ${x.error}.`);
}

function modalCase(level) {
  const x = [
    { page: 'Files', title: 'Delete file?', body: 'This action cannot be undone.', primary: 'Delete', secondary: 'Cancel' },
    { page: 'Team settings', title: 'Leave workspace?', body: 'You will lose access to 12 projects.', primary: 'Leave', secondary: 'Stay' },
    { page: 'API keys', title: 'Rotate production key?', body: 'Existing clients will stop working immediately.', primary: 'Rotate key', secondary: 'Not now' },
    { page: 'Deployments', title: 'Production is locked', body: 'Approval from an owner is required.', primary: 'Request approval', secondary: 'Close' },
    { page: 'Bank transfer', title: 'Confirm transfer of $8,740.00?', body: 'Recipient: NOVA SUPPLY •••• 8841', primary: 'Confirm transfer', secondary: 'Review details' },
  ][level - 1];
  return define(level, 'modal-overlay', x.title, `What modal is blocking the page, and what are its two exact actions?`, { kind: 'modal', ...x }, [
    any('purpose', 'page_purpose', 1, [x.page.toLowerCase(), 'dialog', 'modal'], 1),
    literal('title', 'visible_text', 2, x.title, 2, true),
    literal('primary', 'visible_text', 2, x.primary, 2, true),
    literal('secondary', 'visible_text', 2, x.secondary, 1),
    all('modal-signal', 'state_signals', 4, ['modal', x.body], 2, true),
    any('overlay-blocker', 'blockers', 5, ['modal', 'overlay', 'dialog'], 1, true),
  ], `Recognize a blocking modal, quote ${x.title}, ${x.primary}, and ${x.secondary}.`);
}

function toastCase(level) {
  const x = [
    { heading: 'Notes', toast: 'Saved', tone: 'success', button: 'Done', detail: '' },
    { heading: 'Preferences', toast: 'Settings updated', tone: 'success', button: 'Close', detail: 'Synced just now' },
    { heading: 'Upload center', toast: 'Upload failed', tone: 'error', button: 'Retry', detail: 'Network connection lost' },
    { heading: 'Branch protection', toast: 'Rule saved with warnings', tone: 'warning', button: 'View warnings', detail: '2 checks are missing' },
    { heading: 'Data export', toast: 'Export queued', tone: 'info', button: 'Cancel export', detail: 'Position 14 of 32' },
  ][level - 1];
  const checks = [
    any('purpose', 'page_purpose', 1, [x.heading.toLowerCase(), 'settings', 'upload', 'export'], 1),
    literal('heading', 'visible_text', 2, x.heading),
    literal('button', 'visible_text', 2, x.button),
    literal('toast', 'state_signals', 4, x.toast, 2, true),
  ];
  if (x.detail) checks.push(literal('detail', 'state_signals', 4, x.detail, 2, true));
  return define(level, 'toast-notification', x.toast, `What transient notification is visible, and is it success, warning, error, or informational?`, { kind: 'toast', ...x }, checks, `Quote ${x.toast}${x.detail ? ` and ${x.detail}` : ''}, and classify the visible state.`);
}

function loadingCase(level) {
  const x = [
    { heading: 'Loading messages…', detail: '', progress: '', blank: true },
    { heading: 'Preparing dashboard', detail: 'Fetching latest metrics', progress: '38%', blank: false },
    { heading: 'Processing 12 files', detail: 'File 7 of 12', progress: '58%', blank: false },
    { heading: 'Reconnecting…', detail: 'Attempt 3 of 5', progress: '', blank: false },
    { heading: 'Finalizing import', detail: 'Do not close this tab', progress: '99%', blank: false },
  ][level - 1];
  const checks = [
    any('purpose', 'page_purpose', 1, ['loading', 'processing', 'reconnecting', 'import'], 1, true),
    literal('heading', 'visible_text', level === 1 ? null : 2, x.heading, 2, true),
    any('spinner', 'state_signals', 4, ['loading', 'spinner', 'processing', 'reconnecting', 'progress'], 2, true),
    any('wait-blocker', 'blockers', 5, ['loading', 'wait', 'processing', 'reconnecting', 'not ready'], 1),
  ];
  if (x.detail) checks.push(literal('detail', 'state_signals', 4, x.detail));
  if (x.progress) checks.push(literal('progress', 'state_signals', 4, x.progress, 2, level === 5));
  return define(level, 'loading-state', x.heading, `Is the page ready for interaction, and what exact progress signal is visible?`, { kind: 'loading', ...x }, checks, `Report the loading state and preserve ${x.progress || x.heading} without inventing completion.`);
}

function consentCase(level) {
  const x = [
    { title: 'We use cookies', body: 'Choose whether to allow analytics cookies.', buttons: ['Accept all', 'Reject all'] },
    { title: 'Privacy choices', body: 'Essential cookies are always on.', buttons: ['Manage settings', 'Save choices'] },
    { title: 'Your privacy', body: 'Personalized ads are currently off.', buttons: ['Allow selected', 'Continue without accepting'] },
    { title: 'Çerez tercihleri', body: 'Zorunlu çerezler kapatılamaz.', buttons: ['Tümünü kabul et', 'Yalnızca gerekli'] },
    { title: 'Consent required', body: 'The video is blocked until media cookies are allowed.', buttons: ['Allow media cookies', 'Keep blocked'] },
  ][level - 1];
  return define(level, 'consent-banner', x.title, `Which consent overlay is present and what exact choices does it offer?`, { kind: 'consent', ...x }, [
    any('purpose', 'page_purpose', 1, ['privacy', 'cookie', 'consent', 'video'], 1),
    literal('title', 'visible_text', 2, x.title, 2, true),
    ...x.buttons.map((button, i) => literal(`choice-${i + 1}`, 'visible_text', 2, button, 1, i === 0)),
    any('consent-signal', 'state_signals', 4, ['cookie', 'consent', 'privacy', 'overlay', 'banner'], 2, true),
    any('consent-blocker', 'blockers', 5, ['cookie', 'consent', 'overlay', 'blocked'], 1, level === 5),
  ], `Recognize the consent UI and quote ${x.buttons.join(' / ')}.`);
}

function dashboardCase(level) {
  const x = [
    { heading: 'Overview', metrics: [['Visitors', '1,204'], ['Orders', '86']], alert: '' },
    { heading: 'Sales dashboard', metrics: [['Revenue', '$48.2K'], ['Refunds', '$1.9K'], ['Conversion', '3.8%']], alert: '' },
    { heading: 'System health', metrics: [['API', '99.97%'], ['Queue', '142'], ['Errors', '17']], alert: 'Error rate is above target' },
    { heading: 'Bölgesel performans', metrics: [['İstanbul', '₺82,4K'], ['Ankara', '₺61,7K'], ['İzmir', '₺44,2K']], alert: 'İzmir hedefin %8 altında' },
    { heading: 'Incident command', metrics: [['P0 open', '2'], ['Affected users', '18,420'], ['ETA', 'Unknown']], alert: 'Payments degraded in EU-West' },
  ][level - 1];
  const target = x.metrics[x.metrics.length - 1];
  const checks = [
    any('purpose', 'page_purpose', 1, ['dashboard', 'overview', 'system health', 'incident'], 1, true),
    literal('heading', 'visible_text', 2, x.heading, 1),
    all('target-metric', 'visible_text', 2, target, 2, true),
  ];
  if (x.alert) checks.push(literal('alert', 'state_signals', 4, x.alert, 2, true));
  if (target[1] === 'Unknown') checks.push(any('unknown', 'unknowns', 6, ['ETA', 'unknown'], 2, true));
  return define(level, 'dashboard', x.heading, `What is the value of ${target[0]}, and is there an alert that changes the page state?`, { kind: 'dashboard', ...x }, checks, `Read ${target[0]} = ${target[1]} and report the alert without guessing unknown values.`);
}

function chartCase(level) {
  const x = [
    { heading: 'Weekly signups', labels: ['Mon', 'Tue', 'Wed'], values: [12, 18, 9], highlight: 'Tue', note: '' },
    { heading: 'Quarterly revenue', labels: ['Q1', 'Q2', 'Q3', 'Q4'], values: [22, 31, 27, 44], highlight: 'Q4', note: '$44K' },
    { heading: 'Latency by region', labels: ['US', 'EU', 'APAC', 'MEA'], values: [120, 186, 240, 158], highlight: 'APAC', note: '240 ms' },
    { heading: 'Dönüşüm hunisi', labels: ['Ziyaret', 'Sepet', 'Ödeme', 'Satın alma'], values: [100, 62, 41, 29], highlight: 'Satın alma', note: '29%' },
    { heading: 'Forecast vs actual', labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May'], values: [72, 68, 81, 79, 93], highlight: 'May', note: 'Actual 93; forecast 88' },
  ][level - 1];
  return define(level, 'chart-reading', x.heading, `Which category has the tallest bar, and what exact value or annotation is attached to it?`, { kind: 'chart', ...x }, [
    any('purpose', 'page_purpose', 1, ['chart', 'dashboard', x.heading.toLowerCase()], 1),
    literal('heading', 'visible_text', 2, x.heading, 1),
    any('highest-label', 'visual_reasoning', null, [x.highlight], 2, true),
    any('highest-value', 'visual_reasoning', null, [String(Math.max(...x.values)), x.note].filter(Boolean), 2, true),
  ], `Use the rendered bars, not source order: ${x.highlight} is tallest${x.note ? ` and is labeled ${x.note}` : ''}.`);
}

function tableCase(level) {
  const x = [
    { heading: 'Recent orders', columns: ['Order', 'Status'], rows: [['#1042', 'Shipped'], ['#1043', 'Pending']], target: ['#1043', 'Pending'] },
    { heading: 'Team members', columns: ['Name', 'Role', 'Access'], rows: [['Ava Chen', 'Editor', 'Active'], ['Noah Park', 'Viewer', 'Suspended']], target: ['Noah Park', 'Suspended'] },
    { heading: 'Deployment history', columns: ['Version', 'Environment', 'Result'], rows: [['v4.8.1', 'Staging', 'Passed'], ['v4.8.2', 'Production', 'Rolled back']], target: ['v4.8.2', 'Rolled back'] },
    { heading: 'Fatura listesi', columns: ['Fatura', 'Vade', 'Durum'], rows: [['TR-8831', '18 Ağu', 'Ödendi'], ['TR-8832', '21 Ağu', 'Gecikmiş']], target: ['TR-8832', 'Gecikmiş'] },
    { heading: 'Access audit', columns: ['Principal', 'Scope', 'Last used', 'Risk'], rows: [['svc-build', 'repo:write', '2m ago', 'Low'], ['svc-legacy', 'org:admin', 'Unknown', 'Critical']], target: ['svc-legacy', 'org:admin', 'Critical'] },
  ][level - 1];
  return define(level, 'data-table', x.heading, `Locate the target row and report its exact status without mixing it with neighboring rows.`, { kind: 'table', ...x }, [
    any('purpose', 'page_purpose', 1, ['table', 'orders', 'members', 'deployment', 'invoice', 'audit'], 1),
    literal('heading', 'visible_text', 2, x.heading),
    all('target-row', 'visual_reasoning', null, x.target, 3, true),
  ], `Keep row association intact: ${x.target.join(' — ')}.`);
}

function emailCase(level) {
  const x = [
    { heading: 'New message', to: '', subject: '', body: '', status: '', button: 'Send' },
    { heading: 'Compose', to: 'alex@example.com', subject: 'Project update', body: 'Hi Alex,', status: 'Draft saved', button: 'Send' },
    { heading: 'New Message', to: 'finance@example.com', subject: 'Invoice 8832', body: 'Please review the attached invoice.', status: 'Attachment scanning…', button: 'Send' },
    { heading: 'Yeni ileti', to: 'ekip@example.com', subject: 'Cuma toplantısı', body: 'Saat 14:30 uygun mu?', status: 'Çevrimdışı — taslak yerel kaydedildi', button: 'Gönder' },
    { heading: 'Confidential message', to: 'outside@vendor.test', subject: 'Q3 forecast', body: 'The attached file contains internal estimates.', status: 'External recipient warning', button: 'Send anyway' },
  ][level - 1];
  const checks = [
    any('purpose', 'page_purpose', 1, ['email', 'compose', 'message'], 1, true),
    literal('heading', 'visible_text', 2, x.heading),
    literal('button', 'visible_text', 2, x.button, 2, true),
    all('to-input', 'inputs', 3, ['To', x.to || 'empty'], 1),
    all('subject-input', 'inputs', 3, ['Subject', x.subject || 'empty'], 1),
  ];
  if (x.status) checks.push(literal('status', 'state_signals', 4, x.status, 2, true));
  if (level === 5) checks.push(any('external-blocker', 'blockers', 5, ['external', 'warning', 'recipient'], 2, true));
  return define(level, 'email-compose', x.heading, `Who is the message addressed to, what is its subject, and is any send warning visible?`, { kind: 'email', ...x }, checks, `Report the compose fields exactly and surface ${x.status || 'the empty required fields'}.`);
}

function kanbanCase(level) {
  const x = [
    { heading: 'Project board', columns: [['To do', ['Write brief']], ['Done', ['Create repo']]], target: ['Write brief', 'To do'] },
    { heading: 'Sprint 18', columns: [['Backlog', ['Add filters']], ['In progress', ['Fix checkout']], ['Done', ['Update docs']]], target: ['Fix checkout', 'In progress'] },
    { heading: 'Launch plan', columns: [['Blocked', ['Legal review']], ['In review', ['Pricing page']], ['Ready', ['Email campaign']]], target: ['Legal review', 'Blocked'] },
    { heading: 'İçerik takvimi', columns: [['Taslak', ['Vizyon yazısı']], ['İncelemede', ['Model karşılaştırması']], ['Yayında', ['Sürüm notları']]], target: ['Model karşılaştırması', 'İncelemede'] },
    { heading: 'Incident board', columns: [['Investigating', ['EU payment failures', 'Webhook lag']], ['Mitigating', ['Retry storm']], ['Monitoring', ['Cache recovery']]], target: ['Retry storm', 'Mitigating'] },
  ][level - 1];
  return define(level, 'kanban-board', x.heading, `Which column contains “${x.target[0]}”?`, { kind: 'kanban', ...x }, [
    any('purpose', 'page_purpose', 1, ['board', 'kanban', 'project', 'sprint', 'incident'], 1),
    literal('heading', 'visible_text', 2, x.heading),
    all('card-column', 'visual_reasoning', null, x.target, 3, true),
  ], `Preserve the spatial association: ${x.target[0]} is in ${x.target[1]}.`);
}

function calendarCase(level) {
  const x = [
    { heading: 'August 2026', selected: '21', event: 'Design review', time: '10:00' },
    { heading: 'Team calendar', selected: '24', event: 'Sprint planning', time: '14:30' },
    { heading: 'Conference schedule', selected: '27', event: 'Vision benchmarks', time: '16:15–17:00' },
    { heading: 'Ağustos 2026', selected: '29', event: 'Ürün demosu', time: '09:45' },
    { heading: 'Release calendar', selected: '31', event: 'Production freeze', time: '23:30 UTC', conflict: 'Overlaps with Database migration' },
  ][level - 1];
  const checks = [
    any('purpose', 'page_purpose', 1, ['calendar', 'schedule'], 1),
    literal('heading', 'visible_text', 2, x.heading),
    all('selected-event', 'visual_reasoning', null, [x.selected, x.event, x.time], 3, true),
  ];
  if (x.conflict) checks.push(literal('conflict', 'state_signals', 4, x.conflict, 2, true));
  return define(level, 'calendar', x.heading, `What event is shown on the selected day, and at what exact time?`, { kind: 'calendar', ...x }, checks, `Associate day ${x.selected} with ${x.event} at ${x.time}.`);
}

function travelCase(level) {
  const x = [
    { heading: 'Nearby cafés', selected: 'Pine Café', detail: '4 min walk', pins: 2 },
    { heading: 'Hotel map', selected: 'Harbor House', detail: '$142/night', pins: 3 },
    { heading: 'Delivery tracking', selected: 'Courier', detail: '2 stops away', pins: 4 },
    { heading: 'Tren rotası', selected: 'Ankara Garı', detail: '18:42 varış', pins: 5 },
    { heading: 'Evacuation map', selected: 'Route B', detail: 'Bridge closed', pins: 6, alert: 'Use Route C instead' },
  ][level - 1];
  const checks = [
    any('purpose', 'page_purpose', 1, ['map', 'tracking', 'route', 'hotel', 'café'], 1),
    literal('heading', 'visible_text', 2, x.heading),
    all('selection', 'visual_reasoning', null, [x.selected, x.detail], 3, true),
    any('pin-count', 'visual_reasoning', null, [String(x.pins), ['zero', 'one', 'two', 'three', 'four', 'five', 'six'][x.pins]], 1),
  ];
  if (x.alert) checks.push(literal('route-alert', 'state_signals', 4, x.alert, 2, true));
  return define(level, 'map-and-travel', x.heading, `Which map item is selected, what detail is shown, and how many pins are visible?`, { kind: 'travel', ...x }, checks, `Read the selected ${x.selected} card, its ${x.detail} detail, and ${x.pins} pins.`);
}

function galleryCase(level) {
  const x = [
    { heading: 'Street archive', asset: ASSETS[0], caption: 'Talad Noi', badge: 'Color photo', question: 'Which place name appears beneath the street photograph?' },
    { heading: 'Winter collection', asset: ASSETS[1], caption: 'Snowbound avenue', badge: 'Historic photo', question: 'What weather condition is visible and what is the caption?' },
    { heading: 'Night scenes', asset: ASSETS[2], caption: 'After dusk', badge: 'Etching', question: 'Is the featured scene daytime or nighttime, and what medium badge is shown?' },
    { heading: 'Sanat arşivi', asset: ASSETS[3], caption: 'Tangiers street scene', badge: 'Oil painting', question: 'What type of artwork is displayed and what caption identifies it?' },
    { heading: 'Visual comparison', asset: ASSETS[0], asset2: ASSETS[1], caption: 'Modern / Historic', badge: 'Compare', question: 'Which panel shows snow, left or right, and what comparison caption is visible?' },
  ][level - 1];
  const visual = level === 2 ? ['snow', 'winter'] : level === 3 ? ['night', 'dark', 'dusk'] : level === 5 ? ['right', 'snow'] : [x.caption];
  return define(level, 'photo-understanding', x.heading, x.question, { kind: 'gallery', ...x }, [
    any('purpose', 'page_purpose', 1, ['gallery', 'archive', 'collection', 'comparison'], 1),
    literal('heading', 'visible_text', 2, x.heading),
    literal('caption', 'visible_text', 2, x.caption, 2, true),
    literal('badge', 'visible_text', 2, x.badge, 1),
    any('visual-content', 'visual_reasoning', null, visual, 2, level > 1),
  ], `Combine the rendered image with its UI labels; do not infer a place or date beyond ${x.caption}.`);
}

function multilingualCase(level) {
  const x = [
    { heading: 'Bienvenue', label: 'Adresse e-mail', value: '', button: 'Continuer', status: '' },
    { heading: 'Willkommen zurück', label: 'Passwort', value: '••••••', button: 'Anmelden', status: 'Passwort ist falsch' },
    { heading: 'お支払い', label: 'カード番号', value: '•••• 4242', button: '支払う', status: '有効期限を確認してください' },
    { heading: 'Sipariş ayrıntıları', label: 'Teslimat notu', value: 'Kapıya bırak', button: 'Güncelle', status: 'Adres doğrulanamadı' },
    { heading: 'إعدادات الأمان', label: 'رمز التحقق', value: '19_ 4_', button: 'تأكيد', status: 'تنتهي صلاحية الرمز خلال ٣٨ ثانية', rtl: true },
  ][level - 1];
  return define(level, 'multilingual-ocr', x.heading, `Read the non-English heading, field label/value, action, and visible status exactly as rendered.`, { kind: 'multilingual', ...x }, [
    any('purpose', 'page_purpose', 1, ['sign', 'payment', 'order', 'security', 'login', 'checkout', 'settings'], 1),
    literal('heading', 'visible_text', 2, x.heading, 2, true),
    literal('button', 'visible_text', 2, x.button, 2, true),
    all('input', 'inputs', 3, [x.label, x.value || 'empty'], 2, true),
    ...(x.status ? [literal('status', 'state_signals', 4, x.status, 2, true)] : []),
  ], `Preserve Unicode exactly: ${x.heading}; ${x.label}; ${x.button}${x.status ? `; ${x.status}` : ''}.`);
}

function occlusionCase(level) {
  const x = [
    { heading: 'Account', target: 'Save changes', cover: 'Help', opacity: 1, issue: 'tooltip overlaps the button' },
    { heading: 'Pricing', target: 'Start trial', cover: 'Chat with us', opacity: 0.96, issue: 'chat widget covers part of the button' },
    { heading: 'Report builder', target: 'Export CSV', cover: 'Beta', opacity: 0.78, issue: 'badge overlaps the label' },
    { heading: 'Canvas editor', target: 'Publish', cover: 'Connection lost', opacity: 0.58, issue: 'semi-transparent offline overlay' },
    { heading: 'Trading panel', target: 'Review order', cover: 'Market closed', opacity: 0.34, issue: 'low-contrast overlay blocks the action' },
  ][level - 1];
  return define(level, 'occlusion-and-contrast', x.heading, `What action is partially covered, and what visible overlay or widget causes the obstruction?`, { kind: 'occlusion', ...x }, [
    any('purpose', 'page_purpose', 1, ['account', 'pricing', 'report', 'editor', 'trading'], 1),
    literal('heading', 'visible_text', 2, x.heading),
    literal('target', 'visible_text', 2, x.target, 2, true),
    literal('cover', 'state_signals', 4, x.cover, 2, true),
    any('occlusion', 'blockers', 5, ['cover', 'overlap', 'overlay', 'obstruct', 'block'], 2, true),
  ], `Detect the visual obstruction: ${x.cover} interferes with ${x.target}.`);
}

function securityCase(level) {
  const x = [
    { heading: 'Security check', label: 'I’m not a robot', status: '', button: 'Continue', disabled: true },
    { heading: 'Confirm it’s you', label: 'Select all traffic lights', status: 'Challenge not completed', button: 'Verify', disabled: true },
    { heading: 'Unusual activity detected', label: 'Hold the button for 3 seconds', status: 'Verification required', button: 'Try again', disabled: false },
    { heading: 'Güvenlik doğrulaması', label: 'Bulmacayı tamamlayın', status: '2 denemeden 1’i kaldı', button: 'Doğrula', disabled: true },
    { heading: 'Additional verification', label: 'Image challenge', status: 'Characters are unreadable', button: 'Submit', disabled: true, code: '••?•' },
  ][level - 1];
  const checks = [
    any('purpose', 'page_purpose', 1, ['security', 'verification', 'captcha', 'challenge'], 1, true),
    literal('heading', 'visible_text', 2, x.heading, 1),
    literal('label', 'visible_text', 2, x.label, 2, true),
    literal('button', 'visible_text', 2, x.button, 1),
    any('captcha-signal', 'state_signals', 4, ['CAPTCHA', 'challenge', 'verification', x.status].filter(Boolean), 2, true),
    any('security-blocker', 'blockers', 5, ['verification', 'challenge', 'CAPTCHA', 'disabled'], 2, true),
  ];
  if (x.code) checks.push(any('unknown-code', 'unknowns', 6, ['unreadable', 'cannot read', 'unknown'], 2, true));
  return define(level, 'security-challenge', x.heading, `What security challenge is present, and can the visible action proceed?`, { kind: 'security', ...x }, checks, `Identify the synthetic challenge and disabled state; do not solve or invent unreadable characters.`);
}

function unknownCase(level) {
  const x = [
    { heading: 'Account ID', visible: 'ACCT-1042', obscured: '', label: 'Identifier' },
    { heading: 'Shipment label', visible: 'ZX-81', obscured: 'last 3 characters blurred', label: 'Tracking code' },
    { heading: 'Scanned receipt', visible: '$4?.90', obscured: 'one digit is smudged', label: 'Total' },
    { heading: 'Redacted contract', visible: 'Client: ███████', obscured: 'client name is redacted', label: 'Client' },
    { heading: 'Telemetry capture', visible: 'Node ••7? / region eu-?', obscured: 'node and region identifiers are partially unreadable', label: 'Runtime target' },
  ][level - 1];
  const checks = [
    any('purpose', 'page_purpose', 1, ['account', 'label', 'receipt', 'contract', 'telemetry', 'document'], 1),
    literal('heading', 'visible_text', 2, x.heading, 1),
    literal('visible-fragment', 'visible_text', 2, x.visible, 2, true),
  ];
  if (x.obscured) {
    checks.push(any('unknown', 'unknowns', 6, ['unknown', 'unreadable', 'blurred', 'smudged', 'redacted', 'cannot read'], 3, true));
    checks.push(any('no-guess', 'visual_reasoning', null, [x.visible], 1));
  }
  return define(level, 'uncertainty-calibration', x.heading, `Which characters are actually legible, and which information must remain unknown?`, { kind: 'unknown', ...x }, checks, `Transcribe only ${x.visible}${x.obscured ? ` and explicitly say ${x.obscured}` : ''}.`, level === 1 ? 0.68 : 0.74);
}

const FAMILIES = [
  authCase,
  searchCase,
  checkoutCase,
  validationCase,
  modalCase,
  toastCase,
  loadingCase,
  consentCase,
  dashboardCase,
  chartCase,
  tableCase,
  emailCase,
  kanbanCase,
  calendarCase,
  travelCase,
  galleryCase,
  multilingualCase,
  occlusionCase,
  securityCase,
  unknownCase,
];

export const CASES = Object.freeze(DIFFICULTIES.flatMap(({ level }) => FAMILIES.map(fn => fn(level)))
  .map((entry, index) => ({ ...entry, id: String(index + 1).padStart(3, '0') })));

export { DIFFICULTIES };
