import { fileURLToPath } from 'node:url';

export const sdkVersion = '2.6.4';
export const bootstrapPath = fileURLToPath(new URL('./bootstrap.py', import.meta.url));
