// Thin fs seam — injectable so tests never touch disk. App wires real fs.
import { readFile, writeFile } from 'node:fs/promises';

export const realIo = {
  read: (p) => readFile(p, 'utf8'),
  write: (p, data) => writeFile(p, data, 'utf8'),
};
