import { initializeDb, getDb, dbRun, dbGet, dbAll, dbExec, save } from './db.js';

export const config = {
  jwtSecret: process.env.JWT_SECRET || 'urgad-dev-secret-change-in-production',
  jwtExpiry: process.env.JWT_EXPIRY || '30d',
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3001', 10),
  appName: 'URGAD',
  appVersion: '1.0.0',
};
