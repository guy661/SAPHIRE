import { describe, it, expect, vi } from 'vitest';
import { retry } from './utils';

describe('retry function', () => {

    it('should return result immediately if function succeeds', async () => {
        const mockFn = vi.fn().mockResolvedValue('Success');
        const result = await retry(mockFn, 3, 10); 
        expect(result).toBe('Success');
        expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it('should retry if function fails initially', async () => {
        const mockFn = vi.fn()
            .mockRejectedValueOnce(new Error('Fail 1'))
            .mockResolvedValue('Success');

        const result = await retry(mockFn, 3, 10);

        expect(result).toBe('Success');
        expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it('should throw error if max retries reached (Initial + Retries)', async () => {
        const mockFn = vi.fn().mockRejectedValue(new Error('Always Fail'));

        // Erwartet, dass der Aufruf fehlschlägt
        await expect(retry(mockFn, 3, 10)).rejects.toThrow('Retry failed');
        
        // Neues Verhalten: 1 Initial + 3 Retries = 4 Versuche
        expect(mockFn).toHaveBeenCalledTimes(4);
    });
});
