import { pipeline, env } from '@xenova/transformers';

// Skip local check and use remote CDN for models
env.allowLocalModels = false;
env.useBrowserCache = true;

class EmbeddingPipeline {
    static task = 'feature-extraction';
    static model = 'Xenova/all-MiniLM-L6-v2';
    static instance = null;

    static async getInstance(progress_callback = null) {
        if (this.instance === null) {
            this.instance = pipeline(this.task, this.model, { progress_callback });
        }
        return this.instance;
    }
}

// Listen for messages from the main thread
self.addEventListener('message', async (event) => {
    const { text, id } = event.data;
    if (!text) return;

    try {
        const extractor = await EmbeddingPipeline.getInstance((data) => {
            // Send progress updates back to main thread if needed
            self.postMessage({ status: 'progress', data });
        });

        // Generate embeddings
        const output = await extractor(text, { pooling: 'mean', normalize: true });

        // Convert Float32Array to regular array for serialization
        const embedding = Array.from(output.data);

        // Send the result back
        self.postMessage({
            status: 'complete',
            id,
            embedding
        });
    } catch (error) {
        self.postMessage({
            status: 'error',
            error: error.message
        });
    }
});
