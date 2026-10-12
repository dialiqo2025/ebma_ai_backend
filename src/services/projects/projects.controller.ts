import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { HttpStatusCodes as Code } from "../../utils/httpType.util";
import * as ProjectsProvider from "./projects.provider";

const projectUuid = z.string().uuid();
const projectUpdate = z.object({
  name: z.unknown().optional(),
  description: z.unknown().optional(),
  status: z.enum(["active", "archived"]).optional(),
});
const send = (res: Response, result: { code: number; data: unknown }) => res.status(result.code).json(result.data);

export const ProjectsController = {
  list: async (req: Request, res: Response, next: NextFunction) => {
    try { send(res, await ProjectsProvider.listProjects(req.user?.userId as string)); } catch (error) { next(error); }
  },
  create: async (req: Request, res: Response, next: NextFunction) => {
    try { send(res, await ProjectsProvider.createProject(req.user?.userId as string, req.body ?? {})); } catch (error) { next(error); }
  },
  get: async (req: Request, res: Response, next: NextFunction) => {
    try { send(res, await ProjectsProvider.getProject(req.user?.userId as string, projectUuid.parse(req.params.project_uuid))); } catch (error) { next(error); }
  },
  update: async (req: Request, res: Response, next: NextFunction) => {
    try { send(res, await ProjectsProvider.updateProject(req.user?.userId as string, projectUuid.parse(req.params.project_uuid), projectUpdate.parse(req.body ?? {}))); } catch (error) { next(error); }
  },
  archive: async (req: Request, res: Response, next: NextFunction) => {
    try { send(res, await ProjectsProvider.archiveProject(req.user?.userId as string, projectUuid.parse(req.params.project_uuid))); } catch (error) { next(error); }
  },
  permanentlyDelete: async (req: Request, res: Response, next: NextFunction) => {
    try { send(res, await ProjectsProvider.permanentlyDeleteProject(req.user?.userId as string, projectUuid.parse(req.params.project_uuid))); } catch (error) { next(error); }
  },
};
