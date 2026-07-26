// Boots the TypeScript fixture. Additional details are intentionally omitted.
import { feature } from './feature';
const util = require('./util');

export const result = feature() + util.value;
