# CelliA Lab — Veille IA

Veille francophone sur l'intelligence artificielle : avancées, risques et enjeux, à partir de 30 sources
scientifiques, institutionnelles et de laboratoires, réécrites et vulgarisées par Mistral.

Site : https://nbbou81000.github.io/cellia-lab/

## Fonctionnement

Deux fois par jour, GitHub Actions lance `scripts/fetch.js` :

1. lecture des flux listés dans `scripts/sources.json` (fenêtre de 72 h) ;
2. tri : doublons, plafond par source, alternance des catégories, filtre IA pour les sources généralistes ;
3. récupération du texte complet (moins de 120 mots → article ignoré) ;
4. repérage des illustrations de l'article (figures légendées, sans logos, vignettes ni crédits seuls) ;
5. réécriture par Mistral : titre, accroche, corps, catégorie, tonalité (avancée / enjeu / alerte),
   glossaire, encart « À nuancer », et placement des illustrations utiles avec une légende en français ;
6. publication dans `dist/` (articles conservés 30 jours).

`dist/seen.json` mémorise les articles déjà examinés pour ne jamais les renvoyer à Mistral.

## Suivi des tokens

Chaque appel à Mistral renvoie un compte exact de tokens consommés (`usage.prompt_tokens`,
`completion_tokens`, `total_tokens`), y compris pour les articles écartés après lecture. Ces
chiffres sont cumulés dans `dist/usage.json` : le détail du dernier run et le cumul depuis le
premier run. Une estimation de coût en dollars y est ajoutée, calculée à partir d'un tarif par
million de tokens réglable (`MISTRAL_PRICE_INPUT_PER_1M` / `MISTRAL_PRICE_OUTPUT_PER_1M`, par
défaut le tarif public de Mistral Small au 11/09/2026 — à revérifier sur mistral.ai/pricing en
cas de changement de modèle ou de tarif).

Ces statistiques sont visibles à trois endroits :
- dans le résumé de chaque run, onglet **Actions** du dépôt ;
- dans le panneau admin du site (`?admin=true`), avec un mini-graphique et un lien vers la page complète ;
- sur une page dédiée, **`stats.html`**, accessible depuis le lien « 📊 Stats » en pied de page.

`stats.html` combine automatiquement CelliA Lab et **CelliA** (`../cellia/dist/usage.json`, lu depuis le même
domaine `github.io`, sans configuration) : tokens et coût cumulés des deux sites, répartition par catégorie
(CelliA Lab) et par source (les deux sites), un graphique par site, l'historique complet repliable, et l'agrégat
« ce mois-ci ». CelliA doit avoir été mis à jour avec le même système de suivi pour apparaître — sinon la page
affiche uniquement CelliA Lab, sans erreur.

**Relevé manuel.** Le coût estimé ici est basé sur un tarif public fixe et ne capture pas exactement la
facturation réelle de Mistral (devise, palier, arrondis). Pour un repère fiable, ouvre `mistral.ai/usage`,
note le montant en euros, et saisis-le dans le panneau admin de CelliA Lab, section **📊 Tokens Mistral** →
« Relevé manuel ». Il est stocké dans `dist/usage.json` (`baseline`) et affiché sur `stats.html` à côté du
suivi automatique — les deux nombres restent séparés plutôt que sommés, car ils ne sont pas dans la même devise.

## Réglages

| Où | Quoi |
|---|---|
| Secret `MISTRAL_API_KEY` | clé API Mistral (obligatoire) |
| Secret `NTFY_TOPIC` | notification ntfy à chaque veille (facultatif) |
| `scripts/sources.json` | sources : `category`, `kind`, `max_per_run`, `ai_filter`, `disabled`, `images` (`false` pour ne pas reprendre les illustrations d'une source) |
| Variables `MISTRAL_PRICE_INPUT_PER_1M` / `MISTRAL_PRICE_OUTPUT_PER_1M` | tarif Mistral en \$ par million de tokens, pour l'estimation de coût (Settings → Secrets and variables → Actions → onglet **Variables**) |
| `.github/workflows/daily.yml` | horaires (5 h 30 et 16 h 30 UTC) |
| Variable `MISTRAL_MODEL` dans `fetch.js` | modèle (`mistral-small-2506` par défaut) |

Administration depuis le site : `index.html?admin=true` (token GitHub fine-grained :
Contents + Actions en écriture sur ce dépôt).
