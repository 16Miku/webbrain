# Adaptateurs de site — Comment en écrire un

Les adaptateurs de site sont la **contribution la plus recherchée n°1** (voir CONTRIBUTING.md). Ils injectent des conseils courts et soigneusement rédigés dans le premier message de l'agent lorsqu'il opère sur un site connu. Le but N'est PAS d'encoder chaque sélecteur (ceux-ci vieillissent mal), mais de capturer les particularités non évidentes qui coûtent à un LLM plusieurs appels d'outils infructueux pour les découvrir par lui-même.

---

## Comment ils fonctionnent

### Fichier

`src/chrome/src/agent/adapters.js` (et `src/firefox/src/agent/adapters.js` — les deux builds partagent le même contenu de fichier, refléter les modifications dans les deux).

### Correspondance

`getActiveAdapter(url)` parcourt le tableau `ADAPTERS` et retourne le **premier** adaptateur dont `match(url)` retourne `true` :

```js
export function getActiveAdapter(url) {
  if (!url) return null;
  for (const a of ADAPTERS) {
    try {
      if (a.match(url)) return a;
    } catch (e) { /* ignorer les matchers mal formés */ }
  }
  return null;
}
```

Un seul adaptateur se déclenche à la fois, donc le coût en tokens est fixe quel que soit le nombre total d'adaptateurs.

