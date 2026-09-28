import { Router } from "express";
import {GoalController } from "./goal.controller.js";
import { authMiddleware } from "../auth/auth.middleware.js";

export const goalRouter = Router();

goalRouter.post("/", authMiddleware, GoalController.create);
goalRouter.get("/", authMiddleware, GoalController.findAllByUserId);
goalRouter.put("/check", authMiddleware, GoalController.checkGoal);
goalRouter.put("/:id", authMiddleware, GoalController.update);
goalRouter.delete("/:id", authMiddleware, GoalController.delete);