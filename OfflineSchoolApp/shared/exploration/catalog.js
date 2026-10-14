// shared/exploration/catalog.js
"use strict";

/**
 * The exploration catalog: reusable activity definitions a pupil can try,
 * packaged for offline use, versioned, and free of anything about a pupil.
 *
 * ── What an activity is ───────────────────────────────────────────────────
 *
 * A task with an observable outcome. "Learn about engineering" produces
 * nothing a teacher can see; "design a bridge from the supplied materials and
 * explain why it should carry the load" produces a model, an explanation and
 * something to reflect on. Every entry names its task, its expected outputs,
 * the behaviours a teacher could observe, its reflection prompts, and — when
 * the output is objective enough to rate — the criteria that rating uses.
 *
 * ── Areas, levels, resources ──────────────────────────────────────────────
 *
 * Areas are the strengths layer's ten exploration areas, so a suggestion can
 * say exactly which evidence opened it. Three levels — introductory,
 * intermediate, extended — for progression a pupil chooses, never a ladder
 * that measures them. Resources are named honestly for a school where the
 * internet, a laboratory and a computer are not givens: most entries need
 * paper or nothing at all, and the recommender filters on what a school has.
 *
 * ── Frozen by version ─────────────────────────────────────────────────────
 *
 * The catalog ships in the code, so it is available offline by construction.
 * Each activity carries its own version; the layer carries
 * EXPLORATION_ENGINE_VERSION, and a change to any entry, level, resource list
 * or the recommender's rules moves that version and no other.
 */

const EXPLORATION_ENGINE_VERSION = "1.0.0";

const LEVELS = Object.freeze(["INTRODUCTORY", "INTERMEDIATE", "EXTENDED"]);

const RESOURCES = Object.freeze([
  "NO_SPECIAL_RESOURCES", "PAPER", "PHONE", "COMPUTER", "INTERNET",
  "SCIENCE_MATERIALS", "SCHOOL_LAB", "GROUP", "TEACHER_SUPPORT", "ART_MATERIALS",
]);

const DELIVERY_MODES = Object.freeze(["individual", "pair", "group", "with_teacher"]);

/** The six kinds of evidence an exploration can produce. Never one another. */
const EVIDENCE_TYPES = Object.freeze(["exposure", "participation", "interest", "performance", "reflection", "teacher_observation"]);

const PERFORMANCE_CRITERIA = Object.freeze([
  "task_completion", "accuracy", "quality", "problem_solving_approach", "communication", "iteration",
]);
const PERFORMANCE_RATINGS = Object.freeze(["not_met", "partly_met", "met", "exceeded"]);

const OBSERVATION_LEVELS = Object.freeze(["OBSERVED", "PARTLY_OBSERVED", "NOT_OBSERVED", "INSUFFICIENT_OPPORTUNITY"]);
const OBSERVATION_CODES  = Object.freeze([
  "PROBLEM_SOLVING", "PERSISTENCE", "COMMUNICATION", "TECHNICAL_EXECUTION",
  "CREATIVE_APPROACH", "COLLABORATION", "EXPLANATION", "ITERATION",
]);

const REFLECTION = Object.freeze({
  interest:   ["LOW", "MODERATE", "HIGH"],
  difficulty: ["EASY", "MANAGEABLE", "DIFFICULT", "VERY_DIFFICULT"],
  continue:   ["NO", "MAYBE", "YES"],
});

/** The brief's category names, one per strengths-layer area. */
const CATEGORY_OF_AREA = Object.freeze({
  mathematical:            "QUANTITATIVE",
  quantitative_scientific: "SCIENTIFIC",
  life_sciences:           "SCIENTIFIC",
  computational_technical: "COMPUTATIONAL",
  design_spatial:          "VISUAL_SPATIAL",
  language_media:          "COMMUNICATION",
  humanities_social:       "SOCIAL_INQUIRY",
  creative_arts:           "CREATIVE",
  organisation_enterprise: "ORGANIZATIONAL",
  collaborative_service:   "SOCIAL_INQUIRY",
});
const AREAS = Object.freeze(Object.keys(CATEGORY_OF_AREA));

/**
 * Which areas sit next to which: sharing a dimension, or a common practice.
 * Adjacency is how the recommender steps sideways from a strength without
 * jumping to a random domain — quantitative evidence opens coding and design,
 * not only more mathematics.
 */
