import assert from "node:assert/strict";
import test from "node:test";
import {
  extractFirstName,
  isAffirmative,
  isNameRefusal,
  isNegative,
  isValidContact,
  normalizeContact,
  parseFamilyProfile,
  wantsToSkip,
} from "./flow-v2.js";
import {
  isV2Stage,
  makeQuestionStage,
  normalizeStoredStage,
  parseQuestionStage,
} from "./stages-v2.js";

test("name can be provided or explicitly skipped", () => {
  assert.equal(extractFirstName("Артём"), "Артём");
  assert.equal(extractFirstName("Анна Петрова"), "Анна");
  assert.equal(isNameRefusal("без имени"), true);
  assert.equal(extractFirstName("без имени"), null);
  assert.equal(extractFirstName("1"), null);
});

test("affirmative, negative and video skip phrases are deterministic", () => {
  assert.equal(isAffirmative("other", "давай посмотрим"), true);
  assert.equal(isAffirmative("affirmative", "что угодно"), true);
  assert.equal(isNegative("soft_decline", "не хочу"), true);
  assert.equal(isNegative("negative", "нет"), true);
  assert.equal(wantsToSkip("пропусти видео"), true);
  assert.equal(wantsToSkip("посмотрим"), false);
});

test("family parser handles adults, children and female hygiene", () => {
  assert.deepEqual(parseFamilyProfile("2 взрослых и 2 ребёнка, есть женщины"), {
    adults: 2,
    children: 2,
    femaleHygieneRelevant: true,
  });

  assert.deepEqual(parseFamilyProfile("1 взрослый, женщин нет"), {
    adults: 1,
    children: 0,
    femaleHygieneRelevant: false,
  });

  assert.deepEqual(parseFamilyProfile("4 человека"), {
    adults: 4,
    children: 0,
    femaleHygieneRelevant: true,
  });
});

test("contact validator accepts Telegram and phone but rejects arbitrary text", () => {
  assert.equal(isValidContact("@green7979"), true);
  assert.equal(isValidContact("green7979"), true);
  assert.equal(normalizeContact("green7979"), "@green7979");
  assert.equal(isValidContact("+7 999 123-45-67"), true);
  assert.equal(isValidContact("напишите мне потом"), false);
});

test("question mode safely stores and restores a typed stage", () => {
  const stored = makeQuestionStage("dish_video_permission");
  assert.equal(stored, "v2_question:dish_video_permission");
  assert.equal(parseQuestionStage(stored), "dish_video_permission");
  assert.equal(parseQuestionStage("v2_question:unknown_stage"), null);
});

test("legacy stages map to the closest v2 stage", () => {
  assert.equal(normalizeStoredStage("depth_choice"), "laundry_brand");
  assert.equal(normalizeStoredStage("laundry_video"), "laundry_video_reaction");
  assert.equal(normalizeStoredStage("lead_capture_contact"), "lead_contact");
  assert.equal(normalizeStoredStage("unexpected"), "intro");
  assert.equal(isV2Stage("final_interest"), true);
  assert.equal(isV2Stage("final_question"), false);
});
