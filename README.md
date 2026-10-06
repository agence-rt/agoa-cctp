# AGOA CCTP

Application Windows de l'agence : rédaction des **CCTP** et **BPU**, consultation des entreprises
(BPU Excel, dépôt des devis dans Dropbox), import des offres, comparatif et synthèse pour les copropriétaires.

- **Fichier d'affaire** : `.cctp` (double-clic pour ouvrir ; enregistrement automatique dans le fichier).
  Les anciens fichiers `.dce` s'ouvrent aussi.
- **Données du poste** : `%APPDATA%\AGOA CCTP` (copie de secours `.bak` à chaque enregistrement).
- **Icône** : carré rouge, « CCTP » en blanc gras.
- **Mises à jour** : au démarrage, l'application interroge les Releases du dépôt `agence-rt/agoa-cctp`
  (le dépôt est public : aucun jeton nécessaire ; fenêtre « Mise à jour disponible » avec les nouveautés, « Mettre à jour maintenant » / « Plus tard »).
  Menu *Aide, Rechercher des mises à jour…* pour une vérification manuelle.

## Bibliothèque partagée

La bibliothèque d'articles est un fichier partagé, `bibliotheque-cctp.json`, dans le dossier Dropbox
`09 - BDD / IA / AGOA-CCTP`. L'application le retrouve seule (via l'installation Dropbox du poste) ;
sinon : *Aide, Bibliothèque partagée : choisir le dossier…*. Les modifications sont fusionnées entre postes
(un titre modifié par deux personnes en même temps est conservé en double, « ma version »).
Sur un article venu de la bibliothèque, le bouton orange **MAJ BDD** remplace le modèle.

## Fichiers `.cctp`

Une affaire est enregistrée uniquement dans son fichier `.cctp` (enregistrement automatique). L'application
ne garde que la liste des derniers fichiers ouverts, pas de copie des affaires.

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
