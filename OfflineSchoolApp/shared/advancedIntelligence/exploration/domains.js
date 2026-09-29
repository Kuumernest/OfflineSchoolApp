// shared/advancedIntelligence/exploration/domains.js
"use strict";

/**
 * Exploration domains — broad fields a pupil may investigate. Not
 * professions, not predictions, not a ranking.
 *
 * A domain is opened by evidence in the strengths dimensions it names and
 * by the Stage 10 exploration areas it maps to; its activities come from
 * the existing catalog (shared/exploration/catalog.js), never from a second
 * list. Skills and questions are prompts for the pupil's own investigation.
 * Several domains open at once for most pupils and the output keeps them
 * all, in alphabetical order, with no winner.
 *
 * Nothing here says what a pupil is or will be. The text says what a field
 * involves, and the application never attaches a fit, a match or a
 * probability to it (version.js FORBIDDEN_KEYS; asserted by the check).
 */

const D = (domain, primaryDimensions, secondaryDimensions, areas, en, fr, skills, questions) => Object.freeze({ domain, primaryDimensions, secondaryDimensions, areas, text: { en, fr }, skillsToExplore: skills, questionsToInvestigate: questions });

const DOMAINS = Object.freeze([
  D("BUSINESS_AND_ENTERPRISE", ["organizational_structured"], ["quantitative_reasoning", "social_collaborative"], ["organisation_enterprise"],
    { label: "Business and enterprise", description: "Planning, organising and running an activity that has to balance costs, time and people." },
    { label: "Entreprise et gestion", description: "Planifier, organiser et faire fonctionner une activité qui doit équilibrer coûts, temps et personnes." },
    { en: ["Budgeting a small activity", "Keeping records that others can read", "Planning a sequence of tasks", "Explaining a decision to a group"], fr: ["Établir le budget d'une petite activité", "Tenir des registres lisibles par d'autres", "Planifier une suite de tâches", "Expliquer une décision à un groupe"] },
    { en: ["What does it take to run a stall for a week?", "Which records would tell you whether it worked?", "What would you change the second time?"], fr: ["Que faut-il pour tenir un étal pendant une semaine ?", "Quels registres diraient si cela a marché ?", "Que changeriez-vous la deuxième fois ?"] }),
  D("COMMUNICATION", ["language_communication"], ["social_collaborative", "creative_expression"], ["language_media", "collaborative_service"],
    { label: "Communication", description: "Putting ideas into words, speech or media so that other people understand and respond." },
    { label: "Communication", description: "Mettre des idées en mots, en paroles ou en médias pour que d'autres comprennent et réagissent." },
    { en: ["Explaining something to someone who does not know it", "Speaking to a group", "Writing for a reader", "Listening and summarising"], fr: ["Expliquer quelque chose à quelqu'un qui ne le connaît pas", "Parler devant un groupe", "Écrire pour un lecteur", "Écouter et résumer"] },
    { en: ["Which kind of audience do you find easiest to reach?", "What changes when you write instead of speak?", "What did a listener not understand, and why?"], fr: ["Quel public vous est le plus facile à toucher ?", "Qu'est-ce qui change quand vous écrivez au lieu de parler ?", "Qu'est-ce qu'un auditeur n'a pas compris, et pourquoi ?"] }),
  D("CREATIVE_DESIGN", ["creative_expression"], ["visual_spatial", "technical_applied"], ["creative_arts", "design_spatial"],
    { label: "Creative design", description: "Making something new — an image, an object, a performance, a layout — and improving it through versions." },
    { label: "Création et design", description: "Réaliser quelque chose de nouveau — une image, un objet, une performance, une mise en page — et l'améliorer par versions." },
    { en: ["Sketching before making", "Trying a second version", "Working within a constraint", "Explaining a design choice"], fr: ["Esquisser avant de réaliser", "Essayer une deuxième version", "Travailler sous contrainte", "Expliquer un choix de conception"] },
    { en: ["What did the second version fix?", "What constraint helped you most?", "Whose reaction told you something useful?"], fr: ["Qu'a corrigé la deuxième version ?", "Quelle contrainte vous a le plus aidé ?", "Quelle réaction vous a appris quelque chose d'utile ?"] }),
  D("ENVIRONMENT_AND_SUSTAINABILITY", ["scientific_reasoning"], ["analytical_reasoning", "social_collaborative"], ["life_sciences", "humanities_social"],
    { label: "Environment and sustainability", description: "Observing how living things, water, soil, energy and people affect each other, and testing what changes an outcome." },
    { label: "Environnement et durabilité", description: "Observer comment le vivant, l'eau, le sol, l'énergie et les personnes s'influencent, et tester ce qui change un résultat." },
    { en: ["Observing and recording over days", "Measuring a change", "Comparing two conditions", "Reporting to people who act on it"], fr: ["Observer et noter sur plusieurs jours", "Mesurer un changement", "Comparer deux conditions", "Rendre compte à ceux qui agissent"] },
    { en: ["What changed in your record over two weeks?", "What would you need to measure to be sure?", "Who would use your findings?"], fr: ["Qu'est-ce qui a changé dans vos relevés en deux semaines ?", "Que faudrait-il mesurer pour être sûr ?", "Qui utiliserait vos résultats ?"] }),
  D("HEALTH_AND_LIFE_SCIENCE", ["scientific_reasoning"], ["quantitative_reasoning", "social_collaborative"], ["life_sciences"],
    { label: "Health and life science", description: "Studying how living bodies work and what keeps people well, through observation, measurement and careful recording." },
    { label: "Santé et sciences de la vie", description: "Étudier le fonctionnement des organismes et ce qui maintient les gens en bonne santé, par l'observation, la mesure et des relevés soignés." },
    { en: ["Careful measurement", "Recording without guessing", "Following a procedure exactly", "Explaining a result to someone worried"], fr: ["Mesurer avec soin", "Noter sans deviner", "Suivre une procédure exactement", "Expliquer un résultat à quelqu'un d'inquiet"] },
    { en: ["What did repeating a measurement teach you?", "Where did the procedure matter most?", "What would you want to know next?"], fr: ["Qu'a appris la répétition d'une mesure ?", "Où la procédure a-t-elle le plus compté ?", "Que voudriez-vous savoir ensuite ?"] }),
  D("LANGUAGE", ["language_communication", "reading_interpretation"], [], ["language_media"],
    { label: "Language", description: "Reading closely, writing precisely and moving between languages." },
    { label: "Langues", description: "Lire de près, écrire avec précision et passer d'une langue à l'autre." },
    { en: ["Reading for what a text implies", "Writing in more than one register", "Learning vocabulary in context", "Translating an idea, not a word"], fr: ["Lire ce qu'un texte suggère", "Écrire dans plus d'un registre", "Apprendre du vocabulaire en contexte", "Traduire une idée, pas un mot"] },
    { en: ["What did a close reading show that a first reading missed?", "Which register was hardest to write?", "What is lost in a translation you tried?"], fr: ["Qu'a montré une lecture attentive que la première a manqué ?", "Quel registre a été le plus difficile à écrire ?", "Que perd une traduction que vous avez tentée ?"] }),
  D("MATHEMATICAL_REASONING", ["quantitative_reasoning"], ["analytical_reasoning"], ["mathematical"],
    { label: "Mathematical reasoning", description: "Finding patterns, working with quantities and proving that a rule holds." },
    { label: "Raisonnement mathématique", description: "Trouver des régularités, manipuler des quantités et prouver qu'une règle tient." },
    { en: ["Testing a rule against new cases", "Working a problem more than one way", "Estimating before calculating", "Explaining a method to a peer"], fr: ["Tester une règle sur de nouveaux cas", "Résoudre un problème de plusieurs façons", "Estimer avant de calculer", "Expliquer une méthode à un camarade"] },
    { en: ["Which problems did you enjoy even when they were hard?", "When did a second method reveal a mistake?", "What kind of pattern did you find easiest to spot?"], fr: ["Quels problèmes avez-vous aimés même difficiles ?", "Quand une deuxième méthode a-t-elle révélé une erreur ?", "Quel type de régularité repérez-vous le plus facilement ?"] }),
  D("SCIENTIFIC_INQUIRY", ["scientific_reasoning"], ["quantitative_reasoning", "analytical_reasoning"], ["quantitative_scientific", "life_sciences"],
    { label: "Scientific inquiry", description: "Asking a question, designing a fair test, measuring, and letting the result answer." },
    { label: "Démarche scientifique", description: "Poser une question, concevoir un test équitable, mesurer, et laisser le résultat répondre." },
    { en: ["Designing a fair comparison", "Measuring and recording", "Reading a result that surprises you", "Writing a method someone else can repeat"], fr: ["Concevoir une comparaison équitable", "Mesurer et noter", "Lire un résultat qui surprend", "Rédiger une méthode reproductible"] },
    { en: ["What did a surprising result make you check?", "How would you make the test fairer?", "Could someone repeat your method from your notes?"], fr: ["Qu'avez-vous vérifié après un résultat surprenant ?", "Comment rendriez-vous le test plus équitable ?", "Quelqu'un pourrait-il répéter votre méthode à partir de vos notes ?"] }),
  D("SOCIAL_RESEARCH", ["reading_interpretation", "analytical_reasoning"], ["social_collaborative", "language_communication"], ["humanities_social", "collaborative_service"],
    { label: "Social research", description: "Finding out how people, places and events are connected, from sources and from asking." },
    { label: "Recherche sociale", description: "Découvrir comment les personnes, les lieux et les événements sont liés, à partir de sources et d'enquêtes." },
    { en: ["Comparing two accounts of one event", "Asking a question that gets an honest answer", "Organising what you found", "Saying what the evidence does not show"], fr: ["Comparer deux récits d'un même événement", "Poser une question qui obtient une réponse honnête", "Organiser ce que vous avez trouvé", "Dire ce que les preuves ne montrent pas"] },
    { en: ["Where did two sources disagree, and how did you decide?", "What question did people answer differently than you expected?", "What is still unknown?"], fr: ["Où deux sources ont-elles divergé, et comment avez-vous tranché ?", "À quelle question les gens ont-ils répondu autrement que prévu ?", "Que reste-t-il d'inconnu ?"] }),
  D("TECHNICAL_BUILDING", ["technical_applied"], ["quantitative_reasoning", "visual_spatial"], ["computational_technical", "design_spatial"],
    { label: "Technical building", description: "Making something that works — a program, a circuit, a model, a mechanism — and fixing it when it does not." },
    { label: "Construction technique", description: "Réaliser quelque chose qui fonctionne — un programme, un circuit, une maquette, un mécanisme — et le réparer quand ce n'est pas le cas." },
    { en: ["Breaking a task into steps", "Finding why something failed", "Following and improving a procedure", "Testing before declaring it done"], fr: ["Découper une tâche en étapes", "Trouver pourquoi quelque chose a échoué", "Suivre et améliorer une procédure", "Tester avant de déclarer terminé"] },
    { en: ["What broke first, and how did you find out?", "Which step did you have to redo?", "What would you build next with the same parts?"], fr: ["Qu'est-ce qui a cassé en premier, et comment l'avez-vous su ?", "Quelle étape avez-vous dû refaire ?", "Que construiriez-vous ensuite avec les mêmes pièces ?"] }),
]);

const DOMAIN_CODES = Object.freeze(DOMAINS.map((d) => d.domain));
const domainByCode = (code) => DOMAINS.find((d) => d.domain === code) ?? null;
/** The domains an exploration area feeds. */
const domainsForArea = (area) => DOMAINS.filter((d) => d.areas.includes(area)).map((d) => d.domain);
/** The domains a strengths dimension opens, primary or secondary. */
const domainsForDimension = (dim) => DOMAINS.filter((d) => d.primaryDimensions.includes(dim) || d.secondaryDimensions.includes(dim)).map((d) => d.domain);

module.exports = { DOMAINS, DOMAIN_CODES, domainByCode, domainsForArea, domainsForDimension };
