import { Router } from 'express';
import {
  cancel,
  create,
  createExportSchema,
  detail,
  download,
  exportIdParamSchema,
  list,
  resume,
  stats,
  verify,
} from '../controllers/export.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { validateBody, validateParams } from '../middleware/validate.middleware';
import { exportCreationLimiter } from '../middleware/rateLimit.middleware';

export const exportRouter = Router();

// Every export route is authenticated, and every :id route re-checks ownership
// inside the service layer.
exportRouter.use(requireAuth);

exportRouter.post('/', exportCreationLimiter, validateBody(createExportSchema), create);
exportRouter.get('/', list);
exportRouter.get('/stats', stats);
exportRouter.get('/:id', validateParams(exportIdParamSchema), detail);
exportRouter.post('/:id/resume', validateParams(exportIdParamSchema), resume);
exportRouter.post('/:id/cancel', validateParams(exportIdParamSchema), cancel);
exportRouter.get('/:id/download', validateParams(exportIdParamSchema), download);
exportRouter.get('/:id/verify', validateParams(exportIdParamSchema), verify);
