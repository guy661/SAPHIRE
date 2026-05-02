import { Queue } from 'bullmq';
import redisConnection from './redis.mjs';

export const microSummaryQueue = new Queue('micro-summary', { 
    connection: redisConnection,
    defaultJobOptions: {
        attempts: 5,
        backoff: {
            type: 'exponential',
            delay: 10000,
        },
        removeOnComplete: true,
        removeOnFail: false
    }
});

console.log('✅-Queue microSummaryQueue initialized');

const queues = {
    microSummaryQueue,
};

export default queues;