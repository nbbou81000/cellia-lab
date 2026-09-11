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

## Réglages

| Où | Quoi |
|---|---|
| Secret `MISTRAL_API_KEY` | clé API Mistral (obligatoire) |
| Secret `NTFY_TOPIC` | notification ntfy à chaque veille (facultatif) |
| `scripts/sources.json` | sources : `category`, `kind`, `max_per_run`, `ai_filter`, `disabled`, `images` (`false` pour ne pas reprendre les illustrations d'une source) |
| `.github/workflows/daily.yml` | horaires (5 h 30 et 16 h 30 UTC) |
| Variable `MISTRAL_MODEL` dans `fetch.js` | modèle (`mistral-small-2506` par défaut) |

Administration depuis le site : `index.html?admin=true` (token GitHub fine-grained :
Contents + Actions en écriture sur ce dépôt).
