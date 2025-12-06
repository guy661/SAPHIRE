import { Queue } from 'bullmq';
import redisConnection from './redis.mjs';

export const fetchAllQueue = new Queue('fetch-all', { connection: redisConnection });
export const semanticQueue = new Queue('semantic-summary', { connection: redisConnection });
export const synthesisQueue = new Queue('synthesis', { connection: redisConnection });

console.log('✅-Queue fetchAllQueue initialized');
console.log('✅-Queue semanticQueue initialized');
console.log('✅-Queue synthesisQueue initialized');

const queues = {
    fetchAllQueue,
    semanticQueue,
    synthesisQueue,
};

export default queues;