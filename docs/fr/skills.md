# Compétences

Une compétence est un texte d'instructions de confiance — éventuellement
accompagné de son propre manifeste d'outils — que WebBrain charge dans une
exécution **uniquement quand c'est pertinent**. Gérez-les dans Paramètres →
Compétences, où vous pouvez importer un texte ou une URL de compétence, ou
retirer n'importe quelle compétence intégrée.

## Fonctionnement du chargement

Les exécutions Mid et Full reçoivent un petit catalogue de compétences
éligibles : ID, nom, résumé et intentions sémantiques canoniques optionnelles.
Les instructions complètes ne sont ajoutées au prompt système qu'après
activation de la compétence pour l'exécution en cours, via `load_skill`. **Le
niveau Compact désactive entièrement les compétences** — pas de chargeur, pas de
prompt de compétence, pas d'outils de compétence.

Les compétences importées sont copiées dans le stockage local du navigateur.

## Métadonnées

Un bloc JSON `webbrain-skill` optionnel peut déclarer :

| Champ | Signification |
|---|---|
| `summary` | 200 caractères maximum |
| `modes` | `ask`, `act` et/ou `dev` |
| `intents` | Jusqu'à six intentions canoniques comme `verification_code` ou `public_media_download` |

Les intentions sont des indices de *sens* interlangues destinés au LLM, pas une
correspondance littérale de mots-clés. Les compétences sans métadonnées
déduisent leur résumé du premier paragraphe de prose, n'ont aucune intention
déduite, et utilisent Act/Dev par défaut.

## Outils de compétence

Une compétence peut exposer des outils HTTP en lecture seule, ou des outils de
tâche de téléchargement de courte durée, via un manifeste JSON `webbrain-tools`.

**Importer une compétence constitue la frontière de confiance de son point de
terminaison HTTPS déclaré.** Les outils de téléchargement d'une compétence
s'exécutent toujours en mode Act et passent par le contrôle de permission
Téléchargements habituel avant d'enregistrer des fichiers. Les résultats
d'outils issus de contenu tiers doivent être marqués
`resultPolicy: "untrusted"` afin d'être encapsulés comme des données et non
comme des instructions.

Les outils de compétence ne font pas partie de la
[matrice des outils](agent-tools.md#matrice-des-outils) statique : avant le
chargement d'une compétence, ou après son retrait, ses outils sont absents.

## Compétences intégrées

Les deux sont **activées par défaut** et peuvent être retirées dans Paramètres →
Compétences.

### FreeSkillz.xyz

Peut exposer `read_youtube_transcript`, `fetch_nytimes_article`,
`resolve_public_media` et `download_public_media` via son manifeste. Sur les
onglets NYTimes / The Athletic, elle est préactivée pour l'exécution en cours
afin qu'un `pageGate` bloquant structuré puisse router directement vers le repli
d'article sans identifiants.

### Assistant OTP / code de vérification

Ne se charge que pour les demandes pertinentes et ne déclare aucun outil réseau.
Sur l'onglet de l'exécution active, il privilégie le texte sélectionné ou un
sous-arbre borné de l'arbre d'accessibilité, retient le code de service pertinent
le plus récent, exclut l'accès aux SMS et aux applications natives, et respecte
la gestion stricte des secrets.

Lorsqu'il est utilisé, le contenu de page délimité et le code sont inclus dans la
requête normale envoyée au fournisseur LLM que vous avez configuré. Si
**l'enregistrement des traces** est activé, les résultats d'outils bruts et les
réponses du modèle sont également stockés localement jusqu'à la suppression de
ces traces.

## Voir aussi

- [Outils de l'agent](agent-tools.md) — niveaux, modes et matrice complète
- [Confidentialité et flux de données](privacy-and-data-flow.md)
- [Architecture](architecture.md) — compétences et exposition dynamique des
  outils dans le flux d'un tour
