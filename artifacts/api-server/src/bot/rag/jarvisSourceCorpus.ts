import { JARVIS_SOURCE_GROUP_1 } from "./jarvisSourceGroup1.js";
import { JARVIS_SOURCE_GROUP_2 } from "./jarvisSourceGroup2.js";
import { JARVIS_SOURCE_GROUP_3 } from "./jarvisSourceGroup3.js";
import type { JarvisSourceDocument } from "./jarvisSourceTypes.js";

export const JARVIS_SOURCE_DOCUMENTS: JarvisSourceDocument[] = [
  ...JARVIS_SOURCE_GROUP_1,
  ...JARVIS_SOURCE_GROUP_2,
  ...JARVIS_SOURCE_GROUP_3,
];
