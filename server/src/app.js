import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';

import env, { ROOT_DIR } from './config/env.js';
import apiRoutes from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  // The API serves JSON and file downloads only, so CSP has nothing to protect.
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin and tooling requests arrive without an Origin header.
        if (!origin || env.corsOrigin.includes(origin)) return callback(null, true);
        return callback(new Error(`Origin ${origin} is not allowed by CORS`));
      },
      credentials: true,
      exposedHeaders: ['Content-Disposition'],
    })
  );

  // Editor content carries base64 screenshots, so the limit has to be generous.
  app.use(express.json({ limit: '60mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(cookieParser());

  if (!env.isProd) {
    app.use(morgan(':method :url :status - :response-time ms', { skip: (req) => req.method === 'OPTIONS' }));
  }

  app.use('/api', apiRoutes);

  /*
   * The built app, when there is one.
   *
   * `npm run build` writes it to client/dist, and serving it from here makes `npm start` a whole
   * deployment rather than half of one — which is what a container needs, and what the README has
   * always implied. In development there is no build and Vite serves the app on its own port, so
   * this is skipped entirely: an index.html left over from an old build being served instead of
   * the dev server would be a confusing afternoon.
   *
   * Mounted after /api, so an unknown API path still answers with JSON from `notFoundHandler`
   * rather than with the app's HTML — a fetch that receives a page where it expected an object
   * fails somewhere far away from the mistake.
   */
  const clientDir = path.join(ROOT_DIR, 'client', 'dist');
  if (fs.existsSync(path.join(clientDir, 'index.html'))) {
    /*
     * The hashed assets are immutable — their name changes when their contents do — so they can be
     * cached hard. index.html must not be: it is the file that names the current hashes, and a
     * cached copy of it points a returning browser at assets that no longer exist.
     */
    app.use(
      express.static(clientDir, {
        index: false,
        setHeaders(res, filePath) {
          if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      })
    );

    /* Every other GET is a route inside the single-page app, so it gets the app. */
    app.get(/^(?!\/api\/).*/, (req, res, next) => {
      if (req.method !== 'GET') return next();
      return res.sendFile(path.join(clientDir, 'index.html'));
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