Pour les plateformes fédérées comme Mastodon, gardez les formes d'URL génériques prudentes.
Les chemins simples `/@user` et `/users/user` apparaissent sur de nombreux sites non-Mastodon, et le
matcher actuel ne voit que la chaîne d'URL. Un travail futur pourrait intégrer
[`instances.social`](https://instances.social/api/doc/) comme une recherche basée sur des compétences
ou une liste d'instances connues maintenue afin que les hôtes candidats puissent être vérifiés avant
d'injecter les conseils Mastodon plus largement.

### Moment de l'injection

- **Premier tour** : les `notes` de l'adaptateur sont ajoutées au premier message utilisateur dans `_enrichUserMessageWithCurrentPage()`.
- **Navigation en cours de conversation** : si l'utilisateur navigue vers une URL correspondant à un autre adaptateur, l'agent injecte un message `[Contexte du site changé → maintenant sur <name>]`. Contrôlé par `_maybeReinjectAdapter()`.

### Préambule universel

`UNIVERSAL_PREAMBLE` est injecté avec chaque invite système lorsque `useSiteAdapters` est activé. Il couvre les bannières de cookies/consentement et les paywalls — deux motifs qui apparaissent sur le web public et qui amènent les LLM à faire de mauvaises suppositions.

---

## Format de l'adaptateur

```js
{
  name: 'my-site',          // identifiant court unique
  category: 'general',       // 'general' | 'finance'
  match: (url) => /^https?:\/\/(www\.)?example\.com\//.test(url),
  notes: `
- Point 1 : le conseil actionnable.
- Point 2 : un autre conseil.
- Gardez-les COURTS (4 à 8 points max). Chaque adaptateur coûte des tokens à chaque premier tour.
`,
}
```

### Champs

| Champ | Type | Description |
|---|---|---|
| `name` | string | Identifiant unique pour l'adaptateur. Utilisé dans les en-têtes d'invite système. |
| `category` | `'general'` ou `'finance'` | `'finance'` ajoute une bannière `[FINANCE / ENJEUX ÉLEVÉS]` à l'en-tête et déclenche des consignes de sécurité supplémentaires dans l'invite système. |
| `match` | `(url) => boolean` | Retourne `true` quand l'adaptateur doit se déclencher pour cette URL. L'expression régulière est préférée — gardez-la assez spécifique pour éviter les faux positifs. |
| `notes` | string | Conseils sous forme de puces injectés dans le premier message utilisateur. **Maximum 4 à 8 lignes.** Voir les consignes de style ci-dessous. |

### Ordre

Les adaptateurs sont ordonnés par catégorie/site dans le tableau `ADAPTERS`. **Les adaptateurs Finance doivent être placés AVANT `finance-generic`**, car `finance-generic` utilise une regex large qui masquerait les adaptateurs spécifiques. Actuellement : Stripe → Coinbase → Robinhood → TradingView → finance-generic.

---

## Rédiger des notes efficaces

### À FAIRE

- **Décrire la FORME de la page** plutôt que des sélecteurs littéraux. Les sélecteurs vieillissent ; les structures de mise en page des pages sont stables plus longtemps.
  ```js
  // Bon
  notes: `- Le composeur est un div contenteditable, pas un textarea.`
  // Mauvais
  notes: `- Cliquer sur div[contenteditable="true"] pour composer.`
  ```
- **Nommer l'outil à privilégier** : orienter vers les outils AX (`click_ax`, `set_field`) plutôt que les outils hérités (`click({text})`, `type_text`).
- **Signaler les subtilités destructrices** : "Le bouton 'Annuler' sur la page de facturation arrête immédiatement le service — lire la modale de confirmation."
- **Signaler les pièges de navigation SPA** : "Les modifications de paramètres s'enregistrent automatiquement ; naviguer via le bouton retour du navigateur annule les modifications non sauvegardées."
- **Signaler les superpositions persistantes** : "La bannière de cookies réapparaît toutes les 24h. Ne décrivez pas son texte comme contenu de la page."
- **Signaler les conteneurs virtualisés** : "La timeline est virtualisée — faites défiler pour charger plus d'éléments."
- **Garder chaque puce comme un conseil unique et actionnable**. Le modèle a un contexte limité et survolera.

### À NE PAS FAIRE

- **Ne pas encoder de sélecteurs CSS** — ils changent à chaque refonte du site.
- **Ne pas écrire plus de 8 puces** — le coût en tokens s'accumule à chaque conversation.
- **Ne pas inclure de conseils évidents** que le modèle trouverait en lisant la page (ex. "le bouton de soumission soumet le formulaire").
- **Ne pas dupliquer le préambule universel** (conseils sur les cookies/paywalls).
- **Ne pas ajouter d'adaptateurs alphabétiques ou de référence** — chaque adaptateur doit fournir de véritables conseils qui évitent au modèle au moins 2 à 3 appels d'outils par essai-erreur.

### Exemple : Bon adaptateur

```js
{
  name: 'twitter',
  category: 'general',
  match: (url) => /^https?:\/\/(www\.)?(twitter\.com|x\.com)\//.test(url),
  notes: `
- Le composeur est un contenteditable, pas un textarea. Le nombre de caractères est appliqué côté client.
- La timeline est virtualisée — les tweets disparaissent du DOM. Utilisez la recherche, pas le défilement, pour trouver un tweet.
- Les icônes "Répondre", "Retweeter", "J'aime" sont sous chaque tweet.
- Citer un tweet vs reposter : l'icône de retweet ouvre un menu avec les deux options.
`,
}
```

### Exemple : Adaptateur Finance

```js
{
  name: 'stripe',
  category: 'finance',
  match: (url) => /^https?:\/\/(dashboard\.)?stripe\.com\//.test(url),
  notes: `
- Bascule LIVE vs TEST en haut à droite. Toujours confirmer le mode.
- Les remboursements sont partiels par défaut — vérifier le montant attentivement.
- La suppression d'un client est irréversible.
- ABONNEMENTS : invites de prorata ("Facturer le montant proratisé immédiatement" vs "Sur la prochaine facture").
`,
}
```

---

## Tester votre adaptateur

1. **Ajouter l'adaptateur** à la fois dans `src/chrome/src/agent/adapters.js` et `src/firefox/src/agent/adapters.js`.
2. **Vérifier la correspondance** : naviguez vers l'URL cible dans un navigateur avec l'extension chargée. Ouvrez la console DevTools sur le service worker / la page d'arrière-plan et exécutez :
    ```js
    import { getActiveAdapter, listAdapters } from './agent/adapters.js';
    console.log(getActiveAdapter('https://example.com/some-page'));
    ```
3. **Vérifier que les notes apparaissent** : en mode Ask, Act ou Dev, tapez une instruction simple (ex. "que contient cette page ?"). Ouvrez le mode verbeux du panneau latéral et confirmez que le premier message utilisateur contient `[Conseils pour le site <name>]` avec vos notes.
4. **Vérifier qu'un SEUL adaptateur se déclenche** : naviguez vers une URL qui pourrait correspondre à plusieurs matchers. Vérifiez que la première correspondance gagne et qu'aucune autre ne s'infiltre.
5. **Tester la réinjection lors de la navigation** : commencez une conversation sur un site non adapté, puis naviguez vers votre site adapté. Confirmez qu'un message `[Contexte du site changé]` apparaît.

### URLs de test manuel

Ouvrez chaque site adapté et vérifiez :
- Que l'adaptateur se charge sur la page 1 (pas lors d'un changement de route SPA)
- Que les notes sont utiles (n'induisent pas le modèle en erreur)
- Que le modèle ne suit pas d'instructions obsolètes

---

## Liste de vérification pour ajouter un nouvel adaptateur

- [ ] Ajouter l'objet adaptateur au tableau `ADAPTERS` dans `src/chrome/src/agent/adapters.js`
- [ ] Refléter exactement la même modification dans `src/firefox/src/agent/adapters.js`
- [ ] S'assurer que la regex `match()` est spécifique et ne masque pas les adaptateurs voisins
- [ ] Si `category: 'finance'`, le placer AVANT `finance-generic` dans le tableau
- [ ] Vérifier que les notes sont concises (4 à 8 puces)
- [ ] Tester la correspondance avec `getActiveAdapter(url)`
- [ ] Tester de bout en bout avec l'extension chargée
- [ ] Si l'adaptateur cible un marché non anglophone, ajouter des indications d'étiquettes localisées (voir l'adaptateur WordPress pour un exemple d'annotation d'étiquettes d'interface non anglaises)
