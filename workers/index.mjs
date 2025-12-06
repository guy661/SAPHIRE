import 'dotenv/config';

// Import and start all workers
import './fetching.mjs';
import './semantic.mjs';
import './synthesis.mjs';

console.log('Fetching, Semantic, and Synthesis workers are running...');

