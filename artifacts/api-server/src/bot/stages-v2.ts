export const V2_STAGES = [
  "intro",
  "name_question",
  "laundry_brand",
  "laundry_permission",
  "laundry_video_permission",
  "laundry_video_reaction",
  "laundry_calc_permission",
  "laundry_calc_done",
  "dish_brand",
  "dish_permission",
  "dish_video_permission",
  "dish_video_reaction",
  "dish_calc_permission",
  "dish_calc_done",
  "pads_intro",
  "pads_permission",
  "pads_video_permission",
  "pads_video_reaction",
  "pads_calc_permission",
  "pads_calc_done",
  "toilet_brand",
  "toilet_permission",
  "toilet_video_permission",
  "toilet_video_reaction",
  "toilet_calc_permission",
  "toilet_calc_done",
  "family_question",
  "family_summary",
  "company_permission",
  "purchase_interest",
  "purchase_options_permission",
  "start_reaction",
  "price_objection",
  "model_permission",
  "model_reason_permission",
  "final_summary_permission",
  "final_interest",
  "lead_name",
  "lead_contact",
  "completed",
  "doubt",
] as const;

export type V2Stage = (typeof V2_STAGES)[number];

const V2_STAGE_SET = new Set<string>(V2_STAGES);
const QUESTION_PREFIX = "v2_question:";

export function isV2Stage(value: string): value is V2Stage {
  return V2_STAGE_SET.has(value);
}

export function makeQuestionStage(returnStage: V2Stage): string {
  return `${QUESTION_PREFIX}${returnStage}`;
}

export function parseQuestionStage(value: string): V2Stage | null {
  if (!value.startsWith(QUESTION_PREFIX)) return null;
  const returnStage = value.slice(QUESTION_PREFIX.length);
  return isV2Stage(returnStage) ? returnStage : null;
}

export function normalizeStoredStage(value: string): V2Stage {
  if (isV2Stage(value)) return value;

  const questionReturn = parseQuestionStage(value);
  if (questionReturn) return questionReturn;

  const legacyMap: Record<string, V2Stage> = {
    intro_video: "intro",
    depth_choice: "laundry_brand",
    quick_savings: "laundry_brand",
    laundry_question: "laundry_brand",
    laundry_reaction: "laundry_permission",
    laundry_short_or_details: "laundry_video_permission",
    laundry_video: "laundry_video_reaction",
    laundry_greenleaf: "laundry_calc_permission",
    laundry_calc: "laundry_calc_done",
    dish_question: "dish_brand",
    dish_reaction: "dish_permission",
    dish_short_or_details: "dish_video_permission",
    dish_video: "dish_video_reaction",
    dish_greenleaf: "dish_calc_permission",
    dish_calc: "dish_calc_done",
    pads_reaction: "pads_permission",
    pads_short_or_details: "pads_video_permission",
    pads_video: "pads_video_reaction",
    pads_greenleaf: "pads_calc_permission",
    pads_calc: "pads_calc_done",
    toilet_question: "toilet_brand",
    toilet_reaction: "toilet_permission",
    toilet_short_or_details: "toilet_video_permission",
    toilet_video: "toilet_video_reaction",
    toilet_greenleaf: "toilet_calc_permission",
    toilet_calc: "toilet_calc_done",
    big_calculation: "family_summary",
    calculation_conclusion: "company_permission",
    company_video: "purchase_interest",
    quality_block: "purchase_interest",
    purchase_interest_question: "purchase_interest",
    purchase_options: "purchase_options_permission",
    partnership_explain: "purchase_options_permission",
    start_28900: "start_reaction",
    cashback_10: "model_permission",
    bonus_video: "model_permission",
    bonus_explain: "model_permission",
    free_product_logic: "model_permission",
    model_3x3: "model_reason_permission",
    why_show_to_3_people: "model_reason_permission",
    model_3x3_result: "final_summary_permission",
    final_logic: "final_interest",
    final_question: "final_interest",
    lead_capture_name: "lead_name",
    lead_capture_contact: "lead_contact",
    lead_capture_comment: "lead_contact",
  };

  return legacyMap[value] || "intro";
}
