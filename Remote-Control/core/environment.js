import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

// Explicit process variables win, then server-local configuration, then root defaults.
// Resolve relative to this module so `node Remote-Control/server.js` also works.
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });
