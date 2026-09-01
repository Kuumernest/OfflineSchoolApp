// backend/scripts/seed-form1-students.js
"use strict";

/**
 * Creates 50 test students in Form 1.
 * Each gets a User account + Student record with a unique enrollment number.
 * Safe to run multiple times — skips if 50+ Form 1 students already exist.
 */

require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt   = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");

const User    = require("../src/db/models/User");
const Student = require("../src/db/models/Student");

const SCHOOL_ID = "6a4ccbfac10ad6faa189bd85";
const CLASS_ID  = "0ac69e73-2729-443d-9f72-a26c396c3c59";
const PREFIX    = "GVA00/2026/";
const COUNT     = 50;
const PASSWORD  = "student123"; // default password for all test students

// ── Cameroon names ──────────────────────────────────────────────────────────

const MALE_FIRST = [
  "Aaron","Abel","Adam","Adolph","Alain","Albert","Alex","Alfred","Alvin",
  "Ambrose","Amos","Ange","Anthony","Arnold","Ashley","Axel","Barnabas",
  "Bernard","Bless","Brandon","Brian","Calvin","Carl","Cedric","Charles",
  "Christian","Christopher","Clarence","Clement","Clinton","Cyril","Daniel",
  "Darren","David","Denis","Dennis","Desmond","Donald","Doris","Edmond",
  "Edward","Elijah","Emmanuel","Eric","Ernest","Fabian","Felix","Flavian",
  "Francis","Frank","Frederick","Gavin","George","Gerald","Gordon","Grace",
  "Gregory","Hans","Henry","Herbert","Herman","Hubert","Hugo","Isaac",
  "Ivan","Jack","Jacob","James","Jeffrey","Jeremy","Jerome","Joel",
  "John","Joseph","Joshua","Julian","Junior","Justin","Kenneth","Kevin",
  "Larry","Laurent","Lawrence","Levi","Louis","Luc","Luke","MARC",
  "Marcel","Marcus","Marius","Mark","Martin","Matthew","Max","Michael",
  "Milton","Moses","Munanchi","Nelson","Nicholas","Noel","Norbert","Norris",
  "Obinna","Oliver","Oscar","Patrick","Paul","Peter","Philip","Pierre",
  "Prosper","Quintus","Raphael","Raymond","Reagan","Richard","Robert",
  "Roger","Roland","Romanus","Ross","Rostand","Samuel","Schadrach","Sean",
  "Serges","Severin","Simeon","Simon","Stanley","Stephen","Sylvanus",
  "Theodore","Thierry","Thomas","Timothy","Tino","Tristan","Urban","Valentine",
  "Vincent","Vitalis","Walter","Willibald","William","Willy","Yannick",
  "Yves","Zacharie",
];

const FEMALE_FIRST = [
  "Abigail","Adelaide","Adeline","Agatha","Agnes","Aimée","Albane","Alexandra",
  "Alice","Aline","Alisa","Alison","Amélie","Amina","Anastasie","Andrea",
  "Angélique","Anne","Annette","Annie","Aurélie","Axelle","Beatrice",
  "Bénédicte","Bernadette","Berty","Blessing","Brigitte","Carine","Caroline",
  "Cécile","Célestine","Chantal","Charlotte","Chloé","Christelle","Christiane",
  "Claire","Claudine","Clémentine","Colette","Corinne","Cynthia","Danielle",
  "Daphnée","Deborah","Delphine","Denise","Diana","Diane","Dominique","Dorothy",
  "Edith","Edwige","Eileen","Elena","Elisabeth","Ella","Eloïse","Elsa",
  "Emmanuelle","Estelle","Esther","Ethel","Eugénie","Eva","Eve","Exaucée",
  "Fabiola","Fatima","Flore","Florence","Françoise","Gabrielle","Gaelle",
  "Ginette","Gladys","Grâce","Hélène","Henriette","Herimana","Honorine",
  "Hortense","Inès","Innocente","Isabelle","Isla","Jacqueline","Jade",
  "Jeanne","Jennifer","Jenny","Jessica","Judith","Julia","Julie","Justine",
  "Laetitia","Lambertine","Laure","Laurence","Léa","Léonie","Lilian",
  "Lillian","Line","Lisa","Lise","Louise","Lucie","Lydie","Madeleine",
  "Manuela","Marcelle","Marguerite","Marie","Marie-Claire","Marie-José",
  "Marilyn","Marthe","Martine","Mary","Mathilde","Maud","Maureen","Mélissa",
  "Micheline","Monique","Nadine","Nathalie","Nicole","Noémie","Odile",
  "Olympe","Patricia","Patience","Pauline","Pénélope","Perrine","Philomène",
  "Placide","Prisca","Priscilla","Rachel","Rachelle","Raymonde","Régine",
  "Reine","Rita","Rolande","Rose","Rosemond","Sabine","Salomé","Samira",
  "Sandra","Sandrine","Sarah","Scholastique","Séraphine","Sériane","Sylvie",
  "Thérèse","Valérie","Véronique","Victoire","Vicky","Viola","Viviane",
  "Yolande","Yvette","Yvonne","Zineb",
];

