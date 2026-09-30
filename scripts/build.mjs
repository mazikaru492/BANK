import { copyFile, mkdir, rm } from 'node:fs/promises';

// Publish only the browser application. Keep Java desktop files out of dist.
const outputDirectory = new URL('../dist/', import.meta.url);
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await copyFile(new URL('../index.html', import.meta.url), new URL('index.html', outputDirectory));
console.log('Built dist/index.html');
