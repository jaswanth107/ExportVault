import { Router } from 'express';
import { authRouter } from './auth.routes';
import { exportRouter } from './export.routes';

export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/exports', exportRouter);
