import { Queue } from 'bullmq';
import redisConnection from './redis.mjs';

const fetchQueue = new Queue('fetch', {
    connection: redisConnection,
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 1000,
        },
        removeOnComplete: true,
        removeOnFail: 1000,
    }
});

const semanticSummaryQueue = new Queue('semantic-summary', {
    connection: redisConnection,
    limiter: {
        max: 20,
        duration: 60000
    },
    defaultJobOptions: {
        attempts: 2,
        backoff: {
            type: 'exponential',
            delay: 5000,
        },
        removeOnComplete: true,
        removeOnFail: 1000,
    }
});

const synthesisQueue = new Queue('synthesis', {
    connection: redisConnection,
    limiter: {
        max: 20,
        duration: 60000
    },
    defaultJobOptions: {
        attempts: 2,
        backoff: {
            type: 'exponential',
            delay: 5000,
        },
        removeOnComplete: true,
        removeOnFail: 1000,
    }
});

console.log('✅-Queue fetchQueue initialized');
console.log('✅-Queue semanticSummaryQueue initialized');
console.log('✅-Queue synthesisQueue initialized');


export default {
    fetchQueue,
    semanticSummaryQueue,
    synthesisQueue
};