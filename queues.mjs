import { Queue } from 'bullmq';
import redisConnection from './redis.mjs';

export const microSummaryQueue = new Queue('micro-summary', { connection: redisConnection });

console.log('✅-Queue microSummaryQueue initialized');

const queues = {
    microSummaryQueue,
};

export default queues;