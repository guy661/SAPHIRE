import IORedis from 'ioredis';
import 'dotenv/config';

const redisConnection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: null,
    enableReadyCheck: false
});

redisConnection.on('connect', () => {
    console.log('✅🐞 Redis connected');
});

redisConnection.on('error', (err) => {
    console.error('❌🐞 Redis connection error', err);
});

export default redisConnection;