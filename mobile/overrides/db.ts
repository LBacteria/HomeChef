import { drizzle } from 'drizzle-orm/better-sqlite3';
import NativeDatabase from '@mobile/native-database';
import * as schema from './schema.js';
export const sqlite = new NativeDatabase();
export const db = drizzle(sqlite as any, { schema });
export const databasePath = 'Android application private database';
