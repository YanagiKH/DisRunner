import { fileURLToPath } from 'node:url';

export const sdkVersion = '14.27.0';
export const bootstrapPath = fileURLToPath(new URL('./bootstrap.cjs', import.meta.url));
