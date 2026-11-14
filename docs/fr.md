# Microsoft Teams pour Gladys

Intégration non officielle, sans lien avec Microsoft. **Jamais testée avec un vrai compte Teams** : elle
suit la documentation Microsoft (« Create an Incoming Webhook », webhooks Workflows). Vos retours sont les
bienvenus sur le forum de Gladys.

Gladys publie ses messages et alertes dans un canal ou une conversation Teams. **Envoi seul** :
l'intégration ne lit rien dans Teams, un message écrit dans Teams n'arrive pas à Gladys.

## Ce qu'il faut

Un **webhook Workflows** (Power Automate). Les anciens connecteurs Office 365 (connecteur « Incoming
Webhook », adresses `webhook.office.com`) ont été retirés par Microsoft en mai 2026 ; une telle adresse est
refusée avec une explication.

1. Dans Teams, ouvrez le canal (ou la conversation), puis **...** > **Workflows**.
2. Choisissez un modèle comme **Send webhook alerts to a channel** (ou **Send webhook alerts to a
   chat**), choisissez où publier, enregistrez.
3. Copiez le lien du webhook (il commence par `https://`, son hôte finit par `logic.azure.com` ou
   `api.powerplatform.com`).
4. Dans le déclencheur du workflow, **Who can trigger the flow?** doit valoir **Anyone** : Gladys ne se
   connecte pas à Microsoft. Un lien sans sa signature `sig=` est refusé avec cette explication.

Le lien est un **secret** : quiconque l'a peut publier là où il pointe. Il est gardé par Gladys dans sa
base, jamais réaffiché, envoyé seulement à Microsoft. L'intégration ne l'écrit ni dans ses journaux, ni
dans son statut, ni dans `/data`.

## Deux emplacements de webhook

- **Configuration > URL du webhook du canal** (facultatif) : le canal où vos scènes publient avec l'action
  **Publier dans le canal Teams**, et où publie le bouton **Envoyer un message de test**.
- **Mon compte > URL de mon webhook Teams** (chaque utilisateur de Gladys) : la conversation ou le canal
  où Gladys publie les messages **qui vous sont adressés** : l'action de scène **Envoyer un message**
  (quand elle vise Microsoft Teams ou tous les canaux) et les messages système (Gladys mise à jour,
  sauvegarde en échec, pile faible…) quand l'administrateur les laisse aller vers Teams ou vers tous les
  canaux (paramètres de Gladys).

## Ce qui est publié

Une carte adaptative avec le texte. Teams affiche le Markdown simple (gras, italique, listes, liens) ; les
titres deviennent des lignes en gras. Les textes sont coupés à 4096 caractères. Les images (scène
« Envoyer une image de caméra ») ne sont pas publiées : les webhooks Teams acceptent 28 Ko par message au
plus ; le texte d'un tel message est publié.

L'action de scène **Publier dans le canal Teams** a un texte, un titre facultatif et une importance
(**Urgente** affiche le titre en rouge). Sa sortie `status` vaut :

- `accepted` : Microsoft Workflows a accepté le message ;
- `unconfirmed` : le message est parti mais Microsoft n'a pas répondu à temps, ou a répondu par une
  erreur (5xx) ; il est peut-être publié, peut-être pas.

Quand rien n'a été publié (plafond atteint, pause, webhook refusé, réseau coupé…), l'action échoue avec la
raison dans le journal de la scène, et la scène continue.

« Accepté » veut dire accepté par Workflows : le workflow s'exécute ensuite chez Microsoft. S'il y échoue
(propriétaire parti, canal supprimé), Teams n'affiche rien ; voyez l'historique d'exécution du workflow
dans Power Automate.

## Limites et sécurité

- **Messages par heure** (configuration, 30 par défaut, de 1 à 200) : tous les messages de l'intégration
  ensemble (canal, webhooks personnels, bouton de test), comptés sur la dernière heure, gardés après un
  redémarrage. Au-delà, le message n'est pas envoyé et la raison donne l'attente.
- **Pas de deuxième essai** : un message part une fois. Si Microsoft ne répond pas, il n'est pas renvoyé
  (il a pu être publié : pas de doublon).
- Deux requêtes partent à **300 ms d'écart au moins** (Microsoft limite au-delà de quatre par seconde).
- **429** (Microsoft demande de ralentir) : chaque message attend le délai `Retry-After`, entre 60 s et
  6 h (60 s, puis doublé jusqu'à 1 h quand Microsoft ne donne pas de délai). **5xx** : 60 s, doublé
  jusqu'à 30 min, retour à 60 s après un succès. La pause est gardée après un redémarrage et affichée dans
  le statut.
- **401, 403, 404** (workflow supprimé, désactivé, mauvais lien) : le webhook est refusé et n'est plus
  utilisé pendant **24 h**, ou jusqu'à ce que son lien change ; pour le webhook du canal, un bouton de test réussi le lève aussitôt. Les autres
  webhooks ne sont pas touchés.
- Un message de Gladys doit avoir sa réponse en 5 s : l'intégration abandonne à 3,5 s. Si elle attend
  encore Microsoft à ce moment, le message compte comme « envoyé, sans confirmation ».

## Statut

L'écran Configuration affiche **Prêt** (avec ou sans webhook de canal, et le plafond horaire), une
**pause** demandée par Microsoft et sa fin, un webhook de canal **refusé**, ou un lien inutilisable, avec
la raison.

## Ce qui reste sur votre Gladys

`/data/state.json` : les dates des messages de la dernière heure, la fin d'une pause, une valeur au hasard
et une empreinte de 2 caractères de chaque webhook refusé dans les dernières 24 h. Aucun lien, aucun
texte, aucun nom. Les messages eux-mêmes passent par les serveurs de Microsoft (Power Automate, Teams).

## Questions

- **Gladys peut-elle lire les messages Teams ?** Non, cette intégration ne fait qu'envoyer.
- **Plusieurs canaux ?** Un webhook de canal par Gladys pour l'action de scène ; chaque utilisateur peut
  diriger son propre webhook vers n'importe quelle conversation ou canal.