const ADJACENT_AREAS = Object.freeze({
  mathematical:            ["quantitative_scientific", "computational_technical", "organisation_enterprise"],
  quantitative_scientific: ["mathematical", "life_sciences", "design_spatial", "computational_technical"],
  life_sciences:           ["quantitative_scientific", "humanities_social"],
  computational_technical: ["mathematical", "design_spatial", "quantitative_scientific"],
  design_spatial:          ["creative_arts", "computational_technical", "quantitative_scientific"],
  language_media:          ["humanities_social", "creative_arts", "collaborative_service"],
  humanities_social:       ["language_media", "collaborative_service", "life_sciences"],
  creative_arts:           ["design_spatial", "language_media"],
  organisation_enterprise: ["collaborative_service", "mathematical"],
  collaborative_service:   ["organisation_enterprise", "humanities_social", "language_media"],
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ACTIVITIES
// ─────────────────────────────────────────────────────────────────────────────

const A = (activityId, area, dimensions, level, minutes, resources, deliveryMode, evidenceTypes, performanceCriteria, en, fr) => ({
  activityId, version: 1, area, category: CATEGORY_OF_AREA[area], dimensions, level,
  estimatedMinutes: minutes, resources, deliveryMode, evidenceTypes, performanceCriteria,
  status: "active", text: { en, fr },
});
const T = (title, description, task, expectedOutputs, observable, reflectionPrompts) =>
  ({ title, description, task, expectedOutputs, observable, reflectionPrompts });

const PROMPTS_EN = ["What did you produce?", "How did it feel?", "What was difficult?", "Would you try something similar?"];
const PROMPTS_FR = ["Qu'avez-vous produit ?", "Comment l'avez-vous vécu ?", "Qu'est-ce qui a été difficile ?", "Essaieriez-vous quelque chose de semblable ?"];

const ALL_PERF = ["task_completion", "accuracy", "quality", "problem_solving_approach", "communication", "iteration"];

const ACTIVITIES = Object.freeze([
  // ── Mathematical ────────────────────────────────────────────────────────
  A("math-intro-patterns", "mathematical", ["quantitative_reasoning"], "INTRODUCTORY", 30, ["PAPER"], "individual",
    ["exposure", "participation", "reflection", "performance"], ["task_completion", "accuracy", "problem_solving_approach"],
    T("Find the rule in a number pattern", "Three short sequences; find each rule and predict the tenth term.",
      "For each of the three sequences, write the rule in words, then use it to predict the tenth term and check it.",
      ["Three rules written in words", "Three predicted tenth terms with the checking shown"], ["Tries a hypothesis and tests it", "Corrects a rule that fails"], PROMPTS_EN),
    T("Trouver la règle d'une suite", "Trois courtes suites ; trouver chaque règle et prédire le dixième terme.",
      "Pour chacune des trois suites, écrivez la règle en mots, puis prédisez le dixième terme et vérifiez-le.",
      ["Trois règles écrites en mots", "Trois dixièmes termes prédits avec la vérification"], ["Essaie une hypothèse et la teste", "Corrige une règle qui échoue"], PROMPTS_FR)),
  A("math-inter-market", "mathematical", ["quantitative_reasoning", "organizational_structured"], "INTERMEDIATE", 60, ["PAPER"], "individual",
    ["exposure", "participation", "reflection", "performance"], ["task_completion", "accuracy", "communication"],
    T("Price a market stall", "Plan the buying, pricing and expected profit of a small stall for one day.",
      "Choose five items, estimate their cost and selling price, and calculate the profit for a slow day and a busy day. Show every step.",
      ["A table of items, costs and prices", "Two profit calculations with the working"], ["Keeps quantities and units straight", "Explains a choice of price"], PROMPTS_EN),
    T("Fixer les prix d'un étal", "Planifier les achats, les prix et le bénéfice attendu d'un petit étal pour une journée.",
      "Choisissez cinq articles, estimez leur coût et leur prix de vente, et calculez le bénéfice pour une journée calme et une journée chargée. Montrez chaque étape.",
      ["Un tableau des articles, coûts et prix", "Deux calculs de bénéfice avec le détail"], ["Garde quantités et unités cohérentes", "Explique un choix de prix"], PROMPTS_FR)),
  A("math-ext-model", "mathematical", ["quantitative_reasoning", "analytical_reasoning"], "EXTENDED", 120, ["PAPER"], "pair",
    ["exposure", "participation", "reflection", "performance"], ALL_PERF,
    T("Model a real quantity", "Choose something that changes over time at school and model it.",
      "Pick a quantity you can measure over a week (water used, students absent, temperature). Record it, draw it, fit a simple rule, and say where the rule will stop working.",
      ["A week of recorded values", "A graph", "A written rule and its limits"], ["Chooses what to measure and why", "Names the limits of the model"], PROMPTS_EN),
    T("Modéliser une grandeur réelle", "Choisir quelque chose qui varie dans le temps à l'école et le modéliser.",
      "Choisissez une grandeur mesurable sur une semaine (eau utilisée, absents, température). Relevez-la, tracez-la, ajustez une règle simple et dites où elle cessera de marcher.",
      ["Une semaine de valeurs relevées", "Un graphique", "Une règle écrite et ses limites"], ["Choisit quoi mesurer et pourquoi", "Nomme les limites du modèle"], PROMPTS_FR)),

  // ── Quantitative & scientific ───────────────────────────────────────────
  A("qsci-intro-bridge", "quantitative_scientific", ["scientific_reasoning", "quantitative_reasoning"], "INTRODUCTORY", 60, ["PAPER", "NO_SPECIAL_RESOURCES"], "pair",
    ["exposure", "participation", "reflection", "performance", "teacher_observation"], ["task_completion", "problem_solving_approach", "communication", "iteration"],
    T("Build a simple bridge", "Using paper, sticks or card, build a bridge across a 20 cm gap that holds a book.",
      "Design a bridge from the materials you have, test it with a book, improve it once, and explain why your final design holds the load.",
      ["The bridge", "A drawing of the design before and after", "A short explanation of why it holds"], ["Tests, then changes the design", "Explains the load path in own words"], PROMPTS_EN),
    T("Construire un pont simple", "Avec du papier, des bâtonnets ou du carton, construire un pont sur 20 cm qui porte un livre.",
      "Concevez un pont avec les matériaux disponibles, testez-le avec un livre, améliorez-le une fois et expliquez pourquoi votre version finale tient la charge.",
      ["Le pont", "Un dessin du modèle avant et après", "Une courte explication"], ["Teste puis modifie le modèle", "Explique le chemin de la charge"], PROMPTS_FR)),
  A("qsci-inter-measure", "quantitative_scientific", ["scientific_reasoning", "quantitative_reasoning"], "INTERMEDIATE", 90, ["PAPER", "SCIENCE_MATERIALS"], "pair",
    ["exposure", "participation", "reflection", "performance"], ["task_completion", "accuracy", "problem_solving_approach", "iteration"],
    T("Measure something twice", "Design a fair measurement and repeat it to see how much your results vary.",
      "Choose a quantity (a pendulum's period, a ramp's roll time). Measure it five times, calculate the average and the spread, and explain what caused the spread.",
      ["Five measurements", "An average and a spread", "A written explanation of the variation"], ["Controls what should stay the same", "Distinguishes error from change"], PROMPTS_EN),
    T("Mesurer deux fois", "Concevoir une mesure juste et la répéter pour voir combien les résultats varient.",
      "Choisissez une grandeur (période d'un pendule, temps de descente sur un plan). Mesurez-la cinq fois, calculez la moyenne et l'écart, et expliquez d'où vient l'écart.",
      ["Cinq mesures", "Une moyenne et un écart", "Une explication écrite de la variation"], ["Contrôle ce qui doit rester constant", "Distingue erreur et changement"], PROMPTS_FR)),
  A("qsci-ext-investigation", "quantitative_scientific", ["scientific_reasoning", "quantitative_reasoning", "analytical_reasoning"], "EXTENDED", 180, ["PAPER", "SCIENCE_MATERIALS", "TEACHER_SUPPORT"], "group",
    ["exposure", "participation", "reflection", "performance", "teacher_observation"], ALL_PERF,
    T("Run a small investigation", "Ask one question about the physical world and answer it with evidence.",
      "Write a question, predict the answer, plan a fair test, run it, present the data, and say whether the evidence supports the prediction.",
      ["A question and prediction", "A plan", "Data and a conclusion that follows from it"], ["Plans before acting", "Lets the data change the conclusion"], PROMPTS_EN),
    T("Mener une petite investigation", "Poser une question sur le monde physique et y répondre avec des preuves.",
      "Écrivez une question, prédisez la réponse, planifiez un test juste, réalisez-le, présentez les données et dites si les preuves soutiennent la prédiction.",
      ["Une question et une prédiction", "Un plan", "Des données et une conclusion qui en découle"], ["Planifie avant d'agir", "Laisse les données changer la conclusion"], PROMPTS_FR)),

  // ── Life sciences ───────────────────────────────────────────────────────
  // No rated output: a week of looking is participation and reflection, and
  // nobody marks a child's noticing.
  A("life-intro-observe", "life_sciences", ["scientific_reasoning"], "INTRODUCTORY", 45, ["PAPER"], "individual",
    ["exposure", "participation", "reflection"], [],
    T("Observe one living thing for a week", "Keep a dated record of a plant or animal near you.",
      "Choose one plant or animal you can see every day. Record what changes, draw it twice, and write three questions your observations raise.",
      ["A dated record", "Two drawings", "Three questions"], ["Notices detail over time", "Asks questions from observation"], PROMPTS_EN),
    T("Observer un être vivant pendant une semaine", "Tenir un relevé daté d'une plante ou d'un animal proche.",
      "Choisissez une plante ou un animal que vous voyez chaque jour. Notez ce qui change, dessinez-le deux fois et écrivez trois questions soulevées par vos observations.",
      ["Un relevé daté", "Deux dessins", "Trois questions"], ["Remarque les détails dans le temps", "Pose des questions à partir de l'observation"], PROMPTS_FR)),
  A("life-inter-water", "life_sciences", ["scientific_reasoning"], "INTERMEDIATE", 90, ["PAPER", "SCIENCE_MATERIALS"], "pair",
    ["exposure", "participation", "reflection", "performance"], ["task_completion", "accuracy", "problem_solving_approach"],
    T("Test the water", "Compare two water sources with simple tests and say what the differences might mean.",
      "Collect water from two places. Compare clarity, smell, what settles, and what grows on bread wetted with each after three days. Record and interpret carefully.",
      ["A comparison table", "Dated observations", "A cautious interpretation"], ["Keeps conditions equal", "Interprets without over-claiming"], PROMPTS_EN),
    T("Tester l'eau", "Comparer deux sources d'eau par des tests simples et dire ce que les différences pourraient signifier.",
      "Prélevez de l'eau à deux endroits. Comparez la clarté, l'odeur, ce qui se dépose, et ce qui pousse sur du pain humidifié avec chacune après trois jours. Notez et interprétez avec prudence.",
      ["Un tableau comparatif", "Des observations datées", "Une interprétation prudente"], ["Garde les conditions égales", "Interprète sans exagérer"], PROMPTS_FR)),
  A("life-ext-health", "life_sciences", ["scientific_reasoning", "language_communication"], "EXTENDED", 150, ["PAPER", "GROUP"], "group",
    ["exposure", "participation", "reflection", "performance", "teacher_observation"], ALL_PERF,
    T("Explain a health practice with evidence", "Choose one everyday health practice and find out what supports it.",
      "Pick a practice (hand-washing, boiling water, mosquito nets). Explain the biology behind it, gather what your school community actually does, and present what would help most.",
      ["An explanation of the biology", "A small survey", "A presentation"], ["Separates what is known from what is believed", "Presents to others clearly"], PROMPTS_EN),
    T("Expliquer une pratique de santé avec des preuves", "Choisir une pratique de santé quotidienne et trouver ce qui la justifie.",
      "Choisissez une pratique (lavage des mains, eau bouillie, moustiquaires). Expliquez la biologie, recueillez ce que fait votre communauté scolaire et présentez ce qui aiderait le plus.",
      ["Une explication de la biologie", "Une petite enquête", "Une présentation"], ["Sépare ce qui est su de ce qui est cru", "Présente clairement"], PROMPTS_FR)),

  // ── Computational & technical ───────────────────────────────────────────
  A("comp-intro-algorithm", "computational_technical", ["technical_applied", "quantitative_reasoning"], "INTRODUCTORY", 40, ["PAPER"], "individual",
    ["exposure", "participation", "reflection", "performance"], ["task_completion", "accuracy", "problem_solving_approach"],
    T("Write an algorithm on paper", "Give exact instructions a classmate can follow without asking questions.",
      "Write step-by-step instructions to sort ten shuffled number cards. Have a classmate follow them exactly; fix every step where they got stuck.",
      ["The written steps", "A note of each fix made"], ["Breaks a task into unambiguous steps", "Debugs from another person's confusion"], PROMPTS_EN),
    T("Écrire un algorithme sur papier", "Donner des instructions exactes qu'un camarade peut suivre sans poser de question.",
      "Écrivez des instructions étape par étape pour trier dix cartes numérotées mélangées. Faites-les suivre exactement par un camarade ; corrigez chaque étape où il a bloqué.",
      ["Les étapes écrites", "Une note de chaque correction"], ["Décompose une tâche en étapes sans ambiguïté", "Corrige à partir de la confusion d'autrui"], PROMPTS_FR)),
  A("comp-inter-program", "computational_technical", ["technical_applied"], "INTERMEDIATE", 90, ["PHONE", "COMPUTER"], "individual",
    ["exposure", "participation", "reflection", "performance"], ["task_completion", "quality", "problem_solving_approach", "iteration"],
    T("Build a small interactive program", "A quiz, a calculator or a counter that responds to input.",
      "Using any tool available (a phone app, a spreadsheet, a block editor, a text editor), build something that takes input and responds. Test it with three people and improve one thing.",
      ["The working program", "Three test notes", "One documented improvement"], ["Tests with real users", "Iterates on feedback"], PROMPTS_EN),
    T("Construire un petit programme interactif", "Un quiz, une calculatrice ou un compteur qui réagit à une entrée.",
      "Avec l'outil disponible (application de téléphone, tableur, éditeur par blocs, éditeur de texte), construisez quelque chose qui prend une entrée et répond. Testez-le avec trois personnes et améliorez un point.",
      ["Le programme fonctionnel", "Trois notes de test", "Une amélioration documentée"], ["Teste avec de vrais utilisateurs", "Itère sur les retours"], PROMPTS_FR)),
  A("comp-ext-problem", "computational_technical", ["technical_applied", "analytical_reasoning"], "EXTENDED", 240, ["COMPUTER", "TEACHER_SUPPORT"], "pair",
    ["exposure", "participation", "reflection", "performance", "teacher_observation"], ALL_PERF,
    T("Solve a real problem with software", "Pick a task somebody at school does by hand and make it easier.",
      "Identify a repetitive task (a register, a roster, a tally). Build a tool that helps, hand it to the person, and record what they said and what you changed.",
      ["The tool", "The user's feedback", "A list of changes made after feedback"], ["Understands the user's task first", "Handles the case that breaks the first version"], PROMPTS_EN),
    T("Résoudre un vrai problème avec un logiciel", "Choisir une tâche faite à la main à l'école et la rendre plus facile.",
      "Identifiez une tâche répétitive (un registre, un planning, un comptage). Construisez un outil qui aide, confiez-le à la personne, et notez ce qu'elle a dit et ce que vous avez changé.",
      ["L'outil", "Le retour de l'utilisateur", "La liste des changements après retour"], ["Comprend d'abord la tâche de l'utilisateur", "Gère le cas qui casse la première version"], PROMPTS_FR)),

  // ── Design & spatial ────────────────────────────────────────────────────
  A("design-intro-map", "design_spatial", ["visual_spatial"], "INTRODUCTORY", 45, ["PAPER"], "individual",
    ["exposure", "participation", "reflection", "performance"], ["task_completion", "accuracy", "quality"],
    T("Draw a map somebody can use", "A scaled map of the school that gets a visitor from the gate to the office.",
      "Pace out distances, choose a scale, draw the route with landmarks, and test it on somebody who does not know the school.",
      ["A scaled map", "A note of the test"], ["Keeps scale consistent", "Chooses landmarks a stranger would see"], PROMPTS_EN),
    T("Dessiner un plan utilisable", "Un plan à l'échelle de l'école qui mène un visiteur du portail au bureau.",
      "Mesurez les distances en pas, choisissez une échelle, dessinez l'itinéraire avec des repères et testez-le sur quelqu'un qui ne connaît pas l'école.",
      ["Un plan à l'échelle", "Une note du test"], ["Garde l'échelle constante", "Choisit des repères visibles par un étranger"], PROMPTS_FR)),
  A("design-inter-object", "design_spatial", ["visual_spatial", "technical_applied"], "INTERMEDIATE", 90, ["PAPER", "ART_MATERIALS"], "individual",
    ["exposure", "participation", "reflection", "performance"], ["task_completion", "quality", "problem_solving_approach", "iteration"],
    T("Design an object for a real need", "Something a classmate needs: a pencil holder, a bag hook, a shade.",
      "Interview one person about a small daily problem, sketch three designs, build one from available materials, and have them use it for a day.",
      ["Three sketches", "The object", "The user's verdict"], ["Designs from a need, not a whim", "Chooses between alternatives with reasons"], PROMPTS_EN),
    T("Concevoir un objet pour un vrai besoin", "Ce dont un camarade a besoin : un porte-crayons, un crochet, un pare-soleil.",
      "Interrogez une personne sur un petit problème quotidien, esquissez trois modèles, réalisez-en un avec les matériaux disponibles et faites-le utiliser une journée.",
      ["Trois croquis", "L'objet", "Le verdict de l'utilisateur"], ["Conçoit à partir d'un besoin", "Choisit entre alternatives avec des raisons"], PROMPTS_FR)),
  A("design-ext-space", "design_spatial", ["visual_spatial", "organizational_structured"], "EXTENDED", 180, ["PAPER", "GROUP"], "group",
    ["exposure", "participation", "reflection", "performance", "teacher_observation"], ALL_PERF,
    T("Redesign a space", "Propose a better layout for a classroom, a corridor or the yard.",
      "Measure the space, record how it is used across a day, draw the current layout and a proposed one to scale, and justify each change by an observation.",
      ["Two scaled drawings", "A day's usage notes", "Justifications tied to observations"], ["Grounds every change in an observation", "Presents a plan to others"], PROMPTS_EN),
    T("Repenser un espace", "Proposer un meilleur agencement pour une salle, un couloir ou la cour.",
      "Mesurez l'espace, notez son usage sur une journée, dessinez l'agencement actuel et un agencement proposé à l'échelle, et justifiez chaque changement par une observation.",
      ["Deux dessins à l'échelle", "Les notes d'usage d'une journée", "Des justifications liées aux observations"], ["Fonde chaque changement sur une observation", "Présente un plan aux autres"], PROMPTS_FR)),

  // ── Language, writing & media ───────────────────────────────────────────
  A("lang-intro-explain", "language_media", ["language_communication"], "INTRODUCTORY", 30, ["PAPER"], "individual",
    ["exposure", "participation", "reflection", "performance"], ["task_completion", "quality", "communication"],
    T("Explain something in 150 words", "Make one thing clear to somebody younger.",
      "Choose something you understand well. Write 150 words explaining it to a student two forms below you, read it to one, and rewrite the sentence they did not follow.",
      ["The 150 words", "The rewritten sentence"], ["Chooses words for the listener", "Revises after feedback"], PROMPTS_EN),
    T("Expliquer quelque chose en 150 mots", "Rendre une chose claire pour quelqu'un de plus jeune.",
      "Choisissez quelque chose que vous comprenez bien. Écrivez 150 mots pour l'expliquer à un élève deux classes en dessous, lisez-le-lui et réécrivez la phrase qu'il n'a pas suivie.",
      ["Les 150 mots", "La phrase réécrite"], ["Choisit ses mots pour l'auditeur", "Révise après retour"], PROMPTS_FR)),
  A("lang-inter-speak", "language_media", ["language_communication"], "INTERMEDIATE", 60, ["NO_SPECIAL_RESOURCES", "GROUP"], "group",
    ["exposure", "participation", "reflection", "performance", "teacher_observation"], ["task_completion", "quality", "communication"],
    T("Speak for two minutes", "A two-minute talk with one clear point, delivered to a small group.",
      "Prepare a two-minute talk on a topic you choose with one main point, deliver it to at least three people, take one question, and note what you would change.",
      ["A one-page plan", "The talk delivered", "A note of what to change"], ["Holds one line of argument", "Handles a question without losing the thread"], PROMPTS_EN),
    T("Parler deux minutes", "Un exposé de deux minutes avec une idée claire, devant un petit groupe.",
      "Préparez un exposé de deux minutes sur un sujet de votre choix avec une idée principale, présentez-le à au moins trois personnes, répondez à une question et notez ce que vous changeriez.",
      ["Un plan d'une page", "L'exposé donné", "Une note de ce qu'il faudrait changer"], ["Tient une ligne d'argument", "Répond à une question sans perdre le fil"], PROMPTS_FR)),
  A("lang-ext-investigation", "language_media", ["language_communication", "reading_interpretation"], "EXTENDED", 150, ["PAPER"], "individual",
    ["exposure", "participation", "reflection", "performance"], ALL_PERF,
    T("Write a short investigation", "Ask people a question, gather what they say, and write it up fairly.",
      "Choose a question about school life, interview five people, record their answers accurately, and write 500 words that report what they said and what you conclude — keeping the two apart.",
      ["Five interview notes", "500 words with reporting and conclusion separated"], ["Reports faithfully", "Separates evidence from opinion"], PROMPTS_EN),
    T("Écrire une courte enquête", "Poser une question à des gens, recueillir leurs réponses et les rapporter honnêtement.",
      "Choisissez une question sur la vie scolaire, interrogez cinq personnes, notez fidèlement leurs réponses et écrivez 500 mots qui rapportent ce qu'elles ont dit et ce que vous en concluez — en séparant les deux.",
      ["Cinq notes d'entretien", "500 mots séparant compte rendu et conclusion"], ["Rapporte fidèlement", "Sépare preuve et opinion"], PROMPTS_FR)),

  // ── Humanities & social ─────────────────────────────────────────────────
  A("hum-intro-source", "humanities_social", ["reading_interpretation", "analytical_reasoning"], "INTRODUCTORY", 45, ["PAPER"], "individual",
    ["exposure", "participation", "reflection", "performance"], ["task_completion", "accuracy", "problem_solving_approach"],
    T("Question a source", "Take one text and work out what it says, who wrote it, and why.",
      "Choose a short text (a notice, an article, a speech). Write what it claims, who produced it, what they wanted, and one thing it leaves out.",
      ["Four short answers", "One question you would ask the author"], ["Distinguishes claim from author's purpose", "Notices an omission"], PROMPTS_EN),
    T("Interroger une source", "Prendre un texte et déterminer ce qu'il dit, qui l'a écrit et pourquoi.",
      "Choisissez un texte court (un avis, un article, un discours). Écrivez ce qu'il affirme, qui l'a produit, ce qu'il voulait et une chose qu'il omet.",
      ["Quatre réponses courtes", "Une question que vous poseriez à l'auteur"], ["Distingue affirmation et intention", "Remarque une omission"], PROMPTS_FR)),
  A("hum-inter-history", "humanities_social", ["reading_interpretation"], "INTERMEDIATE", 90, ["PAPER"], "individual",
    ["exposure", "participation", "reflection", "performance"], ["task_completion", "accuracy", "quality", "communication"],
    T("Record a local history", "Interview an elder about how one thing in your area has changed.",
      "Choose one thing (the market, the road, a school). Interview somebody who remembers it differently, write a dated account, and mark what is memory and what you could check.",
      ["An interview record", "A dated account", "A list of what could be checked"], ["Asks open questions", "Marks the limits of memory"], PROMPTS_EN),
    T("Consigner une histoire locale", "Interroger un aîné sur la manière dont une chose de votre quartier a changé.",
      "Choisissez une chose (le marché, la route, une école). Interrogez quelqu'un qui s'en souvient autrement, écrivez un récit daté et marquez ce qui relève de la mémoire et ce qui pourrait être vérifié.",
      ["Un compte rendu d'entretien", "Un récit daté", "Une liste de ce qui pourrait être vérifié"], ["Pose des questions ouvertes", "Marque les limites de la mémoire"], PROMPTS_FR)),
  A("hum-ext-debate", "humanities_social", ["reading_interpretation", "analytical_reasoning", "language_communication"], "EXTENDED", 150, ["PAPER", "GROUP"], "group",
    ["exposure", "participation", "reflection", "performance", "teacher_observation"], ALL_PERF,
    T("Argue both sides", "Prepare and present the strongest case for two opposing positions.",
      "Take a question with two defensible answers. Research both, write the best case for each, present them to a group, and say afterwards which evidence you found hardest to answer.",
      ["Two written cases", "A presentation", "A reflection on the hardest evidence"], ["Represents a view fairly", "Changes position on evidence"], PROMPTS_EN),
    T("Défendre les deux camps", "Préparer et présenter le meilleur argumentaire pour deux positions opposées.",
      "Prenez une question à deux réponses défendables. Documentez les deux, écrivez le meilleur argumentaire pour chacune, présentez-les à un groupe et dites ensuite quelle preuve a été la plus difficile à réfuter.",
      ["Deux argumentaires écrits", "Une présentation", "Une réflexion sur la preuve la plus difficile"], ["Représente un point de vue avec justesse", "Change de position sur des preuves"], PROMPTS_FR)),

  // ── Creative arts ───────────────────────────────────────────────────────
  A("art-intro-series", "creative_arts", ["creative_expression"], "INTRODUCTORY", 45, ["PAPER", "ART_MATERIALS"], "individual",
    ["exposure", "participation", "reflection", "performance"], ["task_completion", "quality", "iteration"],
    T("Make a series of three", "Three versions of one image, each changing one thing.",
      "Draw, paint or photograph one subject three times, changing one choice each time (light, angle, colour). Write which version works best and why.",
      ["Three pieces", "A note on the choice made in each"], ["Varies one thing deliberately", "Judges own work with reasons"], PROMPTS_EN),
    T("Réaliser une série de trois", "Trois versions d'une image, chacune changeant une chose.",
      "Dessinez, peignez ou photographiez un sujet trois fois en changeant un choix à chaque fois (lumière, angle, couleur). Écrivez quelle version marche le mieux et pourquoi.",
      ["Trois pièces", "Une note sur le choix fait dans chacune"], ["Varie une chose délibérément", "Juge son travail avec des raisons"], PROMPTS_FR)),
  A("art-inter-perform", "creative_arts", ["creative_expression", "language_communication"], "INTERMEDIATE", 90, ["NO_SPECIAL_RESOURCES", "GROUP"], "group",
    ["exposure", "participation", "reflection", "performance", "teacher_observation"], ["task_completion", "quality", "communication", "iteration"],
    T("Stage a two-minute scene", "Write and perform a short scene with a beginning, a turn and an end.",
      "In a group, write a two-minute scene, rehearse it twice, perform it, and record one change you made between rehearsal and performance.",
      ["The script", "The performance", "The recorded change"], ["Shapes a scene with structure", "Adjusts after rehearsal"], PROMPTS_EN),
    T("Monter une scène de deux minutes", "Écrire et jouer une courte scène avec un début, un tournant et une fin.",
      "En groupe, écrivez une scène de deux minutes, répétez-la deux fois, jouez-la et notez un changement fait entre la répétition et la représentation.",
      ["Le texte", "La représentation", "Le changement noté"], ["Structure une scène", "Ajuste après répétition"], PROMPTS_FR)),
  A("art-ext-brief", "creative_arts", ["creative_expression", "visual_spatial"], "EXTENDED", 180, ["PAPER", "ART_MATERIALS"], "individual",
    ["exposure", "participation", "reflection", "performance"], ALL_PERF,
    T("Answer a real brief", "Make something the school actually needs: a poster, a badge, a short film, a song.",
      "Take a real request from a teacher or club, agree what it must achieve, produce it, show it to the requester, and revise once from their response.",
      ["The agreed brief", "The work", "The revision after feedback"], ["Works to a constraint", "Revises for an audience"], PROMPTS_EN),
    T("Répondre à une vraie commande", "Réaliser quelque chose dont l'école a besoin : une affiche, un badge, un court film, une chanson.",
      "Prenez une vraie demande d'un enseignant ou d'un club, convenez de ce qu'elle doit accomplir, réalisez-la, montrez-la au demandeur et révisez une fois d'après sa réponse.",
      ["La commande convenue", "L'œuvre", "La révision après retour"], ["Travaille sous contrainte", "Révise pour un public"], PROMPTS_FR)),

  // ── Organisation & enterprise ───────────────────────────────────────────
  A("org-intro-plan", "organisation_enterprise", ["organizational_structured"], "INTRODUCTORY", 40, ["PAPER"], "individual",
    ["exposure", "participation", "reflection", "performance"], ["task_completion", "quality", "communication"],
    T("Plan a small event on paper", "Everything a class tidy-up needs: who, what, when, with what.",
      "Write a plan for a one-hour class activity: tasks, order, who does each, what is needed, and what could go wrong with a fallback for each.",
      ["A one-page plan", "A risk list with fallbacks"], ["Sequences tasks sensibly", "Anticipates a failure"], PROMPTS_EN),
    T("Planifier un petit événement sur papier", "Tout ce qu'un rangement de classe exige : qui, quoi, quand, avec quoi.",
      "Écrivez un plan pour une activité de classe d'une heure : tâches, ordre, responsable de chacune, matériel, et ce qui pourrait mal tourner avec une solution de repli.",
      ["Un plan d'une page", "Une liste de risques avec replis"], ["Ordonne les tâches raisonnablement", "Anticipe un échec"], PROMPTS_FR)),
  A("org-inter-budget", "organisation_enterprise", ["organizational_structured", "quantitative_reasoning"], "INTERMEDIATE", 90, ["PAPER"], "pair",
    ["exposure", "participation", "reflection", "performance"], ["task_completion", "accuracy", "quality", "communication"],
    T("Budget a club for a term", "Income, costs and a decision about what the club can afford.",
      "For a real or imagined club, list income and costs for a term, build a budget, and write a recommendation of what to cut or add, with the numbers that justify it.",
      ["A budget table", "A recommendation with figures"], ["Balances income and cost", "Justifies a decision with numbers"], PROMPTS_EN),
    T("Budgétiser un club pour un trimestre", "Recettes, coûts et une décision sur ce que le club peut se permettre.",
      "Pour un club réel ou imaginé, listez recettes et coûts pour un trimestre, construisez un budget et rédigez une recommandation sur ce qu'il faut réduire ou ajouter, chiffres à l'appui.",
      ["Un tableau de budget", "Une recommandation chiffrée"], ["Équilibre recettes et coûts", "Justifie une décision par des chiffres"], PROMPTS_FR)),
  A("org-ext-run", "organisation_enterprise", ["organizational_structured", "social_collaborative"], "EXTENDED", 240, ["PAPER", "GROUP", "TEACHER_SUPPORT"], "group",
    ["exposure", "participation", "reflection", "performance", "teacher_observation"], ALL_PERF,
    T("Run something for real", "Organise an actual small event or sale and account for it afterwards.",
      "With a teacher's agreement, plan and run a small event or sale. Keep the plan, the roles, the receipts, and write what went to plan, what did not, and what you would change.",
      ["The plan and roles", "The accounts", "A written review"], ["Coordinates others", "Reviews honestly against the plan"], PROMPTS_EN),
    T("Organiser quelque chose pour de vrai", "Organiser un vrai petit événement ou une vente et en rendre compte ensuite.",
      "Avec l'accord d'un enseignant, planifiez et réalisez un petit événement ou une vente. Gardez le plan, les rôles, les reçus, et écrivez ce qui s'est passé comme prévu, ce qui ne l'a pas été, et ce que vous changeriez.",
      ["Le plan et les rôles", "Les comptes", "Un bilan écrit"], ["Coordonne les autres", "Fait un bilan honnête"], PROMPTS_FR)),

  // ── Collaboration & service ─────────────────────────────────────────────
  A("coll-intro-tutor", "collaborative_service", ["social_collaborative", "language_communication"], "INTRODUCTORY", 45, ["NO_SPECIAL_RESOURCES"], "pair",
    ["exposure", "participation", "reflection", "performance"], ["task_completion", "communication", "iteration"],
    T("Teach one thing to one person", "Help a classmate with something you can do, and check it worked.",
      "Choose a skill or topic. Explain it to one classmate, let them try, notice where they struggle, explain differently, and ask them to teach it back.",
      ["A note of what was taught and how", "The classmate's teach-back"], ["Adapts explanation to the learner", "Checks understanding rather than assuming it"], PROMPTS_EN),
    T("Enseigner une chose à une personne", "Aider un camarade sur quelque chose que vous savez faire, et vérifier que cela a marché.",
      "Choisissez une compétence ou un sujet. Expliquez-le à un camarade, laissez-le essayer, repérez où il bute, expliquez autrement et demandez-lui de vous l'enseigner en retour.",
      ["Une note de ce qui a été enseigné et comment", "La restitution du camarade"], ["Adapte l'explication à l'apprenant", "Vérifie la compréhension au lieu de la supposer"], PROMPTS_FR)),
  A("coll-inter-team", "collaborative_service", ["social_collaborative"], "INTERMEDIATE", 90, ["GROUP"], "group",
    ["exposure", "participation", "reflection", "performance", "teacher_observation"], ["task_completion", "communication", "iteration"],
    T("Complete a task as a team of four", "One outcome, four roles, and a review of how the team worked.",
      "Take a task no one person could finish in the time. Agree roles, do it, and each write what the team did well and one thing that would make the next task go better.",
      ["The outcome", "Four short reviews"], ["Takes and keeps a role", "Reviews the team's work, not the people"], PROMPTS_EN),
    T("Accomplir une tâche en équipe de quatre", "Un résultat, quatre rôles, et un bilan du fonctionnement de l'équipe.",
      "Prenez une tâche qu'une seule personne ne pourrait pas finir dans le temps. Répartissez les rôles, réalisez-la, et écrivez chacun ce que l'équipe a bien fait et une chose qui améliorerait la prochaine tâche.",
      ["Le résultat", "Quatre courts bilans"], ["Prend et tient un rôle", "Évalue le travail de l'équipe, pas les personnes"], PROMPTS_FR)),
  A("coll-ext-service", "collaborative_service", ["social_collaborative", "organizational_structured"], "EXTENDED", 240, ["GROUP", "TEACHER_SUPPORT"], "group",
    ["exposure", "participation", "reflection", "performance", "teacher_observation"], ALL_PERF,
    T("Serve the school community", "Identify a need in the school and meet it with others over a month.",
      "With a teacher, identify one need (a reading corner, a clean-up, a welcome for new students). Plan it, do it over four weeks, keep a log, and present what changed.",
      ["A plan", "A four-week log", "A presentation of what changed"], ["Sustains effort over weeks", "Measures what changed"], PROMPTS_EN),
    T("Servir la communauté scolaire", "Repérer un besoin dans l'école et y répondre avec d'autres pendant un mois.",
      "Avec un enseignant, identifiez un besoin (un coin lecture, un nettoyage, un accueil des nouveaux). Planifiez-le, réalisez-le sur quatre semaines, tenez un journal et présentez ce qui a changé.",
      ["Un plan", "Un journal de quatre semaines", "Une présentation de ce qui a changé"], ["Soutient l'effort sur des semaines", "Mesure ce qui a changé"], PROMPTS_FR)),
]);

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const isNonEmptyString = (s) => typeof s === "string" && s.trim().length > 0;

/** The problems with an activity definition; empty when it is valid. */
const validateActivity = (a) => {
  const p = [];
  if (!a || typeof a !== "object") return ["activity must be an object"];
  if (!isNonEmptyString(a.activityId)) p.push("activityId is required");
  if (!Number.isInteger(a.version) || a.version < 1) p.push("version must be a positive integer");
  if (!AREAS.includes(a.area)) p.push(`area must be one of ${AREAS.join(", ")}`);
  if (a.category !== CATEGORY_OF_AREA[a.area]) p.push("category must match the area");
  if (!Array.isArray(a.dimensions) || !a.dimensions.length) p.push("dimensions are required");
  if (!LEVELS.includes(a.level)) p.push(`level must be one of ${LEVELS.join(", ")}`);
  if (!Number.isInteger(a.estimatedMinutes) || a.estimatedMinutes <= 0) p.push("estimatedMinutes must be a positive integer");
  if (!Array.isArray(a.resources) || !a.resources.length || !a.resources.every((r) => RESOURCES.includes(r))) p.push("resources must be a non-empty list of known resources");
  if (!DELIVERY_MODES.includes(a.deliveryMode)) p.push("deliveryMode is unknown");
  if (!Array.isArray(a.evidenceTypes) || !a.evidenceTypes.every((e) => EVIDENCE_TYPES.includes(e))) p.push("evidenceTypes contains an unknown type");
  if (!Array.isArray(a.performanceCriteria) || !a.performanceCriteria.every((c) => PERFORMANCE_CRITERIA.includes(c))) p.push("performanceCriteria contains an unknown criterion");
  if ((a.evidenceTypes ?? []).includes("performance") && !(a.performanceCriteria ?? []).length) p.push("an activity that produces performance evidence must name its criteria");
  for (const lang of ["en", "fr"]) {
    const t = a.text?.[lang];
    if (!t) { p.push(`text.${lang} is required`); continue; }
    for (const k of ["title", "description", "task"]) if (!isNonEmptyString(t[k])) p.push(`text.${lang}.${k} is required`);
    for (const k of ["expectedOutputs", "observable", "reflectionPrompts"]) if (!Array.isArray(t[k]) || !t[k].length) p.push(`text.${lang}.${k} must be a non-empty list`);
  }
  if (a.status !== "active" && a.status !== "retired") p.push("status must be active or retired");
  // Identity never lives on a definition.
  for (const k of ["studentId", "studentName", "schoolId", "userId"]) if (k in (a ?? {})) p.push(`${k} does not belong on a reusable activity`);
  return p;
};

/** One activity in one language, text flattened; `text` kept for the other. */
const localize = (a, lang = "en") => {
  const t = a.text?.[lang] ?? a.text?.en ?? {};
  const { text, ...rest } = a;
  void text;
  return { ...rest, language: a.text?.[lang] ? lang : "en", ...t, engineVersion: EXPLORATION_ENGINE_VERSION };
};

const activityById = (id) => ACTIVITIES.find((a) => a.activityId === id) ?? null;

module.exports = {
  EXPLORATION_ENGINE_VERSION,
  LEVELS, RESOURCES, DELIVERY_MODES, EVIDENCE_TYPES,
  PERFORMANCE_CRITERIA, PERFORMANCE_RATINGS, OBSERVATION_LEVELS, OBSERVATION_CODES, REFLECTION,
  CATEGORY_OF_AREA, AREAS, ADJACENT_AREAS,
  ACTIVITIES, validateActivity, localize, activityById,
};
