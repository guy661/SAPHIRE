import { useEffect, useRef, useCallback } from 'react';

export const useEmbedding = () => {
    const worker = useRef<Worker | null>(null);

    useEffect(() => {
        // Initialize the worker
        // Vite handles the worker import automatically with the ?worker suffix
        worker.current = new Worker(
            new URL('../workers/embeddingWorker.ts', import.meta.url),
            { type: 'module' }
        );

        return () => {
            worker.current?.terminate();
        };
    }, []);

    const generateEmbedding = useCallback((text: string): Promise<number[]> => {
        return new Promise((resolve, reject) => {
            if (!worker.current) {
                reject(new Error('Worker not initialized'));
                return;
            }

            const messageId = Math.random().toString(36).substring(7);

            const handleMessage = (event: MessageEvent) => {
                const { status, id, embedding, error } = event.data;
                
                if (status === 'complete' && id === messageId) {
                    worker.current?.removeEventListener('message', handleMessage);
                    resolve(embedding);
                } else if (status === 'error') {
                    worker.current?.removeEventListener('message', handleMessage);
                    reject(new Error(error));
                }
            };

            worker.current.addEventListener('message', handleMessage);
            worker.current.postMessage({ text, id: messageId });
        });
    }, []);

    return { generateEmbedding };
};
