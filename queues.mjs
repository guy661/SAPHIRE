import { Queue } from "bullmq";
import { connection } from "./redis.mjs";

export const fetchQueue = new Queue("fetch", { connection });
export const semanticSummaryQueue = new Queue("semantic-summary", { connection });
