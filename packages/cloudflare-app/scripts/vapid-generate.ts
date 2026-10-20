import { generateVapidKeys } from '@portfolio/platform';
import { vapidInstructions } from '../src/vapid-instructions.js';

console.log(vapidInstructions(await generateVapidKeys()));