const LAST_NAMES = [
  "Abada","Abdou","Achidi","Agaar","Agbor","Akamba","Akello","Akolgo",
  "Alain","Amabo","Amba","Ambe","Andze","Angu","Animbom","Asaha",
  "Ashu","Atanga","Atem","Ati","Ayaba","Azoho","Baka","Bala",
  "Balanga","Bambe","Bamela","Banda","Bangsi","Banlog","Bankong","Bassey",
  "Bate","Batonga","Bechem","Bele","Bell","Belmond","Ben","Beng",
  "Besse","Betie","Bih","Bikoi","Biloa","Bindzi","Biyiti","Blass",
  "Bogny","Boma","Bond","Bong","Bongli","Bongmin","Bonn","Bonu",
  "Bopda","Bor","Borel","Bot","Bouli","Boum","Bousso","Brice",
  "Bristel","Brobbey","Bulo","Busa","Cabrel","Calvince","Cameroon","Carnot",
  "Chantal","Chia","Chilver","Chou","Christian","Clement","Clinton","Coblah",
  "Colette","Damas","Dambanya","Damien","Damon","David","Deffo","Delors",
  "Demenge","Denis","Desmond","Dexter","Didier","Dimitri","Dipanda","Djomo",
  "Dogmo","Donatus","Dongmo","Donzella","Dorothy","Doss","Douala","Dumont",
  "Ekotto","Ekume","Ekwensi","Elango","Elebiama","Elone","Embang","Embe",
  "Embelle","Emetchi","Emmanuel","Endam","Enow","Epane","Epie","Eppie",
  "Essaka","Essama","Essomba","Estelle","Etchu","Etta","Etuge","Eugene",
  "Eyabi","Eyango","Eyongeta","Ezekiel","Ezéchiel","Fai","Fankam","Fanky",
  "Favor","Felix","Fils","Fobissie","Fon","Fonki","Forjou","Fotso",
  "Fouda","Fru","Fucking","Fum","Funchal","Fuxia","Gaetan","Galabe",
  "Ganne","Garba","Garnier","Gaspar","Gastin","Gervais","Ghislain","Gin",
  "Gobina","Godlove","Gonounga","Gonze","Gordon","Gorel","Gou фай","Guisse",
  "Hans","Hara","Hilaire","Hilary","Hippolyte","Hmann","Hollande","Honoré",
  "Horm","Hugo","Ifeanyichukwu","Igwe","Ikang","Ikome","Imbach","Ime",
  "Irune","Isaac","Isang","Ise","Issa","Itchi","Itoe","Ivane",
  "Iyane","Jabin","Jacques","Jacquin","Jama","Jancha","Jean","Jeremi",
  "Jérémie","Jérôme","Joel","Joseph","Judicaël","Junior","Justin","Kaffo",
  "Kagho","Kamga","Kanjo","Kant","Kariuki","Karo","Keku","Kelvin",
  "Ken","Kilo","Kiven","Koffi","Koh","Kom","Kon","Konda",
  "Kouam","Kouogang","Kwaffe","Kwah","Kwaheru","Kwei","Laurent","Leeken",
  "Lekep","Leyla","Leon","Leonard","Lessom","Leuvan","Libam","Likibi",
  "Linge","Lingue","Lobe","Log","Logmo","Long","Longues","Louis",
  "Lukong","Lumbala","Lumumba","Lyonga","Maaga","Mabang","Mabeka","Mabela",
  "Mabille","Mabi","Mabou","Mache","Madira","Mado","Mafoko","Mafounte",
  "Magbare","Magne","Mahop","Maire","Maisam","Makam","Makhtar","Malang",
  "Malonga","Malu","Mamadou","Mand","Manga","Mangack","Mangelle","Mani",
  "Manuela","Manyo","Marcel","Marguerite","Marie","Marinette","Martial",
  "Martin","Massa","Massock","Mate","Math","Matip","Mbianda","Mbida",
  "Mbita","Mbome","Mbon","Mboo","Mbot","Mbow","Mbu","Mbua",
  "Mbuji","Mebenga","Mechi","Medjo","Mekongo","Mel","Melone","Memna",
  "Mendouga","Mengue","Mentou","Mepiao","Mercel","Merlin","Metogue","Mevoundou",
  "Mintsa","Moa","Mokube","Molem","Molua","Mombo","Momo","Monjowoh",
  "Mono","Mono","Monono","Monsieur","Moock","Moreau","Mounde","Mouelle",
  "Mouement","Moukoko","Moulin","Moussa","Mouttet","Muzondiwan","Mvondo","Nana",
  "Nang","Nanke","Ndi","Ndo","Ndoh","Ndongo","Neba","Ned",
  "Neling","Ngachu","Ngaha","Ngala","Ngalame","Ngauccess","Ngand","Ngane",
  "Ngansala","Nguetnia","Ngu","Ngufor","Nguimdo","Nguimess","Ngum","Ngwa",
  "Ngwe","Nina","Njiki","Njimom","Nkada","Nkain","Nkelle","Nkem",
  "Nkeng","Nkene","Nkongho","Nkoulou","Nkoussou","Ntah","Ntui","Nubi",
  "Nwankwo","Nyambi","Nyembi","Nyo","Nyolfon","Obam","Oben","Obi",
  "Obiakor","Obiko","Obiorah","Ocaya","Ogueke","Okenye","Okenve","Oki",
  "Ola","Olama","Olayinka","Olivier","Olu","Oma","Onana","Onana",
  "Onanena","Ondoua","Onana","Onguene","Onyango","Open","Orock","Oruna",
  "Osée","Ossomba","Otem","Otim","Otou","Owona","Oyelaran","Oyono",
  "Pascal","Passga","Penda","Pierre","Pieter","Placide","Pobill","Pol",
  "Pont","Portella","Priso","Quinn","Raissa","Rascha","Reckley","Rene",
  "Richmond","Rita","Roch","Rodrigue","Rogers","Roland","Rolande","Roman",
  "Romaric","Romeo","Ross","Rostand","Roussel","Rudolf","Ruth","Ruy",
  "Saaba","Sack","Sacouman","Sado","Sagoe","Saha","Sail","Salomon",
  "Sam","Samuel","Sandrine","Sangue","Sanoga","Santos","Sarr","Sasse",
  "Sauer","Schilo","Seck","Sekou","Sende","Serge","Serges","Sering",
  "Sesame","Set","Shank","Shey","Si","Sighoko","Silvain","Siméon",
  "Simon","Simo","Sirri","Solange","Somassa","Sombo","Sone","Sophia",
  "Sore","Souleymane","Staub","Stève","Studio","Sueur","Sultana","Tabi",
  "Taga","Takam","Tala","Tambwe","Tanda","Tatchou","Tchamda","Tchendjoua",
  "Tchenti","Tcheumeu","Tcheva","Tchinda","Tchoupo","Tchui","Tem","Tening",
  "Terence","Tété","Thierry","Théodore","Thom","Tiatri","Tientcheu","Tindo",
  "Tine","Tinto","Tita","Todou","Toko","Tol","Toma","Tonkue",
  "Tou","Touchi","Toukam","Touko","Toung","Touré","Tresor","Tsafack",
  "Tsafo","Tse","Tsimi","Tud","Tum","Turo","Ubong","Ugochukwu",
  "Ukpanya","Ulrich","Uma","Uzoma","Venance","Veronique","Victoire","Victor",
  "Vidjang","Vieri","Vilate","Vital","Viviane","Vron","Wainaina","Wambo",
  "Wang","Wanke","Warne","Watio","Wess","Willy","Windford","Wingo",
  "Wisdom","Wombe","Wonja","Wore","Yannick","Yatara","Yembi","Yerima",
  "Yetene","Yogo","Yomi","Youbi","Youl","Zambo","Zang","Zebaze",
  "Ze","Zing","Zogo","Zou",
];

// ── Helpers ──────────────────────────────────────────────────────────────────

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const uniq = (arr, count) => {
  const set = new Set();
  const result = [];
  while (result.length < count && set.size < arr.length) {
    const item = pick(arr);
    if (!set.has(item)) { set.add(item); result.push(item); }
  }
  return result;
};

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to MongoDB");

  // Check existing Form 1 students
  const existing = await Student.countDocuments({
    schoolId: SCHOOL_ID,
    classId: CLASS_ID,
    deletedAt: null,
  });
  console.log(`Existing Form 1 students: ${existing}`);

  if (existing >= 50) {
    console.log("Already have 50+ students in Form 1. Nothing to do.");
    await mongoose.disconnect();
    return;
  }

  // Find the highest enrollment number to continue from
  const allUsers = await User.find({
    schoolId: SCHOOL_ID,
    role: "student",
    enrollmentNo: { $regex: `^${PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` },
  })
    .select("enrollmentNo")
    .lean();

  let nextNum = 1;
  for (const u of allUsers) {
    if (!u.enrollmentNo) continue;
    const n = parseInt(u.enrollmentNo.split("/").pop(), 10);
    if (Number.isFinite(n) && n >= nextNum) nextNum = n + 1;
  }
  console.log(`Starting enrollment numbers from: ${PREFIX}${String(nextNum).padStart(3, "0")}`);

  // Build 50 unique name combinations
  const usedNames = new Set();
  const students = [];

  while (students.length < COUNT) {
    const gender = Math.random() > 0.5 ? "male" : "female";
    const firstName = gender === "male" ? pick(MALE_FIRST) : pick(FEMALE_FIRST);
    const lastName = pick(LAST_NAMES);
    const fullName = `${firstName} ${lastName}`;

    if (usedNames.has(fullName)) continue;
    usedNames.add(fullName);

    const seq = nextNum + students.length;
    const enrollmentNo = `${PREFIX}${String(seq).padStart(3, "0")}`;

    // Birth year: 2010–2014 (Form 1 age ~12-16)
    const birthYear = 2010 + Math.floor(Math.random() * 5);
    const birthMonth = Math.floor(Math.random() * 12) + 1;
    const birthDay = Math.floor(Math.random() * 28) + 1;

    students.push({
      gender,
      firstName,
      lastName,
      fullName,
      enrollmentNo,
      dateOfBirth: `${birthYear}-${String(birthMonth).padStart(2, "0")}-${String(birthDay).padStart(2, "0")}`,
      guardianFirstName: pick(MALE_FIRST),
      guardianLastName: lastName, // same last name as student
    });
  }

  const hashedPassword = await bcrypt.hash(PASSWORD, 12);
  let created = 0;

  for (const s of students) {
    try {
      // Create User
      const userId = uuidv4();
      await User.create({
        _id: userId,
        name: s.fullName,
        email: null,
        password: hashedPassword,
        enrollmentNo: s.enrollmentNo,
        role: "student",
        schoolId: SCHOOL_ID,
        isActive: true,
        mustResetPassword: true,
      });

      // Create Student
      await Student.create({
        _id: uuidv4(),
        userId,
        schoolId: SCHOOL_ID,
        classId: CLASS_ID,
        className: "Form 1",
        enrollmentNo: s.enrollmentNo,
        studentName: s.fullName,
        firstName: s.firstName,
        lastName: s.lastName,
        gender: s.gender,
        dateOfBirth: s.dateOfBirth,
        status: "approved",
        isActive: true,
        enrolledAt: new Date(),
        approvedAt: new Date(),
        guardianName: `${s.guardianFirstName} ${s.guardianLastName}`,
        guardianPhone: `+237 ${6}${Math.floor(Math.random() * 90000000 + 10000000)}`,
        address: "Buea, Cameroon",
      });

      created++;
    } catch (err) {
      console.error(`Failed to create ${s.fullName}:`, err.message);
    }
  }

  console.log(`\n✅ Created ${created} students in Form 1`);
  console.log(`   Enrollment numbers: ${PREFIX}${String(nextNum).padStart(3, "0")} – ${PREFIX}${String(nextNum + created - 1).padStart(3, "0")}`);
  console.log(`   Default password: ${PASSWORD}`);
  console.log(`   Students can log in with their enrollment number and this password.`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
