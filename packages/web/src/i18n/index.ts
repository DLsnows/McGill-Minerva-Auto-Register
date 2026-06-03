import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

export const LANGS = ['zh', 'en', 'fr'] as const;
export type Lang = (typeof LANGS)[number];

const en = {
  nav: { dashboard: 'Dashboard', courses: 'Courses', session: 'Session', settings: 'Settings' },
  ticker: {
    watching: 'Watching', interval: 'Interval', minSuffix: '± {{j}} min',
    todayQuery: 'Today · Query', todayRegister: 'Today · Register', session: 'Session',
    sessActive: 'Active', sessLoggingIn: 'Logging in', sessLoggedOut: 'Logged out', sessUnknown: 'Unknown',
  },
  mode: { notify: 'Notify', auto: 'Auto', toggleAria: 'toggle mode' },
  scheduler: { running: 'Watching · running', stopped: 'Watching · stopped', start: '▶ Start', stop: '■ Stop' },
  status: { watching: 'WATCHING', waitlisted: 'WAITLISTED', registered: 'REGISTERED', paused: 'PAUSED', stopped: 'STOPPED', error: 'ERROR' },
  card: { registerNow: '⚡ Register now', running: '… running', lastPoll: 'last poll {{rel}}', notPolled: 'not polled yet' },
  console: { liveStream: 'live stream', reconnecting: 'reconnecting…' },
  form: {
    term: 'Term', subject: 'Subject', courseNumber: 'Course #', targetCrn: 'Target CRN',
    faculty: 'Faculty', label: 'Label', mode: 'Mode', modeAuto: 'auto', modeNotify: 'notify',
    required: 'Term, Subject, Faculty, Course # and Target CRN are required.', cancel: 'Cancel',
    ph: { term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', faculty: 'Faculty of Science', label: 'COMP 551' },
    help: {
      term: 'Term — Minerva term code; the last two digits are the season: Winter (Jan–Apr) = 01, Summer (May–Aug) = 05, Fall (Sep–Dec) = 09. e.g. Winter 2027 = 202701, Fall 2026 = 202609.',
      subject: 'Subject — the course subject code, e.g. COMP for Computer Science.',
      courseNumber: 'Course number — the number after the subject, e.g. 551 in COMP 551.',
      targetCrn: 'Target CRN — the 4-digit Course Reference Number of the exact section you want, e.g. 2347.',
      faculty: 'Faculty — the Minerva faculty/college (required for the search), e.g. Faculty of Science.',
      label: 'Label — an optional display name for this watch, e.g. COMP 551.',
      mode: 'Mode — auto registers/waitlists automatically when an opening appears; notify only alerts you.',
    },
  },
  dashboard: {
    watchedCourses: 'Watched Courses', liveConsole: 'Live Console',
    empty: 'No courses watched yet. Add one from the Courses tab.',
    sessionBanner: 'Session is not active — open the Session tab to log in so polling can run.',
    schedToggleFailed: 'Scheduler toggle failed.',
  },
  courses: {
    addACourse: 'Add a course', addCourse: 'Add course', managed: 'Managed courses',
    empty: 'No courses yet.', save: 'Save', edit: 'Edit', delete: 'Delete', opFailed: 'Operation failed.',
  },
  settings: {
    title: 'Settings', pollInterval: 'Poll interval (min)', jitter: 'Jitter (min)',
    queryBudget: 'Query budget / day', registerBudget: 'Register budget / day',
    desktop: 'Desktop', sound: 'Sound', email: 'Email',
    desktopAria: 'Desktop notifications', soundAria: 'Sound', emailAria: 'Email notifications',
    emailSection: 'Email (SMTP)', setupGuide: 'Setup guide ↗',
    smtpHost: 'SMTP host', smtpPort: 'SMTP port', smtpUser: 'SMTP user', smtpPass: 'SMTP pass', emailTo: 'Email to',
    saveSettings: 'Save settings', saved: 'Saved ✓', loading: 'Loading settings…',
    emailRequired: 'All email fields are required when email notifications are enabled.',
    saveFailed: 'Failed to save settings.',
  },
  session: {
    title: 'Session',
    stateAuthenticated: 'Authenticated', stateLoggingIn: 'Logging in', stateLoggedOut: 'Logged out', stateUnknown: 'Unknown',
    descAuthenticated: 'Authenticated — automation can run.',
    descLoggingIn: 'Logging in… a browser window should be open.',
    descLoggedOut: 'Logged out — log in to let polling run.',
    descUnknown: 'Unknown — log in to establish a session.',
    openAndLogin: 'Open browser & log in', loggingInBtn: 'Logging in…', loginFailed: 'Login failed',
    singleSessionNote: 'McGill allows one active session — logging in elsewhere will evict the automation.',
  },
};

const zh: typeof en = {
  nav: { dashboard: '主控台', courses: '课程', session: '会话', settings: '设置' },
  ticker: {
    watching: '监控中', interval: '间隔', minSuffix: '± {{j}} 分',
    todayQuery: '今日 · 查询', todayRegister: '今日 · 注册', session: '会话',
    sessActive: '已登录', sessLoggingIn: '登录中', sessLoggedOut: '已登出', sessUnknown: '未知',
  },
  mode: { notify: '提醒', auto: '自动', toggleAria: '切换模式' },
  scheduler: { running: '监控 · 运行中', stopped: '监控 · 已停止', start: '▶ 启动', stop: '■ 停止' },
  status: { watching: '监控中', waitlisted: '候补中', registered: '已注册', paused: '已暂停', stopped: '已停止', error: '错误' },
  card: { registerNow: '⚡ 立即执行', running: '… 执行中', lastPoll: '上次轮询 {{rel}}', notPolled: '尚未轮询' },
  console: { liveStream: '实时', reconnecting: '重连中…' },
  form: {
    term: '学期', subject: '科目', courseNumber: '课程号', targetCrn: '目标 CRN',
    faculty: '学院', label: '标签', mode: '模式', modeAuto: '自动', modeNotify: '提醒',
    required: '学期、科目、学院、课程号和目标 CRN 为必填。', cancel: '取消',
    ph: { term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', faculty: 'Faculty of Science', label: 'COMP 551' },
    help: {
      term: 'Term(学期）—— Minerva 学期代码,后两位代表季节:Winter 冬季(1–4 月）= 01、Summer 夏季(5–8 月）= 05、Fall 秋季(9–12 月）= 09。例:Winter 2027 = 202701、Fall 2026 = 202609。',
      subject: 'Subject(科目）—— 课程科目代码,如 COMP(计算机科学）。',
      courseNumber: 'Course #(课程号）—— 科目后面的编号,如 COMP 551 中的 551。',
      targetCrn: 'Target CRN(目标 CRN）—— 你想要的那一节课的 4 位课程参考号,如 2347。',
      faculty: 'Faculty(学院）—— Minerva 的学院,搜索时必填,如 Faculty of Science。',
      label: 'Label(标签）—— 该监控的可选显示名,如 COMP 551。',
      mode: 'Mode(模式）—— auto:出现空位时自动注册/候补;notify:仅提醒你。',
    },
  },
  dashboard: {
    watchedCourses: '监控的课程', liveConsole: '实时控制台',
    empty: '还没有监控任何课程。在「课程」页添加。',
    sessionBanner: '会话未激活 —— 打开「会话」页登录,轮询才能运行。',
    schedToggleFailed: '调度器开关失败。',
  },
  courses: {
    addACourse: '添加课程', addCourse: '添加', managed: '已管理课程',
    empty: '暂无课程。', save: '保存', edit: '编辑', delete: '删除', opFailed: '操作失败。',
  },
  settings: {
    title: '设置', pollInterval: '轮询间隔(分)', jitter: '抖动(分)',
    queryBudget: '每日查询预算', registerBudget: '每日注册预算',
    desktop: '桌面', sound: '声音', email: '邮件',
    desktopAria: '桌面通知', soundAria: '声音', emailAria: '邮件通知',
    emailSection: '邮件(SMTP)', setupGuide: '配置指南 ↗',
    smtpHost: 'SMTP 主机', smtpPort: 'SMTP 端口', smtpUser: 'SMTP 用户', smtpPass: 'SMTP 密码', emailTo: '收件人',
    saveSettings: '保存设置', saved: '已保存 ✓', loading: '加载设置中…',
    emailRequired: '启用邮件通知时,所有邮件字段均为必填。',
    saveFailed: '保存设置失败。',
  },
  session: {
    title: '会话',
    stateAuthenticated: '已登录', stateLoggingIn: '登录中', stateLoggedOut: '已登出', stateUnknown: '未知',
    descAuthenticated: '已登录 —— 自动化可运行。',
    descLoggingIn: '登录中…浏览器窗口应已打开。',
    descLoggedOut: '已登出 —— 登录后轮询才能运行。',
    descUnknown: '未知 —— 登录以建立会话。',
    openAndLogin: '打开浏览器并登录', loggingInBtn: '登录中…', loginFailed: '登录失败',
    singleSessionNote: 'McGill 仅允许一个活动会话 —— 在别处登录会把自动化挤下线。',
  },
};

const fr: typeof en = {
  nav: { dashboard: 'Tableau de bord', courses: 'Cours', session: 'Session', settings: 'Paramètres' },
  ticker: {
    watching: 'Surveillance', interval: 'Intervalle', minSuffix: '± {{j}} min',
    todayQuery: "Aujourd'hui · Requêtes", todayRegister: "Aujourd'hui · Inscriptions", session: 'Session',
    sessActive: 'Actif', sessLoggingIn: 'Connexion', sessLoggedOut: 'Déconnecté', sessUnknown: 'Inconnu',
  },
  mode: { notify: 'Notifier', auto: 'Auto', toggleAria: 'changer de mode' },
  scheduler: { running: 'Surveillance · active', stopped: 'Surveillance · arrêtée', start: '▶ Démarrer', stop: '■ Arrêter' },
  status: { watching: 'EN SURVEILLANCE', waitlisted: "LISTE D'ATTENTE", registered: 'INSCRIT', paused: 'EN PAUSE', stopped: 'ARRÊTÉ', error: 'ERREUR' },
  card: { registerNow: '⚡ Inscrire maintenant', running: '… en cours', lastPoll: 'dernier sondage {{rel}}', notPolled: 'pas encore sondé' },
  console: { liveStream: 'flux en direct', reconnecting: 'reconnexion…' },
  form: {
    term: 'Trimestre', subject: 'Matière', courseNumber: 'N° de cours', targetCrn: 'CRN cible',
    faculty: 'Faculté', label: 'Étiquette', mode: 'Mode', modeAuto: 'auto', modeNotify: 'notifier',
    required: 'Trimestre, Matière, Faculté, N° de cours et CRN cible sont requis.', cancel: 'Annuler',
    ph: { term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', faculty: 'Faculty of Science', label: 'COMP 551' },
    help: {
      term: 'Term (Trimestre) — code de trimestre Minerva; les deux derniers chiffres = la saison : Hiver (jan.–avr.) = 01, Été (mai–août) = 05, Automne (sept.–déc.) = 09. p. ex. Hiver 2027 = 202701, Automne 2026 = 202609.',
      subject: 'Subject (Matière) — le code de la matière, p. ex. COMP (informatique).',
      courseNumber: 'Course # (N° de cours) — le numéro après la matière, p. ex. 551 dans COMP 551.',
      targetCrn: 'Target CRN (CRN cible) — le numéro de référence à 4 chiffres de la section visée, p. ex. 2347.',
      faculty: 'Faculty (Faculté) — la faculté Minerva (requise pour la recherche), p. ex. Faculty of Science.',
      label: 'Label (Étiquette) — un nom d’affichage facultatif, p. ex. COMP 551.',
      mode: 'Mode — auto inscrit/met en liste d’attente automatiquement; notify vous alerte seulement.',
    },
  },
  dashboard: {
    watchedCourses: 'Cours surveillés', liveConsole: 'Console en direct',
    empty: "Aucun cours surveillé. Ajoutez-en un dans l'onglet Cours.",
    sessionBanner: 'Session inactive — ouvrez l’onglet Session pour vous connecter et lancer le sondage.',
    schedToggleFailed: 'Échec du basculement du planificateur.',
  },
  courses: {
    addACourse: 'Ajouter un cours', addCourse: 'Ajouter', managed: 'Cours gérés',
    empty: 'Aucun cours.', save: 'Enregistrer', edit: 'Modifier', delete: 'Supprimer', opFailed: "Échec de l'opération.",
  },
  settings: {
    title: 'Paramètres', pollInterval: 'Intervalle de sondage (min)', jitter: 'Gigue (min)',
    queryBudget: 'Budget de requêtes / jour', registerBudget: "Budget d'inscriptions / jour",
    desktop: 'Bureau', sound: 'Son', email: 'Courriel',
    desktopAria: 'Notifications de bureau', soundAria: 'Son', emailAria: 'Notifications par courriel',
    emailSection: 'Courriel (SMTP)', setupGuide: 'Guide de configuration ↗',
    smtpHost: 'Hôte SMTP', smtpPort: 'Port SMTP', smtpUser: 'Utilisateur SMTP', smtpPass: 'Mot de passe SMTP', emailTo: 'Destinataire',
    saveSettings: 'Enregistrer', saved: 'Enregistré ✓', loading: 'Chargement des paramètres…',
    emailRequired: 'Tous les champs courriel sont requis lorsque les notifications par courriel sont activées.',
    saveFailed: "Échec de l'enregistrement des paramètres.",
  },
  session: {
    title: 'Session',
    stateAuthenticated: 'Authentifié', stateLoggingIn: 'Connexion', stateLoggedOut: 'Déconnecté', stateUnknown: 'Inconnu',
    descAuthenticated: "Authentifié — l'automatisation peut s'exécuter.",
    descLoggingIn: 'Connexion… une fenêtre de navigateur devrait être ouverte.',
    descLoggedOut: 'Déconnecté — connectez-vous pour lancer le sondage.',
    descUnknown: 'Inconnu — connectez-vous pour établir une session.',
    openAndLogin: 'Ouvrir le navigateur et se connecter', loggingInBtn: 'Connexion…', loginFailed: 'Échec de la connexion',
    singleSessionNote: "McGill n'autorise qu'une seule session active — vous connecter ailleurs évincera l'automatisation.",
  },
};

const STORAGE_KEY = 'autoreg.lang';

export function detectInitialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && (LANGS as readonly string[]).includes(saved)) return saved as Lang;
  } catch {
    // localStorage unavailable (private mode) — fall through to navigator
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language.slice(0, 2) : 'en';
  if (nav === 'zh') return 'zh';
  if (nav === 'fr') return 'fr';
  return 'en';
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, zh: { translation: zh }, fr: { translation: fr } },
  lng: detectInitialLang(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

/** Switch language and persist the choice. */
export function setLang(lng: Lang): void {
  void i18n.changeLanguage(lng);
  try {
    localStorage.setItem(STORAGE_KEY, lng);
  } catch {
    // ignore persistence failures (private mode) — language still changes in-memory
  }
}

export default i18n;
