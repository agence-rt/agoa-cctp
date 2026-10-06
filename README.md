# AGOA CCTP

Application Windows de l'agence : rédaction des **CCTP** et **BPU**, consultation des entreprises
(BPU Excel, dépôt des devis dans Dropbox), import des offres, comparatif et synthèse pour les copropriétaires.

- **Fichier d'affaire** : `.cctp` (double-clic pour ouvrir ; enregistrement automatique dans le fichier).
  Les anciens fichiers `.dce` s'ouvrent aussi.
- **Données du poste** : `%APPDATA%\AGOA CCTP` (copie de secours `.bak` à chaque enregistrement).
- **Icône** : carré rouge, « CCTP » en blanc gras.
- **Mises à jour** : au démarrage, l'application interroge les Releases du dépôt privé `agence-rt/agoa-cctp`
  (fenêtre « Mise à jour disponible » avec les nouveautés, « Mettre à jour maintenant » / « Plus tard »).
  Menu *Aide, Rechercher des mises à jour…* pour une vérification manuelle.

## Activer les mises à jour sur un poste (dépôt privé)

Le dépôt est privé : chaque poste a besoin, une seule fois, d'un jeton GitHub en lecture seule.

1. GitHub, *Settings, Developer settings, Personal access tokens, Fine-grained tokens, Generate new token*.
2. *Repository access* : seulement `agence-rt/agoa-cctp`. *Permissions* : **Contents : Read-only**.
3. Dans l'application : *Aide, Accès aux mises à jour (jeton GitHub)…* et coller le jeton.
   Il est stocké chiffré (compte Windows) dans `%APPDATA%\AGOA CCTP`.

## Publier une nouvelle version

```
npm run deploy -- "Description de la mise à jour"
git push
```

`deploy` passe au déploiement suivant (version `0.<n>.0`), met à jour l'interface, `DEPLOIEMENTS.md`
et les notes, puis crée le commit. Au push sur `main`, GitHub Actions fabrique l'installateur
(`AGOA-CCTP-Setup-<version>.exe`) et publie la Release `v<version>`.

## Développement

```
npm install
npm start      # lance l'application
npm run dist   # fabrique l'installateur dans dist/
```

L'interface est un fichier unique, `app/index.html`. Les bibliothèques Excel et PDF sont embarquées
dans `app/vendor` (fonctionnement hors ligne). La liaison Ragic passe par une clé API
(*Aide, Clé API Ragic…*).
