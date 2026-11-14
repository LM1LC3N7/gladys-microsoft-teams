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
3. Copiez le lien du webhook. Il commence par `https://` ; son hôte finit par l'un des hôtes que Microsoft
   donne pour le déclencheur HTTP de Power Automate (« IP address configuration ») :
   `api.powerplatform.com` ou `logic.azure.com` (cloud public), `api.gov.powerplatform.microsoft.us` ou
   `logic.azure.us` (gouvernement américain GCC), `api.high.powerplatform.microsoft.us` (GCC High),
   `api.appsplatform.us` (DoD), `api.powerplatform.partner.microsoftonline.cn` ou `logic.azure.cn`
   (Chine). Tout autre hôte est refusé.
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
  redémarrage. Au-delà, le message n'est pas envoyé et la raison donne l'attente. Après un redémarrage,
  tant que Gladys n'a pas redonné la configuration, le dernier plafond lu sert (gardé dans `/data`).
- **Pas de deuxième essai** : un message part une fois. Si Microsoft ne répond pas, il n'est pas renvoyé
  (il a pu être publié : pas de doublon).
- Deux requêtes partent à **300 ms d'écart au moins** (Microsoft limite au-delà de quatre par seconde).
  Dans une rafale, un message écarté pendant son attente (son webhook refusé ou mis en pause entre-temps)
  garde son créneau de 300 ms : les suivants de la rafale partent jusqu'à 0,3 s plus tard par message
  écarté, dans leur budget.
- Pauses et refus sont **par webhook** : un webhook en difficulté ne retient jamais le canal ni les
  autres utilisateurs.
- **429** (Microsoft demande de ralentir) : ce webhook attend le délai `Retry-After`, entre 60 s et 6 h
  (60 s, puis doublé jusqu'à 1 h quand Microsoft ne donne pas de délai). **5xx** : 60 s, doublé jusqu'à
  30 min, retour à 60 s après un succès. La pause est gardée après un redémarrage.
- **401, 403, 404** (workflow supprimé, désactivé, mauvais lien) : le webhook est refusé et n'est plus
  utilisé pendant **24 h**. Avant cela, un **nouveau lien** est essayé aussitôt (une rare exception après un redémarrage, voir plus bas) ; pour le webhook du canal,
  un **Envoyer un message de test** réussi le lève ; pour un webhook personnel, un clic sur **Envoyer un
  message de test** le laisse réessayer à son prochain message (une fois : refusé de nouveau, il attend
  encore 24 h).
- Un message de Gladys doit avoir sa réponse en 5 s : l'intégration abandonne à 3,5 s. Si elle attend
  encore Microsoft à ce moment, le message compte comme « envoyé, sans confirmation ».

## Statut

L'écran Configuration affiche **Prêt** (avec ou sans webhook de canal, et le plafond horaire), une
**pause** du webhook du canal demandée par Microsoft et sa fin, un webhook de canal **refusé**, ou un lien
de canal inutilisable, avec la raison. Derrière **Prêt**, il compte aussi les **webhooks personnels**
refusés ou en pause (sans dire lesquels : aucun nom n'est gardé). L'utilisateur concerné voit pourquoi
dans le journal de la scène qui a envoyé le message (« Rien envoyé : … »), et le journal de l'intégration
désigne chaque webhook par une courte référence qui change à chaque démarrage.

## Ce qui reste sur votre Gladys

`/data/state.json` : les dates des messages de la dernière heure, le dernier plafond horaire, une valeur
au hasard et, pour chaque webhook refusé ou en pause, une empreinte de 2 caractères avec la date du refus
ou la fin de la pause. Aucun lien, aucun texte, aucun nom. Une empreinte est partagée par environ un lien
sur 256. Une marque gardée dans `/data` est reprise par le premier lien utilisé avec la même empreinte,
une fois : dans le cas rare où c'est un autre lien (un lien personnel jamais refusé, ou saisi par un
utilisateur depuis le redémarrage), ce lien est retenu comme refusé jusqu'aux 24 h, à un clic sur le
bouton de test ou à un changement de lien, et le lien vraiment refusé est essayé une fois de plus (une
requête vers un webhook refusé, sans gravité). Le lien du canal changé dans la Configuration pendant une
exécution ne prend jamais de marque. Sinon, pendant une exécution, chaque lien a son propre état.

Si `/data` est illisible au démarrage, l'intégration fonctionne sans et le relit toutes les 10 s : d'ici
là, seuls les messages depuis le démarrage comptent dans le plafond horaire, et les pauses et refus
d'avant le redémarrage ne sont pas connus (les webhooks Teams sont gratuits ; le fichier n'est jamais
écrasé avant d'avoir été lu). Les messages eux-mêmes passent par les serveurs de Microsoft (Power Automate, Teams).

## Questions

- **Gladys peut-elle lire les messages Teams ?** Non, cette intégration ne fait qu'envoyer.
- **Plusieurs canaux ?** Un webhook de canal par Gladys pour l'action de scène ; chaque utilisateur peut
  diriger son propre webhook vers n'importe quelle conversation ou canal.
