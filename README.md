# secheresse-wallonie

Relevés hebdomadaires de l'état des ressources en eau de distribution par
commune wallonne.

- `data/xml/`, `data/xlsx/` : fichiers `SIT_PROD_EAU_COMMUNE_AAAAMMJJ` bruts.
- `donnees/` : `etat.json`, `historique.json` et `communes.topojson`,
  reconstruits par l'Action à chaque ajout dans `data/`.

Source : SPW, Cortex, Aquawal et opérateurs de l'eau. Géométrie : Statbel,
secteurs statistiques au 1er janvier 2024.
