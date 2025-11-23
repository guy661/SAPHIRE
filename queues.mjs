import { Queue } from "bullmq";
import { connection } from "./redis.mjs";

const fetchQueue = new Queue("fetch", { connection });
const semanticSummaryQueue = new Queue("semantic-summary", { connection });

export default { fetchQueue, semanticSummaryQueue };
