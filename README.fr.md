# AutoRegister — inscription automatique aux cours McGill Minerva

[English](README.md) · [中文](README.zh.md) · **Français**

Une application web locale qui surveille les sections de cours sur McGill Minerva
et vous inscrit (ou vous met en liste d'attente) automatiquement dès qu'une place
se libère. Elle réutilise votre **session de navigateur déjà connectée** (la 2FA
n'est donc pas redemandée), interroge à intervalle avec gigue (jitter) pour rester
sous les limites d'opérations quotidiennes de l'école, et décide entre inscription
/ liste d'attente / aucune action à partir du nombre de places de chaque section —
en agissant automatiquement ou en vous avertissant simplement.

> ⚠️ Automatisation personnelle pour **votre propre** inscription. À utiliser de
> manière responsable et conformément aux [conditions d'utilisation de McGill](https://www.mcgill.ca/secretariat/files/secretariat/politique_sur_lutilisation_responsable_des_ressources_en_technologie_de_linformation_de_luniversite_mcgill_.pdf). Un
> mode **dry-run (répétition)** (ci-dessous) permet de répéter en toute sécurité
> avant de le laisser agir pour de vrai. **Veuillez lire la section
> « Utilisation responsable et éthique » ci-dessous avant de commencer.**

## ⚠️ Utilisation responsable et éthique — à lire

Cet outil communique avec les **serveurs Minerva en service de McGill**. Sonder
trop souvent gaspille des ressources universitaires partagées et peut dégrader le
service pour tout le monde. Veuillez l'utiliser **de manière éthique et modérée** :
gardez l'intervalle de sondage par défaut (ou plus long), ne rafraîchissez pas à
outrance, et ne l'exécutez jamais plus agressivement que nécessaire.

**Avis officiel de McGill sur les logiciels d'inscription automatisée**
([source](https://www.mcgill.ca/students/courses/add/problems)) :

> McGill déconseille l'utilisation de logiciels qui tentent automatiquement et de
> façon répétée de s'inscrire à des sections de cours. Si un certain nombre
> cumulatif de tentatives d'inscription est effectué pour une session donnée (au
> moyen d'un logiciel d'inscription ou manuellement), vous serez bloqué de toutes
> les fonctions d'inscription pour cette session dans Minerva. Le cas échéant, vous
> devrez contacter le Service Point pour faire rétablir vos droits d'inscription,
> ce qui peut prendre plusieurs jours ouvrables.
>
> Les étudiants qui choisissent d'utiliser un logiciel d'inscription automatisée
> sont responsables d'assurer leur conformité avec la [Politique sur l'utilisation
> responsable des ressources en technologie de l'information de l'Université
> McGill](https://www.mcgill.ca/secretariat/files/secretariat/politique_sur_lutilisation_responsable_des_ressources_en_technologie_de_linformation_de_luniversite_mcgill_.pdf).

Vous utilisez cet outil **à vos propres risques** et êtes seul responsable du
respect de cette politique. Soyez prévenant envers les autres — ne surconsommez
pas les ressources publiques.

**Gratuit pour un usage personnel uniquement.** Ce projet est fourni gratuitement
pour un usage personnel et non commercial. **Toute utilisation commerciale ou à
but lucratif, sous quelque forme que ce soit, est interdite.** Voir
[LICENSE](LICENSE) (PolyForm Noncommercial 1.0.0).

## Première fois ? Installation pas à pas (aucune expérience de la ligne de commande requise)

Cette section vous guide depuis zéro — vous n'avez **pas** besoin de savoir
utiliser un terminal. Si vous avez déjà fait ce genre de chose, les sections
concises [Prérequis](#prérequis) / [Installation](#installation) /
[Lancer](#lancer) ci-dessous suffisent.

### 1. Installer Node.js (une seule fois)

Cette application fonctionne avec **Node.js**. Allez sur **https://nodejs.org**,
cliquez sur le gros bouton vert **LTS**, ouvrez le fichier téléchargé, puis
cliquez sur **Suivant / Next** tout au long de l'installateur (les options par
défaut conviennent). Cela installe aussi `npm`, utilisé par les commandes plus
bas. Sans lui, ces commandes n'existent pas.

### 2. Télécharger l'application

1. Ouvrez la page du projet :
   **https://github.com/DLsnows/McGill-Minerva-Auto-Register**
2. En haut à gauche, le sélecteur de branche devrait afficher **`prod`** — c'est
   la branche par défaut, donc c'est déjà le cas. (`prod` est la version à
   télécharger.)
3. Cliquez sur le bouton vert **`< > Code`**, puis sur **Download ZIP**.
4. Trouvez le fichier `.zip` téléchargé (généralement dans votre dossier
   **Téléchargements / Downloads**). Sous **Windows**, faites un clic droit
   dessus → **Extraire tout** ; sous **Mac**, double-cliquez dessus. Vous obtenez
   un dossier nommé quelque chose comme `McGill-Minerva-Auto-Register-prod`.
   Déplacez-le dans un endroit facile à trouver, comme le **Bureau**.

### 3. Ouvrir un terminal *dans* ce dossier

Un « terminal » est simplement une fenêtre où vous tapez des commandes. Il doit
pointer vers le dossier de l'application — c'est ce que fait la commande `cd`
(« change directory / changer de dossier »). Pour éviter de taper le chemin
complet, le plus simple est d'**y glisser le dossier** :

**Windows :**
1. Cliquez sur **Démarrer**, tapez **PowerShell**, et appuyez sur **Entrée**. Une
   fenêtre s'ouvre.
2. Tapez `cd` suivi d'**un espace** (n'appuyez pas encore sur Entrée).
3. **Glissez le dossier de l'application** depuis le Bureau sur la fenêtre
   PowerShell — elle colle le chemin complet du dossier pour vous.
4. Appuyez sur **Entrée**. Le texte à gauche se termine maintenant par le nom du
   dossier, ce qui signifie que vous êtes « à l'intérieur ».

**Mac :**
1. Ouvrez **Terminal** (appuyez sur **⌘ + Espace**, tapez **Terminal**, appuyez
   sur **Entrée**).
2. Tapez `cd` suivi d'**un espace**.
3. **Glissez le dossier de l'application** sur la fenêtre Terminal pour coller son
   chemin.
4. Appuyez sur **Entrée**.

### 4. Installer et démarrer (la première fois)

Tapez chaque ligne ci-dessous, appuyez sur **Entrée** après chacune, et attendez
qu'elle se termine avant de taper la suivante :

```bash
npm install                       # télécharge ce dont l'application a besoin (une fois, ~1 min)
npx playwright install chromium   # télécharge le navigateur qu'elle contrôle (une fois)
npm run serve                     # démarre l'application
```

Pendant que l'application tourne, **gardez ses fenêtres ouvertes** : cette fenêtre
de terminal (c'est **elle** l'application — la fermer arrête l'application) et,
une fois connecté, la fenêtre du navigateur Chromium qu'elle ouvre pour votre
session McGill (la fermer déconnecte l'automatisation). Vous pouvez les réduire,
mais ne les fermez pas.

**Pour arrêter l'application** quand vous avez terminé, cliquez sur la fenêtre du
terminal et appuyez sur **Ctrl + C** (maintenez **Ctrl**, appuyez sur **C**) —
c'est la bonne façon de quitter. Pour la relancer plus tard, exécutez à nouveau
`npm run serve`.

> **À chaque fois ensuite**, il vous suffit d'ouvrir le terminal dans le dossier
> (étape 3) et d'exécuter `npm run serve`. Les deux commandes d'installation ne
> servent qu'une seule fois.

### 5. Ouvrir dans le navigateur

Ouvrez **n'importe quel** navigateur (Chrome, Edge, Safari…) et allez à :

**http://127.0.0.1:4575**

C'est l'application. Suivez maintenant les étapes [Lancer](#lancer) ci-dessous —
connectez-vous, ajoutez vos cours, et appuyez sur **Start all**.

## Prérequis

- **Node.js 22+** — installe aussi `npm`. Pas encore Node ? Téléchargez
  l'installateur LTS depuis le site officiel : **https://nodejs.org**. (Sans Node
  installé, les commandes `npm` / `npx` ci-dessous n'existent pas.)
- Le navigateur Chromium de Playwright (téléchargement unique — voir Installation).

## Installation

```bash
npm install                       # installer les dépendances
npx playwright install chromium   # une fois : télécharger le Chromium piloté par Playwright
```

> `npx playwright install chromium` ne télécharge que la version de Chromium dont
> l'application a besoin (pas les trois navigateurs). C'est la façon fiable de
> l'installer — ça fonctionne depuis la racine du dépôt quelle que soit la
> disposition du workspace.

## Lancer

```bash
npm run serve
```

Ouvrez ensuite **http://127.0.0.1:4575** et :

1. Onglet **Session** → *Open browser & log in*. Une fenêtre Chromium s'ouvre ;
   connectez-vous via le SSO de McGill une fois. (McGill n'autorise **qu'une seule
   session active** — se connecter ailleurs évince l'automatisation.)
2. Onglet **Courses** → ajoutez le(s) cours à surveiller. Survolez le `?` de
   chaque champ pour de l'aide ; le **Term** est le code de session Minerva
   (Hiver = …01, Été = …05, Automne = …09, p. ex. Hiver 2027 = `202701`). La
   faculté (Faculty) est obligatoire (p. ex. `Faculty of Science`).
3. Onglet **Settings** → intervalle de sondage et gigue, budgets quotidiens de
   requêtes/inscriptions, canaux de notification (bureau / son / courriel — voir
   [`docs/EMAIL_SETUP.md`](docs/EMAIL_SETUP.md)), et le mode **Dry-run**.
4. **Dashboard** → appuyez sur **Start all** pour commencer la surveillance. (Au
   démarrage, chaque cours est **en pause**, et *Start all* est désactivé tant que
   vous n'êtes pas connecté — donc rien n'est sondé tant que vous ne le lancez pas
   explicitement. Vous pouvez aussi **Pause / Resume** chaque cours individuellement
   sur sa carte.) La console en direct diffuse chaque sondage → décision → action,
   le plus récent en haut, avec un bouton **Clear**. Utilisez **⚡ Register now**
   sur une carte pour tenter ce cours immédiatement.

La langue peut être changée à tout moment (中文 / EN / FR) depuis la barre
supérieure.

## Dry-run (répétition)

Activez **Dry-run** dans Settings pour répéter tout le pipeline sur le vrai
Minerva **sans jamais soumettre d'inscription**. Le planificateur se connecte,
sonde et décide quand même — mais là où il inscrirait/mettrait en liste d'attente,
il enregistre plutôt `DRY-RUN: would REGISTER <CRN>` et laisse le cours en
surveillance. Surveillez la console pour confirmer qu'il se comporte comme prévu,
puis désactivez le dry-run pour le laisser agir pour de vrai.

## Comment ça marche

- **Décision** : à partir de `cap/act/rem` et `wlcap/wlact/wlrem` → REGISTER
  (place libre), WAITLIST (place en liste d'attente), ou NO-OP.
- **Rythme** : un intervalle de base (30 min par défaut) ± gigue, étiré pour
  éviter d'épuiser le **budget de requêtes** quotidien (100 par défaut) et le
  **budget d'inscriptions** (20 par défaut) — pour paraître humain et respecter
  les limites de l'école.
- **Par cours** : `auto` inscrit/met en liste d'attente automatiquement ;
  `notify` vous avertit seulement.

## Dépannage

**Cliquer sur *Open browser & log in* affiche « Logged out » immédiatement et
aucune fenêtre Chromium ne s'ouvre.** Cela signifie que le Chromium de Playwright
n'est pas installé. Le flux de connexion lance une vraie fenêtre Chromium ; si le
binaire du navigateur est absent, le lancement échoue et la session retombe
directement sur *Logged out* sans fenêtre. Installez le navigateur une fois, puis
réessayez :

```bash
npx playwright install chromium
```

(Si vous avez exécuté `npm install` mais sauté le téléchargement du navigateur
Playwright, c'est la cause la plus fréquente.)

## Développement

```bash
npm run lint
npm run typecheck
npm run test          # Vitest (projets node et web/jsdom)
npm run build:web     # build web de production (servi par le serveur)
```

Monorepo Node + TypeScript (npm workspaces) : `packages/{shared,server,web}` —
Playwright (automatisation du navigateur), Fastify + WebSocket (API), interface
React + Vite + Tailwind (thème sombre vitré, i18n).

Conception et plans : [`docs/superpowers/`](docs/superpowers/).
